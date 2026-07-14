'use strict';
/**
 * Wall collision is surface-to-surface: ball disk vs thick segment
 * (centerline ± WALL_HALF_WIDTH), not centroid vs zero-width line.
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, createBallState, stepBallPhysics, resolveWallCollision, wall,
  BALL_RADIUS, WALL_HALF_WIDTH, WALL_THICKNESS, TICK_DT,
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

console.log('wall-surface-collision');

test('WALL_THICKNESS matches drawn stroke (10)', () => {
  assert.strictEqual(WALL_THICKNESS, 10);
  assert.strictEqual(WALL_HALF_WIDTH, 5);
});

test('resolveWallCollision pushes out to ball surface + wall half-width', () => {
  // Vertical wall on x=400. Ball approaching from the left with center at
  // 400 - (BALL_RADIUS + WALL_HALF_WIDTH) + 2 → already penetrating by 2.
  const contactR = BALL_RADIUS + WALL_HALF_WIDTH;
  const w = wall(400, 100, 400, 400);
  const ball = createBallState({ x: 400 - contactR + 2, y: 250 });
  ball.vx = 100;
  ball.vy = 0;
  const hit = resolveWallCollision(ball, w);
  assert.ok(hit, 'bounce fires');
  // After resolve, center should be ~contactR (+ epsilon) from the wall.
  const dist = Math.abs(ball.x - 400);
  assert.ok(dist >= contactR - 0.01, 'not still inside solid (dist=' + dist + ')');
  assert.ok(dist <= contactR + 0.5, 'not teleported far (dist=' + dist + ')');
  assert.ok(ball.vx < 0, 'reflects leftward');
});

test('no contact when ball surface is clear of wall solid', () => {
  const w = wall(400, 100, 400, 400);
  const ball = createBallState({ x: 400 - (BALL_RADIUS + WALL_HALF_WIDTH + 1), y: 250 });
  ball.vx = 50;
  ball.vy = 0;
  const hit = resolveWallCollision(ball, w);
  assert.ok(!hit, 'no contact when surfaces do not overlap');
  assert.ok(ball.vx === 50, 'velocity unchanged');
});

test('stepBallPhysics keeps ball outside thick wall while coasting into it', () => {
  const h = blankHole({
    walls: [wall(500, 100, 500, 400)],
    cup: { x: 100, y: 100, radius: 11 },
  });
  const contactR = BALL_RADIUS + WALL_HALF_WIDTH;
  // Start just outside, move +x into the wall.
  const ball = createBallState({ x: 500 - contactR - 15, y: 250 });
  ball.vx = 400;
  ball.vy = 0;
  for (let i = 0; i < 90; i++) stepBallPhysics(ball, h, TICK_DT);
  // Never penetrate deeper than a small epsilon inside contactR.
  assert.ok(ball.x <= 500 - contactR + 1.5, 'surface stays outside wall solid (x=' + ball.x + ')');
  assert.ok(ball.vx <= 0 || Math.abs(ball.x - (500 - contactR)) < 3, 'bounced or resting at surface');
});

if (!process.exitCode) console.log('wall-surface-collision: ' + passed + ' passed');
else console.log('wall-surface-collision: FAILED');
