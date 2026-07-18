#!/usr/bin/env node
/**
 * Live-like regression: solo player + bidirectional lag + shared wall calendar.
 *
 * Asserts what the browser should see after tick-stamped putts:
 *   after host replay/resync hard snapshot is applied the way game.js does
 *   (seed @ sampleTick → resim to client present), residual must be ~0.
 *
 * Why older harness missed this:
 *   - solo_1p_bidirectional_lag gates hardSnapsWhileMoving from ClientModel's
 *     applyAuthorityPose, which measures dPos at seed time (client@C vs host@H)
 *     inconsistently and often while client is NOT ahead of host (same wallMs drive).
 *   - It never asserts residual AFTER sample→present resim (the live visual path).
 *   - maxSim peaks during free-run are allowed up to 500px.
 *
 * Usage: node test/live-lag-putt-residual.js
 */
'use strict';

const Shared = require('../shared.js');
const { GameSession, TICK_MS } = require('../gameSession.js');
const { ClientModel } = require('./clientModel.js');

const STOP = Shared.STOP_THRESHOLD;
const FRAME_MS = 1000 / 60;
const DELAY = 80;
const JITTER = 40;
const MATCH_PX = 0.75;
const MATCH_V = 3;

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

class NetPipe {
  constructor(delayMs, jitterMs, seed) {
    this.delayMs = delayMs;
    this.jitterMs = jitterMs;
    this.q = [];
    let a = seed;
    this.rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  push(msg, now) {
    const j = this.jitterMs ? (this.rng() * 2 - 1) * this.jitterMs : 0;
    this.q.push({ at: now + this.delayMs + j, msg });
    this.q.sort((a, b) => a.at - b.at);
  }
  pop(now) {
    const out = [];
    while (this.q.length && this.q[0].at <= now) out.push(this.q.shift().msg);
    return out;
  }
}

/** Same residual metric as game.js after sample→present resim. */
function residualAfterSampleResim(client, msg) {
  const tick = msg.tick;
  const reason = msg.reason || '';
  const hard = reason === 'resync' || reason === 'replay' ? true : !!msg.hard;
  if (!hard) return null;

  const clientTickBefore = client.simTick;
  const sampleInPast = typeof tick === 'number' && tick < clientTickBefore;
  const p = client.players.get(client.playerId);
  if (!p) return null;

  const before = {
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    z: p.z || 0,
    vz: p.vz || 0,
    tick: client.simTick,
  };

  // Seed host@tick
  client.simTick = tick;
  Shared.setHoleObstaclesAtTick(client.hole(), tick);
  for (const b of msg.balls || []) {
    if (b.id !== client.playerId) continue;
    p.x = b.x;
    p.y = b.y;
    p.vx = b.vx || 0;
    p.vy = b.vy || 0;
    p.z = b.z || 0;
    p.vz = b.vz || 0;
    if (typeof b.strokes === 'number') p.strokes = b.strokes;
  }

  if (sampleInPast) {
    let g = 0;
    while (client.simTick < clientTickBefore && g++ < 96) client.stepOneTick();
  }

  const dPos = Math.hypot(p.x - before.x, p.y - before.y);
  const dV = Math.hypot(p.vx - before.vx, p.vy - before.vy);
  const matched = dPos < MATCH_PX && dV < MATCH_V;
  const moving =
    Math.hypot(before.vx, before.vy) >= STOP || Math.hypot(p.vx, p.vy) >= STOP;

  // Match game.js: restore present on match (no-op)
  if (matched) {
    p.x = before.x;
    p.y = before.y;
    p.vx = before.vx;
    p.vy = before.vy;
    p.z = before.z;
    p.vz = before.vz;
  }

  return {
    reason,
    rejectReason: msg.rejectReason || null,
    sampleTick: tick,
    clientBefore: before.tick,
    clientAfter: client.simTick,
    sampleInPast,
    dPos,
    dV,
    matched,
    moving,
  };
}

function run() {
  const sock = new FakeSocket();
  const session = new GameSession({ code: 'LAG', joinUrl: 'LAG', joinUrlFallback: 'LAG' });
  const player = session.addPlayer(sock, { name: 'Solo', isLocal: true }).player;
  const client = new ClientModel({ playerId: player.id, courseIndex: 0 });
  const down = new NetPipe(DELAY, JITTER, 21);
  const up = new NetPipe(DELAY, JITTER, 22);

  session.handleMessage(player, { type: 'startRound', courseIndex: 0 });
  if (session.state !== 'PLAYING') session.startNewRound();

  // Synthetic shared wall calendar (both sides step toward floor(wallMs/TICK_MS)).
  let wallMs = 0;
  for (const m of sock.drain()) {
    if (m.type === 'roundState') client.onRoundState(m);
    else if (m.type === 'clockSync') client.onClockSync(m);
    else if (m.type === 'snapshot') client.onSnapshot(m, 0);
  }

  const failures = [];
  const puttFrames = [40, 200, 360];

  for (let frame = 0; frame < 450; frame++) {
    wallMs = frame * FRAME_MS;
    const target = Math.floor(wallMs / TICK_MS);

    if (puttFrames.includes(frame)) {
      const cp = client.players.get(player.id);
      if (cp && Math.hypot(cp.vx, cp.vy) < STOP) {
        const drag = { x: 100, y: 8 };
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
          clientTimeMs: Date.now(),
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
      else if (m.type === 'snapshot') {
        const r = residualAfterSampleResim(client, m);
        if (
          r &&
          r.moving &&
          (r.reason === 'replay' || r.reason === 'resync') &&
          !r.matched
        ) {
          failures.push(r);
        }
      }
    }

    let c = 0;
    while (client.simTick < target && c++ < 8) client.stepOneTick();
  }

  if (failures.length) {
    console.error('live-lag-putt-residual: FAILED %d correction residual(s)', failures.length);
    for (const f of failures.slice(0, 8)) {
      console.error(
        '  reason=%s reject=%s sampleTick=%s clientBefore=%s dPos=%.1f dV=%.1f',
        f.reason,
        f.rejectReason,
        f.sampleTick,
        f.clientBefore,
        f.dPos,
        f.dV
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    'live-lag-putt-residual: ok (bidirectional %dms±%dms, post-resim residual ~0 on replay)',
    DELAY,
    JITTER
  );
}

run();
