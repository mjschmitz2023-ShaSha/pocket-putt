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
// Tick-stamped putts: whole-hole history ring + input log (docs/mp-tick-stamped-inputs.md).
// Snapshot = end-of-tick state. Putt at clientTick T applies on restore(T), then physics T→T+1.
const HISTORY_TICKS = 30;
const TRUST_WINDOW_TICKS = HISTORY_TICKS;
const KEEPALIVE_MISS_THRESHOLD = 3;
const KEEPALIVE_EXPECT_MS = 400;
const KEEPALIVE_STALE_MS = KEEPALIVE_MISS_THRESHOLD * KEEPALIVE_EXPECT_MS;
// Max ticks a putt may be stamped in the host's future (queued until host reaches T).
// Never clamp T down to hostNow — that guarantees a path fork / hard snap.
const CLIENT_TICK_FUTURE_QUEUE = HISTORY_TICKS;

function makeId() {
  return crypto.randomUUID();
}

function cloneBallState(ball) {
  if (!ball) return null;
  return {
    x: ball.x,
    y: ball.y,
    vx: ball.vx,
    vy: ball.vy,
    z: ball.z || 0,
    vz: ball.vz || 0,
    squash: ball.squash || 0,
    spin: ball.spin || 0,
    angleDir: ball.angleDir || 0,
    firedBoosts: new Set(ball.firedBoosts instanceof Set ? ball.firedBoosts : []),
    stuckStickyIndex: typeof ball.stuckStickyIndex === 'number' ? ball.stuckStickyIndex : -1,
    wet: !!ball.wet,
    wetStroke: !!ball.wetStroke,
  };
}

function cloneFloating(fl) {
  if (!fl) return null;
  return {
    zone: fl.zone,
    ticks: fl.ticks,
    vx: fl.vx || 0,
    vy: fl.vy || 0,
  };
}

function cloneSpeedTracker(tr) {
  if (!tr) return Shared.createSpeedAvgTracker();
  return {
    sumSpDt: tr.sumSpDt || 0,
    sumDt: tr.sumDt || 0,
    q: Array.isArray(tr.q) ? tr.q.slice() : [],
  };
}

function clonePerHoleScores(scores) {
  if (!Array.isArray(scores)) return [];
  return scores.map((s) => ({
    holeIndex: s.holeIndex,
    strokes: s.strokes,
    finishSeconds: s.finishSeconds,
    holeScore: s.holeScore,
    timedOut: !!s.timedOut,
  }));
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
    /** @type {object|null} validated single custom hole; when set, round is 1 hole */
    this.customHole = null;
    this.currentHoleIndex = 0;
    this.holeStartedAtMs = 0;
    /** Wall time W0 when hole tick 0 began (same as holeStartedAtMs at beginHole). */
    this.holeEpochMs = 0;
    this.simTick = 0;
    this.holeEnding = false;
    this.holeEndingAtMs = 0;
    this.holeResultsAtMs = 0;
    this.pendingEvents = [];
    this.wasIdle = false;
    this.lastActivity = Date.now();
    this._holeAdvanceTimer = null; // legacy; progression is wall-clock in tickDriver
    this._destroyed = false;
    /** @type {{ tick: number, state: object }[]} end-of-tick whole-hole snapshots */
    this.snapshotRing = [];
    /** @type {{ tick: number, playerId: string, kind: string, dragVector: {x:number,y:number} }[]} */
    this.inputLog = [];
    this._replaying = false;
    /** @type {number|null} coalesce concurrent late inputs to earliest tick */
    this.pendingReplayFrom = null;
    /**
     * Putts stamped in the host's future (clientTick > simTick).
     * Applied when host reaches that tick — never rewritten to hostNow.
     * @type {{ playerId: string, clientTick: number, dragVector: {x:number,y:number} }[]}
     */
    this.pendingPutts = [];
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
    if (this.customHole) return [this.customHole];
    return COURSES[this.courseIndex].holes;
  }

  customHoleLobbyFields() {
    if (!this.customHole) {
      return { hasCustomHole: false, customHoleName: null, customLvl: null };
    }
    let customLvl = null;
    try {
      customLvl = Shared.encodeHole(this.customHole);
    } catch {
      customLvl = null;
    }
    return {
      hasCustomHole: true,
      customHoleName: this.customHole.name || 'Custom',
      customLvl,
    };
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
      hostTimeMs: Date.now(),
      holeEpochMs: this.holeEpochMs || this.holeStartedAtMs,
      ...this.customHoleLobbyFields(),
      // Reliable tee seed — clients must not depend solely on an unreliable resync
      // snapshot to populate Game.players (dropped resync → empty roster / vanished ball).
      balls: [...this.players.values()]
        .filter((p) => p.connected && p.ball)
        .map((p) => this.ballWire(p)),
    };
  }

  clockSyncPayload() {
    return {
      type: 'clockSync',
      holeIndex: this.currentHoleIndex,
      tick: this.simTick,
      hostTimeMs: Date.now(),
      tickHz: TICK_HZ,
      holeEpochMs: this.holeEpochMs || this.holeStartedAtMs,
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
      ...this.customHoleLobbyFields(),
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
      p.dunks = 0;
      p.floating = null; // never carry a hazard float across holes
      p.speedTracker = Shared.createSpeedAvgTracker();
      // Fresh clock trust for the hole (keepalives re-establish).
      p.lastKeepaliveTick = null;
      p.lastKeepaliveWall = 0;
      p.lastHostTickSeen = 0;
      p.clockTrusted = true;
    });
    const now = Date.now();
    this.holeStartedAtMs = now;
    this.holeEpochMs = now;
    this.simTick = 0;
    this.holeEnding = false;
    this.holeEndingAtMs = 0;
    this.holeResultsAtMs = 0;
    this.pendingEvents = [];
    this.wasIdle = false;
    this.snapshotRing = [];
    this.inputLog = [];
    this.pendingReplayFrom = null;
    this.pendingPutts = [];
    this._replaying = false;
    this.state = 'PLAYING';
    this.touch();
    Shared.setHoleObstaclesAtTick(hole, 0);
    // Seed end-of-tick-0 snapshot (tee setup) so putts at T=0 can restore.
    this.pushSnapshot();
    // Reliable roundState now carries tee balls; also push a hard resync for obstacles.
    this.broadcastReliable(this.roundStatePayload());
    this.broadcastReliable(this.clockSyncPayload());
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
    // Per-stroke boost latch — clients must not re-arm on idle snaps while still on a pad.
    if (p.ball.firedBoosts instanceof Set && p.ball.firedBoosts.size > 0) {
      wire.firedBoosts = [...p.ball.firedBoosts];
    }
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
    const includeObstacles =
      !!opts.includeObstacles || reason === 'resync' || reason === 'replay' || reason === 'idle';
    let hard;
    if (opts.hard !== undefined) {
      hard = !!opts.hard;
    } else if (reason === 'resync' || reason === 'replay') {
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
      hostTimeMs: Date.now(),
      holeEpochMs: this.holeEpochMs || this.holeStartedAtMs,
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

  // ---- Whole-hole snapshot ring (end-of-tick authority) ----

  cloneHoleState() {
    const players = {};
    for (const p of this.players.values()) {
      players[p.id] = {
        strokes: p.strokes,
        holedOut: !!p.holedOut,
        dunks: p.dunks || 0,
        floating: cloneFloating(p.floating),
        ball: cloneBallState(p.ball),
        speedTracker: cloneSpeedTracker(p.speedTracker),
        perHoleScores: clonePerHoleScores(p.perHoleScores),
        totalScore: p.totalScore || 0,
      };
    }
    return {
      tick: this.simTick,
      wasIdle: this.wasIdle,
      holeEnding: this.holeEnding,
      holeEndingAtMs: this.holeEndingAtMs,
      players,
    };
  }

  restoreHoleState(state) {
    if (!state) return false;
    for (const p of this.players.values()) {
      const snap = state.players[p.id];
      if (!snap) {
        // Player joined mid-hole after this snapshot — leave their current state.
        continue;
      }
      p.strokes = snap.strokes;
      p.holedOut = !!snap.holedOut;
      p.dunks = snap.dunks || 0;
      p.floating = cloneFloating(snap.floating);
      p.ball = cloneBallState(snap.ball);
      p.speedTracker = cloneSpeedTracker(snap.speedTracker);
      p.perHoleScores = clonePerHoleScores(snap.perHoleScores);
      p.totalScore = snap.totalScore || 0;
    }
    this.simTick = state.tick;
    this.wasIdle = !!state.wasIdle;
    this.holeEnding = !!state.holeEnding;
    this.holeEndingAtMs = state.holeEndingAtMs || 0;
    this.pendingEvents = [];
    const hole = this.currentHoles()[this.currentHoleIndex];
    Shared.setHoleObstaclesAtTick(hole, this.simTick);
    return true;
  }

  pushSnapshot() {
    const state = this.cloneHoleState();
    // Replace existing entry for this tick (replay rewrites history).
    const existing = this.snapshotRing.findIndex((e) => e.tick === this.simTick);
    if (existing >= 0) this.snapshotRing[existing] = { tick: this.simTick, state };
    else this.snapshotRing.push({ tick: this.simTick, state });
    this.snapshotRing.sort((a, b) => a.tick - b.tick);
    const minTick = this.simTick - HISTORY_TICKS;
    while (this.snapshotRing.length && this.snapshotRing[0].tick < minTick) {
      this.snapshotRing.shift();
    }
  }

  getSnapshot(tick) {
    for (let i = this.snapshotRing.length - 1; i >= 0; i--) {
      if (this.snapshotRing[i].tick === tick) return this.snapshotRing[i].state;
    }
    return null;
  }

  /**
   * Apply all logged putts stamped at `tick` (impulses only, simultaneous).
   * Same-player same-tick: last log entry wins.
   * @returns {object[]} applied putt records (for puttApplied juice)
   */
  applyInputsForTick(tick) {
    const hole = this.currentHoles()[this.currentHoleIndex];
    const byPlayer = new Map();
    for (const rec of this.inputLog) {
      if (rec.tick !== tick || rec.kind !== 'putt') continue;
      byPlayer.set(rec.playerId, rec);
    }
    const applied = [];
    for (const rec of byPlayer.values()) {
      const player = this.players.get(rec.playerId);
      if (!player || !player.connected || !player.ball || player.holedOut || player.floating) continue;
      if (!player.speedTracker) player.speedTracker = Shared.createSpeedAvgTracker();
      if (!Shared.mayPuttBall(player.ball, hole, player.speedTracker)) continue;
      const clamped = Shared.clampDragVector(rec.dragVector);
      if (!clamped) continue;
      const launch = Shared.computeLaunchVelocity(clamped);
      const factor = Shared.stickyLaunchFactor(player.ball, hole);
      player.ball.firedBoosts = new Set();
      Shared.latchStickyAfterPutt(player.ball, hole);
      Shared.noteWetPutt(player.ball);
      player.ball.vx = launch.vx * factor;
      player.ball.vy = launch.vy * factor;
      player.ball.z = 0;
      player.ball.vz = 0;
      player.strokes++;
      Shared.resetSpeedAvgTracker(player.speedTracker);
      applied.push({
        playerId: player.id,
        tick,
        dragVector: { x: clamped.x, y: clamped.y },
        strokes: player.strokes,
        x: player.ball.x,
        y: player.ball.y,
        vx: player.ball.vx,
        vy: player.ball.vy,
        z: player.ball.z,
        vz: player.ball.vz,
        stuckStickyIndex: player.ball.stuckStickyIndex,
        wet: player.ball.wet,
        wetStroke: player.ball.wetStroke,
      });
    }
    return applied;
  }

  /**
   * Physics body for one tick: increments simTick, obstacles, floats, subticks, clashes.
   * Collects events into this.pendingEvents. Does not emit network traffic.
   */
  stepPhysicsOneTick() {
    this.simTick += 1;
    this.touch();

    const hole = this.currentHoles()[this.currentHoleIndex];
    Shared.setHoleObstaclesAtTick(hole, this.simTick);

    const tickEvents = this.pendingEvents;
    const bouncedThisTick = new Set();
    const sandedThisTick = new Set();
    const clashedPairs = new Set();

    // Hazard floats first (deterministic waves + slot-indexed drop).
    for (const p of this.players.values()) {
      if (!p.connected || p.holedOut || !p.ball || !p.floating) continue;
      const fl = p.floating;
      fl.ticks -= 1;
      Shared.stepWaterFloat(p.ball, fl, fl.zone, this.simTick * TICK_DT, TICK_DT);
      if (fl.ticks <= 0) {
        const roster = [...this.players.values()];
        const idx = Shared.waterDropIndexFor(roster.indexOf(p), p.dunks || 1);
        const drop = Shared.waterDropPointFor(fl.zone, idx, hole);
        p.ball.x = drop.x;
        p.ball.y = drop.y;
        p.ball.vx = 0;
        p.ball.vy = 0;
        Shared.markWetFromWater(p.ball);
        p.floating = null;
        tickEvents.push({ id: p.id, kind: 'water', x: drop.x, y: drop.y });
      }
    }

    for (let s = 0; s < PHYSICS_SUBTICKS; s++) {
      for (const p of this.players.values()) {
        if (!p.connected || p.holedOut || !p.ball || p.floating) continue;
        const events = Shared.stepBallPhysics(p.ball, hole, TICK_DT / PHYSICS_SUBTICKS);
        if (!p.speedTracker) p.speedTracker = Shared.createSpeedAvgTracker();
        Shared.noteSpeedSample(
          p.speedTracker,
          Math.hypot(p.ball.vx, p.ball.vy),
          TICK_DT / PHYSICS_SUBTICKS
        );
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
          p.dunks = (p.dunks || 0) + 1;
          tickEvents.push({ id: p.id, kind: 'water', x: p.ball.x, y: p.ball.y });
          p.floating = {
            zone: events.water,
            ticks: Shared.WATER_FLOAT_TICKS,
            vx: p.ball.vx * Shared.WATER_FLOAT_CARRY,
            vy: p.ball.vy * Shared.WATER_FLOAT_CARRY,
          };
          p.ball.vx = 0;
          p.ball.vy = 0;
          p.ball.z = 0;
          p.ball.vz = 0;
          p.ball.stuckStickyIndex = -1;
        }
        if (events.blackHole) {
          p.strokes++;
          tickEvents.push({ id: p.id, kind: 'blackHole', x: p.ball.x, y: p.ball.y });
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
        .filter((p) => p.connected && p.ball && !p.holedOut && !p.floating)
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
  }

  /**
   * Emit sparse corrections / hole-end for a completed live tick (not during silent replay).
   */
  emitTickCorrections() {
    const tickEvents = this.pendingEvents;
    const active = [...this.players.values()].filter((p) => p.connected && p.ball && !p.holedOut);
    const connected = [...this.players.values()].filter((p) => p.connected);

    const anyMoving = active.some((p) => Math.hypot(p.ball.vx, p.ball.vy) >= Shared.STOP_THRESHOLD);
    const idle = !anyMoving && tickEvents.length === 0;
    const becameIdle = idle && !this.wasIdle;
    this.wasIdle = idle;
    if (tickEvents.length > 0) {
      this.sendCorrectionNow(tickEvents, { reason: 'event' });
    } else if (becameIdle) {
      // Safety net: hard idle so aim poses match (should be ~no-op when tick-stamps work).
      this.sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: true });
    } else if (idle && this.simTick % CORRECTION_IDLE_EVERY === 0) {
      this.sendCorrectionNow([], { reason: 'idle', includeObstacles: true, hard: false });
    }

    const allHoledOut =
      connected.length > 0 && connected.every((p) => p.holedOut || !p.ball);
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
  }

  /**
   * Live step: physics + corrections + ring push.
   * @param {{ silent?: boolean }} [opts] silent=true during rewind replay (no mid-history sends)
   */
  stepSimulation(opts) {
    if (this.state !== 'PLAYING' || this._destroyed) return;
    const silent = !!(opts && opts.silent);
    this.stepPhysicsOneTick();
    this.pushSnapshot();
    if (!silent) {
      // Future-stamped putts become due when host reaches their clientTick.
      this.processPendingPutts();
      this.emitTickCorrections();
    } else {
      // Still track idle flag so post-replay hard snap / later idle is correct.
      const active = [...this.players.values()].filter((p) => p.connected && p.ball && !p.holedOut);
      const anyMoving = active.some((p) => Math.hypot(p.ball.vx, p.ball.vy) >= Shared.STOP_THRESHOLD);
      this.wasIdle = !anyMoving && this.pendingEvents.length === 0;
      this.pendingEvents = [];
    }
  }

  forceSyncPlayer(player) {
    if (!player || !player.ws) return;
    this.send(
      player.ws,
      this.buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true })
    );
  }

  /**
   * Validate clientTick against trust window + keepalive floor.
   * @returns {{ ok: boolean, tick?: number, queue?: boolean, reason?: string }}
   * queue=true → clientTick is in the host's future; hold until host reaches T (do NOT clamp).
   */
  validateClientTick(player, clientTick) {
    const hostNow = this.simTick;
    if (typeof clientTick !== 'number' || !Number.isFinite(clientTick)) {
      return { ok: false, reason: 'missing_tick' };
    }
    const T = Math.round(clientTick);
    if (Math.abs(T - clientTick) > 1e-3) {
      return { ok: false, reason: 'non_integer_tick' };
    }
    // Stale keepalives revoke trust (except bootstrap before first keepalive).
    if (player.lastKeepaliveWall > 0 && Date.now() - player.lastKeepaliveWall > KEEPALIVE_STALE_MS) {
      player.clockTrusted = false;
      return { ok: false, reason: 'keepalive_stale' };
    }
    if (player.clockTrusted === false) {
      return { ok: false, reason: 'untrusted' };
    }
    if (player.lastKeepaliveTick != null && T < player.lastKeepaliveTick) {
      return { ok: false, reason: 'before_keepalive' };
    }
    if (T < 0) return { ok: false, reason: 'negative' };
    // Too far in the past for history ring.
    if (T < hostNow - TRUST_WINDOW_TICKS) {
      return { ok: false, reason: 'too_old' };
    }
    // Too far in the future (bad clock / cheat) — reject, never clamp.
    if (T > hostNow + CLIENT_TICK_FUTURE_QUEUE) {
      return { ok: false, reason: 'too_far_future' };
    }
    // Future of host: queue until host sim reaches T (shared input tick preserved).
    if (T > hostNow) {
      return { ok: true, tick: T, queue: true };
    }
    // Past or now: need a snapshot to restore.
    if (!this.getSnapshot(T)) {
      return { ok: false, reason: 'no_snapshot' };
    }
    return { ok: true, tick: T, queue: false };
  }

  handleClientClock(player, msg) {
    if (!player || this.state !== 'PLAYING') return;
    const tick = typeof msg.tick === 'number' ? Math.round(msg.tick) : null;
    if (tick == null || !Number.isFinite(tick)) return;
    player.lastKeepaliveTick = tick;
    player.lastKeepaliveWall = Date.now();
    if (typeof msg.lastHostTick === 'number') player.lastHostTickSeen = msg.lastHostTick;
    player.clockTrusted = true;
  }

  /**
   * Whole-hole rewind + replay from earliest affected putt tick to hostNow.
   * Convention: snapshot(T) = end of tick T. Putt stamped T applies on that pose;
   * next stepPhysics advances to T+1.
   */
  scheduleReplayFrom(fromTick) {
    if (this._replaying) {
      this.pendingReplayFrom =
        this.pendingReplayFrom == null ? fromTick : Math.min(this.pendingReplayFrom, fromTick);
      return;
    }
    this.runReplay(fromTick);
  }

  runReplay(fromTick) {
    this._replaying = true;
    let Tstar = fromTick;
    const targetTick = this.simTick;
    let lastAppliedJuice = [];
    try {
      while (Tstar != null) {
        this.pendingReplayFrom = null;
        const snap = this.getSnapshot(Tstar);
        if (!snap) {
          // History gap — force-sync everyone and abort.
          this.broadcastReliable(
            this.buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true })
          );
          return;
        }
        this.restoreHoleState(snap);
        // Drop ring entries after Tstar — they will be rebuilt by silent steps.
        this.snapshotRing = this.snapshotRing.filter((e) => e.tick <= Tstar);
        this.pendingEvents = [];

        // Juice only for putts at the rewind origin (new late inputs); later ticks re-apply silently.
        lastAppliedJuice = this.applyInputsForTick(Tstar);
        let t = Tstar;
        while (t < targetTick) {
          this.stepSimulation({ silent: true });
          t = this.simTick;
          // After arriving at t, apply putts stamped t before further steps.
          this.applyInputsForTick(t);
        }

        if (this.pendingReplayFrom != null) {
          Tstar = this.pendingReplayFrom;
          continue;
        }
        break;
      }

      // Juice: puttApplied for SFX (state truth is the hard snapshot below).
      for (const rec of lastAppliedJuice) {
        const puttMsg = {
          type: 'puttApplied',
          playerId: rec.playerId,
          tick: rec.tick,
          hostTimeMs: Date.now(),
          holeEpochMs: this.holeEpochMs || this.holeStartedAtMs,
          dragVector: rec.dragVector,
          strokes: rec.strokes,
          x: rec.x,
          y: rec.y,
          vx: rec.vx,
          vy: rec.vy,
          z: rec.z,
          vz: rec.vz,
          stuckStickyIndex: rec.stuckStickyIndex,
        };
        if (rec.wet) {
          puttMsg.wet = true;
          if (rec.wetStroke) puttMsg.wetStroke = true;
        }
        this.broadcastReliable(puttMsg);
      }

      // Hard full-hole snapshot after rewind/replay (reliable — state truth).
      this.broadcastReliable(
        this.buildCorrection([], { reason: 'replay', includeObstacles: true, hard: true })
      );
      this.pendingEvents = [];

      // Hole-end if everyone finished during replay.
      const connected = [...this.players.values()].filter((p) => p.connected);
      const allHoledOut =
        connected.length > 0 && connected.every((p) => p.holedOut || !p.ball);
      const timedOut = this.simTick >= HOLE_TIMEOUT_TICKS;
      if ((allHoledOut || timedOut) && !this.holeEnding) {
        this.holeEnding = true;
        this.holeEndingAtMs = Date.now();
        if (timedOut) {
          for (const p of connected) {
            if (!p.holedOut) this.finishPlayerHole(p, true);
          }
        }
      }
    } finally {
      this._replaying = false;
    }
  }

  /**
   * Accept tick-stamped putt: validate → (queue if future) → log → rewind/replay → hard snap.
   * Reject → silent force-sync. Never rewrite clientTick to hostNow.
   */
  handlePutt(player, msg) {
    if (this.state !== 'PLAYING' || !player.ball || player.holedOut || player.floating) {
      this.forceSyncPlayer(player);
      return;
    }
    const v = msg.dragVector;
    if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') {
      this.forceSyncPlayer(player);
      return;
    }
    const clamped = Shared.clampDragVector(v);
    if (!clamped) {
      this.forceSyncPlayer(player);
      return;
    }

    const clientTickRaw = msg.clientTick;
    const check = this.validateClientTick(player, clientTickRaw);
    if (!check.ok) {
      this.forceSyncPlayer(player);
      return;
    }
    const T = check.tick;

    // Client stamp is still in the host's future — hold until host reaches T.
    if (check.queue) {
      this.pendingPutts = this.pendingPutts.filter((p) => p.playerId !== player.id);
      this.pendingPutts.push({
        playerId: player.id,
        clientTick: T,
        dragVector: { x: clamped.x, y: clamped.y },
      });
      return;
    }

    this.commitPuttAtTick(player, T, clamped);
  }

  /**
   * Commit a putt at the exact client tick T (must be ≤ hostNow with snapshot).
   */
  commitPuttAtTick(player, T, clamped) {
    if (!player || this.state !== 'PLAYING') return;
    const hole = this.currentHoles()[this.currentHoleIndex];
    const snap = this.getSnapshot(T);
    const snapP = snap && snap.players[player.id];
    if (!snapP || !snapP.ball || snapP.holedOut || snapP.floating) {
      this.forceSyncPlayer(player);
      return;
    }
    const ballAtT = cloneBallState(snapP.ball);
    const trackerAtT = cloneSpeedTracker(snapP.speedTracker);
    if (!Shared.mayPuttBall(ballAtT, hole, trackerAtT)) {
      this.forceSyncPlayer(player);
      return;
    }

    this.inputLog = this.inputLog.filter(
      (r) => !(r.tick === T && r.playerId === player.id && r.kind === 'putt')
    );
    this.inputLog.push({
      tick: T,
      playerId: player.id,
      kind: 'putt',
      dragVector: { x: clamped.x, y: clamped.y },
    });
    const minLog = this.simTick - HISTORY_TICKS - 1;
    this.inputLog = this.inputLog.filter((r) => r.tick >= minLog);

    this.scheduleReplayFrom(T);
  }

  /**
   * Apply any queued putts whose clientTick is now ≤ host simTick.
   * Call after live steps so future-stamped inputs hit the exact shared tick.
   */
  processPendingPutts() {
    if (!this.pendingPutts.length || this.state !== 'PLAYING' || this._replaying) return;
    const ready = [];
    const keep = [];
    for (const rec of this.pendingPutts) {
      if (rec.clientTick <= this.simTick) ready.push(rec);
      else keep.push(rec);
    }
    this.pendingPutts = keep;
    // Earliest tick first so one replay covers all.
    ready.sort((a, b) => a.clientTick - b.clientTick || (a.playerId < b.playerId ? -1 : 1));
    for (const rec of ready) {
      const player = this.players.get(rec.playerId);
      if (!player || !player.connected) continue;
      const T = rec.clientTick;
      // Already accepted into queue at receive time (shared T preserved).
      // Do not re-apply keepalive floor — later keepalives can have tick > T.
      if (T < this.simTick - TRUST_WINDOW_TICKS || !this.getSnapshot(T)) {
        this.forceSyncPlayer(player);
        continue;
      }
      this.commitPuttAtTick(player, T, rec.dragVector);
    }
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
    // Keepalive starvation → untrusted + force-sync (silent).
    const now = Date.now();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (p.lastKeepaliveWall > 0 && now - p.lastKeepaliveWall > KEEPALIVE_STALE_MS) {
        if (p.clockTrusted !== false) {
          p.clockTrusted = false;
          this.forceSyncPlayer(p);
        }
      }
    }
    // Shared calendar: tick index from hole epoch W0 (same formula as clients).
    const epoch = this.holeEpochMs || this.holeStartedAtMs;
    const wallTarget = Math.floor((Date.now() - epoch) / TICK_MS);
    let steps = 0;
    while (this.simTick < wallTarget && steps < MAX_CATCH_UP_TICKS) {
      this.stepSimulation();
      steps++;
      if (this.state !== 'PLAYING') break;
    }
    // Drain putts that became due even if we took 0 physics steps this frame.
    this.processPendingPutts();
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
      this.send(player.ws, this.clockSyncPayload());
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
      speedTracker: Shared.createSpeedAvgTracker(),
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
        this.customHole = null; // built-in course selection clears custom
        this.broadcastLobbyState();
      }
    } else if (msg.type === 'setCustomHole') {
      if (player.id !== this.hostPlayerId || this.state !== 'WAITING_FOR_PLAYERS') return;
      if (typeof msg.lvl !== 'string' || !msg.lvl) return;
      const decoded = Shared.decodeHole(msg.lvl);
      if (!decoded.ok) {
        this.send(player.ws, { type: 'notice', text: `Custom hole rejected: ${decoded.error}` });
        return;
      }
      this.customHole = decoded.hole;
      this.broadcastLobbyState();
    } else if (msg.type === 'clearCustomHole') {
      if (player.id !== this.hostPlayerId || this.state !== 'WAITING_FOR_PLAYERS') return;
      this.customHole = null;
      this.broadcastLobbyState();
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
          // Explicit course index on start means built-in course (clears custom).
          this.customHole = null;
        }
        // If customHole is set and no courseIndex in message, keep single custom hole.
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
      player.floating = null;
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
      player.speedTracker = Shared.createSpeedAvgTracker();
      // Always deliver — do not use broadcastCorrection's buffer skip (respawn is rare + critical).
      this.broadcastReliable(
        this.buildCorrection([], { reason: 'resync', includeObstacles: true, hard: true })
      );
    } else if (msg.type === 'clientClock') {
      this.handleClientClock(player, msg);
    } else if (msg.type === 'putt') {
      this.handlePutt(player, msg);
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
  HISTORY_TICKS,
  TRUST_WINDOW_TICKS,
  KEEPALIVE_STALE_MS,
};
