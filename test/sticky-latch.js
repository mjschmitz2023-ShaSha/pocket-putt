#!/usr/bin/env node
/**
 * Sticky goo unit tests — real surface, not temporary trap.
 *
 *   - Inside goo: FRICTION_STICKY always (even after putts launched from within)
 *   - Speed < STICKY_STOP_SPEED → hard stop (v = 0)
 *   - In-goo putts: STICKY_LAUNCH_FACTOR + still fight sticky drag
 *   - Exit clear of goo: stuckStickyIndex re-arms to -1
 *   - Host/client multiplayer coast lockstep
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

function speedAfter(hole, startV, ticks, pos) {
  const c = pos || patchCenter(hole);
  const b = Shared.createBallState(c);
  b.vx = startV;
  b.vy = 0;
  // Even if we pretend we were "latched" from a putt, goo must still drag.
  b.stuckStickyIndex = 0;
  for (let i = 0; i < ticks; i++) Shared.stepBallPhysics(b, hole, Shared.TICK_DT);
  return { v: Math.hypot(b.vx, b.vy), x: b.x, latch: b.stuckStickyIndex };
}

console.log('\nSticky goo tests (real surface)');
console.log('='.repeat(48));

// --- constants ---
{
  console.log('\nconstants');
  assert(Shared.FRICTION_STICKY > Shared.FRICTION_SAND, 'sticky friction > sand');
  assert(Shared.FRICTION_SAND > Shared.FRICTION_GRASS, 'sand friction > grass');
  assert(Shared.STICKY_LAUNCH_FACTOR === 0.45, 'launch factor is original 0.45');
  assert(Shared.STICKY_STOP_SPEED === 50, 'stop speed is original 50');
}

// --- trap on entry ---
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
  assert(ball.stuckStickyIndex === 0, 'records patch index on hard stop');
  assert(Math.hypot(ball.vx, ball.vy) === 0, 'velocity exact zero when trapped');
  assert(Shared.stickyIndexAt(ball, hole) === 0, 'still inside goo after trap');
}

// --- putt from inside goo still gets sticky drag (no grass escape) ---
{
  console.log('\nin-goo putt still sticky');
  const hole = gooHole();
  const c = patchCenter(hole);
  // Simulate putt from rest in goo: weak launch + sticky friction.
  const ball = Shared.createBallState(c);
  ball.stuckStickyIndex = 0;
  Shared.latchStickyAfterPutt(ball, hole); // must remain sticky even if this ran
  const factor = Shared.stickyLaunchFactor(ball, hole);
  const launch = Shared.computeLaunchVelocity({ x: -120, y: 0 });
  ball.vx = launch.vx * factor;
  ball.vy = launch.vy * factor;
  const v0 = Math.hypot(ball.vx, ball.vy);

  // Grass-only reference at same start velocity (no sticky on hole).
  const grass = Shared.createBallState(c);
  grass.vx = v0;
  grass.vy = 0;
  const bare = { ...hole, sticky: [], sand: [] };

  for (let i = 0; i < 6; i++) {
    Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
    Shared.stepBallPhysics(grass, bare, Shared.TICK_DT);
  }
  const vGoo = Math.hypot(ball.vx, ball.vy);
  const vGrass = Math.hypot(grass.vx, grass.vy);
  assert(factor === Shared.STICKY_LAUNCH_FACTOR, `launch factor ${factor}`);
  assert(vGoo < vGrass * 0.35, `in-goo putt drags hard (goo=${vGoo.toFixed(1)} grass=${vGrass.toFixed(1)})`);
  // Should re-trap soon; must not cruise out of an 80px patch in one putt.
  let retrapped = Math.hypot(ball.vx, ball.vy) === 0;
  for (let t = 0; t < 60 && !retrapped; t++) {
    const ev = Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
    if (ev.stuck || Math.hypot(ball.vx, ball.vy) === 0) retrapped = true;
  }
  assert(retrapped, 'in-goo putt re-traps (does not free-roll out on grass)');
  assert(Shared.stickyIndexAt(ball, hole) === 0, 'still inside goo after re-trap');
  const traveled = Math.abs(ball.x - c.x);
  assert(traveled < 40, `crawl distance limited (traveled ${traveled.toFixed(1)}px)`);
}

// --- stronger than sand ---
{
  console.log('\nstronger than sand');
  const hole = gooHole();
  const c = patchCenter(hole);
  const goo = speedAfter(hole, 300, 8, c);
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
  assert(goo.v < sandV * 0.5, `trap stronger than sand (goo=${goo.v.toFixed(1)} sand=${sandV.toFixed(1)})`);
}

// --- edge crawl can exit; re-arm outside ---
{
  console.log('\nedge crawl exit + re-arm');
  const hole = gooHole();
  const z = hole.sticky[0];
  // Only the last few px of a patch are escapable in one putt under sticky drag.
  const ball = Shared.createBallState({ x: z.x2 - 4, y: (z.y1 + z.y2) / 2 });
  ball.stuckStickyIndex = 0;
  const factor = Shared.stickyLaunchFactor(ball, hole);
  const launch = Shared.computeLaunchVelocity({ x: -Shared.MAX_DRAG_DIST, y: 0 });
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
  assert(exited, 'near-edge full putt can leave the patch');
  assert(ball.stuckStickyIndex === -1, 're-armed after exit');
}

// --- host/client multiplayer lockstep ---
{
  console.log('\nmp host/client lockstep');
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
  assert(
    Math.abs(Math.hypot(puttMsg.vx, puttMsg.vy) - vOpt) < 0.01,
    'host launch matches client optimistic'
  );
  client.onPuttApplied(puttMsg);
  assert(Math.abs(Math.hypot(cp.vx, cp.vy) - vOpt) < 0.01, 'confirm does not re-fire Δv');

  for (let i = 0; i < 12; i++) {
    session.stepSimulation();
    client.stepOneTick();
  }
  const hb = player.ball;
  const dist = Math.hypot(hb.x - cp.x, hb.y - cp.y);
  assert(dist < 0.05, `host/client coast dist ${dist.toFixed(4)}`);
  // Both should still be fighting goo / re-trapped near center, not free on grass far away.
  assert(
    Shared.stickyIndexAt(hb, hole) === 0 || Math.hypot(hb.vx, hb.vy) === 0,
    'host still in goo or re-trapped after escape putt'
  );
  assert(Math.abs(hb.x - c.x) < 50, 'did not free-roll far through goo');
}

console.log('\n' + '='.repeat(48));
if (failed) {
  console.error(`${failed} sticky test(s) failed`);
  process.exit(1);
}
console.log('All sticky goo tests passed\n');
process.exit(0);
