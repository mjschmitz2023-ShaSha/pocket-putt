'use strict';
/**
 * Boost pads: fire on enter, re-arm when the ball leaves the pad.
 * Resting / authority snaps while still on the pad must not re-fire every tick.
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, boostRect, createBallState, stepBallPhysics, TICK_DT,
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

test('resting on a boost fires once, not every tick while overlapping', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  let fires = 0;
  for (let t = 0; t < 90; t++) {
    // Pin on pad so we only test latch-while-overlapping (boost Δv would eject).
    ball.x = 340;
    ball.y = 250;
    if (t > 0) {
      // Keep a tiny crawl so physics still runs; latch must hold.
      ball.vx = 5;
      ball.vy = 0;
    }
    const ev = stepBallPhysics(ball, hole, TICK_DT);
    if (ev.boosts.length) fires++;
  }
  assert.strictEqual(fires, 1, 'exactly one fire while remaining on pad (got ' + fires + ')');
});

test('authority snap onto pad with latch preserved does not re-fire', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  stepBallPhysics(ball, hole, TICK_DT);
  assert.ok(ball.firedBoosts.has(0), 'fired once');
  // Simulate host soft/hard rest snap: still on pad, latch still set.
  ball.x = 340;
  ball.y = 250;
  ball.vx = 0;
  ball.vy = 0;
  ball.firedBoosts = new Set([0]);
  let fires = 0;
  for (let t = 0; t < 60; t++) {
    ball.x = 340;
    ball.y = 250;
    const ev = stepBallPhysics(ball, hole, TICK_DT);
    if (ev.boosts.length) fires++;
  }
  assert.strictEqual(fires, 0, 'no loop when latch preserved while on pad');
});

test('leaving the pad re-arms; re-entry fires again', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 400)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  const ev1 = stepBallPhysics(ball, hole, TICK_DT);
  assert.strictEqual(ev1.boosts.length, 1);
  assert.ok(ball.firedBoosts.has(0));

  // Leave the pad completely
  ball.x = 100;
  ball.y = 100;
  ball.vx = 0;
  ball.vy = 0;
  for (let t = 0; t < 5; t++) stepBallPhysics(ball, hole, TICK_DT);
  assert.ok(!ball.firedBoosts.has(0), 'latch cleared after exit');

  // Re-enter
  ball.x = 340;
  ball.y = 250;
  ball.vx = 0;
  ball.vy = 0;
  const ev2 = stepBallPhysics(ball, hole, TICK_DT);
  assert.strictEqual(ev2.boosts.length, 1, 're-entry fires again');
  assert.ok(ball.firedBoosts.has(0));
});

test('forced clear while still on pad re-fires once, then holds', () => {
  const hole = blankHole({
    boost: [boostRect(300, 220, 380, 280, 0, 600)],
  });
  const ball = createBallState({ x: 340, y: 250 });
  stepBallPhysics(ball, hole, TICK_DT);
  ball.x = 340;
  ball.y = 250;
  ball.vx = 0;
  ball.vy = 0;
  ball.firedBoosts = new Set();
  let fires = 0;
  for (let t = 0; t < 30; t++) {
    ball.x = 340;
    ball.y = 250;
    const ev = stepBallPhysics(ball, hole, TICK_DT);
    if (ev.boosts.length) fires++;
  }
  assert.strictEqual(fires, 1, 'one re-fire after forced clear, then latch holds');
});

if (process.exitCode) {
  console.error('boost-latch: FAILED');
  process.exit(1);
}
console.log('boost-latch: %d tests passed', passed);
