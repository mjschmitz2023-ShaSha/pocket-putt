#!/usr/bin/env node
/**
 * Keepalive / clock-trust unit tests (Android mobile bug regression).
 *
 * Bug: Chrome Android throttles setInterval past ~1s; host stale window was 1.2s →
 * clockTrusted flipped false → every putt rejected as untrusted / keepalive_stale.
 *
 * Contract after fix:
 *   - Putt acceptance uses history/future bounds only (not keepalive trust).
 *   - Sparse clientClock (1–2s gaps) must not reject putts.
 *   - True long silence still force-syncs once (frozen tab), but a later putt still works.
 */
'use strict';

const assert = require('assert');
const Shared = require('../shared.js');
const {
  GameSession,
  KEEPALIVE_STALE_MS,
  KEEPALIVE_EXPECT_MS,
} = require('../gameSession.js');

class FakeSocket {
  constructor() {
    this.sent = [];
    this.readyState = 1;
    this.bufferedAmount = 0;
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  drain() {
    const out = this.sent.slice();
    this.sent.length = 0;
    return out;
  }
}

function addPlayer(session, sock, name) {
  return session.addPlayer(sock, { name, isLocal: true }).player;
}

function beginPlaying(session, player, sock) {
  session.handleMessage(player, { type: 'startRound', courseIndex: 0 });
  if (session.state !== 'PLAYING') session.startNewRound();
  sock.drain();
  // Establish first keepalive like a real client hole start.
  session.handleMessage(player, {
    type: 'clientClock',
    tick: session.simTick,
    clientTimeMs: Date.now(),
    lastHostTick: session.simTick,
  });
}

function settle(session, ticks) {
  for (let i = 0; i < ticks; i++) session.stepSimulation();
}

function puttAtNow(session, player, sock, drag = { x: 100, y: 0 }) {
  sock.drain();
  const T = session.simTick;
  session.handleMessage(player, {
    type: 'putt',
    dragVector: drag,
    clientTick: T,
  });
  const msgs = sock.drain();
  const rejects = msgs.filter(
    (m) => m.type === 'snapshot' && m.rejectReason
  );
  const replays = msgs.filter(
    (m) => m.type === 'snapshot' && (m.reason === 'replay' || m.hard)
  );
  const applied = msgs.filter((m) => m.type === 'puttApplied');
  return { T, rejects, replays, applied, msgs };
}

function run() {
  assert.ok(
    KEEPALIVE_STALE_MS >= 4000,
    `stale window must tolerate Android 1s+ timer clamps (got ${KEEPALIVE_STALE_MS})`
  );
  assert.ok(
    KEEPALIVE_EXPECT_MS >= 800,
    `expect cadence should align with ~1s client clocks (got ${KEEPALIVE_EXPECT_MS})`
  );

  // --- 1) Android-style sparse keepalives: 1.5s silence then putt ---
  {
    const sock = new FakeSocket();
    const session = new GameSession({ code: 'KA1', joinUrl: 'KA1', joinUrlFallback: 'KA1' });
    const p = addPlayer(session, sock, 'Android');
    beginPlaying(session, p, sock);
    settle(session, 40);

    // Old bug: KEEPALIVE_STALE_MS was 1200. Simulate 1.5s timer throttle gap.
    p.lastKeepaliveWall = Date.now() - 1500;
    // Do not send clientClock — only putt (what a throttled tab looks like mid-aim).
    const r = puttAtNow(session, p, sock);
    assert.strictEqual(
      r.rejects.filter((m) =>
        ['untrusted', 'keepalive_stale'].includes(m.rejectReason)
      ).length,
      0,
      'must not reject putt after 1.5s keepalive gap'
    );
    assert.ok(
      r.applied.length >= 1 || r.replays.length >= 1,
      'putt must be accepted (puttApplied or replay hard)'
    );
    assert.strictEqual(p.clockTrusted, true, 'putt re-establishes liveness trust');
    console.log('  ok android_sparse_1_5s putt accepted');
  }

  // --- 2) Explicit untrusted flag must not block putts ---
  {
    const sock = new FakeSocket();
    const session = new GameSession({ code: 'KA2', joinUrl: 'KA2', joinUrlFallback: 'KA2' });
    const p = addPlayer(session, sock, 'Untrusted');
    beginPlaying(session, p, sock);
    settle(session, 40);

    p.clockTrusted = false;
    p.lastKeepaliveWall = Date.now() - 3000;
    const r = puttAtNow(session, p, sock, { x: 90, y: 10 });
    assert.strictEqual(
      r.rejects.filter((m) =>
        ['untrusted', 'keepalive_stale'].includes(m.rejectReason)
      ).length,
      0,
      'clockTrusted=false must not reject putts'
    );
    assert.ok(r.applied.length >= 1 || r.replays.length >= 1, 'putt accepted while untrusted');
    console.log('  ok untrusted_flag putt accepted');
  }

  // --- 3) True freeze still force-syncs once ---
  {
    const sock = new FakeSocket();
    const session = new GameSession({ code: 'KA3', joinUrl: 'KA3', joinUrlFallback: 'KA3' });
    const p = addPlayer(session, sock, 'Frozen');
    beginPlaying(session, p, sock);
    settle(session, 20);
    sock.drain();

    p.lastKeepaliveWall = Date.now() - (KEEPALIVE_STALE_MS + 50);
    assert.notStrictEqual(p.clockTrusted, false);
    // tickDriver runs starvation check (also advances sim — fine).
    session.tickDriver();
    assert.strictEqual(p.clockTrusted, false, 'long silence revokes liveness trust');
    const msgs = sock.drain();
    const resync = msgs.filter(
      (m) =>
        m.type === 'snapshot' &&
        (m.reason === 'resync' || m.rejectReason === 'keepalive_stale')
    );
    assert.ok(resync.length >= 1, 'starvation should force-sync once');
    // Second tickDriver should not spam force-sync while still untrusted.
    sock.drain();
    session.tickDriver();
    const again = sock.drain().filter(
      (m) => m.type === 'snapshot' && m.rejectReason === 'keepalive_stale'
    );
    assert.strictEqual(again.length, 0, 'no force-sync spam while still stale');
    console.log('  ok freeze force-sync once (staleMs=%d)', KEEPALIVE_STALE_MS);
  }

  // --- 4) After freeze force-sync, putt still lands ---
  {
    const sock = new FakeSocket();
    const session = new GameSession({ code: 'KA4', joinUrl: 'KA4', joinUrlFallback: 'KA4' });
    const p = addPlayer(session, sock, 'Thaw');
    beginPlaying(session, p, sock);
    settle(session, 40);
    p.lastKeepaliveWall = Date.now() - (KEEPALIVE_STALE_MS + 100);
    session.tickDriver();
    assert.strictEqual(p.clockTrusted, false);
    sock.drain();

    const r = puttAtNow(session, p, sock, { x: 80, y: -5 });
    assert.strictEqual(
      r.rejects.filter((m) =>
        ['untrusted', 'keepalive_stale'].includes(m.rejectReason)
      ).length,
      0
    );
    assert.ok(r.applied.length >= 1 || r.replays.length >= 1, 'post-freeze putt accepted');
    assert.strictEqual(p.clockTrusted, true, 'putt noteClientAlive restores trust');
    console.log('  ok post_freeze putt accepted');
  }

  // --- 5) Sparse clientClock under stale window keeps trust (no force-sync) ---
  {
    const sock = new FakeSocket();
    const session = new GameSession({ code: 'KA5', joinUrl: 'KA5', joinUrlFallback: 'KA5' });
    const p = addPlayer(session, sock, 'Sparse');
    beginPlaying(session, p, sock);
    settle(session, 10);

    // 2s gaps × 2 = still under 5s stale if clocks keep coming.
    for (let i = 0; i < 3; i++) {
      p.lastKeepaliveWall = Date.now() - 2000;
      session.handleMessage(p, {
        type: 'clientClock',
        tick: session.simTick,
        clientTimeMs: Date.now(),
        lastHostTick: session.simTick,
      });
      session.tickDriver();
      assert.notStrictEqual(p.clockTrusted, false, `trust after sparse clock ${i}`);
    }
    sock.drain();
    console.log('  ok sparse_1s_cadence trust held');
  }

  // Sanity: Shared still loads (keep harness linked).
  assert.ok(Shared.TICK_HZ > 0);

  console.log('keepalive-trust: all ok');
}

run();
