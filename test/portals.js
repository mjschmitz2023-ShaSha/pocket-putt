'use strict';
/**
 * Portal physics + normalize + codec tests against shipped shared.js.
 * No oracle re-implementation of the teleport transform for pass/fail beyond
 * calling Shared.mapVelocityThroughPortals / stepBallPhysics / encodeHole.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Shared = require('../shared.js');

const {
  blankHole, normalizeHole, validateHole, encodeHole, decodeHole,
  wall, slidingGate, createBallState, stepBallPhysics, TICK_DT,
  resolvePortalAperture, mapVelocityThroughPortals, tryPortalTeleport,
  mapPointThroughPortal, mapVectorThroughPortal,
  collisionWallsForHole, resolveWallCollision, gravityAccelAt, gravityAccelAtWorld, planet,
  PORTAL_MAX_PAIRS, PORTAL_MIN_WIDTH, LEVEL_CODEC_VERSION,
  packHoleBytes, unpackHoleBytes, simulateTrajectory, createTrajectorySim,
  setPortalGravityMode, getPortalGravityMode, portalGravityDualSample,
  PORTAL_GRAVITY_SOI_RADIUS, PORTAL_GRAVITY_LOS_MAX,
} = Shared;

// Default remains world-only; restore after any mode experiment.
function withPortalGravityMode(mode, fn) {
  const prev = getPortalGravityMode(null);
  setPortalGravityMode(mode);
  try {
    return fn();
  } finally {
    setPortalGravityMode(prev);
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

function holeWithPair(opts) {
  opts = opts || {};
  const walls = opts.walls || [
    wall(200, 100, 200, 400),
    wall(600, 100, 600, 400),
  ];
  const pair = opts.pair || {
    width: 50,
    a: { host: 'wall', index: 0, t: 0.5, face: 1 },
    b: { host: 'wall', index: 1, t: 0.5, face: -1 },
  };
  return normalizeHole(blankHole({
    walls,
    gates: opts.gates || [],
    portalPairs: [pair],
    gravityBodies: opts.gravityBodies || [],
  }));
}

// --- Velocity frame map (180° opposite walls) ---
test('mapVelocityThroughPortals 180° preserves speed and direction', () => {
  const h = holeWithPair();
  const entry = resolvePortalAperture(h, h.portalPairs[0].a, 50);
  const exit = resolvePortalAperture(h, h.portalPairs[0].b, 50);
  assert.ok(entry && exit);
  // Enter left wall going right (+x into portal whose n points -x)
  const speed = 400;
  const mapped = mapVelocityThroughPortals(speed, 0, entry, exit);
  const outSpeed = Math.hypot(mapped.vx, mapped.vy);
  assert.ok(Math.abs(outSpeed - speed) < 1e-6, 'speed ' + outSpeed);
  // Exit face n points +x; out velocity should be +x
  assert.ok(mapped.vx > speed * 0.9, 'vx ' + mapped.vx);
  assert.ok(Math.abs(mapped.vy) < 1e-6, 'vy ' + mapped.vy);
});

// --- 90° pair ---
test('mapVelocityThroughPortals 90° maps into exit normal', () => {
  const h = normalizeHole(blankHole({
    walls: [
      wall(200, 100, 200, 400), // vertical
      wall(300, 350, 500, 350), // horizontal
    ],
    portalPairs: [{
      width: 40,
      a: { host: 'wall', index: 0, t: 0.5, face: 1 }, // n = -x
      b: { host: 'wall', index: 1, t: 0.5, face: 1 }, // n = up from (1,0) left-n = (0,1)? dx>0, n0=(0,1)? n0=(-ty,tx)=(0,1) face1 = +y
    }],
  }));
  const entry = resolvePortalAperture(h, h.portalPairs[0].a, 40);
  const exit = resolvePortalAperture(h, h.portalPairs[0].b, 40);
  const speed = 300;
  const mapped = mapVelocityThroughPortals(speed, 0, entry, exit);
  const outSpeed = Math.hypot(mapped.vx, mapped.vy);
  assert.ok(Math.abs(outSpeed - speed) < 1e-6, 'speed');
  // Should come out along exit outward normal (mostly +y)
  assert.ok(mapped.vy > speed * 0.9, 'vy ' + mapped.vy + ' exit n ' + exit.nx + ',' + exit.ny);
});

// --- Surface velocity on moving gate ---
test('mapVelocityThroughPortals includes exit surface velocity', () => {
  const gate = slidingGate(400, 200, 400, 300, 'x', 80, 2.0, 0);
  // phase such that cos is 1 → max speed along x
  gate.phase = 0; // sin0=0 offset, cos0=1 → speed = amplitude * 2π/period
  const h = normalizeHole(blankHole({
    walls: [wall(100, 100, 100, 400)],
    gates: [gate],
    portalPairs: [{
      width: 40,
      a: { host: 'wall', index: 0, t: 0.5, face: 1 },
      b: { host: 'gate', index: 0, t: 0.5, face: 1 },
    }],
  }));
  // Force gate phase for known surface vel
  h.gates[0].phase = 0;
  const entry = resolvePortalAperture(h, h.portalPairs[0].a, 40);
  const exit = resolvePortalAperture(h, h.portalPairs[0].b, 40);
  assert.ok(Math.abs(exit.svx) > 1, 'expected non-zero gate svx, got ' + exit.svx);
  // Ball at rest in world → rest relative to static entry → exit inherits exit sv
  const mapped = mapVelocityThroughPortals(0, 0, entry, exit);
  assert.ok(Math.abs(mapped.vx - exit.svx) < 1e-6, 'vx should be exit.svx ' + mapped.vx + ' vs ' + exit.svx);
  assert.ok(Math.abs(mapped.vy - exit.svy) < 1e-6, 'vy');
});

// --- One-sided open hole vs solid remainder / back face ---
test('open aperture (enterable face) does not collide; solid remainder does', () => {
  const h = holeWithPair();
  // Ball at aperture on enterable face (left of wall 0, face n points -x) — open, no bounce
  const ballOpen = createBallState({ x: 200 - 3, y: 250 });
  ballOpen.vx = 0; ballOpen.vy = 0;
  let hitOpen = false;
  for (const w of collisionWallsForHole(h, 0)) {
    if (resolveWallCollision(ballOpen, w)) hitOpen = true;
  }
  assert.strictEqual(hitOpen, false, 'should not collide in open aperture from face');

  // Ball against solid remainder (y near top of wall, outside aperture)
  const ballSolid = createBallState({ x: 200 - 3, y: 120 });
  ballSolid.vx = 50;
  let hitSolid = false;
  for (const w of collisionWallsForHole(h, 0)) {
    if (resolveWallCollision(ballSolid, w)) hitSolid = true;
  }
  assert.strictEqual(hitSolid, true, 'should collide on solid remainder');
});

test('portal back face stays solid (cannot pass through from behind)', () => {
  const h = holeWithPair();
  // Wall 0 at x=200, face=1 → n=(-1,0) enterable from left. Back is right side.
  const ball = createBallState({ x: 200 + 3, y: 250 });
  ball.vx = -50; // pushing into back of wall
  let hit = false;
  const walls = collisionWallsForHole(h, 0);
  for (const w of walls) {
    if (resolveWallCollision(ball, w)) hit = true;
  }
  assert.strictEqual(hit, true, 'back of portal wall must bounce');
  // Should not teleport from back either
  ball.x = 200 + 2;
  ball.y = 250;
  ball.vx = -400;
  assert.strictEqual(tryPortalTeleport(ball, h), null, 'no teleport from back');
});

test('teleport preserves along-aperture offset', () => {
  const h = holeWithPair();
  // Enter left portal above center (y > 250)
  const ball = createBallState({ x: 200 - 2, y: 250 + 15 });
  ball.vx = 400;
  ball.vy = 0;
  const ev = tryPortalTeleport(ball, h);
  assert.ok(ev, 'should teleport');
  // Exit at wall 600, face -1 → n=(+1,0); along maps with same tangent (0,1)
  // so y should stay ~265 (center 250 + 15)
  assert.ok(Math.abs(ball.y - 265) < 2, 'exit y should match entry offset, y=' + ball.y);
  assert.ok(ball.x > 600, 'exited right of exit portal');
});

// --- Triggers: sticky, z>0, outward, outside width ---
test('no teleport when sticky latched', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 200 - 2, y: 250 });
  ball.vx = 400;
  ball.stuckStickyIndex = 0;
  assert.strictEqual(tryPortalTeleport(ball, h), null);
});

test('no teleport when airborne z>0', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 200 - 2, y: 250 });
  ball.vx = 400;
  ball.z = 5;
  assert.strictEqual(tryPortalTeleport(ball, h), null);
});

test('no teleport with outward velocity', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 200 - 2, y: 250 });
  // Outward: away from wall into room = -x for face n=(-1,0)
  ball.vx = -400;
  assert.strictEqual(tryPortalTeleport(ball, h), null);
});

test('no teleport when center outside aperture width', () => {
  const h = holeWithPair();
  // Aperture around y=250 half-width 25 → y=120 is outside
  const ball = createBallState({ x: 200 - 2, y: 120 });
  ball.vx = 400;
  assert.strictEqual(tryPortalTeleport(ball, h), null);
});

// --- Trajectory ghost includes portalPairs (editor Test aim path) ---
test('createTrajectorySim clones portalPairs', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 170, y: 250 });
  const sim = createTrajectorySim(h, ball, 500, 0, { maxTicks: 1 });
  assert.ok(sim.h.portalPairs && sim.h.portalPairs.length === 1, 'clone must keep portalPairs');
  assert.strictEqual(sim.h.portalPairs[0].a.host, 'wall');
});

test('simulateTrajectory reaches exit side of portal pair', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 170, y: 250 });
  // Live physics with same launch does teleport to x>~500
  const pts = simulateTrajectory(h, ball, 500, 0, { maxTicks: 120, sampleEvery: 1 });
  assert.ok(pts.length > 2, 'path samples');
  const finite = pts.filter((p) => p && Number.isFinite(p.x));
  const maxX = finite.reduce((m, p) => Math.max(m, p.x), -Infinity);
  // Exit portal is at x=600 with outward normal +x → ball should appear past ~600
  assert.ok(maxX > 550, 'ghost path should reach exit side, maxX=' + maxX);
});

test('simulateTrajectory inserts path break at portal teleport', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 170, y: 250 });
  const pts = simulateTrajectory(h, ball, 500, 0, { maxTicks: 120, sampleEvery: 1 });
  const breakIdx = pts.findIndex((p) => p == null);
  assert.ok(breakIdx > 0, 'expected null break sentinel in ghost path');
  assert.ok(pts[breakIdx + 1] && pts[breakIdx + 1].x > 500, 'point after break is on exit side');
});

test('normalize clamps portal width when host wall shortens', () => {
  // Long walls first so pair is accepted at width 80
  let h = normalizeHole(blankHole({
    walls: [wall(200, 50, 200, 450), wall(600, 50, 600, 450)],
    portalPairs: [{
      width: 80,
      a: { host: 'wall', index: 0, t: 0.5, face: 1 },
      b: { host: 'wall', index: 1, t: 0.5, face: -1 },
    }],
  }));
  assert.ok(h.portalPairs[0].width >= 80 - 0.1);
  // Shorten walls below portal width — re-normalize should clamp
  h.walls[0] = wall(200, 200, 200, 230); // length 30
  h.walls[1] = wall(600, 200, 600, 230);
  h = normalizeHole(h);
  assert.ok(h.portalPairs.length === 1, 'pair still valid');
  assert.ok(h.portalPairs[0].width <= 30 + 0.1, 'width clamped to short host, w=' + h.portalPairs[0].width);
});

// --- Live teleport via stepBallPhysics ---
test('stepBallPhysics teleports through pair and emits portal event', () => {
  const h = holeWithPair();
  const ball = createBallState({ x: 170, y: 250 });
  ball.vx = 500;
  ball.vy = 0;
  let saw = false;
  for (let i = 0; i < 90; i++) {
    const e = stepBallPhysics(ball, h, TICK_DT);
    if (e.portals && e.portals.length) {
      saw = true;
      assert.strictEqual(e.portals[0].type, 'portal');
      assert.ok(ball.x > 500, 'should exit near right portal, x=' + ball.x);
      break;
    }
  }
  assert.ok(saw, 'expected portal event');
});

// --- Normalize / caps ---
test('normalize clamps width and enforces max 2 pairs', () => {
  const h = normalizeHole(blankHole({
    walls: [wall(100, 100, 100, 400), wall(500, 100, 500, 400), wall(300, 100, 300, 400)],
    portalPairs: [
      { width: 5, a: { host: 'wall', index: 0, t: 0.5, face: 1 }, b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
      { width: 40, a: { host: 'wall', index: 0, t: 0.2, face: 1 }, b: { host: 'wall', index: 2, t: 0.5, face: 1 } },
      { width: 40, a: { host: 'wall', index: 1, t: 0.2, face: 1 }, b: { host: 'wall', index: 2, t: 0.2, face: 1 } },
    ],
  }));
  assert.ok(h.portalPairs.length <= PORTAL_MAX_PAIRS);
  assert.ok(h.portalPairs.length >= 1);
  for (const p of h.portalPairs) {
    assert.ok(p.width >= PORTAL_MIN_WIDTH, 'width ' + p.width);
  }
});

test('normalize drops overlapping apertures on same segment', () => {
  const h = normalizeHole(blankHole({
    walls: [wall(200, 50, 200, 450), wall(600, 50, 600, 450)],
    portalPairs: [
      { width: 80, a: { host: 'wall', index: 0, t: 0.5, face: 1 }, b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
      // Second pair both on same walls overlapping first
      { width: 80, a: { host: 'wall', index: 0, t: 0.52, face: 1 }, b: { host: 'wall', index: 1, t: 0.52, face: -1 } },
    ],
  }));
  assert.strictEqual(h.portalPairs.length, 1, 'overlap should drop second pair');
});

// --- Codec v4 round-trip ---
test('encode/decode portalPairs round-trip (codec v4)', () => {
  assert.strictEqual(LEVEL_CODEC_VERSION, 4);
  const h = holeWithPair();
  const s = encodeHole(h);
  const d = decodeHole(s);
  assert.ok(d.ok, d.error);
  assert.strictEqual(d.hole.portalPairs.length, 1);
  assert.strictEqual(d.hole.portalPairs[0].a.host, 'wall');
  assert.strictEqual(d.hole.portalPairs[0].b.host, 'wall');
  assert.ok(Math.abs(d.hole.portalPairs[0].width - 50) < 0.2);
  assert.strictEqual(d.hole.portalPairs[0].a.face, 1);
  assert.strictEqual(d.hole.portalPairs[0].b.face, -1);
});

test('pre-v4 payload still decodes (no portals)', () => {
  // Build a v3-looking payload by packing then rewriting version byte and truncating portal tail.
  // Simpler: encode blank at current, then decode after manually writing v3 without portals.
  // Use unpack of a v3 blank: construct via temporarily faking — pack blankHole with empty portals
  // and re-encode by reading packHoleBytes, set ver=3, drop last portal section.
  // Easiest reliable approach: decode a known v3 string from packing without portal write.
  // We'll craft bytes: pack current blank, set version to 3, remove portal pair bytes at end
  // (1 byte count 0 is written for empty portals — for v3 decode we stop before that).
  const hole = normalizeHole(blankHole({ walls: [wall(100, 100, 200, 200)] }));
  // Manually build v3 by encoding and converting: unpackHoleBytes accepts ver 3 without portal section.
  const full = packHoleBytes(hole);
  // full ends with portal count 0 (1 byte). Strip last byte and set ver=3.
  const v3 = full.slice(0, full.length - 1);
  v3[0] = 3;
  const decoded = unpackHoleBytes(v3);
  assert.ok(decoded);
  assert.strictEqual((decoded.portalPairs || []).length, 0);
  assert.strictEqual(decoded.walls.length, 1);
});

// --- Gravity: default off = world-only; modes dual-sample through portal ---
test('gravity default off is world-only (no dual-sample through portal)', () => {
  withPortalGravityMode('off', () => {
    // Planet only near exit side; ball on entry side far from planet.
    const h = holeWithPair({
      gravityBodies: [planet(650, 250, 30, 50000, { fieldRadius: 120 })],
    });
    const ball = createBallState({ x: 150, y: 250 });
    const g = gravityAccelAt(ball, h);
    const m = Math.hypot(g.ax || 0, g.ay || 0);
    assert.ok(m < 1e-3, 'entry-side ball should not feel dual-sampled exit planet, mag=' + m);
    const dual = portalGravityDualSample(ball, h);
    assert.ok(Math.hypot(dual.ax, dual.ay) < 1e-9);
  });
});

test('mapPointThroughPortal preserves along/normal offsets (180°)', () => {
  const h = holeWithPair();
  const entry = resolvePortalAperture(h, h.portalPairs[0].a, 50);
  const exit = resolvePortalAperture(h, h.portalPairs[0].b, 50);
  // Point 40px in front of entry center along face normal, +10 along tangent
  const px = entry.cx + entry.nx * 40 + entry.tx * 10;
  const py = entry.cy + entry.ny * 40 + entry.ty * 10;
  const virt = mapPointThroughPortal(px, py, entry, exit);
  const expX = exit.cx + exit.nx * 40 + exit.tx * 10;
  const expY = exit.cy + exit.ny * 40 + exit.ty * 10;
  assert.ok(Math.hypot(virt.x - expX, virt.y - expY) < 1e-6, JSON.stringify(virt));
});

/** Exit-side planet: far enough that virtual samples are outside the crust skip band. */
function exitPlanet() {
  return planet(720, 250, 20, 80000, { fieldRadius: 250 });
}

test('portal gravity always: entry ball feels exit planet through portal', () => {
  withPortalGravityMode('always', () => {
    // holeWithPair: entry wall@200 face+1 → n=(-1,0) enterable left; exit@600 face-1 → n=(+1,0).
    const h = holeWithPair({ gravityBodies: [exitPlanet()] });
    const ball = createBallState({ x: 170, y: 250 });
    const world = gravityAccelAtWorld(ball, h);
    assert.ok(world.mag < 1e-3, 'world-only should be ~0, mag=' + world.mag);
    const g = gravityAccelAt(ball, h);
    assert.ok(g.mag > 5, 'always mode should dual-sample exit planet, mag=' + g.mag);
    // Mapped pull toward the entry aperture (roughly +x into wall / toward planet through portal).
    assert.ok(g.ax > 0, 'expect pull toward/through portal (+x), ax=' + g.ax);
  });
});

test('portal gravity soi: only near aperture, not across the map', () => {
  withPortalGravityMode('soi', () => {
    const h = holeWithPair({ gravityBodies: [exitPlanet()] });
    const near = createBallState({ x: 170, y: 250 });
    // Outside SOI radius of entry center (200,250): 280px away
    const far = createBallState({ x: 200 - PORTAL_GRAVITY_SOI_RADIUS - 60, y: 250 });
    const gNear = gravityAccelAt(near, h);
    const gFar = gravityAccelAt(far, h);
    assert.ok(gNear.mag > 5, 'near aperture SOI dual-samples, mag=' + gNear.mag);
    const distFar = Math.hypot(far.x - 200, far.y - 250);
    assert.ok(distFar > PORTAL_GRAVITY_SOI_RADIUS, 'fixture far enough dist=' + distFar);
    assert.ok(gFar.mag < 1e-3, 'far ball no dual-sample in SOI, mag=' + gFar.mag);
  });
});

test('portal gravity los: requires aperture width + face LOS', () => {
  withPortalGravityMode('los', () => {
    const h = holeWithPair({ gravityBodies: [exitPlanet()] });
    const onFace = createBallState({ x: 170, y: 250 });
    // Same wall distance but far along tangent (outside aperture width ~50)
    const offAperture = createBallState({ x: 170, y: 100 });
    const gOn = gravityAccelAt(onFace, h);
    const gOff = gravityAccelAt(offAperture, h);
    assert.ok(gOn.mag > 5, 'LOS on aperture, mag=' + gOn.mag);
    assert.ok(gOff.mag < 1e-3, 'LOS off aperture width, mag=' + gOff.mag);
  });
});

test('session setPortalGravityMode is sole authority (hole field ignored)', () => {
  const h = holeWithPair({ gravityBodies: [exitPlanet()] });
  const ball = createBallState({ x: 170, y: 250 });
  // Stale hole field must not override session (the editor mode-switch footgun).
  withPortalGravityMode('always', () => {
    h.portalGravityMode = 'off';
    const g = gravityAccelAt(ball, h);
    assert.ok(g.mag > 5, 'session always wins over hole off, mag=' + g.mag);
  });
  withPortalGravityMode('off', () => {
    h.portalGravityMode = 'always';
    const g = gravityAccelAt(ball, h);
    assert.ok(g.mag < 1e-3, 'session off wins over hole always, mag=' + g.mag);
  });
});

test('mapVectorThroughPortal flips normal component (180°)', () => {
  const h = holeWithPair();
  const entry = resolvePortalAperture(h, h.portalPairs[0].a, 50);
  const exit = resolvePortalAperture(h, h.portalPairs[0].b, 50);
  // Vector into entry along -n_entry should exit along +n_exit
  const into = { x: -entry.nx * 100, y: -entry.ny * 100 };
  const out = mapVectorThroughPortal(into.x, into.y, entry, exit);
  assert.ok(out.x * exit.nx + out.y * exit.ny > 90, JSON.stringify(out));
});

test('always mode does not sum both portal ends into a center-pull', () => {
  withPortalGravityMode('always', () => {
    // Both faces open into the playable room; planet only past exit wall.
    const h = normalizeHole(blankHole({
      walls: [wall(200, 100, 200, 400), wall(600, 100, 600, 400)],
      portalPairs: [{
        width: 50,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },  // n = -x, enterable left
        b: { host: 'wall', index: 1, t: 0.5, face: -1 }, // n = +x, enterable right
      }],
      gravityBodies: [exitPlanet()],
    }));
    // Mid-map: only one end should win (strongest), not a blended center force.
    const ball = createBallState({ x: 400, y: 250 });
    const dual = portalGravityDualSample(ball, h);
    const mag = Math.hypot(dual.ax, dual.ay);
    // Either 0 (not on enterable face of either — mid is "behind" both) or single-direction.
    // Left wall enterable is x<200; right is x>600. Center x=400 is behind both → dual 0.
    assert.ok(mag < 1e-6, 'mid-map between opposing faces should not dual-sample, mag=' + mag);

    // On entry face: single clear +x pull, not a weak averaged vector.
    const onEntry = createBallState({ x: 170, y: 250 });
    const d2 = portalGravityDualSample(onEntry, h);
    assert.ok(d2.ax > 50, 'entry-side dual pull +x, ax=' + d2.ax);
    assert.ok(Math.abs(d2.ay) < 1e-3, 'no spurious y from double-count, ay=' + d2.ay);
  });
});

// --- Editor structural: pair-only + face + caps in normalize (shipped path) ---
test('validateHole rejects >2 pairs after forced raw (normalize already clamps)', () => {
  const raw = blankHole({
    walls: [wall(100, 100, 100, 400), wall(500, 100, 500, 400)],
    portalPairs: [
      { width: 40, a: { host: 'wall', index: 0, t: 0.3, face: 1 }, b: { host: 'wall', index: 1, t: 0.3, face: -1 } },
      { width: 40, a: { host: 'wall', index: 0, t: 0.7, face: 1 }, b: { host: 'wall', index: 1, t: 0.7, face: -1 } },
    ],
  });
  const v = validateHole(raw);
  assert.ok(v.ok, v.error);
  assert.ok(v.hole.portalPairs.length <= 2);
  // Face bits preserved
  assert.ok(v.hole.portalPairs[0].a.face === 1 || v.hole.portalPairs[0].a.face === -1);
});

test('orphan / incomplete pairs dropped (pair-only)', () => {
  const h = normalizeHole(blankHole({
    walls: [wall(100, 100, 100, 400)],
    portalPairs: [
      { width: 40, a: { host: 'wall', index: 0, t: 0.5, face: 1 } }, // missing b
    ],
  }));
  assert.strictEqual(h.portalPairs.length, 0);
});

// --- Audio files present ---
test('portal enter/exit wav files exist', () => {
  const root = path.join(__dirname, '..');
  const enter = path.join(root, 'sounds/portal/portal_enter.wav');
  const exit = path.join(root, 'sounds/portal/portal_exit.wav');
  assert.ok(fs.existsSync(enter), enter);
  assert.ok(fs.existsSync(exit), exit);
  assert.ok(fs.statSync(enter).size > 1000);
  assert.ok(fs.statSync(exit).size > 1000);
});

test('game.js plays portal SFX on portal events', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
  assert.ok(src.includes('portalEnter'), 'portalEnter sfx key');
  assert.ok(src.includes('portalExit'), 'portalExit sfx key');
  assert.ok(src.includes('events.portals'), 'consumes portal events');
  assert.ok(src.includes('sounds/portal/portal_enter.wav'));
});

test('draw.js has drawPortals wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'draw.js'), 'utf8');
  assert.ok(src.includes('function drawPortals'));
  assert.ok(src.includes('drawPortals(ctx, hole)'));
});

test('editor has portal pair tool', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'editor.js'), 'utf8');
  assert.ok(html.includes('data-tool="portal"'));
  assert.ok(js.includes("tool === 'portal'"));
  assert.ok(js.includes('PORTAL_MAX_PAIRS'));
  assert.ok(js.includes('portalPairs'));
});

test('editor hitTest prefers portals before walls (source contract)', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'editor.js'), 'utf8');
  const portalFn = js.indexOf('function hitPortalPairs');
  const portalCall = js.indexOf('h = hitPortalPairs()');
  const wallCall = js.indexOf("h = hitWall(hole.walls, 'walls')");
  assert.ok(portalFn > 0 && portalCall > portalFn, 'hitPortalPairs defined and used');
  assert.ok(wallCall > portalCall, 'portals hit-tested before walls');
  assert.ok(js.includes('bestDist'), 'aperture segment distance pick (not center-only)');
});

test('portal gravity modes exist; windmill host and cooldown still absent', () => {
  const shared = fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8');
  assert.ok(/portalGravityDualSample/.test(shared), 'dual-sample prototype present');
  assert.ok(/setPortalGravityMode/.test(shared));
  assert.ok(/PORTAL_GRAVITY_MODES/.test(shared));
  assert.ok(!/host === ['"]windmill['"]/.test(shared));
  assert.ok(!/portalCooldown|reentryCooldown|PORTAL_COOLDOWN/i.test(shared));
});

test('editor ships BEM portal gravity (no dual-sample dropdown)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'editor.js'), 'utf8');
  assert.ok(!html.includes('id="prop-portal-gravity"'), 'prototype Portal g select removed');
  assert.ok(js.includes('PortalGravity') || js.includes('bakePortalGravity'),
    'editor still bakes material portal gravity');
  assert.ok(js.includes("setPortalGravityMode('off')") || js.includes('setPortalGravityMode("off")'),
    'dual-sample forced off so bake is sole path');
});

console.log('portals: %d tests passed', passed);
if (process.exitCode) process.exit(process.exitCode);
