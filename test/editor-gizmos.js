'use strict';
/**
 * P4: pure unit tests for editor gizmo helpers
 * (angle from drag, rect resize, endpoints, amplitude, radii).
 * No DOM.
 */
const assert = require('assert');
const G = require('../editor-gizmos.js');

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

test('exports API', () => {
  assert.strictEqual(typeof G.angleFromPoint, 'function');
  assert.strictEqual(typeof G.resizeRectFromCorner, 'function');
  assert.strictEqual(typeof G.getHandles, 'function');
  assert.strictEqual(typeof G.hitTestHandles, 'function');
  assert.strictEqual(typeof G.applyHandleDrag, 'function');
  assert.ok(G.HANDLE_HIT_R > 0);
  assert.ok(G.ARROW_LEN > 0);
});

test('angleFromPoint: cardinal directions', () => {
  assert.ok(approx(G.angleFromPoint(0, 0, 1, 0), 0));
  assert.ok(approx(G.angleFromPoint(0, 0, 0, 1), Math.PI / 2));
  assert.ok(approx(G.angleFromPoint(0, 0, -1, 0), Math.PI));
  assert.ok(approx(G.angleFromPoint(0, 0, 0, -1), -Math.PI / 2));
});

test('angleArrowTip length and direction', () => {
  const tip = G.angleArrowTip(10, 20, 0, 40);
  assert.ok(approx(tip.x, 50));
  assert.ok(approx(tip.y, 20));
  const tip2 = G.angleArrowTip(0, 0, Math.PI / 2, 10);
  assert.ok(approx(tip2.x, 0, 1e-9));
  assert.ok(approx(tip2.y, 10, 1e-9));
});

test('resizeRectFromCorner: se expands', () => {
  const start = { x1: 100, y1: 100, x2: 200, y2: 180 };
  const r = G.resizeRectFromCorner(start, 'se', 250, 220);
  assert.strictEqual(r.x1, 100);
  assert.strictEqual(r.y1, 100);
  assert.strictEqual(r.x2, 250);
  assert.strictEqual(r.y2, 220);
});

test('resizeRectFromCorner: nw shrinks with min size', () => {
  const start = { x1: 100, y1: 100, x2: 200, y2: 200 };
  // drag past opposite corner — clamp by minSize
  const r = G.resizeRectFromCorner(start, 'nw', 300, 300, 8);
  assert.strictEqual(r.x1, 200 - 8);
  assert.strictEqual(r.y1, 200 - 8);
  assert.strictEqual(r.x2, 200);
  assert.strictEqual(r.y2, 200);
});

test('resizeRectFromCorner: ne', () => {
  const start = { x1: 10, y1: 10, x2: 50, y2: 60 };
  const r = G.resizeRectFromCorner(start, 'ne', 80, 5);
  assert.strictEqual(r.x1, 10);
  assert.strictEqual(r.y1, 5);
  assert.strictEqual(r.x2, 80);
  assert.strictEqual(r.y2, 60);
});

test('wallEndpointHandles', () => {
  const hs = G.wallEndpointHandles({ x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.strictEqual(hs.length, 2);
  assert.strictEqual(hs[0].id, 'p1');
  assert.strictEqual(hs[1].x, 3);
});

test('rectCornerHandles normalized', () => {
  // inverted rect still yields min/max corners
  const hs = G.rectCornerHandles({ x1: 50, y1: 50, x2: 10, y2: 20 });
  const nw = hs.find((h) => h.id === 'nw');
  assert.strictEqual(nw.x, 10);
  assert.strictEqual(nw.y, 20);
});

test('applyHandleDrag: boost angle', () => {
  const obj = { x1: 0, y1: 0, x2: 100, y2: 100, angle: 0, power: 100 };
  const start = JSON.parse(JSON.stringify(obj));
  const handle = { id: 'angle', kind: 'angle' };
  // center is (50,50); point to the right → angle 0
  G.applyHandleDrag('boost', obj, start, handle, 150, 50);
  assert.ok(approx(obj.angle, 0, 1e-9));
  // point up from center → -π/2 or wait atan2(-1,0) in canvas y-down: point above is y smaller
  G.applyHandleDrag('boost', obj, start, handle, 50, 0);
  assert.ok(approx(obj.angle, -Math.PI / 2, 1e-9));
});

test('applyHandleDrag: water drop', () => {
  const obj = { x1: 0, y1: 0, x2: 40, y2: 40, dropPoint: { x: 5, y: 5 } };
  const start = JSON.parse(JSON.stringify(obj));
  G.applyHandleDrag('water', obj, start, { id: 'drop' }, 12, 18);
  assert.strictEqual(obj.dropPoint.x, 12);
  assert.strictEqual(obj.dropPoint.y, 18);
});

test('applyHandleDrag: wall p2', () => {
  const obj = { x1: 0, y1: 0, x2: 10, y2: 0 };
  const start = JSON.parse(JSON.stringify(obj));
  const r = G.applyHandleDrag('walls', obj, start, { id: 'p2' }, 40, 5);
  assert.ok(r && r.rebuildWall);
  assert.strictEqual(obj.x1, 0);
  assert.strictEqual(obj.x2, 40);
  assert.strictEqual(obj.y2, 5);
});

test('pendulumAmplitudeFromDrag', () => {
  // angleCenter = 0 (right), drag straight up → π/2
  const a = G.pendulumAmplitudeFromDrag(0, 0, -10, 0, 0);
  assert.ok(approx(a, Math.PI / 2, 1e-9));
  // same direction → 0
  const a0 = G.pendulumAmplitudeFromDrag(0, 10, 0, 0, 0);
  assert.ok(approx(a0, 0, 1e-9));
});

test('gateAmplitudeFromDrag', () => {
  const g = { x1: 100, y1: 50, x2: 100, y2: 150, axis: 'x', amplitude: 20 };
  // midpoint (100,100); drag to x=140 → amp 40
  assert.strictEqual(G.gateAmplitudeFromDrag(g, 140, 100), 40);
  const gy = { x1: 0, y1: 0, x2: 40, y2: 0, axis: 'y', amplitude: 10 };
  assert.strictEqual(G.gateAmplitudeFromDrag(gy, 20, 35), 35);
});

test('lengthFromPivot min clamp', () => {
  assert.strictEqual(G.lengthFromPivot(0, 0, 1, 0, 12), 12);
  assert.strictEqual(G.lengthFromPivot(0, 0, 30, 40, 12), 50);
});

test('radiusFromCenter + rings', () => {
  assert.strictEqual(G.radiusFromCenter(0, 0, 3, 4, 1), 5);
  assert.ok(G.hitRadiusRing(0, 0, 50, 50, 0, 2));
  assert.ok(!G.hitRadiusRing(0, 0, 50, 0, 0, 2)); // center miss
});

test('getHandles: walls + water drop + boost angle', () => {
  const hole = {
    walls: [{ x1: 0, y1: 0, x2: 10, y2: 0 }],
    water: [{ x1: 0, y1: 0, x2: 40, y2: 40, dropPoint: { x: 5, y: -5 } }],
    boost: [{ x1: 0, y1: 0, x2: 100, y2: 100, angle: 0 }],
    sand: [], ramps: [], sticky: [],
    pendulums: [], gates: [], windmills: [], gravityBodies: [],
  };
  const wh = G.getHandles({ kind: 'walls', index: 0 }, hole);
  assert.strictEqual(wh.length, 2);

  const waterH = G.getHandles({ kind: 'water', index: 0 }, hole);
  assert.ok(waterH.some((h) => h.id === 'drop'));
  assert.ok(waterH.filter((h) => h.kind === 'corner').length === 4);

  const boostH = G.getHandles({ kind: 'boost', index: 0 }, hole);
  assert.ok(boostH.some((h) => h.id === 'angle'));
  const ang = boostH.find((h) => h.id === 'angle');
  // tip at center+(ARROW_LEN,0)
  assert.ok(approx(ang.x, 50 + G.ARROW_LEN));
  assert.ok(approx(ang.y, 50));
});

test('getHandles: planet rings + moon orbit', () => {
  const hole = {
    walls: [], sand: [], water: [], boost: [], ramps: [], sticky: [],
    pendulums: [], gates: [], windmills: [],
    gravityBodies: [
      { kind: 'planet', x: 100, y: 100, radius: 20, fieldRadius: 120 },
      {
        kind: 'moon', x: 200, y: 150, radius: 10,
        orbitCenter: { x: 150, y: 150 }, orbitRadius: 50, orbitPhase0: 0,
      },
    ],
  };
  const ph = G.getHandles({ kind: 'gravityBodies', index: 0 }, hole);
  assert.ok(ph.some((h) => h.id === 'radius' && h.ring));
  assert.ok(ph.some((h) => h.id === 'fieldRadius' && h.ring));

  const mh = G.getHandles({ kind: 'gravityBodies', index: 1 }, hole);
  assert.ok(mh.some((h) => h.id === 'orbitRadius'));
  assert.ok(mh.some((h) => h.id === 'orbitPhase'));
});

test('hitTestHandles prefers outer ring', () => {
  const handles = [
    { id: 'radius', kind: 'radius', x: 20, y: 0, cx: 0, cy: 0, radius: 20, ring: true },
    { id: 'fieldRadius', kind: 'fieldRadius', x: 80, y: 0, cx: 0, cy: 0, radius: 80, ring: true },
  ];
  const h = G.hitTestHandles(handles, 80, 0);
  assert.ok(h);
  assert.strictEqual(h.id, 'fieldRadius');
});

test('hitTestHandles angle tip', () => {
  const handles = [
    { id: 'nw', kind: 'corner', x: 0, y: 0 },
    { id: 'angle', kind: 'angle', x: 50, y: 50 },
  ];
  const h = G.hitTestHandles(handles, 52, 50);
  assert.ok(h);
  assert.strictEqual(h.id, 'angle');
});

test('applyHandleDrag: windmill arm + planet field', () => {
  const mill = { cx: 0, cy: 0, armLength: 40, angle: 0 };
  G.applyHandleDrag('windmills', mill, { cx: 0, cy: 0, armLength: 40 }, { id: 'arm' }, 80, 0);
  assert.strictEqual(mill.armLength, 80);

  const body = { kind: 'planet', x: 0, y: 0, radius: 10, fieldRadius: 60 };
  G.applyHandleDrag('gravityBodies', body, { x: 0, y: 0, radius: 10, fieldRadius: 60 }, { id: 'fieldRadius' }, 100, 0);
  assert.strictEqual(body.fieldRadius, 100);

  G.applyHandleDrag('gravityBodies', body, { x: 0, y: 0, radius: 10, fieldRadius: 100 }, { id: 'radius' }, 25, 0);
  assert.strictEqual(body.radius, 25);
});

test('applyHandleDrag: pendulum length + amplitude', () => {
  const p = { cx: 0, cy: 0, length: 100, angleCenter: 0, amplitude: 0.5 };
  const start = JSON.parse(JSON.stringify(p));
  G.applyHandleDrag('pendulums', p, start, { id: 'length' }, 0, 150);
  assert.strictEqual(p.length, 150);
  G.applyHandleDrag('pendulums', p, start, { id: 'amplitude' }, 0, 100);
  assert.ok(approx(p.amplitude, Math.PI / 2, 1e-9));
});

console.log(passed + ' tests passed');
if (process.exitCode) process.exit(process.exitCode);
