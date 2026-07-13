#!/usr/bin/env node
/**
 * Orbit pack tests (docs/orbit-spec.md):
 *  - course registration (19 holes, toy box, body budget, moon on 19)
 *  - gravity unit smoke (pull, planet bounce energy loss, BH capture, moon tick lock)
 *  - escape velocity for every planet/moon
 *  - HIO seeds + microcloud majority for all 19 holes
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Shared = require('../shared.js');

const SCRATCH =
  process.env.ORBIT_SCRATCH ||
  path.join(__dirname, '..', '.tmp-orbit-scratch');
try {
  fs.mkdirSync(SCRATCH, { recursive: true });
} catch {
  /* ignore */
}

let failed = 0;
const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
}
function assert(cond, msg) {
  if (!cond) {
    log('FAIL: ' + msg);
    failed++;
  } else {
    log('  ok: ' + msg);
  }
}

const orbit = Shared.COURSES.find((c) => c.id === 'orbit');
const aceFile = require('./orbit-aces.json');
const D_ANG = (aceFile.microcloud && aceFile.microcloud.dAng) || 0.004;
const D_POW = (aceFile.microcloud && aceFile.microcloud.dPow) || 0.01;
const MAX_TICKS = 1400;

log('\nOrbit pack / HIO suite');
log('='.repeat(56));

// ---- registration & pack audit ----
log('\n[pack audit]');
assert(!!orbit, 'course id orbit exists');
assert(orbit && orbit.name === 'Orbit', 'display name Orbit');
assert(Shared.COURSES.length >= 4, 'at least 4 courses');
assert(Shared.COURSES[3] && Shared.COURSES[3].id === 'orbit', 'Orbit is fourth course');
assert(orbit.holes.length === 19, 'exactly 19 holes');

const audit = { holes: [], forbidden: 0, overBudget: 0, moonHoles: [] };
for (let i = 0; i < orbit.holes.length; i++) {
  const h = orbit.holes[i];
  const bodies = h.gravityBodies || [];
  const staticCount = bodies.filter((b) => b.kind !== 'moon').length;
  const moons = bodies.filter((b) => b.kind === 'moon');
  const banned =
    (h.ramps && h.ramps.length) ||
    (h.windmills && h.windmills.length) ||
    (h.pendulums && h.pendulums.length) ||
    (h.gates && h.gates.length) ||
    (h.sticky && h.sticky.length);
  if (banned) audit.forbidden++;
  if (staticCount > 3) audit.overBudget++;
  if (moons.length) audit.moonHoles.push(i);
  audit.holes.push({
    i,
    name: h.name,
    staticAttractors: staticCount,
    moons: moons.length,
    bannedToys: !!banned,
  });
  assert(!banned, `hole ${i} ${h.name}: no ramps/windmills/pendulums/gates/goo`);
  assert(staticCount <= 3, `hole ${i} ${h.name}: ≤3 static attractors (got ${staticCount})`);
}
assert(audit.moonHoles.length === 1 && audit.moonHoles[0] === 18, 'moon only on hole 19 (index 18)');
assert(audit.forbidden === 0 && audit.overBudget === 0, 'pack toy box + budget clean');

// ---- physics unit smoke ----
log('\n[physics]');
{
  const hole = {
    walls: [],
    sand: [],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    ramps: [],
    sticky: [],
    cup: { x: 9000, y: 250, radius: 11 },
    tee: { x: 80, y: 250 },
    gravityBodies: [Shared.planet(400, 250, 40, 20000, { fieldRadius: 300 })],
  };
  Shared.setHoleObstaclesAtTick(hole, 0);
  const ball = Shared.createBallState({ x: 300, y: 250 });
  ball.vx = 0;
  ball.vy = 0;
  for (let i = 0; i < 45; i++) Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
  assert(ball.x > 300, 'resting ball accelerates toward planet (+x)');

  // bounce energy loss (not bumper gain)
  const b2 = Shared.createBallState({ x: 320, y: 250 });
  b2.vx = 400;
  b2.vy = 0;
  const e0 = 0.5 * (b2.vx * b2.vx + b2.vy * b2.vy);
  let bounced = false;
  for (let i = 0; i < 120; i++) {
    const ev = Shared.stepBallPhysics(b2, hole, Shared.TICK_DT);
    if (ev.bounced) bounced = true;
  }
  const e1 = 0.5 * (b2.vx * b2.vx + b2.vy * b2.vy);
  assert(bounced, 'planet collision registers bounce');
  assert(e1 < e0, 'planet bounce loses energy (not bumper gain)');

  // black hole capture
  const holeBh = {
    walls: [],
    sand: [],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    ramps: [],
    sticky: [],
    cup: { x: 9000, y: 250, radius: 11 },
    tee: { x: 80, y: 250 },
    gravityBodies: [Shared.blackHole(400, 250, 8, 50000, { fieldRadius: 200, drawRadius: 4 })],
  };
  Shared.setHoleObstaclesAtTick(holeBh, 0);
  const b3 = Shared.createBallState({ x: 390, y: 250 });
  b3.vx = 50;
  b3.vy = 0;
  let captured = false;
  for (let i = 0; i < 60; i++) {
    const ev = Shared.stepBallPhysics(b3, holeBh, Shared.TICK_DT);
    if (ev.blackHole) {
      captured = true;
      break;
    }
  }
  assert(captured, 'black hole horizon capture event');

  // moon tick lock
  const m = Shared.moon(400, 250, 100, 20, 12000, 240, { orbitPhase0: 0 });
  Shared.setMoonPoseAtTick(m, 0);
  const x0 = m.x;
  const y0 = m.y;
  Shared.setMoonPoseAtTick(m, 60); // quarter period
  const x1 = m.x;
  const y1 = m.y;
  Shared.setMoonPoseAtTick(m, 60);
  assert(Math.abs(m.x - x1) < 1e-9 && Math.abs(m.y - y1) < 1e-9, 'moon pose deterministic at tick');
  assert(Math.hypot(x1 - 400, y1 - 250) - 100 < 0.01, 'moon stays on orbit radius');
  assert(Math.hypot(x1 - x0, y1 - y0) > 10, 'moon moves across ticks');
  assert(Shared.PLANET_RESTITUTION === Shared.WALL_RESTITUTION, 'planet restitution wall-like');

  // No mid-air rest: slow ball above crust must fall back, not freeze in a "dead zone".
  const hover = Shared.createBallState({ x: 400 + 40 + Shared.BALL_RADIUS + 8, y: 250 });
  hover.vx = 0;
  hover.vy = 0;
  assert(Shared.ballFloatingInGravity(hover, hole), 'ball above crust is floating in gravity');
  assert(!Shared.ballMayRestForAim(hover, hole), 'may not rest/aim while floating');
  const xHover = hover.x;
  for (let i = 0; i < 90; i++) Shared.stepBallPhysics(hover, hole, Shared.TICK_DT);
  assert(hover.x < xHover - 2, 'floating ball falls back toward planet (no mid-air freeze)');
  assert(Shared.ballOnPlanetCrust(hover, hole, 2), 'eventually settles on crust');

  // Moving moon field sweeps over a stationary ball → gravity engages (no permanent freeze).
  const moonHole = {
    walls: [],
    sand: [],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    ramps: [],
    sticky: [],
    cup: { x: 9000, y: 250, radius: 11 },
    tee: { x: 80, y: 250 },
    gravityBodies: [
      Shared.moon(400, 250, 120, 22, 22000, 200, { fieldRadius: 100, orbitPhase0: 0 }),
    ],
  };
  // Place ball on the orbit path; at tick 0 moon is at (520,250) — far if ball at (280,250).
  // Advance until moon's field reaches the ball.
  const parked = Shared.createBallState({ x: 280, y: 250 });
  parked.vx = 0;
  parked.vy = 0;
  let moved = false;
  for (let t = 0; t < 200; t++) {
    Shared.setHoleObstaclesAtTick(moonHole, t);
    // While "at rest", mayRest is false once field overlaps.
    if (!Shared.ballMayRestForAim(parked, moonHole) || Shared.gravityAccelAt(parked, moonHole).mag > 10) {
      Shared.stepBallPhysics(parked, moonHole, Shared.TICK_DT);
    }
    if (Math.hypot(parked.x - 280, parked.y - 250) > 3 || Math.hypot(parked.vx, parked.vy) > 5) {
      moved = true;
      break;
    }
  }
  assert(moved, 'stationary ball starts moving when moon field sweeps over it');

  // Sand can hold against a moderate well (force balance), but not an extreme near-field pull.
  const sandPlanet = Shared.planet(400, 250, 40, 12000, { fieldRadius: 220 });
  const sandHole = {
    walls: [],
    sand: [Shared.sandRect(280, 200, 360, 300)],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    ramps: [],
    sticky: [],
    cup: { x: 9000, y: 250, radius: 11 },
    tee: { x: 80, y: 250 },
    gravityBodies: [sandPlanet],
  };
  Shared.setHoleObstaclesAtTick(sandHole, 0);
  const inSand = Shared.createBallState({ x: 320, y: 250 });
  inSand.vx = 0;
  inSand.vy = 0;
  const gSand = Shared.gravityAccelAt(inSand, sandHole);
  assert(gSand.mag > 0 && gSand.mag < Shared.SAND_GRAVITY_HOLD, 'test setup: |g| under sand hold at bunker');
  const xSand0 = inSand.x;
  for (let i = 0; i < 180; i++) Shared.stepBallPhysics(inSand, sandHole, Shared.TICK_DT);
  assert(
    Math.abs(inSand.x - xSand0) < 8 && !Shared.ballOnPlanetCrust(inSand, sandHole, 2),
    'sand holds ball against moderate well (does not slide onto crust)'
  );

  // Stronger / closer well overpowers sand.
  const strong = Shared.planet(400, 250, 40, 50000, { fieldRadius: 220 });
  const sandHole2 = { ...sandHole, gravityBodies: [strong] };
  const inSand2 = Shared.createBallState({ x: 320, y: 250 });
  inSand2.vx = 0;
  inSand2.vy = 0;
  assert(Shared.gravityAccelAt(inSand2, sandHole2).mag > Shared.SAND_GRAVITY_HOLD, 'strong well exceeds sand hold');
  for (let i = 0; i < 240; i++) Shared.stepBallPhysics(inSand2, sandHole2, Shared.TICK_DT);
  assert(
    Shared.ballOnPlanetCrust(inSand2, sandHole2, 3) || inSand2.x > xSand0 + 15,
    'strong well still drags ball through sand toward the body'
  );

  // Crust + sand bunker: settle and allow aim (no infinite bounce soft-loop).
  const bunkerPlanet = Shared.planet(400, 250, 40, 21000, { fieldRadius: 180 });
  const bunkerHole = {
    walls: [],
    sand: [Shared.sandRect(360, 220, 480, 320)],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    ramps: [],
    sticky: [],
    cup: { x: 9000, y: 250, radius: 11 },
    tee: { x: 80, y: 250 },
    gravityBodies: [bunkerPlanet],
  };
  Shared.setHoleObstaclesAtTick(bunkerHole, 0);
  const contact = bunkerPlanet.radius + Shared.BALL_RADIUS;
  const stuck = Shared.createBallState({ x: bunkerPlanet.x, y: bunkerPlanet.y + contact });
  stuck.vx = 80;
  stuck.vy = 40;
  let bounceEvents = 0;
  for (let i = 0; i < 180; i++) {
    const ev = Shared.stepBallPhysics(stuck, bunkerHole, Shared.TICK_DT);
    if (ev.bounced) bounceEvents++;
  }
  assert(Shared.ballOnPlanetCrust(stuck, bunkerHole, 2), 'ends on crust in sand bunker');
  assert(Math.hypot(stuck.vx, stuck.vy) < Shared.STOP_THRESHOLD, 'velocity settled in bunker');
  assert(Shared.ballMayRestForAim(stuck, bunkerHole), 'may putt again from crust+sand (no soft-loop lock)');
  assert(bounceEvents < 40, 'soft crust settle does not spam bounce events (' + bounceEvents + ')');
}

// ---- escape velocity ----
log('\n[escape velocity]');
{
  let planets = 0;
  for (const h of orbit.holes) {
    for (const b of h.gravityBodies || []) {
      if (b.kind !== 'planet' && b.kind !== 'moon') continue;
      planets++;
      const vesc = Shared.escapeSpeed(b);
      assert(
        Shared.bodyCanEscapeAtMaxLaunch(b),
        `${h.name} ${b.kind} vesc=${vesc.toFixed(1)} < ${Shared.MAX_LAUNCH_SPEED * Shared.ESCAPE_SPEED_MARGIN}`
      );
      // surface sample: max anti-radial putt leaves SOI
      const ang = 0;
      const rContact = b.radius + Shared.BALL_RADIUS + 0.5;
      const ball = Shared.createBallState({
        x: b.x + Math.cos(ang) * rContact,
        y: b.y + Math.sin(ang) * rContact,
      });
      ball.vx = Math.cos(ang) * Shared.MAX_LAUNCH_SPEED;
      ball.vy = Math.sin(ang) * Shared.MAX_LAUNCH_SPEED;
      const hole = {
        ...h,
        walls: [],
        sand: [],
        water: [],
        boost: [],
        // isolate body for escape sample
        gravityBodies: [Object.assign({}, b)],
        cup: { x: 9999, y: 9999, radius: 11 },
      };
      Shared.setHoleObstaclesAtTick(hole, 0);
      let escaped = false;
      for (let i = 0; i < 400; i++) {
        Shared.setHoleObstaclesAtTick(hole, i);
        const ev = Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
        if (ev.blackHole) break;
        const r = Math.hypot(ball.x - b.x, ball.y - b.y);
        if (r > (b.fieldRadius || 9999) * 0.98) {
          escaped = true;
          break;
        }
      }
      assert(escaped, `${h.name} ${b.kind}: max launch from surface leaves field`);
    }
  }
  assert(planets > 0, `checked ${planets} planet/moon bodies`);
}

// ---- No trivial pure-horizontal full-power ace ----
// Full pull-back on +x (drag = (-MAX_DRAG, 0)) must never HIO — blocks "hold full and release".
log('\n[no pure-horizontal full-speed HIO]');
{
  const fullH = Shared.clampDragVector({ x: -Shared.MAX_DRAG_DIST, y: 0 });
  assert(!!fullH && Math.abs(fullH.y) < 1e-9, 'horizontal drag is pure -x pull-back');
  const launch = Shared.computeLaunchVelocity(fullH);
  assert(Math.abs(launch.vy) < 1e-6 && launch.vx > 0, 'horizontal launch is pure +x at speed');
  assert(Math.abs(launch.speed - Shared.MAX_LAUNCH_SPEED) < 1e-6, 'horizontal full pull is max speed');

  for (let hi = 0; hi < orbit.holes.length; hi++) {
    const hole = orbit.holes[hi];
    const ball = Shared.createBallState({ x: hole.tee.x, y: hole.tee.y });
    ball.vx = launch.vx;
    ball.vy = launch.vy;
    let tick = 0;
    Shared.setHoleObstaclesAtTick(hole, tick);
    let holed = false;
    for (let i = 0; i < MAX_TICKS; i++) {
      tick += 1;
      Shared.setHoleObstaclesAtTick(hole, tick);
      const ev = Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
      if (ev.holed) {
        holed = true;
        break;
      }
      if (ev.blackHole || ev.water) break;
      if (Math.hypot(ball.vx, ball.vy) < Shared.STOP_THRESHOLD && i > 15) break;
    }
    assert(!holed, `${hole.name}: pure horizontal full-speed must NOT HIO`);
  }
}

// ---- HIO seeds + microcloud ----
log('\n[HIO seeds + microcloud]');

function simulateHio(holeIndex, drag, startTick) {
  const hole = orbit.holes[holeIndex];
  const ball = Shared.createBallState({ x: hole.tee.x, y: hole.tee.y });
  const clamped = Shared.clampDragVector(drag);
  if (!clamped) return { holed: false, reason: 'clamp' };
  const launch = Shared.computeLaunchVelocity(clamped);
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  let tick = startTick || 0;
  Shared.setHoleObstaclesAtTick(hole, tick);
  for (let i = 0; i < MAX_TICKS; i++) {
    tick += 1;
    Shared.setHoleObstaclesAtTick(hole, tick);
    const ev = Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
    if (ev.blackHole) return { holed: false, reason: 'blackHole' };
    if (ev.water) return { holed: false, reason: 'water' };
    if (ev.holed) return { holed: true, ticks: i };
    if (Math.hypot(ball.vx, ball.vy) < Shared.STOP_THRESHOLD && i > 15) {
      return { holed: false, reason: 'stop' };
    }
  }
  return { holed: false, reason: 'timeout' };
}

function microcloudDrags(seedDrag) {
  const samples = [];
  const len = Math.hypot(seedDrag.x, seedDrag.y);
  const ang = Math.atan2(seedDrag.y, seedDrag.x);
  samples.push({ x: seedDrag.x, y: seedDrag.y });
  for (const da of [-D_ANG, 0, D_ANG]) {
    for (const dp of [-D_POW, 0, D_POW]) {
      if (da === 0 && dp === 0) continue;
      const L = len * (1 + dp);
      samples.push({ x: Math.cos(ang + da) * L, y: Math.sin(ang + da) * L });
    }
  }
  return samples;
}

assert(aceFile.seeds && aceFile.seeds.length === 19, '19 committed ace seeds');
const hioResults = [];
for (const seed of aceFile.seeds) {
  const hi = seed.holeIndex;
  assert(hi >= 0 && hi < 19, `seed holeIndex ${hi}`);
  assert(seed.name === orbit.holes[hi].name, `seed name matches hole ${hi}`);
  const seedRun = simulateHio(hi, seed.drag, seed.startTick || 0);
  assert(seedRun.holed, `${seed.name}: seed HIO (${seedRun.reason || 'ok'})`);
  const cloud = microcloudDrags(seed.drag);
  let hits = 0;
  for (const d of cloud) {
    if (simulateHio(hi, d, seed.startTick || 0).holed) hits++;
  }
  const majority = hits > cloud.length / 2;
  assert(majority, `${seed.name}: microcloud majority ${hits}/${cloud.length}`);
  hioResults.push({ name: seed.name, hits, n: cloud.length, majority: true });
}

assert(
  hioResults.length === 19 && hioResults.every((r) => r.majority),
  'all 19 Orbit holes HIO-pass (seed + majority microcloud)'
);

// ---- Hole 19: moon must matter for the committed ace ----
log('\n[Lunar Window moon-required ace]');
{
  const seed19 = aceFile.seeds.find((s) => s.holeIndex === 18);
  assert(!!seed19, 'seed for hole 19 exists');
  const holeFull = orbit.holes[18];
  assert(
    (holeFull.gravityBodies || []).some((b) => b.kind === 'moon'),
    'hole 19 defines a moon'
  );
  const withMoon = simulateHio(18, seed19.drag, seed19.startTick || 0);
  assert(withMoon.holed, 'H19 seed HIO with moon present');

  // Authority sim on a hole clone that strips the moon — same putt must fail.
  const bare = JSON.parse(JSON.stringify(holeFull));
  bare.gravityBodies = (bare.gravityBodies || []).filter((b) => b.kind !== 'moon');
  const ball = Shared.createBallState({ x: bare.tee.x, y: bare.tee.y });
  const clamped = Shared.clampDragVector(seed19.drag);
  const launch = Shared.computeLaunchVelocity(clamped);
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  let tick = seed19.startTick || 0;
  Shared.setHoleObstaclesAtTick(bare, tick);
  let bareHoled = false;
  for (let i = 0; i < MAX_TICKS; i++) {
    tick += 1;
    Shared.setHoleObstaclesAtTick(bare, tick);
    const ev = Shared.stepBallPhysics(ball, bare, Shared.TICK_DT);
    if (ev.holed) {
      bareHoled = true;
      break;
    }
    if (ev.blackHole || ev.water) break;
    if (Math.hypot(ball.vx, ball.vy) < Shared.STOP_THRESHOLD && i > 15) break;
  }
  assert(!bareHoled, 'H19 seed must NOT HIO if moon is removed (moon is on the intended path)');
}

// ---- Sand should sit near a play line (no pure decoration) ----
log('\n[sand placement relevance]');
{
  function distPointSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  for (const h of orbit.holes) {
    for (const z of h.sand || []) {
      const cx = (z.x1 + z.x2) / 2;
      const cy = (z.y1 + z.y2) / 2;
      const d = distPointSeg(cx, cy, h.tee.x, h.tee.y, h.cup.x, h.cup.y);
      // Sand centroid within ~120px of tee→cup segment = on a relevant corridor.
      assert(d < 120, `${h.name}: sand trap near fairway (d=${d.toFixed(0)})`);
    }
  }
}

// ---- evidence files ----
const auditPath = path.join(SCRATCH, 'orbit-pack-audit.txt');
const hioPath = path.join(SCRATCH, 'orbit-npm-test-section.txt');
fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
fs.writeFileSync(hioPath, lines.join('\n') + '\n');
log('\nwrote ' + auditPath);
log('wrote ' + hioPath);

log('\n' + '='.repeat(56));
if (failed) {
  console.error(`${failed} Orbit test(s) failed`);
  process.exit(1);
}
log('All Orbit pack tests passed\n');
process.exit(0);
