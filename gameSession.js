// One authoritative multiplayer session (lobby + physics + scoring).
// Coast netcode: puttApplied + sparse corrections (no mid-flight pose stream).
// Multi-room via relay.js; cosmetics / restart / end from main.
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const Shared = require('./shared.js');

const TICK_HZ = Shared.TICK_HZ;
const TICK_MS = Shared.TICK_MS;
const TICK_DT = Shared.TICK_DT;
const COURSES = Shared.COURSES;
const HOLE_TIMEOUT_MS = Number(process.env.HOLE_TIMEOUT_MS) || 90000;
const HOLE_TIMEOUT_TICKS = Math.round((HOLE_TIMEOUT_MS / 1000) * TICK_HZ);
const HOLE_RESULTS_DELAY_MS = Number(process.env.HOLE_RESULTS_DELAY_MS) || 6000;
const STROKE_PENALTY_SECONDS = 4;
const PLAYER_HUES = [0, 45, 190, 270, 130, 320, 25, 210];
const MAX_CATCH_UP_TICKS = 8;
const MAX_BUFFERED_BYTES = 32768;
const CORRECTION_IDLE_EVERY = 120; // 2s idle keepalives while aiming
// Must match client mpStepOneTick: N calls of stepBallPhysics(TICK_DT/N) per sim tick.
// (Inner shared.js also uses 4 microsteps — host and client must use the same N.)
const PHYSICS_SUBTICKS = 4;
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
    this.courseIndex = 0;
    this.currentHoleIndex = 0;
    this.holeStartedAtMs = 0;
    this.simTick = 0;
    this.holeEnding = false;
    this.holeEndingAtMs = 0;
    this.holeResultsAtMs = 0;
    this.pendingEvents = [];
    this.wasIdle = false;
    this.lastActivity = Date.now();
    this._holeAdvanceTimer = null; // legacy; progression is wall-clock in tickDriver
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

  currentHoles() {
    return COURSES[this.courseIndex].holes;
  }

  roundStatePayload() {
    const hole = this.currentHoles()[this.currentHoleIndex];
    return {
      type: 'roundState',
      courseIndex: this.courseIndex,
      holeIndex: this.currentHoleIndex,
      holeName: hole.name,
      par: hole.par,
      tick: this.simTick,
      tickHz: TICK_HZ,
      // Reliable tee seed — clients must not depend solely on an unreliable resync
      // snapshot to populate Game.players (dropped resync → empty roster / vanished ball).
      balls: [...this.players.values()]
        .filter((p) => p.connected && p.ball)
        .map((p) => this.ballWire(p)),
    };
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

  broadcastReliable(msg) {
    this.broadcast(msg);
  }

  broadcastLobbyState() {
    this.broadcast({
      type: 'lobbyState',
      state: this.state,
      players: this.publicPlayerList(),
      courseIndex: this.courseIndex,
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
    const hole = this.currentHoles()[holeIndex];
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
    this.holeEndingAtMs = 0;
    this.holeResultsAtMs = 0;
    this.pendingEvents = [];
    this.wasIdle = false;
    this.state = 'PLAYING';
    this.touch();
    // Reliable roundState now carries tee balls; also push a hard resync for obstacles.
    this.broadcastReliable(this.roundStatePayload());
    this.broadcastReliable(
      this.buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true })
    );
    this.pendingEvents = [];
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
    this.holeEnding = false;
    this.holeEndingAtMs = 0;
    this.holeResultsAtMs = Date.now();
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
    this._standingsSnapshot = connected
      .map((p) => ({ id: p.id, name: p.name, totalScore: p.totalScore }))
      .sort((a, b) => a.totalScore - b.totalScore);
    this.broadcastReliable({
      type: 'holeResults',
      holeIndex: this.currentHoleIndex,
      results,
      standings: this._standingsSnapshot,
    });
    // Next-hole / final advancement is driven by tickDriver wall clock (not setTimeout),
    // so free-tier freezes or a blocked event loop can't drop the transition forever.
  }

  /** Advance HOLE_RESULTS → next hole or FINAL_RESULTS once the results delay has elapsed. */
  maybeAdvanceFromResults() {
    if (this.state !== 'HOLE_RESULTS' || this._destroyed) return;
    if (!this.holeResultsAtMs) return;
    if (Date.now() - this.holeResultsAtMs < HOLE_RESULTS_DELAY_MS) return;
    this.holeResultsAtMs = 0;
    if (this.currentHoleIndex >= this.currentHoles().length - 1) {
      this.state = 'FINAL_RESULTS';
      this.broadcastReliable({
        type: 'finalResults',
        standings: this._standingsSnapshot || [],
      });
    } else {
      this.beginHole(this.currentHoleIndex + 1);
    }
  }

  ballWire(p) {
    const wire = {
      id: p.id,
      name: p.name,
      hue: p.hue,
      isHost: p.id === this.hostPlayerId,
      special: p.special || null,
      trail: p.trail || null,
      styled: !!p.styled,
      x: p.ball.x,
      y: p.ball.y,
      vx: p.ball.vx,
      vy: p.ball.vy,
      strokes: p.strokes,
      holedOut: p.holedOut,
      // Index latch (not object ref) so clients keep escape-grass vs trap-sticky correct.
      stuckStickyIndex: typeof p.ball.stuckStickyIndex === 'number' ? p.ball.stuckStickyIndex : -1,
    };
    // Only send wet flags when armed (keeps idle packets small).
    if (p.ball.wet) {
      wire.wet = true;
      if (p.ball.wetStroke) wire.wetStroke = true;
    }
    // Omit grounded z/vz to keep idle packets small.
    if (p.ball.z > 0) {
      wire.z = p.ball.z;
      wire.vz = p.ball.vz;
    }
    return wire;
  }

  /**
   * hard policy (rubber-band reduction):
   *  - resync / becameIdle: hard (clean settled authority)
   *  - event water/holed/clash: hard (discrete authority)
   *  - event bounce/sand/boost: soft (juice + gentle pose)
   *  - periodic idle keepalive: soft (don't yank mid-aim drift)
   */
  eventsNeedHardSnap(events) {
    for (const ev of events || []) {
      if (ev.kind === 'water' || ev.kind === 'blackHole' || ev.kind === 'holed' || ev.kind === 'clash') {
        return true;
      }
    }
    return false;
  }

  buildCorrection(events, opts) {
    opts = opts || {};
    const reason = opts.reason || 'idle';
    const includeObstacles = !!opts.includeObstacles || reason === 'resync' || reason === 'idle';
    let hard;
    if (opts.hard !== undefined) {
      hard = !!opts.hard;
    } else if (reason === 'resync') {
      hard = true;
    } else if (reason === 'event') {
      hard = this.eventsNeedHardSnap(events);
    } else if (reason === 'idle') {
      // becameIdle should pass hard:true explicitly; periodic keepalives stay soft
      hard = false;
    } else {
      hard = false;
    }
    const hole = this.currentHoles()[this.currentHoleIndex];
    const msg = {
      type: 'snapshot',
      courseIndex: this.courseIndex,
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

    const hole = this.currentHoles()[this.currentHoleIndex];
    // Absolute obstacle pose from tick — same formula clients use.
    Shared.setHoleObstaclesAtTick(hole, this.simTick);

    const tickEvents = this.pendingEvents;
    const bouncedThisTick = new Set();
    const sandedThisTick = new Set();
    const clashedPairs = new Set();

    // Physics subticks must match client mpStepOneTick (same dt schedule → sticky latch agrees).
    // Ball-ball interleaved each subtick so fast rams still connect.
    for (let s = 0; s < PHYSICS_SUBTICKS; s++) {
      for (const p of this.players.values()) {
        if (!p.connected || p.holedOut || !p.ball) continue;
        const events = Shared.stepBallPhysics(p.ball, hole, TICK_DT / PHYSICS_SUBTICKS);
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
          p.ball.z = 0;
          p.ball.vz = 0;
          p.ball.stuckStickyIndex = -1;
          Shared.markWetFromWater(p.ball);
        }
        if (events.blackHole) {
          p.strokes++;
          const hole = this.currentHoles()[this.currentHoleIndex];
          tickEvents.push({ id: p.id, kind: 'blackHole', x: p.ball.x, y: p.ball.y });
          // Spec: +1 stroke, reset to hole tee (not a custom drop pad); no wet.
          p.ball.x = hole.tee.x;
          p.ball.y = hole.tee.y;
          p.ball.vx = 0;
          p.ball.vy = 0;
          p.ball.z = 0;
          p.ball.vz = 0;
          p.ball.stuckStickyIndex = -1;
          p.ball.wet = false;
          p.ball.wetStroke = false;
          p.ball.firedBoosts = new Set();
        }
        if (events.holed) {
          this.finishPlayerHole(p, false);
          tickEvents.push({ id: p.id, kind: 'holed', strokes: p.strokes });
        }
      }

      const activeNow = [...this.players.values()]
        .filter((p) => p.connected && p.ball && !p.holedOut)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (let i = 0; i < activeNow.length; i++) {
        for (let j = i + 1; j < activeNow.length; j++) {
          const pa = activeNow[i];
          const pb = activeNow[j];
          const a = pa.ball;
          const b = pb.ball;
          if (Shared.resolveBallBallCollision(a, b)) {
            const key = pa.id + '|' + pb.id;
            if (!clashedPairs.has(key)) {
              clashedPairs.add(key);
              // Full post-clash poses so clients never fork on multi-ball (coast model).
              tickEvents.push({
                kind: 'clash',
                a: pa.id,
                b: pb.id,
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
      }
    }

    const active = [...this.players.values()].filter((p) => p.connected && p.ball && !p.holedOut);
    const connected = [...this.players.values()].filter((p) => p.connected);

    // Pure coast while rolling: NO pose heartbeats mid-flight.
    const anyMoving = active.some((p) => Math.hypot(p.ball.vx, p.ball.vy) >= Shared.STOP_THRESHOLD);
    const idle = !anyMoving && tickEvents.length === 0;
    const becameIdle = idle && !this.wasIdle;
    this.wasIdle = idle;
    if (tickEvents.length > 0) {
      // hard decided by event kinds (clash/water/holed hard; bounce/sand/boost soft)
      this.sendCorrectionNow(tickEvents, { reason: 'event' });
    } else if (becameIdle) {
      // Everyone just stopped — hard snap so aim poses match before next putt.
      this.sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: true });
    } else if (idle && this.simTick % CORRECTION_IDLE_EVERY === 0) {
      // Periodic keepalive: soft — corrects drift without rubber-banding.
      this.sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: false });
    }

    // Treat ball-less connected players as done so a glitched join can't block forever.
    const allHoledOut =
      connected.length > 0 &&
      connected.every((p) => p.holedOut || !p.ball);
    const timedOut = this.simTick >= HOLE_TIMEOUT_TICKS;
    if ((allHoledOut || timedOut) && !this.holeEnding) {
      this.holeEnding = true;
      this.holeEndingAtMs = Date.now();
      if (timedOut) {
        for (const p of connected) {
          if (!p.holedOut) this.finishPlayerHole(p, true);
        }
      }
      this.sendCorrectionNow(this.pendingEvents, { reason: 'resync', includeObstacles: true, hard: true });
    }
    // Celebration pause then results — wall-clock in tickDriver (see maybeEndHoleAfterPause).
  }

  maybeEndHoleAfterPause() {
    if (!this.holeEnding || this.state !== 'PLAYING' || this._destroyed) return;
    if (!this.holeEndingAtMs) return;
    if (Date.now() - this.holeEndingAtMs < 1400) return;
    this.endHole();
  }

  tickDriver() {
    if (this._destroyed) return;
    // Always drive hole-results progression even when not PLAYING.
    this.maybeEndHoleAfterPause();
    this.maybeAdvanceFromResults();
    if (this.state !== 'PLAYING') return;
    const wallTarget = Math.floor((Date.now() - this.holeStartedAtMs) / TICK_MS);
    let steps = 0;
    while (this.simTick < wallTarget && steps < MAX_CATCH_UP_TICKS) {
      this.stepSimulation();
      steps++;
      if (this.state !== 'PLAYING') break;
    }
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
      const hole = this.currentHoles()[this.currentHoleIndex];
      if (!player.ball) {
        player.ball = Shared.createBallState(
          Shared.teePositionFor(this.players.size - 1, this.players.size, hole)
        );
      }
      this.send(player.ws, this.roundStatePayload());
      this.send(player.ws, this.buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true }));
    }
  }

  addPlayer(ws, { name, reconnectToken, isLocal }, opts = {}) {
    const quiet = !!opts.quiet;
    const requireReconnect = !!opts.requireReconnect;
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
      if (requireReconnect) {
        return { player: null, error: 'bad_token', reconnected: false };
      }
    } else if (requireReconnect) {
      return { player: null, error: 'bad_token', reconnected: false };
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
    } else if (msg.type === 'selectCourse') {
      if (
        player.id === this.hostPlayerId &&
        this.state === 'WAITING_FOR_PLAYERS' &&
        typeof msg.courseIndex === 'number' &&
        msg.courseIndex >= 0 &&
        msg.courseIndex < COURSES.length
      ) {
        this.courseIndex = msg.courseIndex;
        this.broadcastLobbyState();
      }
    } else if (msg.type === 'startRound') {
      if (
        player.id === this.hostPlayerId &&
        (this.state === 'WAITING_FOR_PLAYERS' || this.state === 'FINAL_RESULTS')
      ) {
        if (
          typeof msg.courseIndex === 'number' &&
          msg.courseIndex >= 0 &&
          msg.courseIndex < COURSES.length
        ) {
          this.courseIndex = msg.courseIndex;
        }
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
        this.holeEndingAtMs = 0;
        this.holeResultsAtMs = 0;
        if (this._holeAdvanceTimer) {
          clearTimeout(this._holeAdvanceTimer);
          this._holeAdvanceTimer = null;
        }
        for (const p of this.players.values()) p.ball = null;
        this.broadcast({ type: 'notice', text: `${player.name} ended the game` });
        this.broadcastLobbyState();
      }
    } else if (msg.type === 'respawn') {
      // Escape hatch when a ball never settles (e.g. Orbit gravity loops). No stroke penalty.
      if (this.state !== 'PLAYING' || !player.ball || player.holedOut) return;
      const hole = this.currentHoles()[this.currentHoleIndex];
      const roster = [...this.players.values()];
      const slot = Math.max(0, roster.indexOf(player));
      const spot = Shared.teePositionFor(slot, roster.length, hole);
      player.ball.x = spot.x;
      player.ball.y = spot.y;
      player.ball.vx = 0;
      player.ball.vy = 0;
      player.ball.z = 0;
      player.ball.vz = 0;
      player.ball.stuckStickyIndex = -1;
      player.ball.wet = false;
      player.ball.wetStroke = false;
      player.ball.firedBoosts = new Set();
      this.sendCorrectionNow([], { reason: 'resync', includeObstacles: true, hard: true });
    } else if (msg.type === 'putt') {
      if (this.state !== 'PLAYING' || !player.ball || player.holedOut) return;
      if (Math.hypot(player.ball.vx, player.ball.vy) >= Shared.STOP_THRESHOLD) return;
      const v = msg.dragVector;
      if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') return;
      const clamped = Shared.clampDragVector(v);
      if (!clamped) return;
      const launch = Shared.computeLaunchVelocity(clamped);
      const hole = this.currentHoles()[this.currentHoleIndex];
      const factor = Shared.stickyLaunchFactor(player.ball, hole);
      player.ball.firedBoosts = new Set();
      // Goo stays sticky while inside the patch (no grass escape latch).
      Shared.latchStickyAfterPutt(player.ball, hole);
      Shared.noteWetPutt(player.ball);
      player.ball.vx = launch.vx * factor;
      player.ball.vy = launch.vy * factor;
      player.ball.z = 0;
      player.ball.vz = 0;
      player.strokes++;
      // One reliable event — no pose stream while the ball is rolling.
      const puttMsg = {
        type: 'puttApplied',
        playerId: player.id,
        tick: this.simTick,
        dragVector: { x: clamped.x, y: clamped.y },
        strokes: player.strokes,
        x: player.ball.x,
        y: player.ball.y,
        vx: player.ball.vx,
        vy: player.ball.vy,
        z: player.ball.z,
        vz: player.ball.vz,
        stuckStickyIndex: player.ball.stuckStickyIndex,
      };
      if (player.ball.wet) {
        puttMsg.wet = true;
        if (player.ball.wetStroke) puttMsg.wetStroke = true;
      }
      this.broadcastReliable(puttMsg);
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
