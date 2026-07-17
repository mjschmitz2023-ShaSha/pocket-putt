#!/usr/bin/env node
/**
 * Portals course pack tests:
 *  - course registration (19 holes, portal toy box, pair budget)
 *  - difficulty contract: pars never decrease; holes 1-18 have EITHER two portal pairs
 *    OR a moving-host portal, never both; hole 19 (index 18) has both
 *  - HIO seeds + microcloud majority for all 19 holes (every ace rides >= 1 portal)
 *  - portal-load-bearing (strip) and putt-timing checks per committed flags
 *  - hole 19 ace must traverse BOTH pairs
 *  - blind-shot ace-rate caps: a player who does not know the path should rarely ace
 */
'use strict';

const Shared = require('../shared.js');

const course = Shared.COURSES.find((c) => c.id === 'portals');
const aceFile = require('./portal-aces.json');
const D_ANG = (aceFile.microcloud && aceFile.microcloud.dAng) || 0.004;
const D_POW = (aceFile.microcloud && aceFile.microcloud.dPow) || 0.01;
const MAX_TICKS = 1400;

let failed = 0;
function log(msg) { console.log(msg); }
function assert(cond, msg) {
  if (!cond) {
    log('FAIL: ' + msg);
    failed++;
  } else {
    log('  ok: ' + msg);
  }
}

log('\nPortals pack / HIO suite');
log('='.repeat(56));

// ---- registration & pack audit ----
log('\n[pack audit]');
assert(!!course, 'course id portals exists');
assert(course && course.name === 'Portals', 'display name Portals');
assert(course && course.holes.length === 19, 'exactly 19 holes');

function movingHostUsed(pairs) {
  return (pairs || []).some((pp) =>
    pp.a.host === 'gate' || pp.a.host === 'pendulum' ||
    pp.b.host === 'gate' || pp.b.host === 'pendulum');
}

for (let i = 0; i < course.holes.length; i++) {
  const h = course.holes[i];
  const pairs = h.portalPairs || [];
  const banned = (h.ramps && h.ramps.length) || (h.sticky && h.sticky.length) ||
    (h.gravityBodies && h.gravityBodies.length);
  assert(!banned, `hole ${i} ${h.name}: no ramps/goo/gravity in portal pack`);
  assert(pairs.length >= 1 && pairs.length <= 2, `hole ${i} ${h.name}: 1-2 portal pairs`);
  for (const pp of pairs) {
    for (const end of [pp.a, pp.b]) {
      const arr = end.host === 'wall' ? h.walls : end.host === 'gate' ? h.gates : h.pendulums;
      assert(arr && arr[end.index] != null, `hole ${i} ${h.name}: portal host ${end.host}[${end.index}] exists`);
    }
  }
  const both = pairs.length === 2 && movingHostUsed(pairs);
  if (i < 18) {
    assert(!both, `hole ${i} ${h.name}: two pairs + moving host is reserved for hole 19`);
  } else {
    assert(pairs.length === 2, 'hole 19 has two portal pairs');
    assert(movingHostUsed(pairs), 'hole 19 has a moving-host portal');
  }
  if (i > 0) {
    assert(course.holes[i].par >= course.holes[i - 1].par, `par never decreases (hole ${i})`);
  }
}
assert(course.holes[0].par === 2 && course.holes[18].par === 6, 'par curve runs 2 -> 6');

// ---- shared sim ----
function simulate(holeSrc, drag, startTick, opts) {
  const hole = (opts && opts.strip)
    ? Object.assign(Shared.deepCloneHole(holeSrc), { portalPairs: [] })
    : holeSrc;
  const ball = Shared.createBallState({ x: hole.tee.x, y: hole.tee.y });
  const clamped = Shared.clampDragVector({ x: drag.x, y: drag.y });
  if (!clamped) return { holed: false, reason: 'clamp', portals: [] };
  const launch = Shared.computeLaunchVelocity(clamped);
  ball.vx = launch.vx;
  ball.vy = launch.vy;
  let tick = startTick || 0;
  Shared.setHoleObstaclesAtTick(hole, tick);
  const portals = [];
  for (let i = 0; i < MAX_TICKS; i++) {
    tick += 1;
    Shared.setHoleObstaclesAtTick(hole, tick);
    const ev = Shared.stepBallPhysics(ball, hole, Shared.TICK_DT);
    if (ev.portals && ev.portals.length) {
      for (const p of ev.portals) portals.push(p.pairIndex);
    }
    if (ev.water) return { holed: false, reason: 'water', portals };
    if (ev.holed) return { holed: true, ticks: i, portals };
    if (Math.hypot(ball.vx, ball.vy) < Shared.STOP_THRESHOLD && i > 15) {
      return { holed: false, reason: 'stop', portals };
    }
  }
  return { holed: false, reason: 'timeout', portals };
}

function microcloudDrags(seedDrag) {
  const samples = [{ x: seedDrag.x, y: seedDrag.y }];
  const len = Math.hypot(seedDrag.x, seedDrag.y);
  const ang = Math.atan2(seedDrag.y, seedDrag.x);
  for (const da of [-D_ANG, 0, D_ANG]) {
    for (const dp of [-D_POW, 0, D_POW]) {
      if (da === 0 && dp === 0) continue;
      const L = len * (1 + dp);
      samples.push({ x: Math.cos(ang + da) * L, y: Math.sin(ang + da) * L });
    }
  }
  return samples;
}

// Canonical blind grid (matches the design harness): 48 angles x 5 powers + 5 at-cup.
function blindRate(hole, startTick) {
  const powers = [0.4, 0.55, 0.7, 0.85, 1.0];
  let aces = 0;
  let n = 0;
  const shoot = (ang, p) => {
    n++;
    const L = Shared.MAX_DRAG_DIST * p;
    const d = { x: -Math.cos(ang) * L, y: -Math.sin(ang) * L };
    if (simulate(hole, d, startTick).holed) aces++;
  };
  for (let a = 0; a < 48; a++) {
    for (const p of powers) shoot((2 * Math.PI * a) / 48, p);
  }
  const cupAng = Math.atan2(hole.cup.y - hole.tee.y, hole.cup.x - hole.tee.x);
  for (const p of powers) shoot(cupAng, p);
  return { rate: aces / n, aces, n };
}

// ---- HIO seeds + microcloud + per-hole contracts ----
log('\n[HIO seeds + microcloud + contracts]');
assert(aceFile.seeds && aceFile.seeds.length === 19, '19 committed ace seeds');
for (const seed of aceFile.seeds) {
  const hi = seed.holeIndex;
  const hole = course.holes[hi];
  assert(seed.name === hole.name, `seed name matches hole ${hi} (${hole.name})`);

  const run = simulate(hole, seed.drag, seed.startTick || 0);
  assert(run.holed, `${hole.name}: seed HIO (${run.reason || 'ok'})`);
  assert(run.portals.length >= 1, `${hole.name}: ace rides a portal`);
  if (seed.bothPairs) {
    assert(run.portals.includes(0) && run.portals.includes(1),
      `${hole.name}: ace traverses BOTH pairs (saw ${JSON.stringify(run.portals)})`);
  }

  const cloud = microcloudDrags(seed.drag);
  let hits = 0;
  for (const d of cloud) if (simulate(hole, d, seed.startTick || 0).holed) hits++;
  assert(hits > cloud.length / 2, `${hole.name}: microcloud majority ${hits}/${cloud.length}`);

  if (seed.strip) {
    const bare = simulate(hole, seed.drag, seed.startTick || 0, { strip: true });
    assert(!bare.holed, `${hole.name}: seed must NOT HIO with portals stripped (portal is load-bearing)`);
  }
  if (seed.timing) {
    let fails = 0;
    for (const off of [-30, -20, -10, 10, 20, 30]) {
      if (!simulate(hole, seed.drag, (seed.startTick || 0) + off).holed) fails++;
    }
    assert(fails >= 4, `${hole.name}: mistimed putt fails (${fails}/6 shifted starts miss)`);
  }
  if (seed.maxBlindRate != null) {
    const r0 = blindRate(hole, 0);
    assert(r0.rate <= seed.maxBlindRate,
      `${hole.name}: blind ace rate ${r0.rate.toFixed(4)} <= ${seed.maxBlindRate} @ tick 0`);
    if ((seed.startTick || 0) !== 0) {
      const rs = blindRate(hole, seed.startTick);
      assert(rs.rate <= seed.maxBlindRate,
        `${hole.name}: blind ace rate ${rs.rate.toFixed(4)} <= ${seed.maxBlindRate} @ seed tick`);
    }
  }
}

// ---- Hole 19: the finale contract, stated explicitly ----
log('\n[hole 19 finale]');
{
  const seed19 = aceFile.seeds.find((s) => s.holeIndex === 18);
  assert(!!seed19, 'seed for hole 19 exists');
  assert(seed19.bothPairs && seed19.strip && seed19.timing, 'hole 19 flags: bothPairs + strip + timing');
}

log('\n' + '='.repeat(56));
if (failed) {
  console.error(`${failed} Portals test(s) failed`);
  process.exit(1);
}
log('All Portals pack tests passed\n');
process.exit(0);
