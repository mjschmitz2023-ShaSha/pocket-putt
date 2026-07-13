// Pocket Putt multi-room relay — Chess101-style cloud process.
//
// WebSocket + health only. No game frontend.
// Each room runs its own authoritative GameSession (lobby, physics, scoring).
//
// Handshake (first message), same spirit as Chess101 network/relay.py:
//   relay_create   { player_name }
//   relay_join     { room_code, player_name, reconnect_token? }
//   relay_reconnect { room_code, token }   // token = reconnectToken from welcome
//
// Then game messages: setName, startRound, putt (same as LAN host).
//
// Env:
//   PORT / RELAY_PORT     listen port (Render injects PORT)
//   RELAY_MAX_ROOMS       default 100
//   RELAY_ROOM_TIMEOUT    idle seconds before room deleted (default 600)
//   RELAY_MAX_PLAYERS     players per room (default 8)
//
// Run: node relay.js
'use strict';

const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { GameSession, TICK_MS } = require('./gameSession.js');

const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8977);
const MAX_ROOMS = Number(process.env.RELAY_MAX_ROOMS || 100);
const ROOM_TIMEOUT_MS = (Number(process.env.RELAY_ROOM_TIMEOUT || 600) || 600) * 1000;
const CODE_LEN = 6;

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

function createRoom() {
  const code = generateCode();
  const session = new GameSession({
    code,
    joinUrl: code,
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

// ---- HTTP: health only (no static frontend) ----
const httpServer = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
  }
  // Explicitly no game UI — clients connect with their own frontend over wss.
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(
    'Pocket Putt relay (WebSocket only).\n' +
      'Connect to /ws with relay_create or relay_join.\n' +
      'Health: GET /health\n'
  );
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
          send(ws, { type: 'relay_error', code: 'server_full' });
          ws.close();
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
          ws.close();
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
          send(ws, { type: 'relay_error', code: 'room_not_found' });
          ws.close();
          return;
        }
        const reconnectToken =
          msg.reconnect_token || msg.reconnectToken || msg.token || null;
        // reconnect path: token must match an existing player
        if (t === 'relay_reconnect' && !reconnectToken) {
          send(ws, { type: 'relay_error', code: 'bad_token' });
          ws.close();
          return;
        }
        const { player, error, reconnected } = room.session.addPlayer(
          ws,
          {
            name: msg.player_name || msg.name || 'Player',
            reconnectToken,
            isLocal: false,
          },
          { quiet: true }
        );
        if (error === 'room_full') {
          send(ws, { type: 'relay_error', code: 'room_full' });
          ws.close();
          return;
        }
        if (!player) {
          send(ws, {
            type: 'relay_error',
            code: t === 'relay_reconnect' ? 'bad_token' : 'join_failed',
          });
          ws.close();
          return;
        }
        // join with a bad token falls through to a new player — fine for relay_join.
        // For relay_reconnect we require an actual reconnect.
        if (t === 'relay_reconnect' && !reconnected) {
          // New player was created by mistake if token didn't match — remove and error.
          room.session.players.delete(player.id);
          send(ws, { type: 'relay_error', code: 'bad_token' });
          ws.close();
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

      // LAN-style join is not valid on the multi-room relay.
      send(ws, { type: 'relay_error', code: 'bad_handshake' });
      ws.close();
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
  console.log(`  WebSocket  ws://0.0.0.0:${PORT}/ws`);
  console.log(`  Health     http://0.0.0.0:${PORT}/health`);
  console.log(`  Max rooms  ${MAX_ROOMS}  timeout ${ROOM_TIMEOUT_MS / 1000}s`);
  console.log('  No static frontend — clients use relay_create / relay_join');
  console.log('');
});
