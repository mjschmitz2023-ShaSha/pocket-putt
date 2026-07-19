#!/usr/bin/env node
/**
 * 1p residual regression under REAL lag-proxy + extra unpredictable FIFO delay.
 *
 * Apply path MUST match game.js hard-truth law (docs/mp-hard-truth-sync.md):
 *   soft = juice only
 *   hard @ H → seed → resim H→present = sim truth
 *   residual match = visual no-op only
 *   causality ignore: tick < lastOptimisticPutt; hard idle also if host strokes
 *   behind local or sampleTick <= putt tick (no idle-while-moving maze)
 *
 * Anti-hack: multi-trial random lag/jitter (not a single 80±40 sweet spot).
 *
 * Requires: npm start (:8977) AND npm run lag-proxy (:8978)
 *   npm run test:e2e-lag
 *   E2E_LAG_TRIALS=5 E2E_LAG_SEED=123 npm run test:e2e-lag
 */
'use strict';

const WebSocket = require('ws');
const Shared = require('../shared.js');

const PROXY = process.env.LAG_PROXY_WS || 'ws://127.0.0.1:8978/ws';
const TICK_MS = Shared.TICK_MS;
const STOP = Shared.STOP_THRESHOLD;
const PHYS = 4;
const MATCH_PX = 3;
const MATCH_V = 12;
const TRIALS = Math.max(3, Number(process.env.E2E_LAG_TRIALS) || 4);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

/** FIFO delayed delivery — never reorders (TCP). */
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
    const at = Math.max(Date.now() + this.delayMs(), this.lastAt + 1);
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
      try {
        this.q.shift().fn();
      } catch (e) {
        console.error(e);
      }
    }
    this.arm();
  }
  async drain(maxMs) {
    const t0 = Date.now();
    while (this.q.length && Date.now() - t0 < maxMs) {
      this.flush();
      await sleep(4);
    }
  }
  close() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.q.length = 0;
  }
}

function drawLag(rng) {
  return {
    lagMs: 15 + Math.floor(rng() * 166),
    jitterMs: Math.floor(rng() * 91),
  };
}

/**
 * Hard-truth client (mirrors game.js mpApplyCorrection self path).
 */
class HardTruthClient {
  constructor(name, net) {
    this.name = name;
    this.net = net;
    this.inbound = new FifoDelay(net.rng, net.lagMs, net.jitterMs);
    this.ws = null;
    this.playerId = null;
    this.simTick = 0;
    this.holeEpochMs = 0;
    this.ball = null;
    this.hole = null;
    this.playing = false;
    this.strokes = 0;
    this.lastPuttClientTick = null;
    this.mismatches = [];
    this.rejectSnaps = [];
    this.staleIgnored = 0;
    this.matchedReplays = 0;
    this.puttAppliedTicks = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(PROXY);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) =>
        reject(new Error(this.name + ' connect fail: ' + (err.message || err)))
      );
      this.ws.on('message', (data) => {
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

  onMessage(msg) {
    if (msg.type === 'welcome') {
      this.playerId = msg.playerId;
    } else if (msg.type === 'roundState') {
      this.playing = true;
      const holes = Shared.COURSES[msg.courseIndex || 0].holes;
      this.hole = Shared.normalizeHole(JSON.parse(JSON.stringify(holes[msg.holeIndex])));
      this.simTick = msg.tick || 0;
      if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;
      else if (typeof msg.hostTimeMs === 'number') {
        this.holeEpochMs = msg.hostTimeMs - this.simTick * TICK_MS;
      }
      const b = (msg.balls || []).find((x) => x.id === this.playerId);
      if (b) {
        this.ball = Shared.createBallState({ x: b.x, y: b.y });
        this.strokes = b.strokes || 0;
      }
      Shared.setHoleObstaclesAtTick(this.hole, this.simTick);
    } else if (msg.type === 'clockSync') {
      if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;
      else if (typeof msg.hostTimeMs === 'number' && typeof msg.tick === 'number') {
        this.holeEpochMs = msg.hostTimeMs - msg.tick * TICK_MS;
      }
      if (typeof msg.tick === 'number') {
        this.simTick = msg.tick;
        if (this.hole) Shared.setHoleObstaclesAtTick(this.hole, this.simTick);
      }
    } else if (msg.type === 'puttApplied') {
      if (typeof msg.holeEpochMs === 'number') this.holeEpochMs = msg.holeEpochMs;
      if (typeof msg.tick === 'number') this.puttAppliedTicks.push(msg.tick);
    } else if (msg.type === 'snapshot') {
      this.onSnapshot(msg);
    }
  }

  targetTick() {
    if (!this.holeEpochMs) return this.simTick;
    return Math.max(0, Math.floor((Date.now() - this.holeEpochMs) / TICK_MS));
  }

  stepOne() {
    this.simTick += 1;
    Shared.setHoleObstaclesAtTick(this.hole, this.simTick);
    for (let s = 0; s < PHYS; s++) {
      Shared.stepBallPhysics(this.ball, this.hole, Shared.TICK_DT / PHYS);
    }
  }

  catchUp() {
    if (!this.playing || !this.ball) return;
    const t = this.targetTick();
    let g = 0;
    while (this.simTick < t && g++ < 8) this.stepOne();
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
    const clientTick = this.simTick;
    this.lastPuttClientTick = clientTick;
    const launch = Shared.computeLaunchVelocity(Shared.clampDragVector(drag));
    this.ball.vx = launch.vx;
    this.ball.vy = launch.vy;
    this.ball.z = 0;
    this.ball.vz = 0;
    this.strokes += 1;
    this.send({ type: 'putt', dragVector: drag, clientTick });
    return { clientTick, launchV: Math.hypot(launch.vx, launch.vy) };
  }

  /**
   * Law: docs/mp-hard-truth-sync.md — same as game.js (no idle-while-moving ignores).
   */
  onSnapshot(msg) {
    const reason = msg.reason || 'idle';
    const hard = reason === 'resync' || reason === 'replay' ? true : !!msg.hard;
    if (!this.ball || !this.playerId) return;

    // Soft = juice only.
    if (!hard) return;

    const tick = msg.tick;
    const clientTickBefore = this.simTick;
    const sampleInPast = typeof tick === 'number' && tick < clientTickBefore;

    if (msg.rejectReason) {
      this.rejectSnaps.push({
        rejectReason: msg.rejectReason,
        reason,
        sampleTick: tick,
        clientTickBefore,
      });
    }

    // Causality (mirror game.js): hard that cannot include our putt.
    const hostMe = (msg.balls || []).find((x) => x.id === this.playerId);
    const idleHostBehindPutt =
      reason === 'idle' &&
      hostMe &&
      typeof hostMe.strokes === 'number' &&
      this.strokes > hostMe.strokes;
    const idleAtOrBeforePutt =
      reason === 'idle' &&
      this.lastPuttClientTick != null &&
      typeof tick === 'number' &&
      tick <= this.lastPuttClientTick;
    const hardBeforePutt =
      typeof tick === 'number' &&
      this.lastPuttClientTick != null &&
      tick < this.lastPuttClientTick;
    if (
      !msg.rejectReason &&
      (hardBeforePutt || idleAtOrBeforePutt || idleHostBehindPutt)
    ) {
      this.staleIgnored++;
      return;
    }

    if (typeof msg.holeEpochMs === 'number') {
      this.holeEpochMs = msg.holeEpochMs;
    } else if (typeof msg.hostTimeMs === 'number' && typeof tick === 'number') {
      this.holeEpochMs = msg.hostTimeMs - tick * TICK_MS;
    }

    const b = (msg.balls || []).find((x) => x.id === this.playerId);
    if (!b) return;

    const before = {
      x: this.ball.x,
      y: this.ball.y,
      vx: this.ball.vx,
      vy: this.ball.vy,
    };

    // Seed host@H
    if (typeof tick === 'number') {
      this.simTick = tick;
      Shared.setHoleObstaclesAtTick(this.hole, tick);
    }
    this.ball.x = b.x;
    this.ball.y = b.y;
    this.ball.vx = b.vx || 0;
    this.ball.vy = b.vy || 0;
    this.ball.z = b.z || 0;
    this.ball.vz = b.vz || 0;
    if (typeof b.strokes === 'number') this.strokes = b.strokes;

    // Resim H→present
    if (sampleInPast) {
      let g = 0;
      while (this.simTick < clientTickBefore && g++ < 256) this.stepOne();
    }

    const dPos = Math.hypot(this.ball.x - before.x, this.ball.y - before.y);
    const dV = Math.hypot(this.ball.vx - before.vx, this.ball.vy - before.vy);
    const beforeV = Math.hypot(before.vx, before.vy);
    const afterV = Math.hypot(this.ball.vx, this.ball.vy);
    const matched = dPos < MATCH_PX && dV < MATCH_V;
    const moving = beforeV >= STOP || afterV >= STOP;

    if (matched) {
      // Visual no-op only
      this.ball.x = before.x;
      this.ball.y = before.y;
      this.ball.vx = before.vx;
      this.ball.vy = before.vy;
      if (reason === 'replay') this.matchedReplays++;
      return;
    }

    // Host-resimmed present is sim truth — record if moving mid-flight correction.
    if (moving && (reason === 'replay' || reason === 'resync')) {
      this.mismatches.push({
        reason,
        rejectReason: msg.rejectReason || null,
        sampleTick: tick,
        clientTickBefore,
        lastPuttClientTick: this.lastPuttClientTick,
        dPos: Math.round(dPos * 10) / 10,
        dV: Math.round(dV * 10) / 10,
        beforeV: Math.round(beforeV * 10) / 10,
        afterV: Math.round(afterV * 10) / 10,
        hostSeedV: Math.round(Math.hypot(b.vx || 0, b.vy || 0) * 10) / 10,
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

async function probeProxy() {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(PROXY);
    ws.on('open', () => {
      ws.close();
      resolve();
    });
    ws.on('error', () => {
      reject(
        new Error(
          'Cannot connect to ' + PROXY + ' — start: npm start AND npm run lag-proxy'
        )
      );
    });
  });
}

async function startClient(name, net) {
  const c = new HardTruthClient(name, net);
  await c.connect();
  c.send({ type: 'relay_create', player_name: name });
  await sleep(200 + net.lagMs + net.jitterMs);
  await c.inbound.drain(1500);
  c.send({ type: 'startRound', courseIndex: 0 });
  const t0 = Date.now();
  while (!c.playing || !c.ball || !c.holeEpochMs) {
    if (Date.now() - t0 > 5000) throw new Error(name + ': no roundState');
    c.catchUp();
    await sleep(16);
  }
  return c;
}

async function waitSettled(c, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    c.catchUp();
    if (Math.hypot(c.ball.vx, c.ball.vy) < STOP && c.simTick > 30) return true;
    if (Date.now() % 350 < 20) c.keepalive();
    await sleep(16);
  }
  return Math.hypot(c.ball.vx, c.ball.vy) < STOP;
}

async function coastAfterPutt(c, ms) {
  const waitUntil = Date.now() + ms;
  while (Date.now() < waitUntil) {
    c.catchUp();
    if (Math.floor(Date.now() / 333) !== Math.floor((Date.now() - 16) / 333)) {
      c.keepalive();
    }
    await sleep(16);
  }
  await c.inbound.drain(400);
  c.catchUp();
}

async function trialMultiPutt(trial, baseSeed) {
  const rng = makeRng((baseSeed + trial * 7919) >>> 0);
  const net = { rng, ...drawLag(rng) };
  const c = await startClient('E2E1p_' + trial, net);
  const aims = [
    { x: 100, y: 12 },
    { x: 80, y: -40 },
    { x: -90, y: 25 },
    { x: 60, y: 60 },
  ];
  let putts = 0;
  const t0 = Date.now();
  const budget = 10000 + net.lagMs * 4;
  while (Date.now() - t0 < budget && putts < aims.length) {
    c.catchUp();
    c.keepalive();
    if (
      c.playing &&
      c.ball &&
      Math.hypot(c.ball.vx, c.ball.vy) < STOP &&
      c.simTick > 40
    ) {
      c.putt(aims[putts]);
      putts++;
      await coastAfterPutt(c, 1400 + Math.floor(rng() * 800));
      continue;
    }
    await sleep(16);
  }
  c.close();
  const ok =
    putts >= 3 &&
    c.mismatches.length === 0 &&
    c.rejectSnaps.filter((r) => r.rejectReason === 'before_keepalive').length === 0 &&
    c.matchedReplays >= 1;
  return {
    trial,
    name: 'multi_putt',
    ok,
    net: { lagMs: net.lagMs, jitterMs: net.jitterMs },
    putts,
    matchedReplays: c.matchedReplays,
    mismatches: c.mismatches,
    rejectSnaps: c.rejectSnaps,
  };
}

async function trialKeepaliveReorder(trial, baseSeed) {
  const rng = makeRng((baseSeed + trial * 4243 + 11) >>> 0);
  const net = { rng, ...drawLag(rng) };
  // Keep reorder lag moderate so putt stays in history window.
  net.lagMs = 40 + Math.floor(rng() * 80);
  net.jitterMs = Math.floor(rng() * 50);
  const c = await startClient('E2EKA_' + trial, net);
  for (let i = 0; i < 12; i++) {
    c.catchUp();
    c.keepalive();
    await sleep(40 + Math.floor(rng() * 40));
  }
  const settled = await waitSettled(c, 5000);
  if (!settled) {
    c.close();
    return { trial, name: 'keepalive_reorder', ok: false, error: 'never settled' };
  }
  c.catchUp();
  const puttTick = c.simTick;
  const launch = Shared.computeLaunchVelocity(Shared.clampDragVector({ x: 100, y: 12 }));
  c.ball.vx = launch.vx;
  c.ball.vy = launch.vy;
  c.lastPuttClientTick = puttTick;
  c.strokes += 1;
  const ahead = 3 + Math.floor(rng() * 5);
  for (let i = 0; i < ahead; i++) c.stepOne();
  c.keepalive();
  c.send({ type: 'putt', dragVector: { x: 100, y: 12 }, clientTick: puttTick });
  await coastAfterPutt(c, 1400 + Math.floor(rng() * 600));
  c.close();

  const kaRejects = c.rejectSnaps.filter((r) => r.rejectReason === 'before_keepalive');
  const fatalRejects = c.rejectSnaps.filter((r) =>
    ['before_keepalive', 'too_old', 'untrusted', 'keepalive_stale'].includes(r.rejectReason)
  );
  const accepted =
    c.puttAppliedTicks.some((t) => Math.abs(t - puttTick) <= 2) || c.matchedReplays >= 1;
  return {
    trial,
    name: 'keepalive_reorder',
    ok:
      kaRejects.length === 0 &&
      fatalRejects.length === 0 &&
      accepted &&
      c.mismatches.length === 0,
    net: { lagMs: net.lagMs, jitterMs: net.jitterMs },
    mismatches: c.mismatches,
    rejectSnaps: c.rejectSnaps,
    matchedReplays: c.matchedReplays,
  };
}

async function trialVariedAims(trial, baseSeed) {
  const rng = makeRng((baseSeed + trial * 3331 + 3) >>> 0);
  const net = { rng, ...drawLag(rng) };
  const c = await startClient('E2EAim_' + trial, net);
  const aims = [
    { x: 110, y: 0 },
    { x: 40, y: 90 },
    { x: -70, y: -50 },
  ];
  let putts = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 9000 + net.lagMs * 3 && putts < aims.length) {
    c.catchUp();
    if (Date.now() % 333 < 20) c.keepalive();
    if (
      c.playing &&
      c.ball &&
      Math.hypot(c.ball.vx, c.ball.vy) < STOP &&
      c.simTick > 40
    ) {
      c.putt(aims[putts]);
      putts++;
      await coastAfterPutt(c, 1500 + Math.floor(rng() * 700));
      continue;
    }
    await sleep(16);
  }
  c.close();
  return {
    trial,
    name: 'varied_aims',
    ok: putts >= 2 && c.mismatches.length === 0 && c.matchedReplays >= 1,
    net: { lagMs: net.lagMs, jitterMs: net.jitterMs },
    putts,
    matchedReplays: c.matchedReplays,
    mismatches: c.mismatches,
  };
}

async function runTrials(label, trialFn, baseSeed) {
  console.log('---', label, 'seed', baseSeed, 'trials', TRIALS, '---');
  const results = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const r = await trialFn(i, baseSeed);
      results.push(r);
      console.log(
        r.ok ? '  PASS' : '  FAIL',
        'trial',
        i,
        r.net ? 'lag ' + r.net.lagMs + '±' + r.net.jitterMs : '',
        'mismatches=' + (r.mismatches ? r.mismatches.length : 0),
        r.matchedReplays != null ? 'matched=' + r.matchedReplays : '',
        r.error || ''
      );
      if (!r.ok && r.mismatches && r.mismatches.length) {
        for (const m of r.mismatches.slice(0, 3)) console.error('   ', m);
      }
      if (!r.ok && r.rejectSnaps && r.rejectSnaps.length) {
        for (const m of r.rejectSnaps.slice(0, 3)) console.error('    reject', m);
      }
    } catch (e) {
      results.push({ trial: i, name: label, ok: false, error: e.message || String(e) });
      console.error('  FAIL trial', i, e.message || e);
    }
  }
  const ok = results.every((r) => r.ok);
  console.log('  summary', label, ok ? 'PASS' : 'FAIL', results.filter((r) => r.ok).length + '/' + TRIALS);
  return { name: label, ok, results };
}

async function main() {
  await probeProxy();
  const baseSeed =
    (Number(process.env.E2E_LAG_SEED) || (Date.now() ^ (process.pid * 2654435761))) >>> 0;

  const scenarios = [
    await runTrials('multi_putt_residual', trialMultiPutt, baseSeed),
    await runTrials('keepalive_reorder', trialKeepaliveReorder, baseSeed ^ 0x111),
    await runTrials('varied_aims', trialVariedAims, baseSeed ^ 0x222),
  ];

  const failed = scenarios.filter((s) => !s.ok);
  if (failed.length) {
    console.error(
      'e2e-lag-proxy-putt FAILED —',
      failed.map((s) => s.name).join(', ')
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    'e2e-lag-proxy-putt: PASS (%d scenarios × %d random-lag trials, hard-truth client)',
    scenarios.length,
    TRIALS
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
