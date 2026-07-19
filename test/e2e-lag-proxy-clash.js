#!/usr/bin/env node
/**
 * Dual-client clash under REAL relay + unpredictable extra lag/jitter.
 *
 * Anti-hack rules for this test:
 *   - No fixed lag that a same-batch "nudge N ticks" can paper over.
 *   - Each trial draws lag/jitter from a wide range (seeded but varying).
 *   - Inbound messages delayed with FIFO (TCP-like); delay is per-message random.
 *   - Free-run is only shared catchUp (whole world) — no single-ball aging.
 *
 * Scenarios (each run multiple trials):
 *   1) both on lag-proxy URL + extra random delay
 *   2) mutual head-on
 *   3) asym: proxy host → direct guest (+ random extra on each side)
 *   4) asym: direct host → proxy guest
 *
 * Requires: npm start (:8977) AND npm run lag-proxy (:8978)
 *   npm run test:e2e-clash
 */
'use strict';

const WebSocket = require('ws');
const Shared = require('../shared.js');

const PROXY = process.env.LAG_PROXY_WS || 'ws://127.0.0.1:8978/ws';
const DIRECT = process.env.RELAY_WS || 'ws://127.0.0.1:8977/ws';
const TICK_MS = Shared.TICK_MS;
const STOP = Shared.STOP_THRESHOLD;
const PHYS = 4;
const MATCH_PX = 12;
const MATCH_V = 40;
const SEVERE_DPos = 40;
const SEVERE_DV = 100;
/** Trials per scenario — wide lag draws so one lucky delay can't greenwash. */
const TRIALS = Math.max(3, Number(process.env.CLASH_TRIALS) || 5);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mulberry32 — deterministic per seed, looks random across trials. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FIFO delayed delivery (TCP-like). Each message gets lag±jitter but never
 * jumps ahead of an earlier message. Hacks that only work for fixed batch
 * timing will fail across random draws.
 */
class FifoDelay {
  constructor(rng, lagMs, jitterMs) {
    this.rng = rng;
    this.lagMs = lagMs;
    this.jitterMs = jitterMs;
    this.q = [];
    this.lastAt = 0;
    this.timer = null;
  }

  delayMs() {
    const j = this.jitterMs ? (this.rng() * 2 - 1) * this.jitterMs : 0;
    return Math.max(0, this.lagMs + j);
  }

  push(fn) {
    const raw = Date.now() + this.delayMs();
    const at = Math.max(raw, this.lastAt + 1);
    this.lastAt = at;
    this.q.push({ at, fn });
    this.arm();
  }

  arm() {
    if (this.timer != null || !this.q.length) return;
    const wait = Math.max(0, this.q[0].at - Date.now());
    this.timer = setTimeout(() => this.flush(), wait);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush() {
    this.timer = null;
    const now = Date.now();
    while (this.q.length && this.q[0].at <= now) {
      const item = this.q.shift();
      try {
        item.fn();
      } catch (e) {
        console.error('delay flush', e);
      }
    }
    this.arm();
  }

  async drain(maxMs) {
    const t0 = Date.now();
    while (this.q.length && Date.now() - t0 < maxMs) {
      this.flush();
      await sleep(5);
    }
  }

  close() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.q.length = 0;
  }
}

class DualClient {
  /**
   * @param {string} name
   * @param {string} wsUrl
   * @param {{ rng: () => number, lagMs: number, jitterMs: number }} net
   */
  constructor(name, wsUrl, net) {
    this.name = name;
    this.wsUrl = wsUrl;
    this.net = net;
    this.inbound = new FifoDelay(net.rng, net.lagMs, net.jitterMs);
    this.ws = null;
    this.playerId = null;
    this.roomCode = null;
    this.isHost = false;
    this.simTick = 0;
    this.holeEpochMs = 0;
    this.hole = null;
    this.playing = false;
    this.balls = new Map();
    this.lastPuttClientTick = null;
    this.mismatches = [];
    this.localClashes = 0;
    this.puttAppliedRemote = 0;
    this.selfHitByRemote = false;
    this.remotePuttAppliedAt = null;
    this.catchUpStepsAfterRemotePutt = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => {
        reject(
          new Error(
            this.name +
              ' cannot connect to ' +
              this.wsUrl +
              (err && err.message ? ': ' + err.message : '')
          )
        );
      });
      this.ws.on('message', (data) => {
        // Unpredictable FIFO delay before handler runs.
        this.inbound.push(() => {
          try {
            this.onMessage(JSON.parse(data.toString()));
          } catch (e) {
            /* ignore */
          }
        });
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  selfBall() {
    return this.balls.get(this.playerId) || null;
  }

  onMessage(msg) {
    if (msg.type === 'welcome') {
      this.playerId = msg.playerId;
      this.isHost = !!msg.isHost;
    } else if (msg.type === 'relay_created' || msg.type === 'relay_reconnected') {
      this.roomCode = msg.room_code;
    } else if (msg.type === 'roundState') {
      this.playing = true;
      const holes = Shared.COURSES[msg.courseIndex || 0].holes;
      this.hole = Shared.normalizeHole(JSON.parse(JSON.stringify(holes[msg.holeIndex])));
      this.simTick = msg.tick || 0;
      if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;
      else if (typeof msg.hostTimeMs === 'number') {
        this.holeEpochMs = msg.hostTimeMs - this.simTick * TICK_MS;
      }
      this.balls.clear();
      for (const b of msg.balls || []) {
        const ball = Shared.createBallState({
          x: b.x,
          y: b.y,
          vx: b.vx || 0,
          vy: b.vy || 0,
        });
        ball.id = b.id;
        ball.strokes = b.strokes || 0;
        ball.holedOut = !!b.holedOut;
        this.balls.set(b.id, ball);
      }
      Shared.setHoleObstaclesAtTick(this.hole, this.simTick);
    } else if (msg.type === 'clockSync') {
      if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;
      if (typeof msg.tick === 'number') {
        this.simTick = msg.tick;
        if (this.hole) Shared.setHoleObstaclesAtTick(this.hole, this.simTick);
      }
    } else if (msg.type === 'puttApplied') {
      this.onPuttApplied(msg);
    } else if (msg.type === 'snapshot') {
      this.onSnapshot(msg);
    }
  }

  onPuttApplied(msg) {
    if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;
    let ball = this.balls.get(msg.playerId);
    if (!ball) {
      ball = Shared.createBallState({ x: msg.x, y: msg.y });
      ball.id = msg.playerId;
      this.balls.set(msg.playerId, ball);
    }
    if (msg.playerId === this.playerId) {
      if (Math.hypot(ball.vx, ball.vy) >= STOP) return;
      ball.x = msg.x;
      ball.y = msg.y;
      ball.vx = msg.vx || 0;
      ball.vy = msg.vy || 0;
      return;
    }
    // Remote: impulse only. Free-run is shared catchUp — no single-ball aging.
    this.puttAppliedRemote++;
    this.remotePuttAppliedAt = Date.now();
    this.catchUpStepsAfterRemotePutt = 0;
    ball.x = msg.x;
    ball.y = msg.y;
    ball.vx = msg.vx || 0;
    ball.vy = msg.vy || 0;
    ball.z = 0;
    ball.vz = 0;
    if (typeof msg.strokes === 'number') ball.strokes = msg.strokes;
  }

  targetTick() {
    if (!this.holeEpochMs) return this.simTick;
    return Math.max(0, Math.floor((Date.now() - this.holeEpochMs) / TICK_MS));
  }

  stepOne() {
    this.simTick += 1;
    Shared.setHoleObstaclesAtTick(this.hole, this.simTick);
    const active = [...this.balls.values()].filter((b) => !b.holedOut);
    for (let s = 0; s < PHYS; s++) {
      for (const ball of active) {
        Shared.stepBallPhysics(ball, this.hole, Shared.TICK_DT / PHYS);
      }
      const now = active
        .filter((b) => !b.holedOut)
        .sort((a, b) => ((a.id || '') < (b.id || '') ? -1 : (a.id || '') > (b.id || '') ? 1 : 0));
      for (let i = 0; i < now.length; i++) {
        for (let j = i + 1; j < now.length; j++) {
          const pa = now[i];
          const pb = now[j];
          const vA0 = Math.hypot(pa.vx, pa.vy);
          const vB0 = Math.hypot(pb.vx, pb.vy);
          if (Shared.resolveBallBallCollision(pa, pb)) {
            this.localClashes++;
            if (
              (pa.id === this.playerId && vA0 < STOP && vB0 >= STOP) ||
              (pb.id === this.playerId && vB0 < STOP && vA0 >= STOP)
            ) {
              this.selfHitByRemote = true;
            }
          }
        }
      }
    }
  }

  catchUp() {
    if (!this.playing || !this.hole) return;
    const t = this.targetTick();
    let g = 0;
    while (this.simTick < t && g++ < 8) {
      this.stepOne();
      if (this.remotePuttAppliedAt != null) this.catchUpStepsAfterRemotePutt++;
    }
  }

  keepalive() {
    this.send({
      type: 'clientClock',
      tick: this.simTick,
      clientTimeMs: Date.now(),
      lastHostTick: this.simTick,
    });
  }

  putt(drag) {
    const me = this.selfBall();
    if (!me) throw new Error(this.name + ': no self ball');
    const clientTick = this.simTick;
    this.lastPuttClientTick = clientTick;
    const launch = Shared.computeLaunchVelocity(Shared.clampDragVector(drag));
    me.vx = launch.vx;
    me.vy = launch.vy;
    me.z = 0;
    me.vz = 0;
    me.strokes = (me.strokes || 0) + 1;
    this.send({ type: 'putt', dragVector: drag, clientTick });
    return { clientTick, launchV: Math.hypot(launch.vx, launch.vy) };
  }

  onSnapshot(msg) {
    const reason = msg.reason || 'idle';
    const hard = reason === 'replay' || reason === 'resync' ? true : !!msg.hard;
    if (!hard || !this.playerId) return;

    const tick = msg.tick;
    const clientTickBefore = this.simTick;
    const sampleInPast = typeof tick === 'number' && tick < clientTickBefore;
    const me = this.selfBall();
    const selfMoving = me && Math.hypot(me.vx, me.vy) >= STOP;

    if (
      !msg.rejectReason &&
      typeof tick === 'number' &&
      this.lastPuttClientTick != null &&
      tick < this.lastPuttClientTick
    ) {
      return;
    }
    if (reason === 'idle' && !msg.rejectReason && selfMoving) return;

    if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;

    const beforeSelf = me ? { x: me.x, y: me.y, vx: me.vx, vy: me.vy } : null;

    if (typeof tick === 'number') {
      this.simTick = tick;
      if (this.hole) Shared.setHoleObstaclesAtTick(this.hole, tick);
    }

    for (const b of msg.balls || []) {
      let ball = this.balls.get(b.id);
      if (!ball) {
        ball = Shared.createBallState({ x: b.x, y: b.y });
        ball.id = b.id;
        this.balls.set(b.id, ball);
      }
      ball.x = b.x;
      ball.y = b.y;
      ball.vx = b.vx || 0;
      ball.vy = b.vy || 0;
      if (typeof b.strokes === 'number') ball.strokes = b.strokes;
      ball.holedOut = !!b.holedOut;
    }

    if (sampleInPast) {
      let g = 0;
      while (this.simTick < clientTickBefore && g++ < 256) this.stepOne();
    }

    const self = this.selfBall();
    if (!self || !beforeSelf) return;

    const dPos = Math.hypot(self.x - beforeSelf.x, self.y - beforeSelf.y);
    const dV = Math.hypot(self.vx - beforeSelf.vx, self.vy - beforeSelf.vy);
    const beforeV = Math.hypot(beforeSelf.vx, beforeSelf.vy);
    const afterV = Math.hypot(self.vx, self.vy);
    const matched = dPos < MATCH_PX && dV < MATCH_V;
    const moving = beforeV >= STOP || afterV >= STOP;

    if (matched) {
      self.x = beforeSelf.x;
      self.y = beforeSelf.y;
      self.vx = beforeSelf.vx;
      self.vy = beforeSelf.vy;
      return;
    }

    if (moving && (reason === 'replay' || reason === 'resync' || reason === 'event')) {
      this.mismatches.push({
        who: this.name,
        reason,
        sampleTick: tick,
        clientTickBefore,
        dPos: Math.round(dPos * 10) / 10,
        dV: Math.round(dV * 10) / 10,
        beforeV: Math.round(beforeV * 10) / 10,
        afterV: Math.round(afterV * 10) / 10,
        catchUpStepsAfterRemotePutt: this.catchUpStepsAfterRemotePutt,
        localClashes: this.localClashes,
        selfHitByRemote: this.selfHitByRemote,
      });
    }
  }

  close() {
    this.inbound.close();
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function probeWs(url, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      ws.close();
      resolve();
    });
    ws.on('error', () => {
      reject(
        new Error(
          'Cannot connect to ' +
            url +
            ' (' +
            label +
            ') — start: npm start AND npm run lag-proxy'
        )
      );
    });
  });
}

function dragToward(from, to, power) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: (-dx / len) * power, y: (-dy / len) * power };
}

/** Draw a lag profile that is not a single fixed sweet spot. */
function drawNetProfile(rng) {
  // One-way extra lag 15–180ms, jitter 0–90ms (can exceed lag for messiness).
  const lagMs = 15 + Math.floor(rng() * 166);
  const jitterMs = Math.floor(rng() * 91);
  return { lagMs, jitterMs };
}

async function setupPair(opts) {
  const hostNet = opts.hostNet;
  const guestNet = opts.guestNet;
  const host = new DualClient(opts.hostName || 'host', opts.hostUrl || PROXY, hostNet);
  const guest = new DualClient(opts.guestName || 'guest', opts.guestUrl || PROXY, guestNet);
  await host.connect();
  await guest.connect();
  host.send({ type: 'relay_create', player_name: opts.hostName || 'E2EHost' });
  await sleep(200 + hostNet.lagMs + hostNet.jitterMs);
  if (!host.roomCode) {
    await host.inbound.drain(2000);
  }
  if (!host.roomCode) throw new Error('no room_code');
  guest.send({
    type: 'relay_join',
    room_code: host.roomCode,
    player_name: opts.guestName || 'E2EGuest',
  });
  await sleep(250 + Math.max(hostNet.lagMs, guestNet.lagMs) + 80);
  host.send({ type: 'startRound', courseIndex: 0 });

  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    host.catchUp();
    guest.catchUp();
    if (
      host.playing &&
      guest.playing &&
      host.balls.size >= 2 &&
      guest.balls.size >= 2 &&
      host.holeEpochMs &&
      guest.holeEpochMs
    ) {
      break;
    }
    await sleep(16);
  }
  if (host.balls.size < 2 || guest.balls.size < 2) {
    throw new Error(
      'need 2 balls host=' +
        host.balls.size +
        ' guest=' +
        guest.balls.size +
        ' netH=' +
        hostNet.lagMs +
        '±' +
        hostNet.jitterMs +
        ' netG=' +
        guestNet.lagMs +
        '±' +
        guestNet.jitterMs
    );
  }
  for (let i = 0; i < 20; i++) {
    host.catchUp();
    guest.catchUp();
    host.keepalive();
    guest.keepalive();
    await sleep(30 + Math.floor(hostNet.rng() * 40));
  }
  return { host, guest };
}

async function coastBoth(host, guest, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    host.catchUp();
    guest.catchUp();
    if (Date.now() % 333 < 25) {
      host.keepalive();
      guest.keepalive();
    }
    await sleep(16);
  }
  await host.inbound.drain(500);
  await guest.inbound.drain(500);
  host.catchUp();
  guest.catchUp();
}

/**
 * Phase-through that is *not* excused: we had free-run time after remote putt
 * (catchUp steps) but never predicted a hit, and hard yanked rest→fly.
 */
function unjustifiedPhaseThrough(target) {
  return target.mismatches.filter((m) => {
    const restToFly = m.beforeV < STOP && m.afterV >= STOP * 2;
    const severe = m.dPos >= SEVERE_DPos || m.dV >= SEVERE_DV;
    const hadFreeRun = (m.catchUpStepsAfterRemotePutt || 0) >= 3;
    const neverPredicted = !m.selfHitByRemote && (m.localClashes || 0) === 0;
    return restToFly && severe && hadFreeRun && neverPredicted;
  });
}

async function trialIntoResting(cfg, trialIndex, baseSeed) {
  const rng = makeRng((baseSeed + trialIndex * 9973) >>> 0);
  const hostNet = { rng, ...drawNetProfile(rng) };
  const guestNet = {
    rng: makeRng((baseSeed + trialIndex * 9973 + 1) >>> 0),
    ...drawNetProfile(makeRng((baseSeed + trialIndex * 9973 + 1) >>> 0)),
  };
  // Optional: force one side near-zero extra delay sometimes (real asym mix).
  if (rng() < 0.25) hostNet.lagMs = Math.floor(rng() * 20);
  if (rng() < 0.25) guestNet.lagMs = Math.floor(rng() * 20);

  const { host, guest } = await setupPair({
    hostUrl: cfg.hostUrl,
    guestUrl: cfg.guestUrl,
    hostName: cfg.hostName,
    guestName: cfg.guestName,
    hostNet,
    guestNet,
  });

  const attacker = cfg.attacker === 'host' ? host : guest;
  const target = cfg.attacker === 'host' ? guest : host;
  const aBall = attacker.selfBall();
  const tOnA = attacker.balls.get(target.playerId);
  if (!aBall || !tOnA) {
    host.close();
    guest.close();
    throw new Error('missing poses');
  }

  attacker.putt(dragToward(aBall, tOnA, 90 + Math.floor(rng() * 20)));
  // Coast length also varies — not a fixed 2.4s sweet spot.
  await coastBoth(host, guest, 1800 + Math.floor(rng() * 1200));

  const phase = unjustifiedPhaseThrough(target);
  // Hard fail = never got remote putt, or rest→fly hard after free-run with zero local
  // clash prediction (true phase-through). Local clash is expected often but not every
  // random lag/aim draw (path can miss); requiring it every trial rewards aiming hacks.
  const ok = target.puttAppliedRemote >= 1 && phase.length === 0;

  const summary = {
    trial: trialIndex,
    hostNet: { lagMs: hostNet.lagMs, jitterMs: hostNet.jitterMs },
    guestNet: { lagMs: guestNet.lagMs, jitterMs: guestNet.jitterMs },
    puttAppliedRemote: target.puttAppliedRemote,
    localClashes: target.localClashes,
    selfHitByRemote: target.selfHitByRemote,
    catchUpStepsAfterRemotePutt: target.catchUpStepsAfterRemotePutt,
    phaseThroughUnjustified: phase.length,
    mismatches: target.mismatches.length,
    predictedHit: target.selfHitByRemote || target.localClashes >= 1,
    ok,
  };

  host.close();
  guest.close();
  return summary;
}

async function runScenarioTrials(name, cfg) {
  const baseSeed =
    (Number(process.env.CLASH_SEED) || (Date.now() ^ (process.pid * 2654435761))) >>> 0;
  console.log('---', name, 'seed', baseSeed, 'trials', TRIALS, '---');
  const results = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const r = await trialIntoResting(cfg, i, baseSeed);
      results.push(r);
      console.log(
        r.ok ? '  PASS' : '  FAIL',
        'trial',
        i,
        'lagH',
        r.hostNet.lagMs + '±' + r.hostNet.jitterMs,
        'lagG',
        r.guestNet.lagMs + '±' + r.guestNet.jitterMs,
        'remotePutt',
        r.puttAppliedRemote,
        'localClash',
        r.localClashes,
        'selfHit',
        r.selfHitByRemote,
        'freeRunSteps',
        r.catchUpStepsAfterRemotePutt,
        'badPhase',
        r.phaseThroughUnjustified
      );
    } catch (e) {
      results.push({ trial: i, ok: false, error: e.message || String(e) });
      console.error('  FAIL trial', i, e.message || e);
    }
  }
  const fails = results.filter((r) => !r.ok);
  const passCount = results.filter((r) => r.ok).length;
  const predicted = results.filter((r) => r.predictedHit).length;
  // All trials must avoid unjustified phase-through. Prediction rate is logged;
  // under random lag we expect some local hits but do not require 100% (geometry/miss).
  const ok = fails.length === 0;
  console.log(
    '  summary',
    name,
    'pass',
    passCount + '/' + TRIALS,
    'predictedHit',
    predicted + '/' + TRIALS
  );
  return { name, ok, results, passCount, predicted, fails };
}

async function scenarioMutual(baseSeed) {
  const results = [];
  console.log('--- mutual_headon seed', baseSeed, 'trials', TRIALS, '---');
  for (let i = 0; i < TRIALS; i++) {
    const rng = makeRng((baseSeed + i * 4243) >>> 0);
    const hostNet = { rng, ...drawNetProfile(rng) };
    const guestNet = {
      rng: makeRng((baseSeed + i * 4243 + 9) >>> 0),
      ...drawNetProfile(makeRng((baseSeed + i * 4243 + 9) >>> 0)),
    };
    try {
      const { host, guest } = await setupPair({
        hostUrl: PROXY,
        guestUrl: PROXY,
        hostNet,
        guestNet,
      });
      const h = host.selfBall();
      const g = guest.selfBall();
      const gOnH = host.balls.get(guest.playerId);
      const hOnG = guest.balls.get(host.playerId);
      host.putt(dragToward(h, gOnH, 80 + Math.floor(rng() * 30)));
      await sleep(20 + Math.floor(rng() * 80));
      guest.putt(dragToward(g, hOnG, 80 + Math.floor(rng() * 30)));
      await coastBoth(host, guest, 1800 + Math.floor(rng() * 1000));
      const ok = host.puttAppliedRemote >= 1 && guest.puttAppliedRemote >= 1;
      results.push({
        trial: i,
        ok,
        hostRemote: host.puttAppliedRemote,
        guestRemote: guest.puttAppliedRemote,
        clashes: host.localClashes + guest.localClashes,
      });
      console.log(
        ok ? '  PASS' : '  FAIL',
        'trial',
        i,
        'clashes',
        host.localClashes + guest.localClashes,
        'remotes',
        host.puttAppliedRemote,
        guest.puttAppliedRemote
      );
      host.close();
      guest.close();
    } catch (e) {
      results.push({ trial: i, ok: false, error: e.message || String(e) });
      console.error('  FAIL trial', i, e.message || e);
    }
  }
  const ok = results.every((r) => r.ok);
  return { name: 'mutual_headon', ok, results };
}

async function main() {
  await probeWs(DIRECT, 'relay');
  await probeWs(PROXY, 'lag-proxy');

  const baseSeed =
    (Number(process.env.CLASH_SEED) || (Date.now() ^ (process.pid * 2654435761))) >>> 0;

  const scenarios = [];
  scenarios.push(
    await runScenarioTrials('into_resting_both_proxy', {
      attacker: 'host',
      hostUrl: PROXY,
      guestUrl: PROXY,
      hostName: 'H',
      guestName: 'G',
    })
  );
  scenarios.push(await scenarioMutual(baseSeed ^ 0xabc));
  scenarios.push(
    await runScenarioTrials('asym_proxy_into_direct', {
      attacker: 'host',
      hostUrl: PROXY,
      guestUrl: DIRECT,
      hostName: 'LagH',
      guestName: 'DirG',
    })
  );
  scenarios.push(
    await runScenarioTrials('asym_direct_into_proxy', {
      attacker: 'host',
      hostUrl: DIRECT,
      guestUrl: PROXY,
      hostName: 'DirH',
      guestName: 'LagG',
    })
  );

  const failed = scenarios.filter((s) => !s.ok);
  if (failed.length) {
    console.error(
      'e2e-lag-proxy-clash FAILED —',
      failed.map((s) => s.name).join(', ')
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    'e2e-lag-proxy-clash: PASS (%d scenarios × %d random-lag trials)',
    scenarios.length,
    TRIALS
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
