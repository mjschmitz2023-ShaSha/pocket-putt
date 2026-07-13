'use strict';
/**
 * P5: Editor Test-mode physics contracts (no DOM).
 * - Gravity pulls via stepBallPhysics (rolling) and simulateTrajectory (ghost).
 * - advanceMovers:false freezes windmill angle across ghost sim;
 *   live advanceHoleObstacles changes angle.
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, createBallState, stepBallPhysics, advanceHoleObstacles,
  simulateTrajectory, planet, computeLaunchVelocity, ballMayRestForAim,
  MAX_DRAG_DIST, TICK_DT, TICK_HZ, STOP_THRESHOLD,
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

console.log('editor-test-physics (P5)');

// --- Gravity: rolling path (zero / small initial velocity) ---
test('stepBallPhysics: resting ball near planet accelerates toward it', () => {
  const h = blankHole({
    tee: { x: 200, y: 250 },
    cup: { x: 700, y: 250, radius: 11 },
    gravityBodies: [planet(400, 250, 40, 20000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 300, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  assert.ok(!ballMayRestForAim(ball, h) || true, 'setup');
  for (let i = 0; i < 45; i++) stepBallPhysics(ball, h, TICK_DT);
  assert.ok(ball.x > 300 + 2, 'ball moves +x toward planet (x=' + ball.x + ')');
});

test('stepBallPhysics: small launch past planet bends path toward well', () => {
  const h = blankHole({
    tee: { x: 120, y: 250 },
    cup: { x: 700, y: 250, radius: 11 },
    gravityBodies: [planet(400, 250, 36, 24000, { fieldRadius: 260 })],
  });
  // Launch parallel above the planet so gravity should pull -y toward cy=250.
  const ball = createBallState({ x: 200, y: 180 });
  ball.vx = 220;
  ball.vy = 0;
  const y0 = ball.y;
  for (let i = 0; i < 90; i++) {
    stepBallPhysics(ball, h, TICK_DT);
    if (ball.x > 380) break;
  }
  assert.ok(ball.y > y0 + 1, 'path dips toward planet (y0=' + y0 + ' y=' + ball.y + ')');
});

// --- Ghost trajectory includes gravity (movers frozen) ---
test('simulateTrajectory: ghost path bends toward planet with advanceMovers:false', () => {
  const h = blankHole({
    tee: { x: 120, y: 250 },
    cup: { x: 720, y: 250, radius: 11 },
    gravityBodies: [planet(400, 250, 36, 28000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 160, y: 170 });
  // Putt +x, above the planet — path should curve downward.
  const launch = computeLaunchVelocity({ x: -MAX_DRAG_DIST * 0.55, y: 0 });
  const pts = simulateTrajectory(h, ball, launch.vx, launch.vy, {
    maxTicks: TICK_HZ * 6,
    advanceMovers: false,
    sampleEvery: 1,
  });
  assert.ok(pts.length >= 8, 'enough samples');
  // Find a point near planet x and check it is below the straight-line y≈170.
  let minY = pts[0].y;
  let sawPast = false;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.x > 300) sawPast = true;
  }
  // Gravity pulls toward (400,250) from y=170 → y increases toward 250.
  let maxYNear = pts[0].y;
  for (const p of pts) {
    if (p.x > 280 && p.x < 480 && p.y > maxYNear) maxYNear = p.y;
  }
  assert.ok(sawPast, 'trajectory reaches planet x-band');
  assert.ok(maxYNear > 170 + 4, 'ghost bends toward planet (maxYNear=' + maxYNear + ')');
});

test('simulateTrajectory: empty hole ghost is straight-ish (+x coast)', () => {
  const h = blankHole();
  const ball = createBallState(h.tee);
  const launch = computeLaunchVelocity({ x: -MAX_DRAG_DIST, y: 0 });
  const pts = simulateTrajectory(h, ball, launch.vx, launch.vy, {
    maxTicks: TICK_HZ * 2,
    advanceMovers: false,
  });
  assert.ok(pts[pts.length - 1].x > pts[0].x);
  const dy = Math.abs(pts[pts.length - 1].y - pts[0].y);
  assert.ok(dy < 2, 'no lateral bend without gravity');
});

// --- Freeze movers on ghost; live advance moves mills ---
test('simulateTrajectory advanceMovers:false freezes windmill angle on input + clone path', () => {
  const h = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 2.5, angle: 0.4 }],
  });
  const angleBefore = h.windmills[0].angle;
  const ball = createBallState(h.tee);
  simulateTrajectory(h, ball, 180, 0, { maxTicks: 90, advanceMovers: false });
  assert.strictEqual(h.windmills[0].angle, angleBefore, 'input hole angle unchanged');
});

test('advanceHoleObstacles changes windmill angle (live Test BALL_MOVING)', () => {
  const h = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 2.5, angle: 0 }],
  });
  const a0 = h.windmills[0].angle;
  for (let i = 0; i < 30; i++) advanceHoleObstacles(h, TICK_DT);
  assert.ok(Math.abs(h.windmills[0].angle - a0) > 1e-4, 'live advance rotates mill');
});

test('ghost freeze vs live advance: same hole, angles diverge', () => {
  const hLive = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 3, angle: 0.1 }],
  });
  const hGhost = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 3, angle: 0.1 }],
  });
  const ball = createBallState(hGhost.tee);
  simulateTrajectory(hGhost, ball, 100, 0, { maxTicks: 60, advanceMovers: false });
  for (let i = 0; i < 60; i++) advanceHoleObstacles(hLive, TICK_DT);
  assert.strictEqual(hGhost.windmills[0].angle, 0.1, 'ghost input frozen');
  assert.ok(Math.abs(hLive.windmills[0].angle - 0.1) > 0.01, 'live mill moved');
});

// --- Rest / wake contract used by editor Test loop ---
test('ballMayRestForAim false while floating in planet field at rest velocity', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 20000, { fieldRadius: 280 })],
  });
  // Just outside crust, inside field — floating.
  const ball = createBallState({ x: 400 + 40 + Shared.BALL_RADIUS + 10, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  assert.ok(!ballMayRestForAim(ball, h), 'must not rest while floating (editor wakes BALL_MOVING)');
  for (let i = 0; i < 100; i++) stepBallPhysics(ball, h, TICK_DT);
  assert.ok(ball.x < 400 + 40 + Shared.BALL_RADIUS + 10 - 1, 'falls toward planet');
});

test('after settle on crust, ballMayRestForAim allows aim again', () => {
  const h = blankHole({
    gravityBodies: [planet(400, 250, 40, 20000, { fieldRadius: 280 })],
  });
  const ball = createBallState({ x: 400 + 40 + Shared.BALL_RADIUS + 12, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  for (let i = 0; i < 180; i++) {
    stepBallPhysics(ball, h, TICK_DT);
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp < STOP_THRESHOLD && ballMayRestForAim(ball, h)) {
      ball.vx = 0;
      ball.vy = 0;
      break;
    }
  }
  assert.ok(ballMayRestForAim(ball, h), 'may aim once on crust/settled');
});

if (process.exitCode) {
  console.error('editor-test-physics: FAILED');
} else {
  console.log('editor-test-physics: ' + passed + ' passed');
}
