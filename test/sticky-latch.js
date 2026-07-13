#!/usr/bin/env node
/**
 * Sticky goo unit tests — trap, escape latch, launch factor, host/client lockstep.
 * Sticky must NOT feel like "sand with more friction":
 *   - unlatched entry: hard stop (v → 0) + latch
 *   - escape putt: STICKY_LAUNCH_FACTOR power + grass friction while latched in goo
 *   - exit goo: re-arm (stuckStickyIndex = -1)
 */
'use strict';

const Shared = require('../shared.js');
const { GameSession } = require('../gameSession.js');
const { ClientModel } = require('./clientModel.js');
const WebSocket = require('ws');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('  ok:', msg);
  }
}

class FakeSocket {
  constructor() {
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.outbox = [];
  }
  send(raw) {
    try {
      this.outbox.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
  drain() {
    const m = this.outbox;
    this.outbox = [];
    return m;
  }
}

function gooHole() {
  return Shared.COURSES.find((c) => c.id === 'goo').holes[0];
}

function patchCenter(hole) {
  const z = hole.sticky[0];
  return { x: (z.x1 + z.x2) / 2, y: (z.y1 + z.y2) / 2 };
}

function speedAfter(hole, startV, latch, ticks, pos) {
  const c = pos || patchCenter(hole);
  const b = Shared.createBallState(c);
  b.vx = startV;
  b.vy = 0;
  b.stuckStickyIndex = latch;
  for (let i = 0; i < ticks; i++) Shared.stepBallPhysics(b, hole, Shared.TICK_DT);
  return Math.hypot(b.vx, b.vy);
}

console.log('\nSticky latch tests');
console.log('='.repeat(48));

// --- constants differ from sand ---
{
  console.log('\nconstants');
  assert(Shared.FRICTION_STICKY > Shared.FRICTION_SAND, 'sticky friction > sand');
  assert(Shared.FRICTION_SAND > Shared.FRICTION_GRASS, 'sand friction > grass');
  assert(Shared.STICKY_LAUNCH_FACTOR < 1 && Shared.STICKY_LAUNCH_FACTOR > 0, 'launch factor in (0,1)');
  assert(Shared.STICKY_STOP_SPEED > Shared.STOP_THRESHOLD, 'sticky stop above crawl threshold');
}

// --- trap: enter unlatched → dead stop + latch ---
{
  console.log('\ntrap on entry');
  const hole = gooHole();
  const c = patchCenter(hole);
  const ball = Shared.createBallState({ x: c.x - 80, y: c.y });
  ball.vx = 200;
  ball.vy = 0;
  let stuck = false;
  for (let t = 0; t < 120; t++) {
    const ev = Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
    if (ev.stuck) {
      stuck = true;
      break;
    }
  }
  assert(stuck, 'events.stuck fires');
  assert(ball.stuckStickyIndex === 0, 'latched to patch 0');
  assert(Math.hypot(ball.vx, ball.vy) === 0, 'velocity exact zero when trapped');
  assert(Shared.stickyIndexAt(ball, hole) === 0, 'still inside goo after trap');
}

// --- latched coast uses grass friction, not sticky drag ---
{
  console.log('\nescape latch friction');
  const hole = gooHole();
  const c = patchCenter(hole);
  const unlatched = speedAfter(hole, 300, -1, 8, c);
  const latched = speedAfter(hole, 300, 0, 8, c);
  assert(latched > unlatched * 3, `latched keeps speed (latched=${latched.toFixed(1)} unlatched=${unlatched.toFixed(1)})`);
  // Latched in goo ≈ free grass at the same coordinates (sticky/sand stripped).
  const grassish = speedAfter({ ...hole, sticky: [], sand: [] }, 300, -1, 8, c);
  assert(Math.abs(latched - grassish) < 5, `latched ≈ grass (latched=${latched.toFixed(1)} grass=${grassish.toFixed(1)})`);
  // Unlatched sticky much stronger than sand
  const classic = Shared.COURSES[0].holes.find((h) => h.sand && h.sand.length);
  const sz = classic.sand[0];
  const sandB = Shared.createBallState({
    x: (sz.x1 + sz.x2) / 2,
    y: (sz.y1 + sz.y2) / 2,
  });
  sandB.vx = 300;
  sandB.vy = 0;
  for (let i = 0; i < 8; i++) Shared.stepBallPhysics(sandB, classic, Shared.TICK_DT);
  const sandV = Math.hypot(sandB.vx, sandB.vy);
  assert(unlatched < sandV * 0.7, `trap stronger than sand (sticky=${unlatched.toFixed(1)} sand=${sandV.toFixed(1)})`);
}

// --- launch factor + exit re-arm ---
{
  console.log('\nescape putt + re-arm');
  const hole = gooHole();
  const c = patchCenter(hole);
  const ball = Shared.createBallState(c);
  ball.stuckStickyIndex = 0;
  Shared.latchStickyAfterPutt(ball, hole);
  const factor = Shared.stickyLaunchFactor(ball, hole);
  assert(factor === Shared.STICKY_LAUNCH_FACTOR, `launch factor ${factor}`);
  const launch = Shared.computeLaunchVelocity({ x: -120, y: 0 });
  ball.vx = launch.vx * factor;
  ball.vy = launch.vy * factor;
  let exited = false;
  for (let t = 0; t < 180; t++) {
    Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
    if (Shared.stickyIndexAt(ball, hole) < 0) {
      exited = true;
      break;
    }
  }
  assert(exited, 'escape putt leaves the patch');
  assert(ball.stuckStickyIndex === -1, 're-armed after exit');
}

// --- host/client multiplayer escape lockstep ---
{
  console.log('\nmp host/client lockstep escape');
  const sock = new FakeSocket();
  const session = new GameSession({ code: 'G', joinUrl: 'G', joinUrlFallback: 'G' });
  const { player } = session.addPlayer(sock, { name: 'P', isLocal: true });
  session.courseIndex = 2;
  session.startNewRound();
  session.holeStartedAtMs = 0;
  const hole = session.currentHoles()[0];
  const c = patchCenter(hole);
  player.ball.x = c.x;
  player.ball.y = c.y;
  player.ball.vx = 80;
  player.ball.vy = 0;
  player.ball.stuckStickyIndex = -1;
  for (let i = 0; i < 40; i++) session.stepSimulation();
  assert(player.ball.stuckStickyIndex === 0, 'host trapped in goo');
  assert(Math.hypot(player.ball.vx, player.ball.vy) === 0, 'host at rest in goo');

  const client = new ClientModel({ playerId: player.id, courseIndex: 2 });
  for (const m of sock.drain()) {
    if (m.type === 'roundState') client.onRoundState(m);
    if (m.type === 'snapshot') client.onSnapshot(m, 0);
  }
  const cp = client.players.get(player.id);
  cp.x = player.ball.x;
  cp.y = player.ball.y;
  cp.vx = 0;
  cp.vy = 0;
  cp.stuckStickyIndex = player.ball.stuckStickyIndex;
  cp.rx = cp.x;
  cp.ry = cp.y;

  const drag = { x: -100, y: 0 };
  client.applyPuttLocal(player.id, drag, null);
  const vOpt = Math.hypot(cp.vx, cp.vy);
  session.handleMessage(player, { type: 'putt', dragVector: drag });
  const puttMsg = sock.drain().find((m) => m.type === 'puttApplied');
  assert(!!puttMsg, 'puttApplied broadcast');
  assert(puttMsg.stuckStickyIndex === 0, 'host puttApplied keeps escape latch');
  assert(
    Math.abs(Math.hypot(puttMsg.vx, puttMsg.vy) - vOpt) < 0.01,
    'host launch matches client optimistic (0.55 factor)'
  );
  client.onPuttApplied(puttMsg);
  assert(Math.abs(Math.hypot(cp.vx, cp.vy) - vOpt) < 0.01, 'confirm does not re-fire Δv');
  assert(cp.stuckStickyIndex === 0, 'client keeps escape latch after confirm');

  for (let i = 0; i < 12; i++) {
    session.stepSimulation();
    client.stepOneTick();
  }
  const hb = player.ball;
  const dist = Math.hypot(hb.x - cp.x, hb.y - cp.y);
  assert(dist < 0.05, `host/client coast dist ${dist.toFixed(4)} after escape`);
  assert(hb.stuckStickyIndex === cp.stuckStickyIndex, 'latch state matches after coast');
}

console.log('\n' + '='.repeat(48));
if (failed) {
  console.error(`${failed} sticky latch test(s) failed`);
  process.exit(1);
}
console.log('All sticky latch tests passed\n');
process.exit(0);
