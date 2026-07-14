'use strict';
/**
 * P2: mover phase0 → absolute pose via setHoleObstaclesAtTick / advanceHoleObstacles.
 * Deterministic unit checks (no DOM).
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, normalizeHole, encodeHole, decodeHole,
  setHoleObstaclesAtTick, resetHoleObstacles, advanceHoleObstacles,
  pendulum, slidingGate, moon, getPendulumSegment, getSlidingGateSegment, getWindmillBlades,
  TICK_DT, TICK_HZ,
} = Shared;

function approx(a, b, eps) {
  eps = eps == null ? 1e-9 : eps;
  return Math.abs(a - b) <= eps;
}

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

test('windmill phase0 changes setHoleObstaclesAtTick pose vs phase0=0', () => {
  const h0 = normalizeHole(blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 2, phase0: 0, angle: 0 }],
  }));
  const h1 = normalizeHole(blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 2, phase0: 0.5, angle: 0.5 }],
  }));
  const tick = 30; // 0.5 s at 60 Hz
  setHoleObstaclesAtTick(h0, tick);
  setHoleObstaclesAtTick(h1, tick);
  const t = tick * TICK_DT;
  assert.ok(approx(h0.windmills[0].angle, 0 + 2 * t), 'base angle ' + h0.windmills[0].angle);
  assert.ok(approx(h1.windmills[0].angle, 0.5 + 2 * t), 'offset angle ' + h1.windmills[0].angle);
  assert.ok(!approx(h0.windmills[0].angle, h1.windmills[0].angle), 'poses differ');
  // Blade geometry differs
  const b0 = getWindmillBlades(h0.windmills[0]);
  const b1 = getWindmillBlades(h1.windmills[0]);
  assert.ok(
    !approx(b0[0].x2, b1[0].x2, 0.01) || !approx(b0[0].y2, b1[0].y2, 0.01),
    'blade tips differ'
  );
});

test('windmill phase0 round-trips encode/decode and survives setAtTick', () => {
  const h = blankHole({
    windmills: [{ cx: 300, cy: 200, armLength: 70, blades: 3, rotationSpeed: 1.25, phase0: 1.1, angle: 1.1 }],
  });
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok, d.error);
  assert.ok(approx(d.hole.windmills[0].phase0, 1.1, 0.02));
  setHoleObstaclesAtTick(d.hole, TICK_HZ); // 1 second
  assert.ok(approx(d.hole.windmills[0].angle, 1.1 + 1.25 * 1, 0.02));
});

test('pendulum phase0 preserved under setHoleObstaclesAtTick', () => {
  const h = normalizeHole(blankHole({
    pendulums: [pendulum(400, 20, 200, Math.PI / 2, 0.8, 2.0, 0.6)],
  }));
  setHoleObstaclesAtTick(h, 60); // +1s
  assert.ok(approx(h.pendulums[0].phase, 0.6 + 1, 1e-9));
  const seg = getPendulumSegment(h.pendulums[0]);
  const h0 = normalizeHole(blankHole({
    pendulums: [pendulum(400, 20, 200, Math.PI / 2, 0.8, 2.0, 0)],
  }));
  setHoleObstaclesAtTick(h0, 60);
  const seg0 = getPendulumSegment(h0.pendulums[0]);
  assert.ok(!approx(seg.x2, seg0.x2, 0.01) || !approx(seg.y2, seg0.y2, 0.01), 'pendulum tip differs');
});

test('gate phase0 preserved under setHoleObstaclesAtTick', () => {
  const h = normalizeHole(blankHole({
    gates: [slidingGate(400, 200, 400, 280, 'y', 50, 2.0, 0.7)],
  }));
  setHoleObstaclesAtTick(h, 30); // 0.5s
  assert.ok(approx(h.gates[0].phase, 0.7 + 0.5, 1e-9));
  const seg = getSlidingGateSegment(h.gates[0]);
  const h0 = normalizeHole(blankHole({
    gates: [slidingGate(400, 200, 400, 280, 'y', 50, 2.0, 0)],
  }));
  setHoleObstaclesAtTick(h0, 30);
  const seg0 = getSlidingGateSegment(h0.gates[0]);
  assert.ok(!approx(seg.y1, seg0.y1, 0.01), 'gate y offset differs');
});

test('resetHoleObstacles restores design phase0 poses', () => {
  const h = normalizeHole(blankHole({
    windmills: [{ cx: 100, cy: 100, armLength: 50, blades: 4, rotationSpeed: 1, phase0: 0.3, angle: 0.3 }],
    pendulums: [pendulum(200, 20, 100, Math.PI / 2, 0.5, 2, 0.2)],
    gates: [slidingGate(300, 100, 300, 150, 'x', 40, 2, 0.1)],
  }));
  advanceHoleObstacles(h, 2.5);
  assert.ok(h.windmills[0].angle !== 0.3);
  resetHoleObstacles(h);
  assert.ok(approx(h.windmills[0].angle, 0.3));
  assert.ok(approx(h.pendulums[0].phase, 0.2));
  assert.ok(approx(h.gates[0].phase, 0.1));
  assert.strictEqual(h._orbitTick, 0);
});

test('advanceHoleObstacles keeps phase0 delta between two windmills', () => {
  const h = normalizeHole(blankHole({
    windmills: [
      { cx: 200, cy: 200, armLength: 60, blades: 4, rotationSpeed: 1.5, phase0: 0, angle: 0 },
      { cx: 400, cy: 200, armLength: 60, blades: 4, rotationSpeed: 1.5, phase0: 0.8, angle: 0.8 },
    ],
  }));
  advanceHoleObstacles(h, 1.0);
  const delta = h.windmills[1].angle - h.windmills[0].angle;
  assert.ok(approx(delta, 0.8, 1e-9), 'delta ' + delta);
});

test('moon orbitPhase0 changes pose at same tick', () => {
  const a = normalizeHole(blankHole({
    gravityBodies: [moon(400, 250, 100, 14, 20, 240, { orbitPhase0: 0 })],
  }));
  const b = normalizeHole(blankHole({
    gravityBodies: [moon(400, 250, 100, 14, 20, 240, { orbitPhase0: 1.0 })],
  }));
  setHoleObstaclesAtTick(a, 0);
  setHoleObstaclesAtTick(b, 0);
  assert.ok(!approx(a.gravityBodies[0].x, b.gravityBodies[0].x, 0.5)
    || !approx(a.gravityBodies[0].y, b.gravityBodies[0].y, 0.5));
});

if (process.exitCode) {
  console.error('editor-phase: FAILED');
  process.exit(1);
}
console.log('editor-phase: ' + passed + ' passed');
