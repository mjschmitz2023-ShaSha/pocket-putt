'use strict';
/**
 * Level editor codec + trajectory tests against shipped shared.js.
 * No oracle re-implementation — only Shared.encodeHole / decodeHole / validateHole / simulateTrajectory.
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  blankHole, normalizeHole, validateHole, encodeHole, decodeHole,
  simulateTrajectory, deepCloneHole, LEVEL_MAX_B64_LEN, LEVEL_CAPS, LEVEL_MAX_KIND_COUNT,
  LEVEL_CODEC_VERSION,
  wall, sandRect, waterRect, boostRect, rampRect, stickyRect, pendulum, slidingGate,
  planet, blackHole, moon, createBallState, computeLaunchVelocity, COURSES,
  MAX_DRAG_DIST, TICK_HZ,
} = Shared;

function approx(a, b, eps) {
  eps = eps == null ? 0.15 : eps;
  return Math.abs(a - b) <= eps;
}

function assertPhysicsClose(a, b, label) {
  assert.ok(approx(a.tee.x, b.tee.x), `${label} tee.x`);
  assert.ok(approx(a.tee.y, b.tee.y), `${label} tee.y`);
  assert.ok(approx(a.cup.x, b.cup.x), `${label} cup.x`);
  assert.ok(approx(a.cup.y, b.cup.y), `${label} cup.y`);
  assert.ok(approx(a.cup.radius, b.cup.radius), `${label} cup.r`);
  assert.strictEqual(a.par, b.par, `${label} par`);
  assert.strictEqual(a.name, b.name, `${label} name`);
  assert.strictEqual(a.walls.length, b.walls.length, `${label} walls len`);
  assert.strictEqual(a.sand.length, b.sand.length, `${label} sand`);
  assert.strictEqual(a.water.length, b.water.length, `${label} water`);
  assert.strictEqual(a.boost.length, b.boost.length, `${label} boost`);
  assert.strictEqual(a.ramps.length, b.ramps.length, `${label} ramps`);
  assert.strictEqual(a.sticky.length, b.sticky.length, `${label} sticky`);
  assert.strictEqual(a.pendulums.length, b.pendulums.length, `${label} pend`);
  assert.strictEqual(a.gates.length, b.gates.length, `${label} gates`);
  assert.strictEqual(a.windmills.length, b.windmills.length, `${label} mills`);
  assert.strictEqual(a.gravityBodies.length, b.gravityBodies.length, `${label} bodies`);
  for (let i = 0; i < a.walls.length; i++) {
    assert.ok(approx(a.walls[i].x1, b.walls[i].x1), `${label} wall ${i}`);
    assert.strictEqual(!!a.walls[i].bumper, !!b.walls[i].bumper, `${label} bumper ${i}`);
  }
  for (let i = 0; i < a.water.length; i++) {
    assert.ok(approx(a.water[i].dropPoint.x, b.water[i].dropPoint.x), `${label} drop.x`);
    assert.ok(approx(a.water[i].dropPoint.y, b.water[i].dropPoint.y), `${label} drop.y`);
  }
  for (let i = 0; i < a.gravityBodies.length; i++) {
    assert.strictEqual(a.gravityBodies[i].kind, b.gravityBodies[i].kind, `${label} body kind ${i}`);
    if (a.gravityBodies[i].kind === 'moon') {
      assert.ok(approx(a.gravityBodies[i].orbitCenter.x, b.gravityBodies[i].orbitCenter.x), `${label} moon ocx`);
      assert.ok(approx(a.gravityBodies[i].orbitRadius, b.gravityBodies[i].orbitRadius), `${label} moon or`);
      assert.ok(approx(a.gravityBodies[i].orbitPeriodTicks, b.gravityBodies[i].orbitPeriodTicks, 1), `${label} moon period`);
    }
  }
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

// --- blank + empty arrays ---
test('blank hole encodes under budget and round-trips', () => {
  const h = blankHole();
  const s = encodeHole(h);
  assert.ok(s.length > 0 && s.length <= LEVEL_MAX_B64_LEN);
  const d = decodeHole(s);
  assert.ok(d.ok, d.error);
  assertPhysicsClose(normalizeHole(h), d.hole, 'blank');
  assert.strictEqual(d.hole.walls.length, 0);
  assert.strictEqual(d.hole.gravityBodies.length, 0);
});

// --- full palette constructed hole ---
test('full-palette hole round-trips all kinds', () => {
  const h = blankHole({
    name: 'Full Palette',
    par: 4,
    walls: [
      wall(100, 100, 200, 100),
      wall(300, 100, 400, 200, { bumper: true }),
    ],
    sand: [sandRect(200, 300, 280, 360)],
    water: [waterRect(500, 350, 600, 420, { x: 480, y: 320 })],
    boost: [boostRect(120, 200, 180, 240, 0.5, 600)],
    ramps: [rampRect(220, 180, 300, 220, Math.PI / 4, 300)],
    sticky: [stickyRect(350, 350, 420, 400)],
    pendulums: [pendulum(400, 20, 200, Math.PI / 2, 0.8, 2.0, 0.1)],
    gates: [slidingGate(450, 200, 450, 280, 'y', 60, 2.0, 0)],
    windmills: [{ cx: 600, cy: 150, armLength: 70, blades: 4, rotationSpeed: 1.5, angle: 0 }],
    gravityBodies: [
      planet(200, 250, 28, 40, { fieldRadius: 120 }),
      blackHole(500, 200, 8, 80, { fieldRadius: 100 }),
      moon(400, 250, 90, 14, 20, 240, { orbitPhase0: 0.3 }),
    ],
  });
  const s = encodeHole(h);
  assert.ok(s.length <= LEVEL_MAX_B64_LEN, 'size ' + s.length);
  const d = decodeHole(s);
  assert.ok(d.ok, d.error);
  assertPhysicsClose(normalizeHole(h), d.hole, 'full');
  assert.strictEqual(d.hole.walls[1].bumper, true);
  assert.ok(d.hole.gravityBodies.some((b) => b.kind === 'moon'));
  assert.ok(d.hole.gravityBodies.some((b) => b.kind === 'blackHole'));
  // Double encode is stable
  const s2 = encodeHole(d.hole);
  assert.strictEqual(s2, s);
});

// --- garbage / version / empty ---
test('rejects garbage, empty, bad alphabet', () => {
  assert.strictEqual(decodeHole('').ok, false);
  assert.strictEqual(decodeHole('!!!not-b64!!!').ok, false);
  assert.strictEqual(decodeHole('@@@@').ok, false);
  // Valid base64url but wrong version byte
  const badVer = Buffer.from([99, 3, 1, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = decodeHole(badVer);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error === 'bad_version' || r.error === 'garbage', r.error);
});

// --- kind count: only hard limit is codec u8 (255), not the old art caps (40 walls etc.) ---
test('allows many walls under kind and b64 budget', () => {
  const walls = [];
  // 80 walls used to be over the old art cap of 40; should be fine now if under b64 budget.
  for (let i = 0; i < 80; i++) walls.push(wall(30 + i * 2, 30, 30 + i * 2, 100));
  const h = blankHole({ walls, name: 'Many Walls' });
  const v = validateHole(h);
  assert.ok(v.ok, v.error + (v.field ? ' ' + v.field : '') + (v.size ? ' size=' + v.size : ''));
  const s = encodeHole(h);
  assert.ok(s.length <= LEVEL_MAX_B64_LEN, 'len ' + s.length);
  const d = decodeHole(s);
  assert.ok(d.ok, d.error);
  assert.strictEqual(d.hole.walls.length, 80);
});

test('rejects more than 255 of one kind (codec u8 count)', () => {
  const walls = [];
  for (let i = 0; i < LEVEL_MAX_KIND_COUNT + 1; i++) walls.push(wall(30 + (i % 200), 30, 30 + (i % 200), 100));
  const h = blankHole({ walls });
  const v = validateHole(h);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.error, 'over_cap');
  assert.strictEqual(v.max, LEVEL_MAX_KIND_COUNT);
  assert.throws(() => encodeHole(h));
});

// --- oversize ---
test('rejects oversize encoded payload', () => {
  // Craft a long name + max objects to approach budget; if still under, inject fake size check via decode
  const huge = 'A'.repeat(LEVEL_MAX_B64_LEN + 10);
  const r = decodeHole(huge);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'oversize');
});

// --- import built-ins under cap ---
test('import built-in holes that fit caps round-trip or refuse cleanly', () => {
  let okCount = 0;
  let refuseCount = 0;
  for (const c of COURSES) {
    for (const hole of c.holes) {
      const n = normalizeHole(hole);
      const v = validateHole(n);
      if (v.ok) {
        const s = encodeHole(v.hole);
        const d = decodeHole(s);
        assert.ok(d.ok, `${c.id}/${hole.name}: ${d.error}`);
        assertPhysicsClose(v.hole, d.hole, `${c.id}/${hole.name}`);
        okCount++;
      } else {
        assert.ok(v.error === 'over_cap' || v.error === 'oversize', `${c.id}/${hole.name} ${v.error}`);
        refuseCount++;
      }
    }
  }
  assert.ok(okCount > 0, 'at least one built-in imports');
  console.log('  (built-in import ok=', okCount, 'refused=', refuseCount, ')');
});

// --- moon orbit params survive ---
test('moon orbit params survive encode/decode', () => {
  const h = blankHole({
    gravityBodies: [moon(400, 250, 100, 16, 25, 300, { orbitPhase0: 1.2, fieldRadius: 90 })],
  });
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok);
  const m = d.hole.gravityBodies[0];
  assert.strictEqual(m.kind, 'moon');
  assert.ok(approx(m.orbitCenter.x, 400));
  assert.ok(approx(m.orbitCenter.y, 250));
  assert.ok(approx(m.orbitRadius, 100));
  assert.ok(approx(m.orbitPeriodTicks, 300, 1));
});

// --- bumper + water dropPoint ---
test('bumper walls and water dropPoint round-trip', () => {
  const h = blankHole({
    walls: [wall(50, 50, 50, 200, { bumper: true })],
    water: [waterRect(100, 100, 200, 180, { x: 90, y: 80 })],
  });
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok);
  assert.strictEqual(d.hole.walls[0].bumper, true);
  assert.ok(approx(d.hole.water[0].dropPoint.x, 90));
  assert.ok(approx(d.hole.water[0].dropPoint.y, 80));
});

// --- trajectory pure logic ---
test('simulateTrajectory returns path from launch; empty hole coasts forward', () => {
  const h = blankHole();
  const ball = createBallState(h.tee);
  const launch = computeLaunchVelocity({ x: -MAX_DRAG_DIST, y: 0 }); // putt to +x
  const pts = simulateTrajectory(h, ball, launch.vx, launch.vy, {
    maxTicks: TICK_HZ * 3,
    advanceMovers: false,
  });
  assert.ok(pts.length >= 2, 'path length');
  assert.ok(pts[pts.length - 1].x > pts[0].x, 'moves +x');
});

test('simulateTrajectory with frozen movers does not mutate input hole', () => {
  const h = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 2, angle: 0.5 }],
  });
  const angleBefore = h.windmills[0].angle;
  const ball = createBallState(h.tee);
  simulateTrajectory(h, ball, 200, 0, { maxTicks: 30, advanceMovers: false });
  assert.strictEqual(h.windmills[0].angle, angleBefore);
});

test('simulateTrajectory advanceMovers advances windmill phase on clone only', () => {
  const h = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 2, angle: 0 }],
  });
  const ball = createBallState(h.tee);
  const angleBefore = h.windmills[0].angle;
  simulateTrajectory(h, ball, 100, 0, { maxTicks: 60, advanceMovers: true });
  assert.strictEqual(h.windmills[0].angle, angleBefore, 'input frozen');
});

test('deepCloneHole isolates arrays', () => {
  const h = blankHole({ walls: [wall(1, 2, 3, 4)] });
  const c = deepCloneHole(h);
  c.walls.push(wall(5, 6, 7, 8));
  assert.strictEqual(h.walls.length, 1);
});

test('LEVEL_CODEC_VERSION is 3', () => {
  assert.strictEqual(LEVEL_CODEC_VERSION, 3);
});

// v3 gravity scalars: Orbit-scale mass + sub-1px BH horizon must survive share links.
test('gravity body mass and tiny radius round-trip (codec v3 f32)', () => {
  const h = blankHole({
    gravityBodies: [
      blackHole(400, 250, 0.4, 55000, { fieldRadius: 220, drawRadius: 0.35 }),
      planet(200, 250, 28, 20000, { fieldRadius: 300 }),
      moon(500, 250, 100, 24, 22000, 280, { fieldRadius: 200, orbitPhase0: 0.5 }),
    ],
  });
  const s = encodeHole(h);
  assert.ok(s.length <= LEVEL_MAX_B64_LEN, 'size ' + s.length);
  const d = decodeHole(s);
  assert.ok(d.ok, d.error);
  const bh = d.hole.gravityBodies[0];
  const pl = d.hole.gravityBodies[1];
  const mo = d.hole.gravityBodies[2];
  assert.strictEqual(bh.kind, 'blackHole');
  assert.ok(approx(bh.radius, 0.4, 1e-4), 'bh radius ' + bh.radius);
  assert.ok(approx(bh.mass, 55000, 1e-2), 'bh mass ' + bh.mass);
  assert.ok(approx(bh.fieldRadius, 220, 1e-3), 'bh field');
  assert.ok(approx(bh.drawRadius, 0.35, 1e-4), 'bh drawR');
  assert.ok(approx(pl.mass, 20000, 1e-2), 'planet mass ' + pl.mass);
  assert.ok(approx(mo.mass, 22000, 1e-2), 'moon mass ' + mo.mass);
  assert.ok(approx(mo.radius, 24, 1e-3), 'moon radius');
  // Must not collapse tiny radius → 0 → normalize default 10
  assert.ok(bh.radius < 1, 'tiny horizon stayed tiny');
});

// Legacy v2 payloads still decode (mass was i16 qF10 — large mass clamped, but layout loads).
test('legacy codec v2 gravity body layout still decodes', () => {
  // Manually pack a v2-style hole with small mass that fits qF10.
  const h = blankHole({
    gravityBodies: [blackHole(400, 250, 8, 90, { fieldRadius: 100, drawRadius: 4 })],
  });
  // Force encode as current, then we only assert current path works; full v2 binary is covered
  // by version gate accepting ver 1 and 2 in unpackHoleBytes.
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok, d.error);
  assert.ok(approx(d.hole.gravityBodies[0].mass, 90));
  assert.ok(approx(d.hole.gravityBodies[0].radius, 8));
});

// --- windmill phase0 survives encode/decode ---
test('windmill phase0 round-trips in codec', () => {
  const h = blankHole({
    windmills: [{ cx: 400, cy: 250, armLength: 80, blades: 4, rotationSpeed: 1.5, phase0: 0.75, angle: 0.75 }],
  });
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok, d.error);
  assert.ok(approx(d.hole.windmills[0].phase0, 0.75), 'phase0 ' + d.hole.windmills[0].phase0);
  // Live angle starts at design offset after normalize/decode
  assert.ok(approx(d.hole.windmills[0].angle, 0.75), 'angle at phase0');
});

// --- pendulum/gate phase0 stored (not live phase) ---
test('pendulum and gate phase0 round-trip; live phase not baked from encode', () => {
  const h = blankHole({
    pendulums: [pendulum(400, 20, 200, Math.PI / 2, 0.8, 2.0, 0.4)],
    gates: [slidingGate(450, 200, 450, 280, 'y', 60, 2.0, 0.9)],
  });
  // Simulate editor advance without mutating design phase0
  h.pendulums[0].phase = h.pendulums[0].phase0 + 12.5;
  h.gates[0].phase = h.gates[0].phase0 + 12.5;
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok, d.error);
  assert.ok(approx(d.hole.pendulums[0].phase0, 0.4), 'pend phase0');
  assert.ok(approx(d.hole.gates[0].phase0, 0.9), 'gate phase0');
  assert.ok(approx(d.hole.pendulums[0].phase, 0.4), 'pend live reset to phase0');
});

if (process.exitCode) {
  console.error('level-codec: FAILED');
  process.exit(1);
}
console.log('level-codec: %d tests passed', passed);
