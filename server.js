// Pocket Putt — LAN multiplayer host.
// Serves the game's static files and runs the authoritative multiplayer session over
// WebSocket, reusing shared.js for physics/course data so the host and every browser
// agree exactly on how the ball moves. Run with: npm install && node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const Shared = require('./shared.js');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const TICK_MS = 1000 / 60;
// Overridable via env for fast automated testing of the 19-hole progression.
const HOLE_TIMEOUT_MS = Number(process.env.HOLE_TIMEOUT_MS) || 90000;
const HOLE_RESULTS_DELAY_MS = Number(process.env.HOLE_RESULTS_DELAY_MS) || 6000;
const STROKE_PENALTY_SECONDS = 4;
const PLAYER_HUES = [0, 45, 190, 270, 130, 320, 25, 210];

// ---- Static file serving ----
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.wav': 'audio/wav' };
const STATIC_FILES = ['index.html', 'style.css', 'game.js', 'shared.js', 'putt.wav', 'echoey_putt.wav', 'putt_go_in.wav'];

function serveStatic(req, res) {
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  const name = path.basename(reqPath);
  if (!STATIC_FILES.includes(name)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const filePath = path.join(ROOT, name);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });
    res.end(data);
  });
}

const httpServer = http.createServer(serveStatic);

// ---- Join URL (Bonjour/.local hostname + LAN IP fallback) ----
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

// ---- Lobby / session state ----
const Lobby = {
  state: 'WAITING_FOR_PLAYERS', // WAITING_FOR_PLAYERS | PLAYING | HOLE_RESULTS | FINAL_RESULTS
  players: new Map(), // id -> PlayerSession
  hostPlayerId: null,
  currentHoleIndex: 0,
  holeStartedAtMs: 0,
  holeEnding: false,
};

function makeId() { return crypto.randomUUID(); }

function publicPlayerList() {
  return [...Lobby.players.values()].map((p) => ({
    id: p.id, name: p.name, hue: p.hue, connected: p.connected, isHost: p.id === Lobby.hostPlayerId,
  }));
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const p of Lobby.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

function broadcastLobbyState() {
  broadcast({ type: 'lobbyState', state: Lobby.state, players: publicPlayerList(), joinUrl, joinUrlFallback });
}

// Keeps hostPlayerId valid at all times. Priority: a connected player on the server's own
// machine (whoever is running `node server.js` should own the Start button), then any
// already-valid host, then any connected player. Called on every join and disconnect —
// the old first-joiner-only assignment could leave the lobby hostless after reloads,
// stranding everyone on "waiting for the host to start".
function ensureHost() {
  const players = [...Lobby.players.values()];
  const current = Lobby.players.get(Lobby.hostPlayerId);
  if (current && current.connected && current.isLocal) return;
  const localConnected = players.find((p) => p.connected && p.isLocal);
  if (localConnected) { Lobby.hostPlayerId = localConnected.id; return; }
  if (current && current.connected) return;
  const next = players.find((p) => p.connected);
  Lobby.hostPlayerId = next ? next.id : null;
}

// ---- Round / hole progression (all 19 holes, per-hole heats) ----
function beginHole(holeIndex) {
  Lobby.currentHoleIndex = holeIndex;
  const hole = Shared.HOLES[holeIndex];
  Shared.resetHoleObstacles(hole);
  for (const p of Lobby.players.values()) {
    p.ball = Shared.createBallState(hole.tee);
    p.strokes = 0;
    p.holedOut = false;
  }
  Lobby.holeStartedAtMs = Date.now();
  Lobby.holeEnding = false;
  Lobby.state = 'PLAYING';
  broadcast({ type: 'roundState', holeIndex, holeName: hole.name, par: hole.par });
}

function startNewRound() {
  for (const p of Lobby.players.values()) {
    p.perHoleScores = [];
    p.totalScore = 0;
  }
  beginHole(0);
}

function finishPlayerHole(p, timedOut) {
  const finishSeconds = (Date.now() - Lobby.holeStartedAtMs) / 1000;
  const holeScore = finishSeconds + p.strokes * STROKE_PENALTY_SECONDS;
  p.holedOut = true;
  p.perHoleScores.push({ holeIndex: Lobby.currentHoleIndex, strokes: p.strokes, finishSeconds, holeScore, timedOut });
  p.totalScore += holeScore;
}

function endHole() {
  Lobby.state = 'HOLE_RESULTS';
  const connected = [...Lobby.players.values()].filter((p) => p.connected);
  // Anyone who joined or reconnected mid-hole (including during the celebration delay
  // before this runs) has no score entry for this hole yet — close theirs out now so the
  // results map below can never hit an undefined entry and crash the server.
  for (const p of connected) {
    const last = p.perHoleScores[p.perHoleScores.length - 1];
    if (!last || last.holeIndex !== Lobby.currentHoleIndex) finishPlayerHole(p, true);
  }
  const results = connected.map((p) => {
    const last = p.perHoleScores[p.perHoleScores.length - 1];
    return { id: p.id, name: p.name, strokes: last.strokes, finishSeconds: last.finishSeconds, holeScore: last.holeScore, timedOut: last.timedOut };
  });
  const standings = connected
    .map((p) => ({ id: p.id, name: p.name, totalScore: p.totalScore }))
    .sort((a, b) => a.totalScore - b.totalScore);
  broadcast({ type: 'holeResults', holeIndex: Lobby.currentHoleIndex, results, standings });

  setTimeout(() => {
    if (Lobby.currentHoleIndex >= Shared.HOLES.length - 1) {
      Lobby.state = 'FINAL_RESULTS';
      broadcast({ type: 'finalResults', standings });
    } else {
      beginHole(Lobby.currentHoleIndex + 1);
    }
  }, HOLE_RESULTS_DELAY_MS);
}

// ---- Authoritative tick loop ----
function tick() {
  if (Lobby.state !== 'PLAYING') return;
  const hole = Shared.HOLES[Lobby.currentHoleIndex];
  const dt = TICK_MS / 1000;
  Shared.advanceHoleObstacles(hole, dt);

  // Per-tick gameplay events, forwarded in the snapshot so clients can play the matching
  // sound/particle juice at the right moment (the client no longer runs its own physics
  // in multiplayer, so it can't detect these locally).
  const tickEvents = [];
  for (const p of Lobby.players.values()) {
    if (!p.connected || p.holedOut || !p.ball) continue;
    const events = Shared.stepBallPhysics(p.ball, hole, dt);
    if (events.bounced) tickEvents.push({ id: p.id, kind: 'bounce' });
    if (events.enteredSand) tickEvents.push({ id: p.id, kind: 'sand' });
    for (const z of events.boosts) tickEvents.push({ id: p.id, kind: 'boost', x: p.ball.x, y: p.ball.y, angle: p.ball.angleDir });
    if (events.water) {
      p.strokes++;
      tickEvents.push({ id: p.id, kind: 'water', x: p.ball.x, y: p.ball.y });
      p.ball.x = events.water.dropPoint.x;
      p.ball.y = events.water.dropPoint.y;
      p.ball.vx = 0;
      p.ball.vy = 0;
    }
    if (events.holed) {
      finishPlayerHole(p, false);
      tickEvents.push({ id: p.id, kind: 'holed', strokes: p.strokes });
    }
  }

  const connected = [...Lobby.players.values()].filter((p) => p.connected);
  const elapsed = Date.now() - Lobby.holeStartedAtMs;

  // Broadcast BEFORE the hole-advance check so the snapshot carrying the final 'holed'
  // event actually reaches clients — otherwise the last player to sink never sees their
  // own celebration.
  broadcast({
    type: 'snapshot',
    holeIndex: Lobby.currentHoleIndex,
    elapsedMs: elapsed,
    events: tickEvents,
    obstacles: {
      windmillAngles: hole.windmills.map((wm) => wm.angle),
      pendulumPhases: hole.pendulums.map((p) => p.phase),
      gatePhases: hole.gates.map((g) => g.phase),
    },
    balls: [...Lobby.players.values()]
      .filter((p) => p.connected && p.ball)
      .map((p) => ({
        id: p.id, name: p.name, hue: p.hue, x: p.ball.x, y: p.ball.y, vx: p.ball.vx, vy: p.ball.vy,
        strokes: p.strokes, holedOut: p.holedOut,
      })),
  });

  const allHoledOut = connected.length > 0 && connected.every((p) => p.holedOut);
  const timedOut = elapsed > HOLE_TIMEOUT_MS;
  if ((allHoledOut || timedOut) && !Lobby.holeEnding) {
    Lobby.holeEnding = true;
    if (timedOut) {
      for (const p of connected) { if (!p.holedOut) finishPlayerHole(p, true); }
    }
    // Short pause before the results screen so the final hole-in celebration is visible.
    setTimeout(() => { Lobby.holeEnding = false; endHole(); }, 1400);
  }
}
setInterval(tick, TICK_MS);

// ---- WebSocket handling ----
const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  let player = null;
  const remoteAddr = req.socket.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddr);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      if (msg.reconnectToken) {
        const existing = [...Lobby.players.values()].find((p) => p.reconnectToken === msg.reconnectToken);
        if (existing) {
          existing.ws = ws;
          existing.connected = true;
          existing.isLocal = isLocal;
          player = existing;
          ensureHost();
          send(ws, { type: 'welcome', playerId: player.id, hue: player.hue, isHost: player.id === Lobby.hostPlayerId, reconnectToken: player.reconnectToken });
          // A reloaded client comes back with a fresh page stuck on the lobby screen —
          // re-send roundState so it rejoins the hole in progress (with a ball if their
          // session never had one for this hole).
          if (Lobby.state === 'PLAYING') {
            const hole = Shared.HOLES[Lobby.currentHoleIndex];
            if (!player.ball) player.ball = Shared.createBallState(hole.tee);
            send(ws, { type: 'roundState', holeIndex: Lobby.currentHoleIndex, holeName: hole.name, par: hole.par });
          }
          broadcastLobbyState();
          return;
        }
      }
      const id = makeId();
      const hue = PLAYER_HUES[Lobby.players.size % PLAYER_HUES.length];
      player = {
        id, ws, name: (msg.name || 'Player').slice(0, 20), hue, connected: true, isLocal,
        reconnectToken: makeId(),
        strokes: 0, holedOut: false,
        ball: null,
        perHoleScores: [], totalScore: 0,
      };
      Lobby.players.set(id, player);
      ensureHost();
      send(ws, { type: 'welcome', playerId: id, hue, isHost: id === Lobby.hostPlayerId, reconnectToken: player.reconnectToken });
      // Late joiner while a hole is underway: drop them in at the tee so they can play
      // along right away instead of sitting ball-less until the next hole.
      if (Lobby.state === 'PLAYING') {
        const hole = Shared.HOLES[Lobby.currentHoleIndex];
        player.ball = Shared.createBallState(hole.tee);
        send(ws, { type: 'roundState', holeIndex: Lobby.currentHoleIndex, holeName: hole.name, par: hole.par });
      }
      broadcastLobbyState();
    } else if (msg.type === 'setName') {
      if (player && typeof msg.name === 'string') {
        player.name = msg.name.slice(0, 20);
        broadcastLobbyState();
      }
    } else if (msg.type === 'startRound') {
      if (player && player.id === Lobby.hostPlayerId &&
          (Lobby.state === 'WAITING_FOR_PLAYERS' || Lobby.state === 'FINAL_RESULTS')) {
        startNewRound();
      }
    } else if (msg.type === 'putt') {
      if (!player || Lobby.state !== 'PLAYING' || !player.ball || player.holedOut) return;
      const v = msg.dragVector;
      if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') return;
      const dragLen = Math.hypot(v.x, v.y);
      if (dragLen < Shared.MIN_DRAG_DIST) return;
      const clampedLen = Math.min(dragLen, Shared.MAX_DRAG_DIST);
      const clamped = { x: (v.x / dragLen) * clampedLen, y: (v.y / dragLen) * clampedLen };
      const launch = Shared.computeLaunchVelocity(clamped);
      player.ball.firedBoosts.clear();
      player.ball.vx = launch.vx;
      player.ball.vy = launch.vy;
      player.strokes++;
    }
  });

  ws.on('close', () => {
    if (!player) return;
    player.connected = false;
    ensureHost();
    broadcastLobbyState();
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Pocket Putt server running.');
  console.log('  Ask friends on the same Wi-Fi to open this in Safari:');
  console.log(`    ${joinUrl}`);
  console.log(`    (fallback if that .local address doesn't resolve: ${joinUrlFallback})`);
  console.log('');
});
