// Pure-Node mirror of game.js multiplayer coast reconcilation (no DOM/audio).
// Used by the rubber-band harness to quantify soft/hard snaps vs host ground truth.
'use strict';

const Shared = require('../shared.js');

const TICK_HZ = Shared.TICK_HZ;
const TICK_DT = Shared.TICK_DT;
const PHYSICS_SUBTICKS = 4;
const MAX_CATCH_UP = 8;
const SOFT_ERR_PX = 10;
const HARD_ERR_PX = 80;
const ERR_DECAY_TAU = 0.12;
const STOP = Shared.STOP_THRESHOLD;

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * Headless multiplayer client model.
 * @param {{ playerId: string, courseIndex?: number }} opts
 */
class ClientModel {
  constructor(opts) {
    this.playerId = opts.playerId;
    this.courseIndex = opts.courseIndex || 0;
    this.playing = false;
    this.simTick = 0;
    this.hostTick = 0;
    this.hostTickAtMs = 0; // harness wall clock when hostTick was observed
    this.players = new Map();
    this.metrics = this._emptyMetrics();
  }

  _emptyMetrics() {
    return {
      samples: 0,
      maxSimErr: 0,
      maxVisErr: 0,
      sumSimErr: 0,
      sumVisErr: 0,
      hardSnaps: 0,
      hardSnapsWhileMoving: 0,
      softApplies: 0,
      puttResyncs: 0, // self puttApplied that re-snapped pose
      rubberBands: [], // { tick, kind, dist, moving }
    };
  }

  resetMetrics() {
    this.metrics = this._emptyMetrics();
  }

  currentHoles() {
    return Shared.COURSES[this.courseIndex].holes;
  }

  hole() {
    return this.currentHoles()[this.holeIndex || 0];
  }

  noteHostTick(tick, wallMs) {
    this.hostTick = tick;
    this.hostTickAtMs = wallMs;
  }

  hostTargetTick(wallMs) {
    return Math.floor(this.hostTick + ((wallMs - this.hostTickAtMs) / 1000) * TICK_HZ);
  }

  onRoundState(msg) {
    if (msg.courseIndex !== undefined) this.courseIndex = msg.courseIndex;
    this.holeIndex = msg.holeIndex;
    this.players.clear();
    const hole = this.currentHoles()[msg.holeIndex];
    Shared.resetHoleObstacles(hole);
    const startTick = typeof msg.tick === 'number' ? msg.tick : 0;
    this.simTick = startTick;
    this.noteHostTick(startTick, 0);
    Shared.setHoleObstaclesAtTick(hole, startTick);
    this.playing = true;
  }

  upsert(b) {
    let p = this.players.get(b.id);
    if (!p) {
      p = {
        id: b.id,
        name: b.name,
        hue: b.hue,
        x: b.x,
        y: b.y,
        vx: b.vx || 0,
        vy: b.vy || 0,
        z: b.z || 0,
        vz: b.vz || 0,
        strokes: b.strokes || 0,
        holedOut: !!b.holedOut,
        rx: b.x,
        ry: b.y,
        errX: 0,
        errY: 0,
        firedBoosts: new Set(),
        stuckStickyIndex: typeof b.stuckStickyIndex === 'number' ? b.stuckStickyIndex : -1,
      };
      this.players.set(b.id, p);
    } else {
      if (b.name !== undefined) p.name = b.name;
      if (b.hue !== undefined) p.hue = b.hue;
    }
    return p;
  }

  applyAuthorityPose(p, b, hard) {
    const visX = p.rx;
    const visY = p.ry;
    const d = dist(p.x, p.y, b.x, b.y);
    const moving = Math.hypot(b.vx || 0, b.vy || 0) >= STOP || Math.hypot(p.vx, p.vy) >= STOP;

    p.strokes = b.strokes;
    p.holedOut = !!b.holedOut;
    p.x = b.x;
    p.y = b.y;
    p.vx = b.vx;
    p.vy = b.vy;
    p.z = b.z || 0;
    p.vz = b.vz || 0;
    if (typeof b.stuckStickyIndex === 'number') p.stuckStickyIndex = b.stuckStickyIndex;
    if (Math.hypot(b.vx, b.vy) < STOP && p.z === 0) p.firedBoosts = new Set();

    // Mirror game.js: while moving, prefer soft visual blend unless error is huge.
    const forceHard =
      b.holedOut ||
      d >= HARD_ERR_PX ||
      (hard && !moving) ||
      (hard && d >= SOFT_ERR_PX * 3);
    if (forceHard) {
      p.errX = 0;
      p.errY = 0;
      p.rx = b.x;
      p.ry = b.y;
      this.metrics.hardSnaps++;
      if (moving && d > 0.5) {
        this.metrics.hardSnapsWhileMoving++;
        this.metrics.rubberBands.push({
          tick: this.simTick,
          kind: 'hard_snap',
          dist: d,
          moving: true,
        });
      }
    } else {
      p.errX = visX - b.x;
      p.errY = visY - b.y;
      const elen = Math.hypot(p.errX, p.errY);
      this.metrics.softApplies++;
      if (elen < SOFT_ERR_PX) {
        p.errX = 0;
        p.errY = 0;
        p.rx = b.x;
        p.ry = b.y;
      }
      if (elen > 2) {
        this.metrics.rubberBands.push({
          tick: this.simTick,
          kind: 'soft_offset',
          dist: elen,
          moving,
        });
      }
    }
    return d;
  }

  applyPuttLocal(playerId, dragVector, fromServer) {
    const p = this.players.get(playerId);
    if (!p || p.holedOut) return;
    const hole = this.hole();
    const clamped = Shared.clampDragVector(dragVector);
    if (!clamped && !fromServer) return;
    p.firedBoosts = new Set();
    p.errX = 0;
    p.errY = 0;
    if (fromServer) {
      p.x = fromServer.x;
      p.y = fromServer.y;
      p.vx = fromServer.vx;
      p.vy = fromServer.vy;
      p.z = fromServer.z || 0;
      p.vz = fromServer.vz || 0;
      p.strokes = fromServer.strokes;
      if (typeof fromServer.stuckStickyIndex === 'number') {
        p.stuckStickyIndex = fromServer.stuckStickyIndex;
      } else {
        Shared.latchStickyAfterPutt(p, hole);
      }
    } else {
      const launch = Shared.computeLaunchVelocity(clamped);
      const factor = Shared.stickyLaunchFactor(p, hole);
      Shared.latchStickyAfterPutt(p, hole);
      p.vx = launch.vx * factor;
      p.vy = launch.vy * factor;
      p.z = 0;
      p.vz = 0;
      p.strokes += 1;
    }
    p.rx = p.x;
    p.ry = p.y;
  }

  onPuttApplied(msg) {
    if (!this.playing) return;
    if (typeof msg.tick === 'number') {
      this.noteHostTick(msg.tick, this.hostTickAtMs); // wall updated by harness
      if (msg.tick >= this.simTick) {
        this.simTick = msg.tick;
        Shared.setHoleObstaclesAtTick(this.hole(), this.simTick);
      }
    }
    // Ensure player exists for remote putts
    if (!this.players.has(msg.playerId)) {
      this.upsert({
        id: msg.playerId,
        name: '?',
        hue: 0,
        x: msg.x,
        y: msg.y,
        vx: msg.vx,
        vy: msg.vy,
        strokes: msg.strokes,
        holedOut: false,
        stuckStickyIndex: msg.stuckStickyIndex,
      });
    }
    const isSelf = msg.playerId === this.playerId;
    const p = this.players.get(msg.playerId);
    const hostPose = {
      x: msg.x,
      y: msg.y,
      vx: msg.vx,
      vy: msg.vy,
      strokes: msg.strokes,
      stuckStickyIndex: msg.stuckStickyIndex,
      z: msg.z,
      vz: msg.vz,
    };
    if (isSelf && p) {
      const wasOptimistic = Math.hypot(p.vx, p.vy) >= STOP || p.strokes >= (msg.strokes || 0);
      const d = dist(p.x, p.y, msg.x, msg.y);
      const dv = Math.hypot(p.vx - msg.vx, p.vy - msg.vy);
      const ticksAhead = typeof msg.tick === 'number' ? this.simTick - msg.tick : 0;
      if (wasOptimistic && (d > 1 || dv > 1)) {
        if (ticksAhead <= 2 || d >= HARD_ERR_PX) {
          this.metrics.puttResyncs++;
          this.metrics.rubberBands.push({
            tick: this.simTick,
            kind: 'putt_resync',
            dist: d,
            moving: true,
          });
          this.applyPuttLocal(msg.playerId, msg.dragVector, hostPose);
          if (typeof msg.tick === 'number' && ticksAhead > 2) this.simTick = msg.tick;
        } else {
          // Late confirm — keep coasting.
          p.strokes = msg.strokes;
          if (typeof msg.stuckStickyIndex === 'number') p.stuckStickyIndex = msg.stuckStickyIndex;
        }
      } else if (wasOptimistic) {
        p.strokes = msg.strokes;
        if (typeof msg.stuckStickyIndex === 'number') p.stuckStickyIndex = msg.stuckStickyIndex;
      } else {
        this.applyPuttLocal(msg.playerId, msg.dragVector, hostPose);
      }
    } else {
      this.applyPuttLocal(msg.playerId, msg.dragVector, hostPose);
    }
  }

  onSnapshot(msg, wallMs) {
    const hole = this.currentHoles()[msg.holeIndex];
    const tick = typeof msg.tick === 'number' ? msg.tick : Shared.elapsedMsToTick(msg.elapsedMs || 0);
    const reason = msg.reason || 'heartbeat';
    const hard = reason === 'resync' ? true : !!msg.hard;
    this.playing = true;
    this.noteHostTick(tick, wallMs);

    if (msg.obstacles) {
      msg.obstacles.windmillAngles.forEach((a, i) => {
        if (hole.windmills[i]) hole.windmills[i].angle = a;
      });
      msg.obstacles.pendulumPhases.forEach((ph, i) => {
        if (hole.pendulums[i]) hole.pendulums[i].phase = ph;
      });
      msg.obstacles.gatePhases.forEach((ph, i) => {
        if (hole.gates[i]) hole.gates[i].phase = ph;
      });
    } else {
      Shared.setHoleObstaclesAtTick(hole, tick);
    }

    if (hard || this.simTick > tick + 2) {
      this.simTick = tick;
      if (!msg.obstacles) Shared.setHoleObstaclesAtTick(hole, tick);
    }

    const seen = new Set();
    for (const b of msg.balls || []) {
      seen.add(b.id);
      const existed = this.players.has(b.id);
      const p = this.upsert(b);
      this.applyAuthorityPose(p, b, hard || !existed);
    }
    for (const id of this.players.keys()) {
      if (!seen.has(id)) this.players.delete(id);
    }

    for (const ev of msg.events || []) {
      if (ev.kind === 'clash' && Array.isArray(ev.balls)) {
        for (const b of ev.balls) {
          const p =
            this.players.get(b.id) ||
            this.upsert({
              id: b.id,
              name: '?',
              hue: 0,
              x: b.x,
              y: b.y,
              vx: b.vx,
              vy: b.vy,
              strokes: 0,
              holedOut: false,
            });
          this.applyAuthorityPose(
            p,
            {
              x: b.x,
              y: b.y,
              vx: b.vx,
              vy: b.vy,
              strokes: p.strokes,
              holedOut: p.holedOut,
              stuckStickyIndex: p.stuckStickyIndex,
            },
            true
          );
        }
      }
    }
  }

  stepOneTick() {
    const hole = this.hole();
    this.simTick += 1;
    Shared.setHoleObstaclesAtTick(hole, this.simTick);
    const active = [...this.players.values()].filter((p) => !p.holedOut);
    for (let s = 0; s < PHYSICS_SUBTICKS; s++) {
      for (const p of active) {
        if (p.holedOut) continue;
        const events = Shared.stepBallPhysics(p, hole, TICK_DT / PHYSICS_SUBTICKS);
        if (events.water) {
          p.x = events.water.dropPoint.x;
          p.y = events.water.dropPoint.y;
          p.vx = 0;
          p.vy = 0;
          p.z = 0;
          p.vz = 0;
          p.stuckStickyIndex = -1;
          p.strokes += 1;
          p.errX = 0;
          p.errY = 0;
          p.rx = p.x;
          p.ry = p.y;
        }
        if (events.holed) {
          p.holedOut = true;
          p.vx = 0;
          p.vy = 0;
          p.errX = 0;
          p.errY = 0;
          p.rx = p.x;
          p.ry = p.y;
        }
      }
    }
  }

  /**
   * Advance local sim toward host clock and decay visual error.
   * @param {number} wallMs harness wall clock
   * @param {number} dt frame dt seconds
   */
  update(wallMs, dt) {
    if (!this.playing) return;
    const target = this.hostTargetTick(wallMs);
    let steps = 0;
    while (this.simTick < target && steps < MAX_CATCH_UP) {
      this.stepOneTick();
      steps++;
    }
    const decay = Math.exp(-dt / ERR_DECAY_TAU);
    for (const p of this.players.values()) {
      p.errX *= decay;
      p.errY *= decay;
      if (Math.hypot(p.errX, p.errY) < 0.5) {
        p.errX = 0;
        p.errY = 0;
      }
      p.rx = p.x + p.errX;
      p.ry = p.y + p.errY;
    }
  }

  /**
   * Compare to host ground-truth ball poses: { id: {x,y,vx,vy} }
   */
  sampleError(hostBalls) {
    for (const [id, hb] of Object.entries(hostBalls)) {
      const p = this.players.get(id);
      if (!p || !hb) continue;
      const simErr = dist(p.x, p.y, hb.x, hb.y);
      const visErr = dist(p.rx, p.ry, hb.x, hb.y);
      this.metrics.samples++;
      this.metrics.sumSimErr += simErr;
      this.metrics.sumVisErr += visErr;
      if (simErr > this.metrics.maxSimErr) this.metrics.maxSimErr = simErr;
      if (visErr > this.metrics.maxVisErr) this.metrics.maxVisErr = visErr;
    }
  }

  summary() {
    const m = this.metrics;
    const n = Math.max(1, m.samples);
    return {
      samples: m.samples,
      maxSimErr: round3(m.maxSimErr),
      maxVisErr: round3(m.maxVisErr),
      avgSimErr: round3(m.sumSimErr / n),
      avgVisErr: round3(m.sumVisErr / n),
      hardSnaps: m.hardSnaps,
      hardSnapsWhileMoving: m.hardSnapsWhileMoving,
      softApplies: m.softApplies,
      puttResyncs: m.puttResyncs,
      rubberBandEvents: m.rubberBands.length,
      topRubberBands: m.rubberBands
        .slice()
        .sort((a, b) => b.dist - a.dist)
        .slice(0, 8)
        .map((e) => ({ ...e, dist: round3(e.dist) })),
    };
  }
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = {
  ClientModel,
  SOFT_ERR_PX,
  HARD_ERR_PX,
  PHYSICS_SUBTICKS,
  TICK_HZ,
};
