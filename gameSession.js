// One authoritative multiplayer session (lobby + physics + scoring).
// Used by LAN server.js (single session) and relay.js (one session per room).
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const Shared = require('./shared.js');

const TICK_HZ = Shared.TICK_HZ;
const TICK_MS = Shared.TICK_MS;
const TICK_DT = Shared.TICK_DT;
const HOLE_TIMEOUT_MS = Number(process.env.HOLE_TIMEOUT_MS) || 90000;
const HOLE_TIMEOUT_TICKS = Math.round((HOLE_TIMEOUT_MS / 1000) * TICK_HZ);
const HOLE_RESULTS_DELAY_MS = Number(process.env.HOLE_RESULTS_DELAY_MS) || 6000;
const STROKE_PENALTY_SECONDS = 4;
const PLAYER_HUES = [0, 45, 190, 270, 130, 320, 25, 210];
const MAX_CATCH_UP_TICKS = 8;
const MAX_BUFFERED_BYTES = 32768;
const CORRECTION_IDLE_EVERY = 120;
const MAX_PLAYERS = Number(process.env.RELAY_MAX_PLAYERS) || 8;

function makeId() {
  return crypto.randomUUID();
}

class GameSession {
  /**
   * @param {{ code?: string, joinUrl?: string, joinUrlFallback?: string }} opts
   */
  constructor(opts = {}) {
    this.code = opts.code || null;
    this.joinUrl = opts.joinUrl || (opts.code ? opts.code : '');
    this.joinUrlFallback = opts.joinUrlFallback || this.joinUrl;
    this.state = 'WAITING_FOR_PLAYERS';
    this.players = new Map();
    this.hostPlayerId = null;
    this.currentHoleIndex = 0;
    this.holeStartedAtMs = 0;
    this.simTick = 0;
    this.holeEnding = false;
    this.pendingEvents = [];
    this.wasIdle = false;
    this.lastActivity = Date.now();
    this._holeAdvanceTimer = null;
    this._destroyed = false;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  playerCount() {
    return this.players.size;
  }

  connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  isFull() {
    return this.connectedCount() >= MAX_PLAYERS;
  }

  holeElapsedMs() {
    return Shared.tickToElapsedMs(this.simTick);
  }

  roundStatePayload() {
    const hole = Shared.HOLES[this.currentHoleIndex];
    return {
      type: 'roundState',
      holeIndex: this.currentHoleIndex,
      holeName: hole.name,
      par: hole.par,
      tick: this.simTick,
      tickHz: TICK_HZ,
    };
  }

  publicPlayerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      hue: p.hue,
      connected: p.connected,
      isHost: p.id === this.hostPlayerId,
    }));
  }

  send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
  }

  broadcastReliable(msg) {
    this.broadcast(msg);
  }

  broadcastLobbyState() {
    this.broadcast({
      type: 'lobbyState',
      state: this.state,
      players: this.publicPlayerList(),
      joinUrl: this.joinUrl,
      joinUrlFallback: this.joinUrlFallback,
      roomCode: this.code,
    });
  }

  broadcastCorrection(msg) {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== WebSocket.OPEN) continue;
      if (p.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      p.ws.send(raw);
    }
  }

  ensureHost() {
    const players = [...this.players.values()];
    const current = this.players.get(this.hostPlayerId);
    if (current && current.connected && current.isLocal) return;
    const localConnected = players.find((p) => p.connected && p.isLocal);
    if (localConnected) {
      this.hostPlayerId = localConnected.id;
      return;
    }
    if (current && current.connected) return;
    const next = players.find((p) => p.connected);
    this.hostPlayerId = next ? next.id : null;
  }

  beginHole(holeIndex) {
    this.currentHoleIndex = holeIndex;
    const hole = Shared.HOLES[holeIndex];
    Shared.resetHoleObstacles(hole);
    const roster = [...this.players.values()];
    roster.forEach((p, i) => {
      const slot = (i + holeIndex) % roster.length;
      p.ball = Shared.createBallState(Shared.teePositionFor(slot, roster.length, hole));
      p.strokes = 0;
      p.holedOut = false;
    });
    this.holeStartedAtMs = Date.now();
    this.simTick = 0;
    this.holeEnding = false;
    this.pendingEvents = [];
    this.wasIdle = false;
    this.state = 'PLAYING';
    this.touch();
    this.broadcastReliable(this.roundStatePayload());
    this.sendCorrectionNow([], { reason: 'resync', includeObstacles: true, hard: true });
  }

  startNewRound() {
    for (const p of this.players.values()) {
      p.perHoleScores = [];
      p.totalScore = 0;
    }
    this.beginHole(0);
  }

  finishPlayerHole(p, timedOut) {
    const finishSeconds = this.simTick / TICK_HZ;
    const holeScore = finishSeconds + p.strokes * STROKE_PENALTY_SECONDS;
    p.holedOut = true;
    if (p.ball) {
      p.ball.vx = 0;
      p.ball.vy = 0;
    }
    p.perHoleScores.push({
      holeIndex: this.currentHoleIndex,
      strokes: p.strokes,
      finishSeconds,
      holeScore,
      timedOut,
    });
    p.totalScore += holeScore;
  }

  endHole() {
    if (this._destroyed) return;
    this.state = 'HOLE_RESULTS';
    const connected = [...this.players.values()].filter((p) => p.connected);
    for (const p of connected) {
      const last = p.perHoleScores[p.perHoleScores.length - 1];
      if (!last || last.holeIndex !== this.currentHoleIndex) this.finishPlayerHole(p, true);
    }
    const results = connected.map((p) => {
      const last = p.perHoleScores[p.perHoleScores.length - 1];
      return {
        id: p.id,
        name: p.name,
        strokes: last.strokes,
        finishSeconds: last.finishSeconds,
        holeScore: last.holeScore,
        timedOut: last.timedOut,
      };
    });
    const standings = connected
      .map((p) => ({ id: p.id, name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => a.totalScore - b.totalScore);
    this.broadcastReliable({
      type: 'holeResults',
      holeIndex: this.currentHoleIndex,
      results,
      standings,
    });

    if (this._holeAdvanceTimer) clearTimeout(this._holeAdvanceTimer);
    this._holeAdvanceTimer = setTimeout(() => {
      this._holeAdvanceTimer = null;
      if (this._destroyed) return;
      if (this.currentHoleIndex >= Shared.HOLES.length - 1) {
        this.state = 'FINAL_RESULTS';
        this.broadcastReliable({ type: 'finalResults', standings });
      } else {
        this.beginHole(this.currentHoleIndex + 1);
      }
    }, HOLE_RESULTS_DELAY_MS);
  }

  ballWire(p) {
    return {
      id: p.id,
      name: p.name,
      hue: p.hue,
      isHost: p.id === this.hostPlayerId,
      x: p.ball.x,
      y: p.ball.y,
      vx: p.ball.vx,
      vy: p.ball.vy,
      strokes: p.strokes,
      holedOut: p.holedOut,
    };
  }

  buildCorrection(events, opts) {
    opts = opts || {};
    const reason = opts.reason || 'idle';
    const includeObstacles = !!opts.includeObstacles || reason === 'resync' || reason === 'idle';
    const hard =
      opts.hard !== undefined
        ? !!opts.hard
        : reason === 'resync' || reason === 'event' || reason === 'idle';
    const hole = Shared.HOLES[this.currentHoleIndex];
    const msg = {
      type: 'snapshot',
      holeIndex: this.currentHoleIndex,
      tick: this.simTick,
      tickHz: TICK_HZ,
      elapsedMs: this.holeElapsedMs(),
      reason,
      hard,
      events: events || [],
      balls: [...this.players.values()].filter((p) => p.connected && p.ball).map((p) => this.ballWire(p)),
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

  sendCorrectionNow(events, opts) {
    this.broadcastCorrection(this.buildCorrection(events || [], opts));
    this.pendingEvents = [];
  }

  stepSimulation() {
    if (this.state !== 'PLAYING' || this._destroyed) return;
    this.simTick += 1;
    this.touch();

    const hole = Shared.HOLES[this.currentHoleIndex];
    Shared.setHoleObstaclesAtTick(hole, this.simTick);

    const tickEvents = this.pendingEvents;
    for (const p of this.players.values()) {
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
        this.finishPlayerHole(p, false);
        tickEvents.push({ id: p.id, kind: 'holed', strokes: p.strokes });
      }
    }

    const active = [...this.players.values()]
      .filter((p) => p.connected && p.ball && !p.holedOut)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const pa = active[i];
        const pb = active[j];
        const a = pa.ball;
        const b = pb.ball;
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

    const connected = [...this.players.values()].filter((p) => p.connected);
    const anyMoving = active.some((p) => Math.hypot(p.ball.vx, p.ball.vy) >= Shared.STOP_THRESHOLD);
    const idle = !anyMoving && tickEvents.length === 0;
    const becameIdle = idle && !this.wasIdle;
    this.wasIdle = idle;
    if (tickEvents.length > 0) {
      this.sendCorrectionNow(tickEvents, { reason: 'event', hard: true });
    } else if (becameIdle) {
      this.sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: true });
    } else if (idle && this.simTick % CORRECTION_IDLE_EVERY === 0) {
      this.sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: true });
    }

    const allHoledOut = connected.length > 0 && connected.every((p) => p.holedOut);
    const timedOut = this.simTick >= HOLE_TIMEOUT_TICKS;
    if ((allHoledOut || timedOut) && !this.holeEnding) {
      this.holeEnding = true;
      if (timedOut) {
        for (const p of connected) {
          if (!p.holedOut) this.finishPlayerHole(p, true);
        }
      }
      this.sendCorrectionNow(this.pendingEvents, { reason: 'resync', includeObstacles: true, hard: true });
      setTimeout(() => {
        if (this._destroyed) return;
        this.holeEnding = false;
        this.endHole();
      }, 1400);
    }
  }

  tickDriver() {
    if (this.state !== 'PLAYING' || this._destroyed) return;
    const wallTarget = Math.floor((Date.now() - this.holeStartedAtMs) / TICK_MS);
    let steps = 0;
    while (this.simTick < wallTarget && steps < MAX_CATCH_UP_TICKS) {
      this.stepSimulation();
      steps++;
      if (this.state !== 'PLAYING') break;
    }
  }

  /**
   * Send welcome (+ in-progress hole resync) to one player.
   */
  sendWelcome(player) {
    if (!player) return;
    this.send(player.ws, {
      type: 'welcome',
      playerId: player.id,
      hue: player.hue,
      isHost: player.id === this.hostPlayerId,
      reconnectToken: player.reconnectToken,
      roomCode: this.code,
    });
    if (this.state === 'PLAYING') {
      const hole = Shared.HOLES[this.currentHoleIndex];
      if (!player.ball) {
        player.ball = Shared.createBallState(
          Shared.teePositionFor(this.players.size - 1, this.players.size, hole)
        );
      }
      this.send(player.ws, this.roundStatePayload());
      this.send(player.ws, this.buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true }));
    }
  }

  /**
   * Add or reconnect a player. Returns { player, error? }.
   * @param {{ quiet?: boolean }} opts  quiet=true: skip welcome/lobby (caller sends relay_created first)
   */
  addPlayer(ws, { name, reconnectToken, isLocal }, opts = {}) {
    const quiet = !!opts.quiet;
    this.touch();
    if (reconnectToken) {
      const existing = [...this.players.values()].find((p) => p.reconnectToken === reconnectToken);
      if (existing) {
        existing.ws = ws;
        existing.connected = true;
        existing.isLocal = !!isLocal;
        if (name) existing.name = String(name).slice(0, 20);
        this.ensureHost();
        if (!quiet) {
          this.sendWelcome(existing);
          this.broadcastLobbyState();
        }
        return { player: existing, reconnected: true };
      }
    }

    if (this.isFull()) {
      return { player: null, error: 'room_full' };
    }

    const id = makeId();
    const hue = PLAYER_HUES[this.players.size % PLAYER_HUES.length];
    const player = {
      id,
      ws,
      name: (name || 'Player').slice(0, 20),
      hue,
      connected: true,
      isLocal: !!isLocal,
      reconnectToken: makeId(),
      strokes: 0,
      holedOut: false,
      ball: null,
      perHoleScores: [],
      totalScore: 0,
    };
    this.players.set(id, player);
    this.ensureHost();
    if (!quiet) {
      this.sendWelcome(player);
      this.broadcastLobbyState();
    }
    return { player, reconnected: false };
  }

  handleMessage(player, msg) {
    if (!player || this._destroyed) return;
    this.touch();

    if (msg.type === 'setName') {
      if (typeof msg.name === 'string') {
        player.name = msg.name.slice(0, 20);
        this.broadcastLobbyState();
      }
    } else if (msg.type === 'startRound') {
      if (
        player.id === this.hostPlayerId &&
        (this.state === 'WAITING_FOR_PLAYERS' || this.state === 'FINAL_RESULTS')
      ) {
        this.startNewRound();
      }
    } else if (msg.type === 'putt') {
      if (this.state !== 'PLAYING' || !player.ball || player.holedOut) return;
      if (Math.hypot(player.ball.vx, player.ball.vy) >= Shared.STOP_THRESHOLD) return;
      const v = msg.dragVector;
      if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') return;
      const clamped = Shared.clampDragVector(v);
      if (!clamped) return;
      const launch = Shared.computeLaunchVelocity(clamped);
      player.ball.firedBoosts.clear();
      player.ball.vx = launch.vx;
      player.ball.vy = launch.vy;
      player.strokes++;
      this.broadcastReliable({
        type: 'puttApplied',
        playerId: player.id,
        tick: this.simTick,
        dragVector: { x: clamped.x, y: clamped.y },
        strokes: player.strokes,
        x: player.ball.x,
        y: player.ball.y,
        vx: player.ball.vx,
        vy: player.ball.vy,
      });
    }
  }

  onDisconnect(player) {
    if (!player || this._destroyed) return;
    player.connected = false;
    this.ensureHost();
    this.broadcastLobbyState();
    this.touch();
  }

  destroy() {
    this._destroyed = true;
    if (this._holeAdvanceTimer) {
      clearTimeout(this._holeAdvanceTimer);
      this._holeAdvanceTimer = null;
    }
    for (const p of this.players.values()) {
      try {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.players.clear();
  }
}

module.exports = {
  GameSession,
  TICK_MS,
  MAX_PLAYERS,
};
