'use strict';
/**
 * Quasi-rest putt escape: avg |v| near 0 for QUASI_REST_WINDOW_S allows putt
 * even when ballMayRestForAim is false (e.g. floating in a gravity field).
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, createBallState, planet, ballMayRestForAim, mayPuttBall,
  createSpeedAvgTracker, noteSpeedSample, isQuasiRest, speedAvg, resetSpeedAvgTracker,
  QUASI_REST_WINDOW_S, QUASI_REST_AVG_SPEED, STOP_THRESHOLD, BALL_RADIUS,
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

console.log('quasi-rest');

test('constants: 5s window, avg threshold above STOP_THRESHOLD', () => {
  assert.strictEqual(QUASI_REST_WINDOW_S, 5);
  assert.ok(QUASI_REST_AVG_SPEED > STOP_THRESHOLD);
});

test('tracker needs full window before quasi-rest', () => {
  const tr = createSpeedAvgTracker();
  // 4.5s of zero speed — not enough
  for (let i = 0; i < 45; i++) noteSpeedSample(tr, 0, 0.1);
  assert.ok(!isQuasiRest(tr), 'under window');
  // fill to 5s
  for (let i = 0; i < 5; i++) noteSpeedSample(tr, 0, 0.1);
  assert.ok(isQuasiRest(tr), 'full window of near-zero');
  assert.ok(speedAvg(tr) < QUASI_REST_AVG_SPEED);
});

test('high speed prevents quasi-rest even over long window', () => {
  const tr = createSpeedAvgTracker();
  for (let i = 0; i < 60; i++) noteSpeedSample(tr, 200, 0.1);
  assert.ok(!isQuasiRest(tr));
  assert.ok(speedAvg(tr) > QUASI_REST_AVG_SPEED);
});

test('soft bounce chatter (spikes) still averages low enough', () => {
  const tr = createSpeedAvgTracker();
  // 5s of mostly crawl with brief bounce spikes
  for (let i = 0; i < 50; i++) {
    noteSpeedSample(tr, 8, 0.09);
    noteSpeedSample(tr, 80, 0.01); // spike
  }
  assert.ok(tr.sumDt >= QUASI_REST_WINDOW_S - 0.05);
  assert.ok(isQuasiRest(tr), 'avg still low (avg=' + speedAvg(tr) + ')');
});

test('mayPuttBall: floating crawl is puttable immediately (no quasi-rest wait)', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 20, y: 250 });
  ball.vx = 12;
  ball.vy = 0;
  assert.ok(!ballMayRestForAim(ball, h), 'floating should not clean-rest');
  // Crawl putt: low instant speed is enough (was blocked before by ballMayRestForAim).
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()), 'crawl putt while floating');
});

test('mayPuttBall: floating + high speed needs quasi-rest', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 25000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + BALL_RADIUS + 20, y: 250 });
  ball.vx = 90;
  ball.vy = 0;
  assert.ok(!mayPuttBall(ball, h, createSpeedAvgTracker()), 'fast float denied');
  const tr = createSpeedAvgTracker();
  for (let i = 0; i < 55; i++) noteSpeedSample(tr, 15, 0.1);
  assert.ok(isQuasiRest(tr));
  assert.ok(mayPuttBall(ball, h, tr), 'quasi-rest allows putt while floating fast');
});

test('mayPuttBall still works for normal rest without tracker fill', () => {
  const h = blankHole();
  const ball = createBallState(h.tee);
  ball.vx = 0;
  ball.vy = 0;
  assert.ok(mayPuttBall(ball, h, createSpeedAvgTracker()));
});

test('resetSpeedAvgTracker clears quasi-rest', () => {
  const tr = createSpeedAvgTracker();
  for (let i = 0; i < 60; i++) noteSpeedSample(tr, 0, 0.1);
  assert.ok(isQuasiRest(tr));
  resetSpeedAvgTracker(tr);
  assert.ok(!isQuasiRest(tr));
});

if (!process.exitCode) console.log('quasi-rest: ' + passed + ' passed');
else console.log('quasi-rest: FAILED');
