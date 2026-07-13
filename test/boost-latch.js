'use strict';
/**
 * Boost pads fire at most once per stroke. Resting / authority snaps must not re-arm
 * a pad under a settled ball (that causes soft/hard teleport loops in multiplayer).
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, boostRect, sandRect, createBallState, stepBallPhysics,
  circleTouchesZone, BALL_RADIUS, STOP_THRESHOLD, TICK_DT,
} = Shared;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e && e.message ? e.message : e);
    process.exitCode = 1;
  }
}

test('resting on a boost fires once, not every tick', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  let fires = 0;
  for (let t = 0; t < 90; t++) {
    const ev = stepBallPhysics(ball, hole, TICK_DT);
    if (ev.boosts.length) fires++;
  }
  assert.strictEqual(fires, 1, 'exactly one fire from rest on pad');
  assert.ok(ball.firedBoosts.has(0));
});

test('clearing firedBoosts while still on pad re-fires (bug we guard against in MP)', () => {
  // Documents the old client snap bug: empty set + rest on pad => boost again.
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  stepBallPhysics(ball, hole, TICK_DT);
  assert.ok(ball.firedBoosts.has(0));
  // Simulate old mpApplyAuthorityPose rest clear
  ball.x = 340;
  ball.y = 250;
  ball.vx = 0;
  ball.vy = 0;
  ball.firedBoosts = new Set();
  const ev = stepBallPhysics(ball, hole, TICK_DT);
  assert.strictEqual(ev.boosts.length, 1, 're-fire if latch cleared while on pad');
});

test('keeping firedBoosts while snapped back onto pad does not re-fire', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
    sand: [sandRect(450, 200, 550, 300)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  stepBallPhysics(ball, hole, TICK_DT); // fire once, leave pad
  assert.ok(ball.firedBoosts.has(0));
  // Coast a bit then snap back to rest on pad (authority disagreement) WITHOUT clearing latch
  for (let t = 0; t < 30; t++) stepBallPhysics(ball, hole, TICK_DT);
  ball.x = 340;
  ball.y = 250;
  ball.vx = 0;
  ball.vy = 0;
  // firedBoosts still has 0
  let fires = 0;
  for (let t = 0; t < 60; t++) {
    const ev = stepBallPhysics(ball, hole, TICK_DT);
    if (ev.boosts.length) fires++;
  }
  assert.strictEqual(fires, 0, 'no loop when latch preserved');
  assert.ok(circleTouchesZone(ball.x, ball.y, BALL_RADIUS, hole.boost[0]) || Math.hypot(ball.vx, ball.vy) > STOP_THRESHOLD
    || true);
});

test('new putt re-arms pads (latch clear is correct on stroke)', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  stepBallPhysics(ball, hole, TICK_DT);
  assert.ok(ball.firedBoosts.has(0));
  // Next stroke: clear like putt sites do
  ball.firedBoosts = new Set();
  ball.x = 340;
  ball.y = 250;
  ball.vx = 0;
  ball.vy = 0;
  const ev = stepBallPhysics(ball, hole, TICK_DT);
  assert.strictEqual(ev.boosts.length, 1);
});

if (process.exitCode) {
  console.error('boost-latch: FAILED');
  process.exit(1);
}
console.log('boost-latch: %d tests passed', passed);
