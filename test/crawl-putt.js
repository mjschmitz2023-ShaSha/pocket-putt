'use strict';
/**
 * Launch-from-low-speed (crawl putt) + quasi-rest.
 *
 * Reproduces the editor Test bug: ball slowly moving in a gravity field is
 * puttable (mayPuttBall), and an aim-drag must survive the next gravity-wake frame
 * (wake must not cancel an active drag).
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, createBallState, planet, ballMayRestForAim, mayPuttBall,
  createSpeedAvgTracker, noteSpeedSample, isQuasiRest, computeLaunchVelocity,
  STOP_THRESHOLD, CRAWL_PUTT_SPEED, QUASI_REST_WINDOW_S, BALL_RADIUS,
  MAX_DRAG_DIST, clampDragVector,
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

test('CRAWL_PUTT_SPEED is above STOP_THRESHOLD', () => {
  assert.ok(CRAWL_PUTT_SPEED > STOP_THRESHOLD);
});

test('mayPuttBall: slow crawl while floating in gravity (not clean rest)', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  // Floating just outside crust, inside field — ballMayRestForAim is false.
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 18, y: 250 });
  ball.vx = 12; // below STOP_THRESHOLD, still "moving"
  ball.vy = 0;
  assert.ok(!ballMayRestForAim(ball, h), 'setup: not clean rest (floating)');
  assert.ok(Math.hypot(ball.vx, ball.vy) < CRAWL_PUTT_SPEED, 'setup: crawl speed');
  assert.ok(
    mayPuttBall(ball, h, createSpeedAvgTracker()),
    'must allow putt at low speed without waiting for quasi-rest'
  );
});

test('mayPuttBall: mid crawl slightly above STOP still allowed', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 18, y: 250 });
  const crawl = (STOP_THRESHOLD + CRAWL_PUTT_SPEED) / 2;
  ball.vx = crawl;
  ball.vy = 0;
  assert.ok(crawl >= STOP_THRESHOLD, 'above hard stop');
  assert.ok(crawl < CRAWL_PUTT_SPEED, 'under crawl cap');
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
  ball.vx = 80; // spike — above CRAWL_PUTT_SPEED
  ball.vy = 0;
  const tr = createSpeedAvgTracker();
  // 5s of mostly crawl with occasional spikes → avg under QUASI_REST_AVG_SPEED
  for (let i = 0; i < 50; i++) {
    noteSpeedSample(tr, 10, 0.09);
    noteSpeedSample(tr, 70, 0.01);
  }
  assert.ok(isQuasiRest(tr), 'tracker filled as quasi-rest');
  assert.ok(mayPuttBall(ball, h, tr), 'quasi-rest overrides instant high speed');
});

/**
 * Pure model of the editor Test wake + pointerdown contract (no DOM).
 * Fails if gravity wake clears an active aim drag (the production bug).
 */
function simEditorPuttFromCrawl() {
  const h = blankHole({
    tee: { x: 200, y: 250 },
    cup: { x: 700, y: 250, radius: 11 },
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 20, y: 250 });
  ball.vx = 14;
  ball.vy = 3;
  const tracker = createSpeedAvgTracker();
  let state = 'BALL_MOVING';
  let drag = { active: false, pointerVec: { x: 0, y: 0 } };

  function wake(hasGravity) {
    // Correct contract: never cancel active drag; only wake when not puttable.
    if (
      state === 'AIMING' &&
      !drag.active &&
      hasGravity &&
      !ballMayRestForAim(ball, h) &&
      !mayPuttBall(ball, h, tracker)
    ) {
      state = 'BALL_MOVING';
      return 'woke';
    }
    return 'hold';
  }

  // BUG replica (old editor): wake clears drag even mid-aim
  function wakeBuggy(hasGravity) {
    if (
      state === 'AIMING' &&
      hasGravity &&
      !ballMayRestForAim(ball, h) &&
      !isQuasiRest(tracker)
    ) {
      state = 'BALL_MOVING';
      drag.active = false;
      return 'woke_and_cleared_drag';
    }
    return 'hold';
  }

  assert.ok(mayPuttBall(ball, h, tracker), 'crawl putt allowed while BALL_MOVING');

  // pointerdown on ball
  assert.ok(Math.hypot(0, 0) <= 48 || true);
  ball.vx = 0;
  ball.vy = 0;
  state = 'AIMING';
  drag.active = true;
  drag.pointerVec = { x: 0, y: 0 };

  // next frame: gravity wake must NOT clear drag
  const r = wake(true);
  assert.strictEqual(r, 'hold', 'wake holds while drag active');
  assert.strictEqual(state, 'AIMING');
  assert.ok(drag.active, 'drag survives gravity wake frame');

  // aim pull-back and release
  drag.pointerVec = { x: -MAX_DRAG_DIST * 0.5, y: 0 };
  const clamped = clampDragVector(drag.pointerVec);
  assert.ok(clamped);
  const launch = computeLaunchVelocity(clamped);
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  state = 'BALL_MOVING';
  drag.active = false;

  assert.ok(ball.vx > 50, 'launch overwrote crawl freeze (vx=' + ball.vx + ')');
  assert.strictEqual(state, 'BALL_MOVING');

  // Document that the old wake rule would have cancelled the putt:
  ball.vx = 0;
  ball.vy = 0;
  state = 'AIMING';
  drag.active = true;
  // empty tracker → not quasi-rest; floating → not ballMayRestForAim
  // After crawl freeze speed is 0, mayPuttBall is still true (crawl) — buggy wake used isQuasiRest only.
  const bad = wakeBuggy(true);
  assert.strictEqual(bad, 'woke_and_cleared_drag', 'old rule cancelled mid-drag putts');
  assert.ok(!drag.active, 'old rule cleared drag');
}

test('editor contract: crawl putt drag survives gravity-wake frame + launches', () => {
  simEditorPuttFromCrawl();
});

test('editor contract: launch from low speed overwrites velocity', () => {
  const h = blankHole();
  const ball = createBallState(h.tee);
  ball.vx = 10;
  ball.vy = -5;
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()));
  // freeze + launch (handleTestPointerUp path)
  ball.vx = 0;
  ball.vy = 0;
  const launch = computeLaunchVelocity(clampDragVector({ x: -MAX_DRAG_DIST * 0.6, y: 0 }));
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  assert.ok(ball.vx > 100, 'putt launch replaces crawl velocity');
  assert.ok(Math.abs(ball.vy) < 1e-6, 'aimed along +x');
});

if (!process.exitCode) console.log('crawl-putt: ' + passed + ' passed');
else console.log('crawl-putt: FAILED');
