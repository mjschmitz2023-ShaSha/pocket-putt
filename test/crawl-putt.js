'use strict';
/**
 * Crawl putt + gravity wake contracts.
 *
 * Two separate ideas (must not be conflated):
 *  1. mayPuttBall — can click the ball to START an aim (incl. low-speed crawl)
 *  2. drag.active — mouse held down lining up a shot (only then freeze / no wake)
 *
 * Gravity wake: AIMING + !drag + field yank (!ballMayRestForAim) → BALL_MOVING
 * even when mayPuttBall is true (stationary ball in a field must still roll).
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, createBallState, planet, ballMayRestForAim, mayPuttBall,
  createSpeedAvgTracker, noteSpeedSample, isQuasiRest, computeLaunchVelocity,
  stepBallPhysics, STOP_THRESHOLD, CRAWL_PUTT_SPEED, BALL_RADIUS,
  MAX_DRAG_DIST, clampDragVector, TICK_DT,
} = Shared;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL  ' + name);
    console.error('    ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

console.log('crawl-putt');

/** Correct wake: only suppress while actively drag-aiming. */
function gravityWake(state, dragActive, ball, hole) {
  if (state === 'AIMING' && dragActive) return { state, action: 'hold_drag' };
  if (state === 'AIMING' && !dragActive && !ballMayRestForAim(ball, hole)) {
    return { state: 'BALL_MOVING', action: 'woke' };
  }
  return { state, action: 'hold' };
}

test('CRAWL_PUTT_SPEED is above STOP_THRESHOLD', () => {
  assert.ok(CRAWL_PUTT_SPEED > STOP_THRESHOLD);
});

test('mayPuttBall: slow crawl while floating in gravity (not clean rest)', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 18, y: 250 });
  ball.vx = 12;
  ball.vy = 0;
  assert.ok(!ballMayRestForAim(ball, h), 'setup: not clean rest (floating)');
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()), 'crawl putt allowed');
});

test('mayPuttBall: mid crawl slightly above STOP still allowed', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 18, y: 250 });
  const crawl = (STOP_THRESHOLD + CRAWL_PUTT_SPEED) / 2;
  ball.vx = crawl;
  ball.vy = 0;
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()), 'crawl band is puttable');
});

test('mayPuttBall: fast roll denied without quasi-rest', () => {
  const h = blankHole();
  const ball = createBallState(h.tee);
  ball.vx = 200;
  ball.vy = 0;
  assert.ok(!mayPuttBall(ball, h, createSpeedAvgTracker()));
});

test('mayPuttBall: quasi-rest allows putt even with high instant speed', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 18, y: 250 });
  ball.vx = 80;
  ball.vy = 0;
  const tr = createSpeedAvgTracker();
  for (let i = 0; i < 50; i++) {
    noteSpeedSample(tr, 10, 0.09);
    noteSpeedSample(tr, 70, 0.01);
  }
  assert.ok(isQuasiRest(tr));
  assert.ok(mayPuttBall(ball, h, tr), 'quasi-rest overrides instant high speed');
});

test('gravity wake: stationary AIMING ball in field rolls (mayPutt true must NOT block)', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 20, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  assert.ok(!ballMayRestForAim(ball, h), 'floating → should wake');
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()), 'also puttable (crawl)');

  // Regression: old code used !mayPuttBall and never woke.
  const wrong = ballMayRestForAim(ball, h) || mayPuttBall(ball, h, createSpeedAvgTracker());
  // mayPutt is true so a "wake only if !mayPutt" rule would fail:
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()));
  const w = gravityWake('AIMING', false, ball, h);
  assert.strictEqual(w.action, 'woke', 'wake despite mayPuttBall');
  assert.strictEqual(w.state, 'BALL_MOVING');

  // Physics actually pulls the ball after wake
  let state = 'BALL_MOVING';
  const x0 = ball.x;
  for (let i = 0; i < 45; i++) stepBallPhysics(ball, h, TICK_DT);
  assert.ok(ball.x < x0 - 1, 'falls toward planet after wake (x0=' + x0 + ' x=' + ball.x + ')');
});

test('gravity wake: suppressed only while drag.active (lining up shot)', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 20, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  const w = gravityWake('AIMING', true, ball, h);
  assert.strictEqual(w.action, 'hold_drag');
  assert.strictEqual(w.state, 'AIMING');
});

test('crawl putt: interrupt BALL_MOVING, hold only while drag, then launch', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 20, y: 250 });
  ball.vx = 14;
  ball.vy = 3;
  const tracker = createSpeedAvgTracker();
  assert.ok(mayPuttBall(ball, h, tracker));

  // pointerdown: freeze + AIMING + drag
  ball.vx = 0;
  ball.vy = 0;
  let state = 'AIMING';
  let dragActive = true;

  // next frames while lining up — no wake
  for (let i = 0; i < 5; i++) {
    const w = gravityWake(state, dragActive, ball, h);
    assert.strictEqual(w.action, 'hold_drag');
    state = w.state;
  }
  assert.ok(dragActive);

  // release putt
  const launch = computeLaunchVelocity(clampDragVector({ x: -MAX_DRAG_DIST * 0.5, y: 0 }));
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  state = 'BALL_MOVING';
  dragActive = false;
  assert.ok(ball.vx > 50, 'launch overwrote freeze');

  // after release, if somehow AIMING in field without drag → wake
  state = 'AIMING';
  ball.vx = 0;
  ball.vy = 0;
  const after = gravityWake(state, false, ball, h);
  assert.strictEqual(after.action, 'woke');
});

test('editor contract: launch from low speed overwrites velocity', () => {
  const h = blankHole();
  const ball = createBallState(h.tee);
  ball.vx = 10;
  ball.vy = -5;
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()));
  ball.vx = 0;
  ball.vy = 0;
  const launch = computeLaunchVelocity(clampDragVector({ x: -MAX_DRAG_DIST * 0.6, y: 0 }));
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  assert.ok(ball.vx > 100, 'putt launch replaces crawl velocity');
});

if (!process.exitCode) console.log('crawl-putt: ' + passed + ' passed');
else console.log('crawl-putt: FAILED');
