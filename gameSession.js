// One authoritative multiplayer session (lobby + physics + scoring).
// Protocol matches main (snapshots, cosmetics, restart/end). Used by multi-room relay.js.
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const Shared = require('./shared.js');

const TICK_MS = Shared.TICK_MS || 1000 / 60;
const HOLE_TIMEOUT_MS = Number(process.env.HOLE_TIMEOUT_MS) || 90000;
const HOLE_RESULTS_DELAY_MS = Number(process.env.HOLE_RESULTS_DELAY_MS) || 6000;
const STROKE_PENALTY_SECONDS = 4;
const PLAYER_HUES = [0, 45, 190, 270, 130, 320, 25, 210];
const MAX_BUFFERED_BYTES = 32768;
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
    this.joinUrl = opts.joinUrl || opts.code || '';
    this.joinUrlFallback = opts.joinUrlFallback || this.joinUrl;
    this.state = 'WAITING_FOR_PLAYERS';
    this.players = new Map();
    this.hostPlayerId = null;
    this.currentHoleIndex = 0;
    this.holeStartedAtMs = 0;
    this.holeEnding = false;
    this.pendingEvents = [];
    this.tickCounter = 0;
    this.wasIdle = false;
    this.lastActivity = Date.now();
    this._holeAdvanceTimer = null;
    this._destroyed = false;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  isFull() {
    return this.connectedCount() >= MAX_PLAYERS;
  }

  publicPlayerList() {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      hue: p.hue,
      special: p.special || null,
      trail: p.trail || null,
      styled: !!p.styled,
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

  broadcastSnapshot(msg) {
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
    this.holeEnding = false;
    this.pendingEvents = [];
    this.tickCounter = 0;
    this.wasIdle = false;
    this.state = 'PLAYING';
    this.touch();
    this.broadcast({
      type: 'roundState',
      holeIndex,
      holeName: hole.name,
      par: hole.par,
    });
  }

  startNewRound() {
    for (const p of this.players.values()) {
      p.perHoleScores = [];
      p.totalScore = 0;
    }
    this.beginHole(0);
  }

  finishPlayerHole(p, timedOut) {
    const finishSeconds = (Date.now() - this.holeStartedAtMs) / 1000;
    const holeScore = finishSeconds + p.strokes * STROKE_PENALTY_SECONDS;
    p.holedOut = true;
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
    this.broadcast({ type: 'holeResults', holeIndex: this.currentHoleIndex, results, standings });

    if (this._holeAdvanceTimer) clearTimeout(this._holeAdvanceTimer);
    this._holeAdvanceTimer = setTimeout(() => {
      this._holeAdvanceTimer = null;
      if (this._destroyed) return;
      // A restart/end-game may have changed the state while we showed results.
      if (this.state !== 'HOLE_RESULTS') return;
      if (this.currentHoleIndex >= Shared.HOLES.length - 1) {
        this.state = 'FINAL_RESULTS';
        this.broadcast({ type: 'finalResults', standings });
      } else {
        this.beginHole(this.currentHoleIndex + 1);
      }
    }, HOLE_RESULTS_DELAY_MS);
  }

  /** Authoritative physics tick (main protocol: snapshots + subticks). */
  tick() {
    if (this.state !== 'PLAYING' || this._destroyed) return;
    this.touch();
    const hole = Shared.HOLES[this.currentHoleIndex];
    const dt = TICK_MS / 1000;
    Shared.advanceHoleObstacles(hole, dt);

    const tickEvents = this.pendingEvents;
    const SUBTICKS = 4;
    const bouncedThisTick = new Set();
    const sandedThisTick = new Set();
    const clashedPairs = new Set();
    for (let s = 0; s < SUBTICKS; s++) {
      for (const p of this.players.values()) {
        if (!p.connected || p.holedOut || !p.ball) continue;
        const events = Shared.stepBallPhysics(p.ball, hole, dt / SUBTICKS);
        if (events.bounced && !bouncedThisTick.has(p.id)) {
          bouncedThisTick.add(p.id);
          tickEvents.push({ id: p.id, kind: 'bounce' });
        }
        if (events.enteredSand && !sandedThisTick.has(p.id)) {
          sandedThisTick.add(p.id);
          tickEvents.push({ id: p.id, kind: 'sand' });
        }
        for (const z of events.boosts) {
          tickEvents.push({
            id: p.id,
            kind: 'boost',
            x: p.ball.x,
            y: p.ball.y,
            angle: p.ball.angleDir,
          });
        }
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

      const activeNow = [...this.players.values()].filter(
        (p) => p.connected && p.ball && !p.holedOut
      );
      for (let i = 0; i < activeNow.length; i++) {
        for (let j = i + 1; j < activeNow.length; j++) {
          const a = activeNow[i].ball;
          const b = activeNow[j].ball;
          if (Shared.resolveBallBallCollision(a, b)) {
            const key = activeNow[i].id + '|' + activeNow[j].id;
            if (!clashedPairs.has(key)) {
              clashedPairs.add(key);
              tickEvents.push({
                kind: 'clash',
                a: activeNow[i].id,
                b: activeNow[j].id,
                x: (a.x + b.x) / 2,
                y: (a.y + b.y) / 2,
              });
            }
          }
        }
      }
    }

    const active = [...this.players.values()].filter((p) => p.connected && p.ball && !p.holedOut);
    const connected = [...this.players.values()].filter((p) => p.connected);
    const elapsed = Date.now() - this.holeStartedAtMs;

    this.tickCounter++;
    const anyMoving = active.some((p) => Math.hypot(p.ball.vx, p.ball.vy) >= Shared.STOP_THRESHOLD);
    const idle = !anyMoving && tickEvents.length === 0;
    const becameIdle = idle && !this.wasIdle;
    this.wasIdle = idle;
    const lastPlayer = connected.length > 0 && connected.every((p) => p.holedOut);
    const shouldSend =
      tickEvents.length > 0 ||
      lastPlayer ||
      becameIdle ||
      (idle ? this.tickCounter % 12 === 0 : this.tickCounter % 2 === 0);
    if (shouldSend) {
      const r1 = (v) => Math.round(v * 10) / 10;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      this.broadcastSnapshot({
        type: 'snapshot',
        holeIndex: this.currentHoleIndex,
        elapsedMs: elapsed,
        events: tickEvents,
        obstacles: {
          windmillAngles: hole.windmills.map((wm) => r3(wm.angle)),
          pendulumPhases: hole.pendulums.map((p) => r3(p.phase)),
          gatePhases: hole.gates.map((g) => r3(g.phase)),
        },
        balls: [...this.players.values()]
          .filter((p) => p.connected && p.ball)
          .map((p) => ({
            id: p.id,
            name: p.name,
            hue: p.hue,
            isHost: p.id === this.hostPlayerId,
            special: p.special || null,
            trail: p.trail || null,
            styled: !!p.styled,
            x: r1(p.ball.x),
            y: r1(p.ball.y),
            vx: r1(p.ball.vx),
            vy: r1(p.ball.vy),
            strokes: p.strokes,
            holedOut: p.holedOut,
          })),
      });
      this.pendingEvents = [];
    }

    const allHoledOut = connected.length > 0 && connected.every((p) => p.holedOut);
    const timedOut = elapsed > HOLE_TIMEOUT_MS;
    if ((allHoledOut || timedOut) && !this.holeEnding) {
      this.holeEnding = true;
      if (timedOut) {
        for (const p of connected) {
          if (!p.holedOut) this.finishPlayerHole(p, true);
        }
      }
      setTimeout(() => {
        if (this._destroyed) return;
        this.holeEnding = false;
        this.endHole();
      }, 1400);
    }
  }

  // Alias used by relay interval.
  tickDriver() {
    this.tick();
  }

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
      this.send(player.ws, {
        type: 'roundState',
        holeIndex: this.currentHoleIndex,
        holeName: hole.name,
        par: hole.par,
      });
    }
  }

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

    if (this.isFull()) return { player: null, error: 'room_full' };

    const id = makeId();
    const hue = PLAYER_HUES[this.players.size % PLAYER_HUES.length];
    const player = {
      id,
      ws,
      name: (name || 'Player').slice(0, 20),
      hue,
      special: null,
      trail: null,
      styled: false,
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
    } else if (msg.type === 'setStyle') {
      if (typeof msg.hue === 'number' && msg.hue >= 0 && msg.hue < 360) {
        player.hue = Math.round(msg.hue);
        player.styled = true;
      }
      player.special = ['sunburst', 'galaxy'].includes(msg.special) ? msg.special : null;
      if (player.special) player.styled = true;
      player.trail = ['comet', 'fire', 'water', 'rainbow'].includes(msg.trail) ? msg.trail : null;
      this.broadcastLobbyState();
    } else if (msg.type === 'startRound') {
      if (
        player.id === this.hostPlayerId &&
        (this.state === 'WAITING_FOR_PLAYERS' || this.state === 'FINAL_RESULTS')
      ) {
        this.startNewRound();
      }
    } else if (msg.type === 'restartGame') {
      if (this.state !== 'WAITING_FOR_PLAYERS') {
        this.broadcast({ type: 'notice', text: `${player.name} restarted the game` });
        this.startNewRound();
      }
    } else if (msg.type === 'endGame') {
      if (this.state !== 'WAITING_FOR_PLAYERS') {
        this.state = 'WAITING_FOR_PLAYERS';
        this.holeEnding = false;
        if (this._holeAdvanceTimer) {
          clearTimeout(this._holeAdvanceTimer);
          this._holeAdvanceTimer = null;
        }
        for (const p of this.players.values()) p.ball = null;
        this.broadcast({ type: 'notice', text: `${player.name} ended the game` });
        this.broadcastLobbyState();
      }
    } else if (msg.type === 'putt') {
      if (this.state !== 'PLAYING' || !player.ball || player.holedOut) return;
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
