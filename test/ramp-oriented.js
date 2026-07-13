'use strict';
/**
 * After oriented ramp pads: every shipped hole with ramps stays playable.
 * - angle≈0 ramps: circleTouchesRamp ≡ circleTouchesZone (AABB identity)
 * - every ramp: ball on pad center, velocity along launch angle, speed>minSpeed → launches
 * - angled ramps: approach along angle from outside still launches
 */
const assert = require('assert');
const S = require('../shared.js');

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

function allRamps() {
  const out = [];
  for (const c of S.COURSES) {
    c.holes.forEach((h, hi) => {
      (h.ramps || []).forEach((ramp, ri) => {
        out.push({ course: c.id, hole: h, hi, ramp, ri });
      });
    });
  }
  return out;
}

const ramps = allRamps();
assert.ok(ramps.length >= 20, 'expected canyon+goo ramps, got ' + ramps.length);

test('axis-aligned ramps: oriented touch matches AABB', () => {
  let checks = 0;
  for (const { ramp, course, hole, ri } of ramps) {
    if (Math.abs(ramp.angle || 0) > 1e-9) continue;
    for (let x = ramp.x1 - 12; x <= ramp.x2 + 12; x += 8) {
      for (let y = ramp.y1 - 12; y <= ramp.y2 + 12; y += 8) {
        const a = S.circleTouchesZone(x, y, S.BALL_RADIUS, ramp);
        const b = S.circleTouchesRamp(x, y, S.BALL_RADIUS, ramp);
        assert.strictEqual(a, b, `${course}/${hole.name} r${ri} @${x},${y}`);
        checks++;
      }
    }
  }
  assert.ok(checks > 100, 'enough samples');
});

test('every ramp launches when on-pad along angle above minSpeed', () => {
  for (const { course, hole, ramp, ri } of ramps) {
    const h = S.deepCloneHole(hole);
    S.resetHoleObstacles(h);
    const cx = (ramp.x1 + ramp.x2) / 2, cy = (ramp.y1 + ramp.y2) / 2;
    const a = ramp.angle || 0;
    const speed = (ramp.minSpeed || S.RAMP_MIN_SPEED) + 50;
    const ball = S.createBallState({ x: cx, y: cy });
    ball.vx = Math.cos(a) * speed;
    ball.vy = Math.sin(a) * speed;
    let launched = false;
    for (let t = 0; t < 24; t++) {
      if (S.stepBallPhysics(ball, h, S.TICK_DT).launched) {
        launched = true;
        break;
      }
    }
    assert.ok(launched, `${course}/${hole.name} ramp${ri} ang=${a}`);
    assert.ok((ball.z || 0) > 0 || ball.vz > 0, 'airborne after launch');
  }
});

test('angled canyon ramps launch when approached along angle', () => {
  const angled = ramps.filter((x) => Math.abs(x.ramp.angle || 0) > 0.05);
  assert.ok(angled.length >= 3, 'expected several angled ramps');
  for (const { course, hole, ramp, ri } of angled) {
    const h = S.deepCloneHole(hole);
    S.resetHoleObstacles(h);
    const cx = (ramp.x1 + ramp.x2) / 2, cy = (ramp.y1 + ramp.y2) / 2;
    const a = ramp.angle || 0;
    const dist = Math.max(ramp.x2 - ramp.x1, ramp.y2 - ramp.y1) * 0.65 + 35;
    const ball = S.createBallState({
      x: cx - Math.cos(a) * dist,
      y: cy - Math.sin(a) * dist,
    });
    const speed = Math.max(450, (ramp.minSpeed || S.RAMP_MIN_SPEED) + 100);
    ball.vx = Math.cos(a) * speed;
    ball.vy = Math.sin(a) * speed;
    let launched = false;
    for (let t = 0; t < S.TICK_HZ * 4; t++) {
      S.advanceHoleObstacles(h, S.TICK_DT);
      if (S.stepBallPhysics(ball, h, S.TICK_DT).launched) {
        launched = true;
        break;
      }
    }
    assert.ok(launched, `approach ${course}/${hole.name} r${ri}`);
  }
});

test('oriented corners exist for non-zero angle', () => {
  const r = S.rampRect(100, 100, 200, 160, Math.PI / 4);
  const c = S.orientedRectCorners(r);
  assert.strictEqual(c.length, 4);
  // Not the same as AABB corners when rotated
  const aabb = [
    { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 160 }, { x: 100, y: 160 },
  ];
  const match = c.every((p) => aabb.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.5));
  assert.ok(!match, 'rotated corners differ from AABB');
});

if (process.exitCode) {
  console.error('ramp-oriented: FAILED');
  process.exit(1);
}
console.log('ramp-oriented: %d tests passed (%d ramps audited)', passed, ramps.length);
