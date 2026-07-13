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

const PORT = process.env.PORT || 8977;
const ROOT = __dirname;
const TICK_HZ = Shared.TICK_HZ;
const TICK_MS = Shared.TICK_MS;
const TICK_DT = Shared.TICK_DT;
// Overridable via env for fast automated testing of the 19-hole progression.
// Timeout is measured in sim ticks (not wall clock) so scoring stays tied to physics time.
const HOLE_TIMEOUT_MS = Number(process.env.HOLE_TIMEOUT_MS) || 90000;
const HOLE_TIMEOUT_TICKS = Math.round((HOLE_TIMEOUT_MS / 1000) * TICK_HZ);
const HOLE_RESULTS_DELAY_MS = Number(process.env.HOLE_RESULTS_DELAY_MS) || 6000;
const STROKE_PENALTY_SECONDS = 4;
const PLAYER_HUES = [0, 45, 190, 270, 130, 320, 25, 210];
// Cap catch-up steps per timer fire so a long stall doesn't freeze the event loop.
const MAX_CATCH_UP_TICKS = 8;

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

// Render (and other hosts) probe GET /health. Must be plain HTTP, not WebSocket.
function handleRequest(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
    return;
  }
  serveStatic(req, res);
}

const httpServer = http.createServer(handleRequest);

// ---- Join URL ----
// On Render, RENDER_EXTERNAL_URL is injected (https://….onrender.com).
// PUBLIC_URL overrides that for a custom domain (set in the dashboard).
// Locally, fall back to Bonjour/.local hostname + LAN IP.
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const publicBase = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const hostname = os.hostname();
const lanIp = getLanIp();
const joinUrl = publicBase || `http://${hostname}:${PORT}`;
const joinUrlFallback = publicBase || `http://${lanIp}:${PORT}`;

// ---- Lobby / session state ----
const Lobby = {
  state: 'WAITING_FOR_PLAYERS', // WAITING_FOR_PLAYERS | PLAYING | HOLE_RESULTS | FINAL_RESULTS
  players: new Map(), // id -> PlayerSession
  hostPlayerId: null,
  currentHoleIndex: 0,
  // Wall time when the hole began — only used to schedule catch-up ticks toward realtime.
  // Authoritative hole time is simTick (integer), advanced once per fixed physics step.
  holeStartedAtMs: 0,
  simTick: 0,
  holeEnding: false,
  pendingEvents: [], // gameplay events accumulated between snapshot broadcasts
  wasIdle: false,
};

function holeElapsedMs() {
  return Shared.tickToElapsedMs(Lobby.simTick);
}

function roundStatePayload() {
  const hole = Shared.HOLES[Lobby.currentHoleIndex];
  return {
    type: 'roundState',
    holeIndex: Lobby.currentHoleIndex,
    holeName: hole.name,
    par: hole.par,
    tick: Lobby.simTick,
    tickHz: TICK_HZ,
  };
}

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
  // Line players up across the tee, perpendicular to the play line, with real spacing.
  // The line order rotates by one slot every hole so nobody keeps the center-line
  // advantage (the middle spot aims straight down the play line) for the whole round.
  const roster = [...Lobby.players.values()];
  roster.forEach((p, i) => {
    const slot = (i + holeIndex) % roster.length;
    p.ball = Shared.createBallState(Shared.teePositionFor(slot, roster.length, hole));
    p.strokes = 0;
    p.holedOut = false;
  });
  Lobby.holeStartedAtMs = Date.now();
  Lobby.simTick = 0;
  Lobby.holeEnding = false;
  Lobby.pendingEvents = [];
  Lobby.wasIdle = false;
  Lobby.state = 'PLAYING';
  broadcastReliable(roundStatePayload());
  // Seed every client with tee poses + obstacles (full resync).
  sendCorrectionNow([], { reason: 'resync', includeObstacles: true, hard: true });
}

function startNewRound() {
  for (const p of Lobby.players.values()) {
    p.perHoleScores = [];
    p.totalScore = 0;
  }
  beginHole(0);
}

function finishPlayerHole(p, timedOut) {
  // Score off sim time so a slow host timer can't invent a different clock than physics.
  const finishSeconds = Lobby.simTick / TICK_HZ;
  const holeScore = finishSeconds + p.strokes * STROKE_PENALTY_SECONDS;
  p.holedOut = true;
  if (p.ball) { p.ball.vx = 0; p.ball.vy = 0; }
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
  broadcastReliable({ type: 'holeResults', holeIndex: Lobby.currentHoleIndex, results, standings });

  setTimeout(() => {
    if (Lobby.currentHoleIndex >= Shared.HOLES.length - 1) {
      Lobby.state = 'FINAL_RESULTS';
      broadcastReliable({ type: 'finalResults', standings });
    } else {
      beginHole(Lobby.currentHoleIndex + 1);
    }
  }, HOLE_RESULTS_DELAY_MS);
}

// Corrections are disposable (the next one supersedes) — skip clients whose socket buffer
// is backed up instead of queueing forever behind a slow tab.
const MAX_BUFFERED_BYTES = 32768;
// NO mid-flight pose heartbeats. Clients coast from puttApplied with shared.js; we only
// correct on events (water/holed/clash), became-idle, idle keepalives, and resync.
const CORRECTION_IDLE_EVERY = 120; // 2s while everyone is aiming (join/timer safety)

function broadcastReliable(msg) {
  const raw = JSON.stringify(msg);
  for (const p of Lobby.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
  }
}

function broadcastCorrection(msg) {
  const raw = JSON.stringify(msg);
  for (const p of Lobby.players.values()) {
    if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
    if (p.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
    p.ws.send(raw);
  }
}

// Full IEEE doubles on the wire for poses — matching host+client coasts needs precision,
// not 0.1 rounding (that alone forked trajectories from the first putt tick).
function ballWire(p) {
  return {
    id: p.id, name: p.name, hue: p.hue, isHost: p.id === Lobby.hostPlayerId,
    x: p.ball.x, y: p.ball.y, vx: p.ball.vx, vy: p.ball.vy,
    strokes: p.strokes, holedOut: p.holedOut,
  };
}

// opts.reason: 'event' | 'resync' | 'idle'
// Obstacles only on resync/idle — never mid-roll (paths stay tick-derived on both sides).
function buildCorrection(events, opts) {
  opts = opts || {};
  const reason = opts.reason || 'idle';
  const includeObstacles = !!opts.includeObstacles || reason === 'resync' || reason === 'idle';
  const hard = opts.hard !== undefined ? !!opts.hard : (reason === 'resync' || reason === 'event' || reason === 'idle');
  const hole = Shared.HOLES[Lobby.currentHoleIndex];
  const msg = {
    type: 'snapshot',
    holeIndex: Lobby.currentHoleIndex,
    tick: Lobby.simTick,
    tickHz: TICK_HZ,
    elapsedMs: holeElapsedMs(),
    reason,
    hard,
    events: events || [],
    balls: [...Lobby.players.values()]
      .filter((p) => p.connected && p.ball)
      .map(ballWire),
  };
  if (includeObstacles) {
    msg.obstacles = {
      windmillAngles: hole.windmills.map((wm) => wm.angle),
      pendulumPhases: hole.pendulums.map((p) => p.phase),
      gatePhases: hole.gates.map((g) => g.phase),
    };
  }
  return msg;
}

function sendCorrectionNow(events, opts) {
  broadcastCorrection(buildCorrection(events || [], opts));
  Lobby.pendingEvents = [];
}

// ---- Authoritative fixed-timestep sim ----
// One call = exactly one sim tick. Time-of-record is Lobby.simTick; wall clock only
// drives how many ticks we attempt to catch up when the timer fires late.
function stepSimulation() {
  if (Lobby.state !== 'PLAYING') return;
  Lobby.simTick += 1;

  const hole = Shared.HOLES[Lobby.currentHoleIndex];
  // Absolute obstacle pose from tick — same formula clients use, no integration drift.
  Shared.setHoleObstaclesAtTick(hole, Lobby.simTick);

  // Host still simulates authoritatively (scoring, timeout, anti-cheat, ball-ball).
  // Clients coast alone from puttApplied; multi-ball is host-only with clash pose payloads.
  const tickEvents = Lobby.pendingEvents;
  for (const p of Lobby.players.values()) {
    if (!p.connected || p.holedOut || !p.ball) continue;
    const events = Shared.stepBallPhysics(p.ball, hole, TICK_DT);
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

  // Ball-vs-ball: host-only. Clients apply clash payloads instead of resolving locally.
  const active = [...Lobby.players.values()]
    .filter((p) => p.connected && p.ball && !p.holedOut)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const pa = active[i], pb = active[j];
      const a = pa.ball, b = pb.ball;
      if (Shared.resolveBallBallCollision(a, b)) {
        tickEvents.push({
          kind: 'clash',
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          balls: [
            { id: pa.id, x: a.x, y: a.y, vx: a.vx, vy: a.vy },
            { id: pb.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy },
          ],
        });
      }
    }
  }

  const connected = [...Lobby.players.values()].filter((p) => p.connected);

  // Pure coast while rolling: NO pose heartbeats mid-flight (that was the rubber-band source).
  // Correct only on discrete events, when everyone stops, idle keepalives, and hole end.
  const anyMoving = active.some((p) => Math.hypot(p.ball.vx, p.ball.vy) >= Shared.STOP_THRESHOLD);
  const idle = !anyMoving && tickEvents.length === 0;
  const becameIdle = idle && !Lobby.wasIdle;
  Lobby.wasIdle = idle;
  if (tickEvents.length > 0) {
    sendCorrectionNow(tickEvents, { reason: 'event', hard: true });
  } else if (becameIdle) {
    sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: true });
  } else if (idle && Lobby.simTick % CORRECTION_IDLE_EVERY === 0) {
    sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: true });
  }

  const allHoledOut = connected.length > 0 && connected.every((p) => p.holedOut);
  const timedOut = Lobby.simTick >= HOLE_TIMEOUT_TICKS;
  if ((allHoledOut || timedOut) && !Lobby.holeEnding) {
    Lobby.holeEnding = true;
    if (timedOut) {
      for (const p of connected) { if (!p.holedOut) finishPlayerHole(p, true); }
    }
    sendCorrectionNow(Lobby.pendingEvents, { reason: 'resync', includeObstacles: true, hard: true });
    setTimeout(() => { Lobby.holeEnding = false; endHole(); }, 1400);
  }
}

// Drive sim toward wall-clock realtime with fixed steps. Never run ahead of wall time; if
// the process stalls, catch up several ticks next fire (capped) so physics rate stays ~1:1
// with real time instead of permanently running slow after a hitch.
function tickDriver() {
  if (Lobby.state !== 'PLAYING') return;
  const wallTarget = Math.floor((Date.now() - Lobby.holeStartedAtMs) / TICK_MS);
  let steps = 0;
  while (Lobby.simTick < wallTarget && steps < MAX_CATCH_UP_TICKS) {
    stepSimulation();
    steps++;
    if (Lobby.state !== 'PLAYING') break;
  }
}
setInterval(tickDriver, TICK_MS);

// ---- WebSocket handling ----
const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  let player = null;
  // Send our small 30Hz packets immediately instead of letting Nagle batch them.
  req.socket.setNoDelay(true);
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
            if (!player.ball) player.ball = Shared.createBallState(Shared.teePositionFor(Lobby.players.size - 1, Lobby.players.size, hole));
            send(ws, roundStatePayload());
            send(ws, buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true }));
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
        player.ball = Shared.createBallState(Shared.teePositionFor(Lobby.players.size - 1, Lobby.players.size, hole));
        send(ws, roundStatePayload());
        // Full resync so the late joiner (and everyone else) gets the new roster pose.
        sendCorrectionNow([], { reason: 'resync', includeObstacles: true, hard: true });
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
      // Must be at rest on the host — rejects spam / mid-roll putts.
      if (Math.hypot(player.ball.vx, player.ball.vy) >= Shared.STOP_THRESHOLD) return;
      const v = msg.dragVector;
      if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') return;
      const dragLen = Math.hypot(v.x, v.y);
      if (dragLen < Shared.MIN_DRAG_DIST) return;
      const clampedLen = Math.min(dragLen, Shared.MAX_DRAG_DIST);
      const clamped = { x: (v.x / dragLen) * clampedLen, y: (v.y / dragLen) * clampedLen };
      const launch = Shared.computeLaunchVelocity(clamped);
      player.ball.firedBoosts.clear();
      // Full-precision launch on host; same numbers go on the wire so guests coast identically.
      player.ball.vx = launch.vx;
      player.ball.vy = launch.vy;
      player.strokes++;
      // One reliable event — no pose stream while the ball is rolling.
      broadcastReliable({
        type: 'puttApplied',
        playerId: player.id,
        tick: Lobby.simTick,
        dragVector: { x: clamped.x, y: clamped.y },
        strokes: player.strokes,
        x: player.ball.x,
        y: player.ball.y,
        vx: player.ball.vx,
        vy: player.ball.vy,
      });
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
  if (publicBase) {
    console.log(`  Public URL: ${publicBase}`);
    console.log(`  WebSocket:  ${publicBase.replace(/^http/, 'ws')}/ws`);
    console.log(`  Health:     ${publicBase}/health`);
  } else {
    console.log('  Ask friends on the same Wi-Fi to open this in Safari:');
    console.log(`    ${joinUrl}`);
    console.log(`    (fallback if that .local address doesn't resolve: ${joinUrlFallback})`);
  }
  console.log('');
});
