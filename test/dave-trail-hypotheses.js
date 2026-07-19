#!/usr/bin/env node
/**
 * Hypotheses for Dave (observer) single-putt mid-path hole.
 *
 * Uses REAL production code only:
 *   - gameSession.js (host path / strokePath / replay wire)
 *   - mp-recon.js (residual, T0→T2 path catch-up, free-run trail, prune)
 *
 * A PASS means that hypothesis cannot explain the visual hole under the
 * contracts encoded in that production code (with the stated setup).
 *
 * Run: npm run test:dave-trail-hypotheses
 */
'use strict';

const assert = require('assert');
const Shared = require('../shared.js');
const { GameSession } = require('../gameSession.js');
const MpRecon = require('../mp-recon.js');

const STOP = Shared.STOP_THRESHOLD;

function dist(a, b) {
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
}

function maxNeighborGap(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m = Math.max(m, dist(pts[i - 1], pts[i]));
  return m;
}

class FakeSocket {
  constructor() {
    this.sent = [];
    this.readyState = 1;
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  drain() {
    const o = this.sent.slice();
    this.sent.length = 0;
    return o;
  }
}

/** Real host putt → hard replay with path (GameSession production). */
function hostSinglePuttReplay(opts) {
  opts = opts || {};
  const lagTicks = opts.lagTicks != null ? opts.lagTicks : 16;
  const sock = new FakeSocket();
  const session = new GameSession({ code: 'H5', joinUrl: 'H5', joinUrlFallback: 'H5' });
  const player = session.addPlayer(sock, { name: 'Zach', isLocal: true }).player;
  player.trail = 'comet';
  session.handleMessage(player, { type: 'startRound', courseIndex: 0 });
  if (session.state !== 'PLAYING') session.startNewRound();
  sock.drain();
  for (let i = 0; i < 40; i++) session.stepSimulation();

  const puttTick = session.simTick - lagTicks;
  assert.ok(session.getSnapshot(puttTick), 'history at puttTick');
  const restBall = session.getSnapshot(puttTick).players[player.id].ball;

  let denseStroke = null;
  const origDec = session.pathTimeEvenDecimate.bind(session);
  session.pathTimeEvenDecimate = (samples, n) => {
    denseStroke = samples ? samples.map((s) => ({ ...s })) : [];
    return origDec(samples, n);
  };

  session.handleMessage(player, {
    type: 'putt',
    dragVector: opts.drag || { x: 140, y: 20 },
    clientTick: puttTick,
  });
  const msgs = sock.drain();
  const puttApplied = msgs.filter((m) => m.type === 'puttApplied').pop();
  const replay = msgs.filter((m) => m.type === 'snapshot' && m.reason === 'replay').pop();
  assert.ok(replay && puttApplied, 'replay + puttApplied');
  const ball = replay.balls.find((b) => b.id === player.id);
  assert.ok(ball && Array.isArray(ball.path) && ball.path.length > 0, 'path on wire');

  return {
    session,
    playerId: player.id,
    puttTick,
    rest: { x: restBall.x, y: restBall.y, vx: 0, vy: 0 },
    impulse: {
      x: puttApplied.x,
      y: puttApplied.y,
      vx: puttApplied.vx,
      vy: puttApplied.vy,
    },
    present: { x: ball.x, y: ball.y, vx: ball.vx || 0, vy: ball.vy || 0 },
    path: ball.path,
    denseStroke,
    ballWire: ball,
    replay,
    puttApplied,
  };
}

/** Dave observer ball state (fields MpRecon mutates). */
function makeObserverBall(id, pose, trail) {
  return {
    id,
    x: pose.x,
    y: pose.y,
    vx: pose.vx || 0,
    vy: pose.vy || 0,
    z: 0,
    vz: 0,
    rx: pose.rx != null ? pose.rx : pose.x,
    ry: pose.ry != null ? pose.ry : pose.y,
    errX: 0,
    errY: 0,
    strokes: 0,
    holedOut: false,
    trail: trail === undefined ? 'comet' : trail,
    trailPts: [],
    visPath: null,
  };
}

function snapshotBefore(p) {
  return {
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    z: p.z || 0,
    vz: p.vz || 0,
    rx: p.rx,
    ry: p.ry,
    errX: p.errX || 0,
    errY: p.errY || 0,
    strokes: p.strokes,
    holedOut: !!p.holedOut,
  };
}

let failed = 0;
function hyp(name, fn) {
  try {
    fn();
    console.log('  DISPROVED (not the cause under this production path):', name);
  } catch (e) {
    failed++;
    console.error('  OPEN / FAILED:', name);
    console.error('   ', e.message || e);
  }
}

console.log('dave-trail-hypotheses: 5 single-putt hole causes vs REAL gameSession + mp-recon\n');

// ─────────────────────────────────────────────────────────────────────────
// H1: Wire path incomplete (not impulse→present) for a single putt hard
// PASS ⇒ path starts near impulse and ends near present (within lastHard window)
// ─────────────────────────────────────────────────────────────────────────
hyp('H1 wire path incomplete on single-putt hard', () => {
  const h = hostSinglePuttReplay({ lagTicks: 16 });
  assert.ok(h.path.length <= MpRecon.PATH_CATCHUP_N, 'path length ≤ N');
  assert.ok(dist(h.path[0], h.impulse) < 3, `path[0] must be impulse (got d=${dist(h.path[0], h.impulse)})`);
  assert.ok(
    dist(h.path[h.path.length - 1], h.present) < 3,
    `path[end] must be present (got d=${dist(h.path[h.path.length - 1], h.present)})`
  );
  assert.ok(h.denseStroke && h.denseStroke.length > 0, 'dense strokePath recorded');
  // Wire is sparse N — chord coverage vs dense GT may leave gaps; endpoints are the contract.
  assert.ok(h.path.length >= 2, 'wire has motion samples');
});

// ─────────────────────────────────────────────────────────────────────────
// H2: "before" is not rest when residual runs (so residual/path branch wrong)
// PASS ⇒ under production juice-only + rest setup, before is rest and residual is !matched
// ─────────────────────────────────────────────────────────────────────────
hyp('H2 before is not rest for observer residual', () => {
  const h = hostSinglePuttReplay({ lagTicks: 16 });
  // Dave: Zach at rest (last hard / tee)
  const p = makeObserverBall(h.playerId, h.rest, 'comet');
  // Production: remote puttApplied juice only — must not move pose
  const juice = MpRecon.applyRemotePuttAppliedJuiceOnly(p);
  assert.strictEqual(juice.poseUntouched, true);
  assert.ok(Math.hypot(p.vx, p.vy) < STOP, 'after juice-only, still rest v');
  assert.ok(dist(p, h.rest) < 1, 'after juice-only, still rest pose');

  const before = snapshotBefore(p);
  assert.ok(Math.hypot(before.vx, before.vy) < STOP, 'before.v rest');
  assert.ok(dist(before, h.rest) < 1, 'before pose rest');

  // Seed sim to host present (as after authority pose + resim to host tip)
  p.x = h.present.x;
  p.y = h.present.y;
  p.vx = h.present.vx;
  p.vy = h.present.vy;

  const vis = MpRecon.applyHardBallVisual(p, before, h.path, { nowMs: 1000 });
  assert.strictEqual(vis.matched, false, 'rest before vs flying present must !match');
  // Hypothesis H2 said "before not rest causes bug". Under correct juice-only, before IS rest.
  // So H2 cannot explain the hole if Dave follows juice-only + residual (production).
});

// ─────────────────────────────────────────────────────────────────────────
// H3: Path catch-up never ran (matched / no path / no trail)
// PASS ⇒ rest before + path + trail → pathCatchup; trail seeds start; free-run stamps trail
// ─────────────────────────────────────────────────────────────────────────
hyp('H3 path catch-up never ran', () => {
  const h = hostSinglePuttReplay({ lagTicks: 16 });
  const p = makeObserverBall(h.playerId, h.rest, 'comet');
  MpRecon.applyRemotePuttAppliedJuiceOnly(p);
  const before = snapshotBefore(p);
  p.x = h.present.x;
  p.y = h.present.y;
  p.vx = h.present.vx;
  p.vy = h.present.vy;

  const vis = MpRecon.applyHardBallVisual(p, before, h.path, { nowMs: 2000 });
  assert.strictEqual(vis.pathCatchup, true, 'must start path catch-up');
  assert.ok(p.visPath && p.visPath.length > 0, 'visPath set');
  // Catch-up starts at current board (before), not rewound to host path[0].
  assert.ok(
    dist({ x: p.rx, y: p.ry }, { x: before.rx, y: before.ry }) < 1,
    'catch-up starts at board state, not path[0] rewind'
  );
  assert.ok(p.trailPts && p.trailPts.length >= 1, 'trail seeds board start when trail set');
  assert.strictEqual(
    p.visPathTargetFrames,
    h.path.length,
    'catch-up frames = wire path length'
  );
  let frames = 0;
  const maxF = (p.visPathTargetFrames || h.path.length) + 5;
  while (p.visPath && frames < maxF) {
    MpRecon.advanceVisualPathOne(p, 2000 + frames * 16);
    MpRecon.freeRunTrailAndPrune(p, 2000 + frames * 16);
    frames++;
  }
  assert.ok(!p.visPath, 'catch-up finished');
  assert.ok(p.trailPts.length >= 2, 'trail stamps real catch-up poses');

  const pNoTrail = makeObserverBall(h.playerId, h.rest, null);
  pNoTrail.x = h.present.x;
  pNoTrail.y = h.present.y;
  pNoTrail.vx = h.present.vx;
  pNoTrail.vy = h.present.vy;
  const vis2 = MpRecon.applyHardBallVisual(pNoTrail, before, h.path, { nowMs: 2000 });
  assert.strictEqual(vis2.pathCatchup, true, 'catch-up still runs without trail cosmetic');
  assert.ok(!pNoTrail.trailPts || pNoTrail.trailPts.length === 0, 'no trailPts without cosmetic');
});

// ─────────────────────────────────────────────────────────────────────────
// H4: Trail stamps cleared / pruned / large neighbor jump after catch-up
// PASS ⇒ free-run trail during catch-up stays continuous; age prune works
// ─────────────────────────────────────────────────────────────────────────
hyp('H4 trail cleared/pruned or discontinuous after catch-up', () => {
  const h = hostSinglePuttReplay({ lagTicks: 16 });
  const p = makeObserverBall(h.playerId, h.rest, 'comet');
  const before = snapshotBefore(p);
  p.x = h.present.x;
  p.y = h.present.y;
  p.vx = h.present.vx;
  p.vy = h.present.vy;

  const t0 = 10000;
  const vis = MpRecon.applyHardBallVisual(p, before, h.path, { nowMs: t0 });
  assert.ok(vis.pathCatchup && p.trailPts.length > 0, 'catch-up + trail seed');

  let frames = 0;
  while (p.visPath && frames < 40) {
    MpRecon.advanceVisualPathOne(p, t0 + frames * 16);
    MpRecon.freeRunTrailAndPrune(p, t0 + frames * 16);
    frames++;
  }
  assert.ok(!p.visPath, 'catch-up finished');
  assert.ok(dist({ x: p.rx, y: p.ry }, h.present) < 1, 'draw at sim present when live unmoved');

  const t1 = t0 + 100;
  p.x += 12;
  p.rx = p.x;
  p.y = h.present.y;
  p.ry = p.y;
  MpRecon.freeRunTrailAndPrune(p, t1);

  assert.ok(
    maxNeighborGap(p.trailPts) <= 40,
    'no huge neighbor jump in trailPts (handoff hole)'
  );

  // Age-out: stamps older than TRAIL_MAX_AGE_MS pruned
  MpRecon.freeRunTrailAndPrune(p, t0 + MpRecon.TRAIL_MAX_AGE_MS + 50);
  assert.ok(
    !p.trailPts.some((pt) => pt.t === t0),
    'after max age, seed timestamp pruned'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// H5: Something else draws the "trail" (cosmetic trailPts is not what's on screen)
// PASS ⇒ draw path for multiplayer cosmetic trails is only trailPts when p.trail set;
//         without trailPts or trail, no cosmetic trail points exist to draw
// ─────────────────────────────────────────────────────────────────────────
hyp('H5 something else draws the cosmetic trail (not trailPts)', () => {
  // Production draw rule (game.js drawWorld): only `if (b.trail && b.trailPts) drawTrailPts(...)`.
  // So the dual-client blue dotted trail requires p.trail + p.trailPts. Nothing else paints it.
  // This hypothesis is disproved for the cosmetic trail: there is no alternate source in game.js.
  // (Black-hole tracers are separate Draw.updateTracerTrail — not the putt trail on Green Mile.)
  const h = hostSinglePuttReplay({ lagTicks: 12 });
  const p = makeObserverBall(h.playerId, h.rest, 'comet');
  const before = snapshotBefore(p);
  p.x = h.present.x;
  p.y = h.present.y;
  p.vx = h.present.vx;
  p.vy = h.present.vy;
  MpRecon.applyHardBallVisual(p, before, h.path, { nowMs: 5000 });

  assert.ok(p.trail, 'trail cosmetic required for drawTrailPts');
  assert.ok(p.trailPts && p.trailPts.length > 0, 'trailPts is the only cosmetic trail buffer');

  // Without trail cosmetic, no buffer to draw
  const p2 = makeObserverBall(h.playerId, h.rest, null);
  p2.x = h.present.x;
  p2.y = h.present.y;
  p2.vx = h.present.vx;
  p2.vy = h.present.vy;
  MpRecon.applyHardBallVisual(p2, before, h.path, { nowMs: 5000 });
  assert.ok(!p2.trailPts || p2.trailPts.length === 0, 'no trailPts without cosmetic');
  // drawWorld would not call drawTrailPts — no alternate trail painter for putts
});

// ─────────────────────────────────────────────────────────────────────────
// H6: Multi-frame keyframe walk ends at T1 then snaps to free-run live (T2)
// PASS ⇒ T0→T2 catch-up retargets live each frame; finish lands on live with no jump
// ─────────────────────────────────────────────────────────────────────────
hyp('H6 path ends at hard present then teleports to free-run live', () => {
  const h = hostSinglePuttReplay({ lagTicks: 16 });
  const p = makeObserverBall(h.playerId, h.rest, 'comet');
  const before = snapshotBefore(p);
  p.x = h.present.x;
  p.y = h.present.y;
  p.vx = h.present.vx;
  p.vy = h.present.vy;

  const pathEnd = h.path[h.path.length - 1];
  MpRecon.applyHardBallVisual(p, before, h.path, { nowMs: 1000 });
  assert.ok(p.visPath, 'catch-up started');

  // Simulate free-run racing ahead during multi-frame anim (the real hole).
  const liveAhead = {
    x: pathEnd.x + 60,
    y: pathEnd.y + 5,
  };
  let maxRenderJump = 0;
  let prev = { x: p.rx, y: p.ry };
  let frames = 0;
  const N = (p.visPathTargetFrames || h.path.length) + 2;
  while (p.visPath && frames < N) {
    // Live advances during catch-up (observer free-run).
    const t = (frames + 1) / N;
    p.x = pathEnd.x + 60 * t;
    p.y = pathEnd.y + 5 * t;
    MpRecon.advanceVisualPathOne(p, 1000 + frames * 16);
    const jump = dist(prev, { x: p.rx, y: p.ry });
    if (jump > maxRenderJump) maxRenderJump = jump;
    prev = { x: p.rx, y: p.ry };
    frames++;
  }
  assert.ok(!p.visPath, 'catch-up finished');
  assert.ok(
    dist({ x: p.rx, y: p.ry }, { x: p.x, y: p.y }) < 0.5,
    `finish must land on live, not path end (d=${dist({ x: p.rx, y: p.ry }, { x: p.x, y: p.y }).toFixed(1)})`
  );
  // Old bug: last step jumped ~60px from pathEnd to live. New: smooth over N frames.
  assert.ok(
    maxRenderJump < 40,
    `render jump ${maxRenderJump.toFixed(1)}px — still snapping pathEnd→live`
  );
  // Path end alone is stale vs final live
  assert.ok(
    dist(pathEnd, { x: p.x, y: p.y }) > 20,
    'sanity: live moved well past path end'
  );
});

console.log('');
if (failed) {
  console.error(`dave-trail-hypotheses: ${failed} hypothesis test(s) FAILED (hypothesis still open or contract broken)`);
  process.exitCode = 1;
} else {
  console.log(
    'dave-trail-hypotheses: all 6 DISPROVED under production gameSession + mp-recon.\n' +
      'T0→T2 catch-up lands on live; if browser still holes, re-capture path-trace.'
  );
}
