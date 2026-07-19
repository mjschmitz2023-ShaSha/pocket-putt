// Pocket Putt multi-room relay — Chess101-style cloud process.
//
// Serves the game UI (static files) + multi-room WebSocket authority.
// Players open the public URL in a browser — no code download required.
//
// Handshake (first WS message), same spirit as Chess101 network/relay.py:
//   relay_create   { player_name }
//   relay_join     { room_code, player_name, reconnect_token? }
//   relay_reconnect { room_code, token }   // token = reconnectToken from welcome
//
// Then game messages: setName, startRound, putt.
//
// Env:
//   PORT / RELAY_PORT     listen port (Render injects PORT)
//   PUBLIC_URL            optional public origin for share links
//   RELAY_MAX_ROOMS       default 100
//   RELAY_ROOM_TIMEOUT    idle seconds before room deleted (default 600)
//   RELAY_MAX_PLAYERS     players per room (default 8)
//
// Run: node relay.js   (also: npm start / npm run lan)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { GameSession, TICK_MS } = require('./gameSession.js');

const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8977);
const ROOT = __dirname;
const MAX_ROOMS = Number(process.env.RELAY_MAX_ROOMS || 100);
const ROOM_TIMEOUT_MS = (Number(process.env.RELAY_ROOM_TIMEOUT || 600) || 600) * 1000;
const CODE_LEN = 6;
const publicBase = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(
  /\/$/,
  ''
);

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const STATIC_FILES = [
  'index.html',
  'style.css',
  'mp-recon.js',
  'game.js',
  'shared.js',
  'share-level.js',
  'draw.js',
  'editor.html',
  'editor.js',
  'editor-snap.js',
  'editor-gizmos.js',
  'editor.css',
  'path-trace.html',
  'path-trace-viewer.js',
  'putt.wav',
  'echoey_putt.wav',
  'putt_go_in.wav',
  'sounds/portal/portal_enter.wav',
  'sounds/portal/portal_exit.wav',
];

/** @type {Map<string, { code: string, session: GameSession, createdAt: number }>} */
const rooms = new Map();

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O (ambiguous)
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function roomShareUrl(code) {
  // Prefer a clickable deep link so friends open the game and join in one step.
  if (publicBase) return `${publicBase}/?room=${code}`;
  // Local / no PUBLIC_URL yet: still a path; host is whatever they already used.
  return `/?room=${code}`;
}

function createRoom() {
  const code = generateCode();
  const share = roomShareUrl(code);
  const session = new GameSession({
    code,
    joinUrl: share,
    joinUrlFallback: code,
  });
  const room = { code, session, createdAt: Date.now() };
  rooms.set(code, room);
  console.log(`[${code}] room created (${rooms.size} active)`);
  return room;
}

function getRoom(code) {
  if (!code || typeof code !== 'string') return null;
  return rooms.get(code.toUpperCase().trim()) || null;
}

function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.session.destroy();
  rooms.delete(code);
  console.log(`[${code}] room destroyed (${rooms.size} active)`);
}

// ---- HTTP: health + game static files (same origin as /ws) ----
function serveStatic(req, res) {
  let reqPath = (req.url || '/').split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  // Allowlisted relative paths (may include subdirs like sounds/portal/...).
  const rel = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
  const name = STATIC_FILES.includes(rel)
    ? rel
    : (STATIC_FILES.includes(path.basename(rel)) ? path.basename(rel) : null);
  if (!name) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
    return;
  }
  const filePath = path.join(ROOT, name);
  // Path-traversal guard: resolved file must stay under ROOT.
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });
    res.end(data);
  });
}

const Shared = require('./shared.js');

/**
 * Expand a TinyURL alias to the permanent pocketputt ?lvl= URL.
 * TinyURL often serves long targets via a "preview/deprecated" interstitial
 * instead of a direct 301 — browsers can fail or truncate. We walk redirects
 * (and meta-refresh HTML) server-side to recover the full payload.
 */
async function expandLvlShortAlias(alias) {
  if (!Shared.isValidTinyAlias(alias)) {
    return { ok: false, error: 'invalid_alias' };
  }
  let url = Shared.tinyurlExpandUrl(alias);
  for (let hop = 0; hop < 8; hop++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PocketPuttExpand/1.0)',
          Accept: 'text/html,*/*',
        },
      });
    } catch (e) {
      return { ok: false, error: 'fetch_failed', detail: String(e && e.message ? e.message : e) };
    }

    const xtarget = res.headers.get('x-tinyurl-target');
    if (xtarget) {
      const lvl = Shared.extractLvlFromUrl(xtarget);
      if (lvl) return { ok: true, alias, url: xtarget, lvl, via: 'x-tinyurl-target', hops: hop + 1 };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, error: 'redirect_missing_location', status: res.status };
      url = new URL(loc, url).href;
      const lvl = Shared.extractLvlFromUrl(url);
      if (lvl) return { ok: true, alias, url, lvl, via: 'location', hops: hop + 1 };
      continue;
    }

    if (res.status === 200) {
      const text = await res.text();
      const next = Shared.extractRedirectFromHtml(text, url);
      if (next) {
        const lvl = Shared.extractLvlFromUrl(next);
        if (lvl) return { ok: true, alias, url: next, lvl, via: 'meta-refresh', hops: hop + 1 };
        url = next;
        continue;
      }
      // Landed on a final page without a further redirect.
      const lvl = Shared.extractLvlFromUrl(url);
      if (lvl) return { ok: true, alias, url, lvl, via: 'final-url', hops: hop + 1 };
      return { ok: false, error: 'no_lvl_in_target', status: res.status };
    }

    return { ok: false, error: 'unexpected_status', status: res.status };
  }
  return { ok: false, error: 'too_many_hops' };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const httpServer = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const urlPath = rawUrl.split('?')[0];
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
  }
  // Short-link expand: TinyURL is the store; we resolve so browsers skip preview traps.
  if (urlPath === '/api/expand-lvl-short' && (req.method === 'GET' || req.method === 'HEAD')) {
    const q = new URL(rawUrl, 'http://localhost').searchParams;
    const alias = (q.get('alias') || q.get('a') || '').trim();
    expandLvlShortAlias(alias)
      .then((result) => {
        sendJson(res, result.ok ? 200 : 422, result);
      })
      .catch((e) => {
        sendJson(res, 500, { ok: false, error: 'server_error', detail: String(e && e.message ? e.message : e) });
      });
    return;
  }
  // Path-trace observability:
  //   GET /path-trace           → list active rooms (codes + sample counts)
  //   GET /path-trace/ROOMCODE  → full host+client dump for that room
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (urlPath === '/path-trace' || urlPath === '/path-trace/') {
      const list = [];
      for (const [code, room] of rooms) {
        const b = room.session && room.session.buildPathTraceBundle
          ? room.session.buildPathTraceBundle()
          : null;
        let hostSamples = 0;
        if (b && b.host) {
          for (const id of Object.keys(b.host)) {
            hostSamples += (b.host[id].samples && b.host[id].samples.length) || 0;
          }
        }
        list.push({
          code,
          players: room.session ? room.session.connectedCount() : 0,
          state: room.session ? room.session.state : null,
          hostTick: b ? b.hostTick : null,
          hostSamples,
          clientDumps: b && b.clients ? Object.keys(b.clients).length : 0,
          events: b && b.events ? b.events.length : 0,
        });
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendJson(res, 200, { ok: true, rooms: list });
      return;
    }
    const m = urlPath.match(/^\/path-trace\/([A-Za-z0-9]+)$/i);
    if (m) {
      const room = getRoom(m[1]);
      if (!room || !room.session) {
        const codes = [...rooms.keys()];
        sendJson(res, 404, {
          ok: false,
          error: 'room_not_found',
          room: String(m[1]).toUpperCase(),
          activeRooms: codes,
          hint:
            codes.length === 0
              ? 'No rooms on this relay. Create a room in the game first (relay restart clears all rooms).'
              : `Room not active. Live rooms: ${codes.join(', ')}`,
        });
        return;
      }
      if (typeof room.session.buildPathTraceBundle !== 'function') {
        sendJson(res, 500, {
          ok: false,
          error: 'path_trace_unavailable',
          hint: 'Restart npm start — this relay process predates path-trace.',
        });
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      try {
        sendJson(res, 200, room.session.buildPathTraceBundle());
      } catch (e) {
        sendJson(res, 500, {
          ok: false,
          error: 'bundle_failed',
          detail: String(e && e.message ? e.message : e),
        });
      }
      return;
    }
  }
  serveStatic(req, res);
});

const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  try {
    req.socket.setNoDelay(true);
  } catch {
    /* ignore */
  }

  /** @type {{ room: object, player: object } | null} */
  let binding = null;
  let handshaken = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // First message must be a room handshake (Chess101 pattern).
    if (!handshaken) {
      const t = msg.type;
      if (t === 'relay_create') {
        if (rooms.size >= MAX_ROOMS) {
          // Keep socket open so the client can retry without a full page refresh.
          send(ws, { type: 'relay_error', code: 'server_full' });
          return;
        }
        const room = createRoom();
        const { player, error } = room.session.addPlayer(
          ws,
          { name: msg.player_name || msg.name || 'Player', isLocal: false },
          { quiet: true }
        );
        if (error || !player) {
          destroyRoom(room.code);
          send(ws, { type: 'relay_error', code: error || 'join_failed' });
          return;
        }
        binding = { room, player };
        handshaken = true;
        // Chess101 order: room ack first, then game welcome/lobby.
        send(ws, {
          type: 'relay_created',
          room_code: room.code,
          token: player.reconnectToken,
        });
        room.session.sendWelcome(player);
        room.session.broadcastLobbyState();
        return;
      }

      if (t === 'relay_join' || t === 'relay_reconnect') {
        const room = getRoom(msg.room_code);
        if (!room) {
          // Expired/stale room codes are common after free-tier sleep — do NOT close
          // the socket; the client can Create Room or Join a different code next.
          send(ws, { type: 'relay_error', code: 'room_not_found' });
          return;
        }
        const reconnectToken =
          msg.reconnect_token || msg.reconnectToken || msg.token || null;
        if (t === 'relay_reconnect' && !reconnectToken) {
          send(ws, { type: 'relay_error', code: 'bad_token' });
          return;
        }
        const { player, error, reconnected } = room.session.addPlayer(
          ws,
          {
            name: msg.player_name || msg.name || 'Player',
            reconnectToken,
            isLocal: false,
          },
          { quiet: true, requireReconnect: t === 'relay_reconnect' }
        );
        if (error === 'room_full') {
          send(ws, { type: 'relay_error', code: 'room_full' });
          return;
        }
        if (!player || (t === 'relay_reconnect' && !reconnected)) {
          send(ws, {
            type: 'relay_error',
            code: t === 'relay_reconnect' ? 'bad_token' : error || 'join_failed',
          });
          return;
        }
        binding = { room, player };
        handshaken = true;
        send(ws, {
          type: t === 'relay_reconnect' || reconnected ? 'relay_reconnected' : 'relay_created',
          room_code: room.code,
          token: player.reconnectToken,
        });
        room.session.sendWelcome(player);
        room.session.broadcastLobbyState();
        return;
      }

      // LAN-style join is not valid on the multi-room relay — keep socket open for a
      // proper relay_create / relay_join next.
      send(ws, { type: 'relay_error', code: 'bad_handshake' });
      return;
    }

    // In-room game protocol.
    if (binding) binding.room.session.handleMessage(binding.player, msg);
  });

  ws.on('close', () => {
    if (!binding) return;
    const { room, player } = binding;
    room.session.onDisconnect(player);
    binding = null;
    // Drop empty idle rooms quickly so codes recycle.
    if (room.session.connectedCount() === 0) {
      // Keep briefly so reconnect_token works after a refresh.
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        if (room.session.connectedCount() === 0) destroyRoom(room.code);
      }, 60_000);
    }
  });
});

// Drive physics for every active room.
setInterval(() => {
  for (const room of rooms.values()) {
    room.session.tickDriver();
  }
}, TICK_MS);

// Idle room cleanup (Chess101: every 60s).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.session.lastActivity > ROOM_TIMEOUT_MS) {
      destroyRoom(code);
    }
  }
}, 60_000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Pocket Putt multi-room relay');
  console.log(`  Listening  0.0.0.0:${PORT}`);
  console.log(`  Game UI    http://0.0.0.0:${PORT}/`);
  console.log(`  WebSocket  ws://0.0.0.0:${PORT}/ws`);
  console.log(`  Health     http://0.0.0.0:${PORT}/health`);
  if (publicBase) console.log(`  Public     ${publicBase}`);
  console.log(`  Max rooms  ${MAX_ROOMS}  timeout ${ROOM_TIMEOUT_MS / 1000}s`);
  console.log('  Open the URL → Create Room / Join with code (or ?room=CODE)');
  console.log('');
});
