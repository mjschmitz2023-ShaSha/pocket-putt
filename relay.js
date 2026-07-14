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
  'game.js',
  'shared.js',
  'draw.js',
  'editor.html',
  'editor.js',
  'editor-snap.js',
  'editor-gizmos.js',
  'editor.css',
  'putt.wav',
  'echoey_putt.wav',
  'putt_go_in.wav',
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
  const name = path.basename(reqPath);
  if (!STATIC_FILES.includes(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
    return;
  }
  const filePath = path.join(ROOT, name);
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

const httpServer = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
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
