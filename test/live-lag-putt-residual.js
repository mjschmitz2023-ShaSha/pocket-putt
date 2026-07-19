#!/usr/bin/env node
/**
 * Solo + bidirectional lag: ClientModel hard-truth path; residual after seed@H→resim
 * must not produce hardSnapsWhileMoving (same gate as honest browser dogfood).
 *
 * Multi-trial random lag/jitter, FIFO (no reorder).
 *
 *   npm run test:live-lag
 *   LIVE_LAG_TRIALS=5 LIVE_LAG_SEED=42 npm run test:live-lag
 */
'use strict';

const Shared = require('../shared.js');
const { GameSession, TICK_MS } = require('../gameSession.js');
const { ClientModel } = require('./clientModel.js');

const STOP = Shared.STOP_THRESHOLD;
const FRAME_MS = 1000 / 60;
const TRIALS = Math.max(3, Number(process.env.LIVE_LAG_TRIALS) || 4);

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

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.outbox = [];
  }
  send(raw) {
    try {
      this.outbox.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }
  drain() {
    const m = this.outbox;
    this.outbox = [];
    return m;
  }
}

/** FIFO delayed pipe (TCP-like). */
class FifoNetPipe {
  constructor(delayMs, jitterMs, rng) {
    this.delayMs = delayMs;
    this.jitterMs = jitterMs;
    this.rng = rng;
    this.q = [];
    this.lastAt = 0;
  }
  push(msg, now) {
    const j = this.jitterMs ? (this.rng() * 2 - 1) * this.jitterMs : 0;
    const raw = now + this.delayMs + j;
    const at = Math.max(raw, this.lastAt + 0.001);
    this.lastAt = at;
    this.q.push({ at, msg });
  }
  pop(now) {
    const out = [];
    while (this.q.length && this.q[0].at <= now) out.push(this.q.shift().msg);
    return out;
  }
}

function runOnce(delayMs, jitterMs, seed) {
  const rngDown = makeRng(seed);
  const rngUp = makeRng(seed ^ 0x9e3779b9);
  const sock = new FakeSocket();
  const session = new GameSession({ code: 'LAG', joinUrl: 'LAG', joinUrlFallback: 'LAG' });
  const player = session.addPlayer(sock, { name: 'Solo', isLocal: true }).player;
  const client = new ClientModel({ playerId: player.id, courseIndex: 0 });
  const down = new FifoNetPipe(delayMs, jitterMs, rngDown);
  const up = new FifoNetPipe(delayMs, jitterMs, rngUp);

  session.handleMessage(player, { type: 'startRound', courseIndex: 0 });
  if (session.state !== 'PLAYING') session.startNewRound();

  let wallMs = 0;
  for (const m of sock.drain()) {
    if (m.type === 'roundState') client.onRoundState(m);
    else if (m.type === 'clockSync') client.onClockSync(m);
    else if (m.type === 'snapshot') client.onSnapshot(m, 0);
  }

  // Shared synthetic wall — both sides step toward floor(wallMs / TICK_MS).
  const puttFrames = [40, 200, 360].map((f, i) => f + Math.floor(rngDown() * 12) + i);
  const puttSet = new Set(puttFrames);

  for (let frame = 0; frame < 480; frame++) {
    wallMs = frame * FRAME_MS;
    const target = Math.floor(wallMs / TICK_MS);

    if (puttSet.has(frame)) {
      const cp = client.players.get(player.id);
      if (cp && Math.hypot(cp.vx, cp.vy) < STOP) {
        const drag = {
          x: 90 + Math.floor(rngUp() * 30),
          y: -20 + Math.floor(rngUp() * 40),
        };
        const ct = client.simTick;
        client.applyPuttLocal(player.id, drag, null);
        up.push({ type: 'putt', dragVector: drag, clientTick: ct }, wallMs);
      }
    }
    if (frame % 12 === 0) {
      up.push(
        {
          type: 'clientClock',
          tick: client.simTick,
          clientTimeMs: wallMs,
          lastHostTick: client.simTick,
        },
        wallMs
      );
    }

    for (const m of up.pop(wallMs)) {
      if (m.type === 'putt' || m.type === 'clientClock') {
        session.handleMessage(player, m);
      }
    }

    let g = 0;
    while (session.simTick < target && g++ < 8) session.stepSimulation();
    session.processPendingPutts();

    for (const m of sock.drain()) down.push(m, wallMs);
    for (const m of down.pop(wallMs)) {
      if (m.type === 'roundState') client.onRoundState(m);
      else if (m.type === 'clockSync') client.onClockSync(m);
      else if (m.type === 'puttApplied') client.onPuttApplied(m);
      else if (m.type === 'snapshot') client.onSnapshot(m, wallMs);
    }

    let c = 0;
    while (client.simTick < target && c++ < 8) client.stepOneTick();
  }

  const m = client.metrics;
  return {
    delayMs,
    jitterMs,
    seed,
    hardMoving: m.hardSnapsWhileMoving,
    hardSnaps: m.hardSnaps,
    rubberBands: (m.rubberBands || []).slice(-5),
  };
}

function run() {
  const baseSeed =
    (Number(process.env.LIVE_LAG_SEED) || (Date.now() ^ (process.pid * 2654435761))) >>> 0;
  console.log('live-lag-putt-residual: seed', baseSeed, 'trials', TRIALS);

  let anyFail = false;
  for (let i = 0; i < TRIALS; i++) {
    const rng = makeRng((baseSeed + i * 9973) >>> 0);
    const delayMs = 20 + Math.floor(rng() * 140);
    const jitterMs = Math.floor(rng() * 80);
    const seed = (baseSeed + i * 7919) >>> 0;
    const r = runOnce(delayMs, jitterMs, seed);
    if (r.hardMoving > 0) {
      anyFail = true;
      console.error(
        '  FAIL trial',
        i,
        'lag',
        delayMs + '±' + jitterMs,
        'hardMoving=' + r.hardMoving,
        'hardSnaps=' + r.hardSnaps
      );
      for (const e of r.rubberBands) console.error('   ', e);
    } else {
      console.log(
        '  PASS trial',
        i,
        'lag',
        delayMs + '±' + jitterMs,
        'hardSnaps=' + r.hardSnaps,
        'hardMoving=0'
      );
    }
  }

  if (anyFail) {
    console.error('live-lag-putt-residual: FAILED under random lag trials');
    process.exitCode = 1;
    return;
  }
  console.log(
    'live-lag-putt-residual: ok (%d trials, random bi-lag, hardMoving=0 / residual match)',
    TRIALS
  );
}

run();
