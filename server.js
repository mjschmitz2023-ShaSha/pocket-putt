// Pocket Putt — optional single-process LAN entry (legacy).
// Prefer `npm start` / `relay.js` for multi-room + static UI (local and Render).
// This file remains a thin single-room host for debugging.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { GameSession, TICK_MS } = require('./gameSession.js');

const PORT = process.env.PORT || 8977;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.wav': 'audio/wav',
};
const STATIC_FILES = [
  'index.html',
  'style.css',
  'game.js',
  'shared.js',
  'putt.wav',
  'echoey_putt.wav',
  'putt_go_in.wav',
];

function serveStatic(req, res) {
  let reqPath = (req.url || '/').split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const name = path.basename(reqPath);
  if (!STATIC_FILES.includes(name)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(ROOT, name), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleRequest(req, res) {
  if ((req.url || '/').split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
  }
  serveStatic(req, res);
}

const httpServer = http.createServer(handleRequest);

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const hostname = os.hostname();
const lanIp = getLanIp();
const joinUrl = `http://${hostname}:${PORT}`;
const joinUrlFallback = `http://${lanIp}:${PORT}`;
const session = new GameSession({ joinUrl, joinUrlFallback, code: 'LAN' });

setInterval(() => session.tickDriver(), TICK_MS);

const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
wss.on('connection', (ws, req) => {
  let player = null;
  try {
    req.socket.setNoDelay(true);
  } catch {
    /* ignore */
  }
  const remoteAddr = req.socket.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'join' || msg.type === 'relay_create' || msg.type === 'relay_join' || msg.type === 'relay_reconnect') {
      const result = session.addPlayer(ws, {
        name: msg.player_name || msg.name,
        reconnectToken: msg.reconnect_token || msg.reconnectToken || msg.token,
        isLocal,
      });
      player = result.player;
      if (player && msg.type !== 'join') {
        ws.send(
          JSON.stringify({
            type: msg.type === 'relay_reconnect' ? 'relay_reconnected' : 'relay_created',
            room_code: 'LAN',
            token: player.reconnectToken,
          })
        );
      }
      return;
    }
    if (player) session.handleMessage(player, msg);
  });
  ws.on('close', () => {
    if (player) session.onDisconnect(player);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Pocket Putt single-room LAN host (legacy).');
  console.log(`    ${joinUrl}`);
  console.log(`    ${joinUrlFallback}`);
  console.log('  Prefer: npm start  (multi-room relay + same UI)');
  console.log('');
});
