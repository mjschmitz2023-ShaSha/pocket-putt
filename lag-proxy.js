// Bidirectional lag / jitter proxy in front of the real Pocket Putt relay.
//
// Why a proxy (not client-side delay):
//   Real RTT hits *both* directions. Client-only inbound lag is asymmetric and
//   misleads netcode diagnosis. This process sits between browser and relay:
//
//     browser  ──lag+jitter──►  proxy  ──lag+jitter──►  relay (authority)
//     browser  ◄─lag+jitter──  proxy  ◄─lag+jitter──  relay
//
// Each *message* is delayed (base LAG_MS ± JITTER_MS). **Order is preserved
// per direction** (WebSocket is TCP — real networks do not reorder frames on
// one connection). Jitter only varies delay; a later message never jumps ahead
// of an earlier one (that reordering broke puttApplied-before-hard and made
// dual-client clash tests fail unrealistically).
//
// HTTP is reverse-proxied without artificial delay so assets load normally;
// only WebSocket frames are delayed.
//
// Env:
//   PROXY_PORT     listen port (default 8978)
//   UPSTREAM       relay origin (default http://127.0.0.1:8977)
//   LAG_MS         one-way base delay each direction (default 80)
//   JITTER_MS      ± uniform jitter on each message (default 40)
//
// Usage:
//   terminal A:  npm start                 # real relay :8977
//   terminal B:  npm run lag-proxy         # proxy :8978
//   browser:     http://localhost:8978/?rbdebug=1
//
// Joiner (same RTT): also open through :8978 with ?room=CODE&rbdebug=1
// Zero-lag control: open :8977 directly (bypass proxy).
'use strict';

const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');

const PROXY_PORT = Number(process.env.PROXY_PORT || 8978);
const UPSTREAM = (process.env.UPSTREAM || 'http://127.0.0.1:8977').replace(/\/$/, '');
const LAG_MS = Math.max(0, Number(process.env.LAG_MS || 80));
const JITTER_MS = Math.max(0, Number(process.env.JITTER_MS || 40));

const upstreamUrl = new URL(UPSTREAM);
const upstreamIsHttps = upstreamUrl.protocol === 'https:';
const upstreamHost = upstreamUrl.hostname;
const upstreamPort =
  upstreamUrl.port || (upstreamIsHttps ? 443 : 80);
const upstreamWsProto = upstreamIsHttps ? 'wss:' : 'ws:';
const upstreamWsBase = `${upstreamWsProto}//${upstreamHost}:${upstreamPort}`;

/**
 * FIFO delayed sender for one direction of a live WebSocket.
 * Delays each payload by LAG_MS ± JITTER_MS; never reorders (TCP/WS semantics).
 */
function createDelayedPipe(sendFn, label) {
  /** @type {{ at: number, data: any, isBinary: boolean }[]} */
  const queue = [];
  let timer = null;
  let closed = false;
  /** Monotonic floor so message N+1 never delivers before message N. */
  let lastDeliverAt = 0;

  function jitteredDelay() {
    if (!JITTER_MS) return LAG_MS;
    const j = (Math.random() * 2 - 1) * JITTER_MS;
    return Math.max(0, LAG_MS + j);
  }

  function arm() {
    if (closed || timer != null || !queue.length) return;
    const wait = Math.max(0, queue[0].at - Date.now());
    timer = setTimeout(flush, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function flush() {
    timer = null;
    if (closed) return;
    const now = Date.now();
    while (queue.length && queue[0].at <= now) {
      const item = queue.shift();
      try {
        sendFn(item.data, item.isBinary);
      } catch (e) {
        console.warn(`[lag-proxy] ${label} send failed:`, e && e.message ? e.message : e);
      }
    }
    arm();
  }

  return {
    push(data, isBinary) {
      if (closed) return;
      // FIFO: deliver-at is never earlier than the previous message's deliver-at.
      const raw = Date.now() + jitteredDelay();
      const at = Math.max(raw, lastDeliverAt + 1);
      lastDeliverAt = at;
      queue.push({
        at,
        data,
        isBinary: !!isBinary,
      });
      arm();
    },
    close() {
      closed = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      queue.length = 0;
    },
    get pending() {
      return queue.length;
    },
  };
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: upstreamHost + (upstreamPort ? `:${upstreamPort}` : '') };
  // Avoid hop-by-hop issues
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['proxy-connection'];
  delete headers['transfer-encoding'];

  const opts = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamHost,
    port: upstreamPort,
    path: req.url,
    method: req.method,
    headers,
  };

  const up = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end(`lag-proxy: upstream error: ${err.message}\n(is npm start running on ${UPSTREAM}?)`);
  });
  req.pipe(up);
}

const server = http.createServer(proxyHttp);

const wss = new WebSocket.Server({ server, path: '/ws' });

let pairId = 0;
wss.on('connection', (clientWs, req) => {
  const id = ++pairId;
  const qs = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `${upstreamWsBase}/ws${qs}`;

  console.log(`[lag-proxy] #${id} open → ${target}  (lag=${LAG_MS}ms ±${JITTER_MS}ms each way)`);

  let upstreamWs;
  try {
    upstreamWs = new WebSocket(target);
  } catch (e) {
    console.warn(`[lag-proxy] #${id} failed to open upstream:`, e.message);
    try { clientWs.close(); } catch { /* ignore */ }
    return;
  }

  const toUpstream = createDelayedPipe((data, isBinary) => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      upstreamWs.send(data, { binary: isBinary });
    }
  }, `#${id} c→s`);

  const toClient = createDelayedPipe((data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  }, `#${id} s→c`);

  upstreamWs.on('open', () => {
    console.log(`[lag-proxy] #${id} upstream connected`);
  });

  clientWs.on('message', (data, isBinary) => {
    toUpstream.push(data, isBinary);
  });
  upstreamWs.on('message', (data, isBinary) => {
    toClient.push(data, isBinary);
  });

  function shutdown(why) {
    console.log(`[lag-proxy] #${id} close (${why})`);
    toUpstream.close();
    toClient.close();
    try {
      if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
        clientWs.close();
      }
    } catch { /* ignore */ }
    try {
      if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
        upstreamWs.close();
      }
    } catch { /* ignore */ }
  }

  clientWs.on('close', () => shutdown('client'));
  clientWs.on('error', () => shutdown('client-error'));
  upstreamWs.on('close', () => shutdown('upstream'));
  upstreamWs.on('error', (err) => {
    console.warn(`[lag-proxy] #${id} upstream error:`, err && err.message ? err.message : err);
    shutdown('upstream-error');
  });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Pocket Putt bidirectional lag proxy');
  console.log(`  Listen     http://0.0.0.0:${PROXY_PORT}/`);
  console.log(`  Upstream   ${UPSTREAM}`);
  console.log(`  WebSocket  ws://0.0.0.0:${PROXY_PORT}/ws`);
  console.log(`  One-way    ${LAG_MS}ms ± ${JITTER_MS}ms  (each direction independently)`);
  console.log(`  Est. RTT   ~${LAG_MS * 2}ms ± ${JITTER_MS * 2}ms`);
  console.log('');
  console.log('  1) npm start                 # real authority on :8977');
  console.log(`  2) open  http://localhost:${PROXY_PORT}/?rbdebug=1`);
  console.log('  Control (no lag): http://localhost:8977/?rbdebug=1');
  console.log('');
});
