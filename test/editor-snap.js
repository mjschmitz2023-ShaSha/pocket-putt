'use strict';
/**
 * P3: pure unit tests for editor snap helpers (grid, vertices, midpoints, Shift-ortho).
 * No DOM.
 */
const assert = require('assert');
const Snap = require('../editor-snap.js');

const {
  collectSnapPoints,
  projectOrtho,
  snapToGrid,
  snapToGeometry,
  snapPoint,
  DEFAULT_RADIUS,
  DEFAULT_GRID,
} = Snap;

function approx(a, b, eps) {
  eps = eps == null ? 1e-9 : eps;
  return Math.abs(a - b) <= eps;
}

function ptEq(a, b, eps) {
  return approx(a.x, b.x, eps) && approx(a.y, b.y, eps);
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

const sampleHole = {
  tee: { x: 90, y: 250 },
  cup: { x: 710, y: 250, radius: 11 },
  walls: [
    { x1: 100, y1: 100, x2: 200, y2: 100 }, // horizontal wall mid (150,100)
    { x1: 300, y1: 50, x2: 300, y2: 150 },  // vertical
  ],
  sand: [{ shape: 'rect', x1: 400, y1: 200, x2: 500, y2: 300 }],
  water: [],
  boost: [],
  ramps: [],
  sticky: [],
  pendulums: [{ cx: 120, cy: 40, length: 100 }],
  gates: [{ x1: 50, y1: 400, x2: 150, y2: 400 }],
  windmills: [{ cx: 600, cy: 100, armLength: 80 }],
  gravityBodies: [
    { kind: 'planet', x: 450, y: 80, radius: 20 },
    { kind: 'moon', x: 520, y: 200, orbitCenter: { x: 500, y: 200 }, orbitRadius: 20 },
  ],
};

test('exports API + defaults', () => {
  assert.strictEqual(typeof collectSnapPoints, 'function');
  assert.strictEqual(typeof snapToGeometry, 'function');
  assert.strictEqual(typeof snapPoint, 'function');
  assert.strictEqual(typeof projectOrtho, 'function');
  assert.strictEqual(DEFAULT_RADIUS, 12);
  assert.strictEqual(DEFAULT_GRID, 5);
});

test('collectSnapPoints: wall ends + midpoints', () => {
  const pts = collectSnapPoints(sampleHole);
  const has = (x, y, kind) => pts.some((p) => approx(p.x, x) && approx(p.y, y) && (!kind || p.kind === kind));
  assert.ok(has(100, 100, 'vertex'), 'wall start');
  assert.ok(has(200, 100, 'vertex'), 'wall end');
  assert.ok(has(150, 100, 'midpoint'), 'wall midpoint');
  assert.ok(has(300, 50, 'vertex'));
  assert.ok(has(300, 100, 'midpoint'), 'vertical wall mid');
});

test('collectSnapPoints: rect corners + edge midpoints', () => {
  const pts = collectSnapPoints(sampleHole);
  const has = (x, y) => pts.some((p) => approx(p.x, x) && approx(p.y, y));
  assert.ok(has(400, 200) && has(500, 300), 'rect corners');
  assert.ok(has(450, 200), 'top edge mid');
  assert.ok(has(400, 250), 'left edge mid');
});

test('collectSnapPoints: tee, cup, hub, pivot, body, orbit', () => {
  const pts = collectSnapPoints(sampleHole);
  const kinds = new Set(pts.map((p) => p.kind));
  assert.ok(kinds.has('tee'));
  assert.ok(kinds.has('cup'));
  assert.ok(kinds.has('hub'));
  assert.ok(kinds.has('pivot'));
  assert.ok(kinds.has('body'));
  assert.ok(kinds.has('orbit'));
  assert.ok(pts.some((p) => p.kind === 'orbit' && approx(p.x, 500) && approx(p.y, 200)));
  assert.ok(pts.some((p) => p.kind === 'hub' && approx(p.x, 600) && approx(p.y, 100)));
  assert.ok(pts.some((p) => p.kind === 'pivot' && approx(p.x, 120) && approx(p.y, 40)));
});

test('collectSnapPoints: empty / null hole safe', () => {
  assert.deepStrictEqual(collectSnapPoints(null), []);
  assert.deepStrictEqual(collectSnapPoints({}), []);
});

test('projectOrtho: locks to H when movement more horizontal', () => {
  const o = projectOrtho(180, 105, { x: 100, y: 100 });
  assert.strictEqual(o.axis, 'h');
  assert.ok(approx(o.y, 100));
  assert.ok(approx(o.x, 180));
});

test('projectOrtho: locks to V when movement more vertical', () => {
  const o = projectOrtho(105, 180, { x: 100, y: 100 });
  assert.strictEqual(o.axis, 'v');
  assert.ok(approx(o.x, 100));
  assert.ok(approx(o.y, 180));
});

test('snapToGrid rounds to gridSize', () => {
  const g = snapToGrid(12, 18, 5);
  assert.ok(approx(g.x, 10) && approx(g.y, 20));
  const g2 = snapToGrid(13, 17, 5);
  assert.ok(approx(g2.x, 15) && approx(g2.y, 15));
});

test('snapToGeometry: snaps near wall vertex within radius', () => {
  const r = snapToGeometry(103, 98, sampleHole, 12);
  assert.ok(r.snapped, 'should snap');
  assert.ok(ptEq(r, { x: 100, y: 100 }, 1e-9));
  assert.ok(r.target && ptEq(r.target, { x: 100, y: 100 }));
});

test('snapToGeometry: snaps to wall midpoint', () => {
  const r = snapToGeometry(152, 104, sampleHole, 12);
  assert.ok(r.snapped);
  assert.ok(ptEq(r, { x: 150, y: 100 }, 1e-9));
});

test('snapToGeometry: no snap outside radius', () => {
  const r = snapToGeometry(250, 250, sampleHole, 12);
  assert.ok(!r.snapped);
  assert.ok(approx(r.x, 250) && approx(r.y, 250));
});

test('snapPoint: geometry wins over grid when both in range', () => {
  // Near vertex (100,100); grid would snap 103→105 if grid-only
  const r = snapPoint(103, 98, sampleHole, { grid: true, gridSize: 5, radius: 12 });
  assert.ok(r.snapped);
  assert.strictEqual(r.source, 'geometry');
  assert.ok(ptEq(r, { x: 100, y: 100 }));
});

test('snapPoint: grid when no geometry in range', () => {
  const r = snapPoint(253, 257, sampleHole, { grid: true, gridSize: 5, radius: 12 });
  assert.ok(r.snapped);
  assert.strictEqual(r.source, 'grid');
  assert.ok(ptEq(r, { x: 255, y: 255 }));
});

test('snapPoint: no grid, free coords when far from geometry', () => {
  const r = snapPoint(253.5, 257.5, sampleHole, { grid: false, radius: 12 });
  assert.ok(!r.snapped);
  assert.ok(approx(r.x, 253.5) && approx(r.y, 257.5));
});

test('snapPoint: Shift ortho then vertex along line', () => {
  // From (100,100), free cursor near (200, 108) → H lock y=100, then snap to wall end (200,100)
  const r = snapPoint(200, 108, sampleHole, {
    grid: false,
    radius: 12,
    shift: true,
    orthoFrom: { x: 100, y: 100 },
  });
  assert.ok(r.snapped);
  assert.ok(ptEq(r, { x: 200, y: 100 }));
  assert.strictEqual(r.source, 'geometry');
});

test('snapPoint: Shift ortho without geometry stays on axis', () => {
  const r = snapPoint(250, 108, sampleHole, {
    grid: false,
    radius: 12,
    shift: true,
    orthoFrom: { x: 100, y: 100 },
  });
  // Horizontal lock: y=100, x free; no wall vertex at 250 on that line within radius
  assert.ok(approx(r.y, 100));
  assert.ok(approx(r.x, 250));
  assert.ok(!r.snapped || r.source === 'ortho' || r.source == null);
});

test('snapPoint: Shift vertical ortho to vertical wall', () => {
  // From (300, 200) toward (305, 50) → V lock x=300, snap to wall end (300,50)
  const r = snapPoint(305, 50, sampleHole, {
    grid: false,
    radius: 12,
    shift: true,
    orthoFrom: { x: 300, y: 200 },
  });
  assert.ok(r.snapped);
  assert.ok(ptEq(r, { x: 300, y: 50 }));
});

test('snapPoint: Shift + grid after ortho when no vertex', () => {
  const r = snapPoint(253, 108, sampleHole, {
    grid: true,
    gridSize: 5,
    radius: 12,
    shift: true,
    orthoFrom: { x: 100, y: 100 },
  });
  // y locked to 100, x→255 grid; (250,100) might exist as mid? wall mid is 150. No geometry at ~253.
  assert.ok(approx(r.y, 100));
  assert.ok(r.snapped);
  assert.strictEqual(r.source, 'grid');
  assert.ok(approx(r.x, 255));
});

test('snapToGeometry along ortho rejects off-axis targets', () => {
  // Cursor on H line at (150, 100); planet at (450,80) is far. Midpoint (150,100) should win.
  const r = snapToGeometry(148, 100, sampleHole, 12, {
    axis: 'h',
    orthoFrom: { x: 100, y: 100 },
  });
  assert.ok(r.snapped);
  assert.ok(ptEq(r, { x: 150, y: 100 }));
});

test('collectSnapPoints skip excludes dragged wall (no self-snap)', () => {
  const all = collectSnapPoints(sampleHole);
  const skipped = collectSnapPoints(sampleHole, { skip: { kind: 'walls', index: 0 } });
  assert.ok(all.some((p) => approx(p.x, 100) && approx(p.y, 100)));
  assert.ok(!skipped.some((p) => approx(p.x, 100) && approx(p.y, 100) && p.kind === 'vertex'));
  assert.ok(!skipped.some((p) => approx(p.x, 150) && approx(p.y, 100) && p.kind === 'midpoint'));
  // Other wall still present
  assert.ok(skipped.some((p) => approx(p.x, 300) && approx(p.y, 50)));
});

test('snapPoint skip: near own wall endpoint does not pin when skipped', () => {
  // Cursor near wall0 start; with skip walls[0] should not snap to (100,100)
  const r = snapPoint(103, 98, sampleHole, {
    grid: false,
    radius: 12,
    skip: { kind: 'walls', index: 0 },
  });
  assert.ok(!r.snapped);
  assert.ok(approx(r.x, 103) && approx(r.y, 98));
});

if (!process.exitCode) {
  console.log('editor-snap: ' + passed + ' tests passed');
} else {
  console.error('editor-snap: failures present');
}
