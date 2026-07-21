'use strict';
/**
 * Material-space portal gravity (BEM layers + 1/r² direct sum).
 */
const assert = require('assert');

const Shared = require('../shared.js');
global.Shared = Shared;
require('../portal-gravity.js');
const PG = global.PortalGravity || Shared.PortalGravity;
assert.ok(PG, 'PortalGravity API attached');

const {
  blankHole, normalizeHole, wall, planet, createBallState, gravityAccelAt,
  setHoleObstaclesAtTick, slidingGate, TICK_HZ, TICK_DT,
} = Shared;

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

function portalGravityFixture() {
  return normalizeHole(blankHole({
    walls: [wall(200, 100, 200, 400), wall(600, 100, 600, 400)],
    portalPairs: [{
      width: 50,
      a: { host: 'wall', index: 0, t: 0.5, face: 1 },
      b: { host: 'wall', index: 1, t: 0.5, face: -1 },
    }],
    gravityBodies: [planet(720, 250, 20, 80000, { fieldRadius: 250 })],
  }));
}

function multiPairFixture() {
  return normalizeHole(blankHole({
    walls: [
      wall(150, 80, 150, 420),
      wall(400, 80, 400, 420),
      wall(650, 80, 650, 420),
    ],
    portalPairs: [
      {
        width: 40,
        a: { host: 'wall', index: 0, t: 0.4, face: 1 },
        b: { host: 'wall', index: 1, t: 0.4, face: -1 },
      },
      {
        width: 40,
        a: { host: 'wall', index: 1, t: 0.7, face: 1 },
        b: { host: 'wall', index: 2, t: 0.7, face: -1 },
      },
    ],
    gravityBodies: [planet(720, 250, 18, 90000, { fieldRadius: 280 })],
  }));
}

function noPortalFixture() {
  return normalizeHole(blankHole({
    gravityBodies: [planet(400, 250, 30, 20000, { fieldRadius: 180 })],
  }));
}

/** Static wall mouth + accelerating gate mouth; no mass — pure portal-paradox field. */
function acceleratingPortalFixture() {
  // Gate segment vertical at x=600, slides in y with large amplitude/short period → big a.
  return normalizeHole(blankHole({
    walls: [wall(200, 100, 200, 400)],
    gates: [slidingGate(600, 150, 600, 350, 'y', 80, 1.0, 0)],
    portalPairs: [{
      width: 50,
      a: { host: 'wall', index: 0, t: 0.5, face: 1 },
      b: { host: 'gate', index: 0, t: 0.5, face: -1 },
    }],
  }));
}

test('no bake needed without portals', () => {
  assert.strictEqual(PG.holeNeedsPortalGravityBake(noPortalFixture()), false);
});

test('bake needed with portals + masses', () => {
  assert.strictEqual(PG.holeNeedsPortalGravityBake(portalGravityFixture()), true);
});

test('bake needed with moving portal host even without masses', () => {
  assert.strictEqual(PG.holeNeedsPortalGravityBake(acceleratingPortalFixture()), true);
  assert.strictEqual(PG.holeHasMovingPortalHost(acceleratingPortalFixture()), true);
});

test('period cap covers Double Slit LCM (1584)', () => {
  assert.ok(PG.PG_MAX_PERIOD_TICKS >= 1584, 'cap=' + PG.PG_MAX_PERIOD_TICKS);
});

test('period for static portals is 1', () => {
  const h = portalGravityFixture();
  const info = PG.gravityPeriodInfo(h);
  assert.strictEqual(info.period, 1);
  assert.strictEqual(info.capped, false);
});

test('soft length is ≪ panel length', () => {
  const plen = 50 / 32; // fixture width / panels
  const soft = PG.panelSoft(plen);
  assert.ok(soft < plen * 0.25, 'soft=' + soft + ' plen=' + plen);
  assert.ok(soft >= PG.PG_SOFT_MIN);
});

test('Plummer single-layer g matches −∇Φ (conjugacy)', () => {
  const sx = 100, sy = 100, eps = 1.2;
  const x = 140, y = 115;
  const k = PG.coulombKernel(x, y, sx, sy, eps);
  // Φ_unit = −1/R  (single-layer mass sign in layersAt)
  // g_unit = ∇(1/R) = dInvR  so g = −∇Φ for Φ=−1/R
  const h = 1e-4;
  const invR = (xx, yy) => PG.coulombKernel(xx, yy, sx, sy, eps).invR;
  const dphidx = -(invR(x + h, y) - invR(x - h, y)) / (2 * h); // ∂(−1/R)/∂x
  const dphidy = -(invR(x, y + h) - invR(x, y - h)) / (2 * h);
  // g = −∇Φ = −dphi
  const gx = -dphidx;
  const gy = -dphidy;
  assert.ok(Math.abs(gx - k.dInvR_dx) < 2e-3, 'gx ' + gx + ' vs ' + k.dInvR_dx);
  assert.ok(Math.abs(gy - k.dInvR_dy) < 2e-3, 'gy ' + gy + ' vs ' + k.dInvR_dy);
});

test('double-layer g matches −∇ of double-layer Φ', () => {
  const sx = 200, sy = 200, nx = 1, ny = 0, eps = 0.8;
  const x = 230, y = 210;
  const g = PG.doubleLayerG(x, y, sx, sy, nx, ny, eps);
  const h = 1e-4;
  const phi = (xx, yy) => PG.doubleLayerPhi(xx, yy, sx, sy, nx, ny, eps);
  const dphidx = (phi(x + h, y) - phi(x - h, y)) / (2 * h);
  const dphidy = (phi(x, y + h) - phi(x, y - h)) / (2 * h);
  assert.ok(Math.abs(g.gx - (-dphidx)) < 5e-3, 'gx ' + g.gx + ' vs ' + (-dphidx));
  assert.ok(Math.abs(g.gy - (-dphidy)) < 5e-3, 'gy ' + g.gy + ' vs ' + (-dphidy));
});

test('solveDense pins singular DOF (no NaN)', () => {
  // Rank-1 system on 2 unknowns — second row is zero after ridge still small
  const A = [
    [1, 1],
    [0, 0],
  ];
  const x = PG.solveDense(A, [2, 0]);
  assert.ok(Number.isFinite(x[0]) && Number.isFinite(x[1]), JSON.stringify(Array.from(x)));
});

test('non-portal field matches Orbit gDirect (zero layers)', () => {
  const h = noPortalFixture();
  const x = 300, y = 250;
  const gd = PG.gDirect(x, y, h.gravityBodies);
  const f = PG.fieldDirectOnly(x, y, h);
  assert.ok(Math.abs(f.ax - gd.ax) < 1e-9 && Math.abs(f.ay - gd.ay) < 1e-9,
    JSON.stringify({ f, gd }));
});

test('zero-portal gravityAccelAt matches gDirect', () => {
  const h = noPortalFixture();
  delete h._portalGravityCache;
  const ball = createBallState({ x: 300, y: 250 });
  const g = gravityAccelAt(ball, h);
  const gd = PG.gDirect(ball.x, ball.y, h.gravityBodies);
  assert.ok(Math.abs(g.ax - gd.ax) < 1e-6 && Math.abs(g.ay - gd.ay) < 1e-6,
    'ax ' + g.ax + ' vs ' + gd.ax);
});

test('BEM bake method tag and finite field', () => {
  const h = portalGravityFixture();
  const cache = PG.bakePortalGravity(h, { maxPeriod: 1 });
  assert.ok(cache);
  assert.strictEqual(cache.method, 'bem-layers+accel');
  assert.strictEqual(cache.version, 3);
  assert.ok(cache.phiFrames && cache.phiFrames[0]);
  assert.ok(cache.fingerprint && typeof cache.fingerprint === 'string');
  PG.attachCacheToHole(h, cache);
  setHoleObstaclesAtTick(h, 0);
  const ball = createBallState({ x: 170, y: 250 });
  const g = gravityAccelAt(ball, h);
  assert.ok(Number.isFinite(g.ax) && Number.isFinite(g.ay), JSON.stringify(g));
  // Entry side should feel exit planet through material layers
  assert.ok(g.mag > 1e-3, 'expected non-zero material g, mag=' + g.mag);
});

test('Phi_xi conjugacy: g_xi matches -grad Phi_xi', () => {
  const src = { x: 400, y: 250, ax: 120, ay: -40, rin: 20, rout: 50 };
  const x = 430, y = 260;
  const f = PG.fieldAccelOne(x, y, src);
  const h = 1e-3;
  const dphidx = (PG.fieldAccelOne(x + h, y, src).phi - PG.fieldAccelOne(x - h, y, src).phi) / (2 * h);
  const dphidy = (PG.fieldAccelOne(x, y + h, src).phi - PG.fieldAccelOne(x, y - h, src).phi) / (2 * h);
  assert.ok(Math.abs(f.ax - (-dphidx)) < 0.05, 'ax ' + f.ax + ' vs ' + (-dphidx));
  assert.ok(Math.abs(f.ay - (-dphidy)) < 0.05, 'ay ' + f.ay + ' vs ' + (-dphidy));
});

test('core of accel shell: g ≈ a', () => {
  const src = { x: 300, y: 200, ax: 55, ay: -12, rin: 25, rout: 60 };
  const f = PG.fieldAccelOne(src.x + 5, src.y - 3, src);
  assert.ok(Math.abs(f.ax - src.ax) < 1e-6 && Math.abs(f.ay - src.ay) < 1e-6,
    JSON.stringify(f));
  const far = PG.fieldAccelOne(src.x + 200, src.y, src);
  assert.ok(Math.hypot(far.ax, far.ay) < 1e-9, 'far g should vanish');
});

test('near accelerating mouth material g tracks mouth a', () => {
  const h = acceleratingPortalFixture();
  // Gate: offset = A sin(2π phase/T), phase=t, T=1s → period ticks = 60
  // a_y = -A (2π/T)^2 sin(2π t/T). Max |a| at sin=±1.
  const periodTicks = Math.round(1.0 * TICK_HZ);
  // Find a tick with large |a|
  let bestT = 0, bestMag = 0, bestSrc = null;
  for (let t = 0; t < periodTicks; t++) {
    setHoleObstaclesAtTick(h, t);
    const mouths = PG.buildMouthAccelSources(h, t, periodTicks);
    if (!mouths.length) continue;
    const m = Math.hypot(mouths[0].ax, mouths[0].ay);
    if (m > bestMag) { bestMag = m; bestT = t; bestSrc = mouths[0]; }
  }
  assert.ok(bestSrc && bestMag > 10, 'expected measurable mouth a, mag=' + bestMag);
  setHoleObstaclesAtTick(h, bestT);
  // Embedding core (paper): direct g_xi ≈ a before layers.
  const d = PG.directField(bestSrc.x, bestSrc.y, h, [bestSrc]);
  assert.ok(Math.abs(d.ax - bestSrc.ax) < 1e-3 && Math.abs(d.ay - bestSrc.ay) < 1e-3,
    'direct core ' + JSON.stringify(d) + ' vs a ' + bestSrc.ax + ',' + bestSrc.ay);
  // After BEM, still roughly co-directed with a (layers redistribute for transmission).
  const ls = PG.solveLayers(h, { mouths: [bestSrc], tick: bestT, period: periodTicks });
  const f = PG.fieldAt(bestSrc.x, bestSrc.y, h, ls);
  const gMag = Math.hypot(f.ax, f.ay);
  const dot = f.ax * bestSrc.ax + f.ay * bestSrc.ay;
  const cos = dot / (gMag * bestMag + 1e-12);
  assert.ok(cos > 0.7, 'material g should align with a, cos=' + cos + ' g=' + JSON.stringify(f));
  assert.ok(gMag > bestMag * 0.2 && gMag < bestMag * 3,
    'gMag=' + gMag + ' aMag=' + bestMag);
});

test('static mouth feels accelerating partner through BEM (portal paradox)', () => {
  const h = acceleratingPortalFixture();
  const periodTicks = Math.round(1.0 * TICK_HZ);
  let bestT = 0, bestSrc = null, bestMag = 0;
  for (let t = 0; t < periodTicks; t++) {
    setHoleObstaclesAtTick(h, t);
    const mouths = PG.buildMouthAccelSources(h, t, periodTicks);
    if (!mouths.length) continue;
    const m = Math.hypot(mouths[0].ax, mouths[0].ay);
    if (m > bestMag) { bestMag = m; bestT = t; bestSrc = mouths[0]; }
  }
  assert.ok(bestSrc, 'need accel source');
  setHoleObstaclesAtTick(h, bestT);
  const ls = PG.solveLayers(h, { mouths: [bestSrc], tick: bestT, period: periodTicks });
  // Entry side of static wall at x=200, face +1 → enterable room has nx direction
  // Sample just in front of static mouth (~170, 250)
  const fEntry = PG.fieldAt(170, 250, h, ls);
  const entryMag = Math.hypot(fEntry.ax, fEntry.ay);
  // Direct-only (no layers) at entry: only wall side has no local xi shell → ~0
  const dOnly = PG.directField(170, 250, h, [bestSrc]);
  const directMag = Math.hypot(dOnly.ax, dOnly.ay);
  assert.ok(directMag < entryMag * 0.5 + 1 || entryMag > 1,
    'layers should add through-portal field; entryMag=' + entryMag + ' directMag=' + directMag);
  assert.ok(entryMag > 0.5, 'static mouth should feel partner accel, mag=' + entryMag);
});

test('pull through portal points toward exit-side mass', () => {
  // Planet at (720,250) right of exit wall x=600; entry left of wall x=200 at (170,250).
  // Material g at entry should have positive ax (toward +x, into portal then toward mass).
  const h = portalGravityFixture();
  const ls = PG.solveLayers(h);
  const f = PG.fieldAt(170, 250, h, ls);
  assert.ok(f.ax > 0, 'expected +ax through portal, ax=' + f.ax + ' ay=' + f.ay);
  // Free-space alone at entry: planet is far past a wall, still may pull +x but layers should reinforce.
  const gd = PG.gDirect(170, 250, h.gravityBodies);
  // Material |g| should not collapse to free-space zero-ish; layers add structure.
  assert.ok(Math.hypot(f.ax, f.ay) > Math.hypot(gd.ax, gd.ay) * 0.5 || f.ax > gd.ax,
    'material field weaker than free-space unexpectedly');
});

test('transmission residuals small after solve', () => {
  const h = portalGravityFixture();
  const ls = PG.solveLayers(h);
  const res = PG.transmissionResiduals(h, ls);
  // Collocation Nyström: expect residuals small vs free-space mismatch scale.
  const freePhiA = PG.phiDirect(170, 250, h.gravityBodies);
  const freePhiB = PG.phiDirect(630, 250, h.gravityBodies);
  const freeScale = Math.max(1, Math.abs(freePhiA - freePhiB));
  assert.ok(res.maxAbsPhi < freeScale * 0.15,
    'phi residual ' + res.maxAbsPhi + ' freeScale ' + freeScale);
  // Flux residual in accel units; free-space flux mismatch is O(g).
  const gB = PG.gDirect(630, 250, h.gravityBodies);
  const fluxScale = Math.max(10, Math.hypot(gB.ax, gB.ay));
  assert.ok(res.maxAbsFlux < fluxScale * 0.25,
    'flux residual ' + res.maxAbsFlux + ' fluxScale ' + fluxScale);
});

test('multi-pair bake is finite and fingerprints', () => {
  const h = multiPairFixture();
  const cache = PG.bakePortalGravity(h, { maxPeriod: 1 });
  assert.ok(cache && cache.frames.length === 1);
  assert.ok(Number.isFinite(cache.frames[0][0]));
  const ls = PG.solveLayers(h);
  assert.strictEqual(ls.pairPanels.length, 2);
  assert.strictEqual(ls.densities.length, 2);
  const res = PG.transmissionResiduals(h, ls);
  assert.ok(Number.isFinite(res.maxAbsPhi) && Number.isFinite(res.maxAbsFlux));
});

test('host/client bake fingerprint is deterministic', () => {
  const h1 = portalGravityFixture();
  const h2 = portalGravityFixture();
  const c1 = PG.bakePortalGravity(h1, { maxPeriod: 1 });
  const c2 = PG.bakePortalGravity(h2, { maxPeriod: 1 });
  assert.strictEqual(c1.fingerprint, c2.fingerprint, c1.fingerprint + ' vs ' + c2.fingerprint);
  assert.strictEqual(c1.period, c2.period);
  // Spot-check first frame sample
  assert.ok(Math.abs(c1.frames[0][10] - c2.frames[0][10]) < 1e-9);
});

test('sample phi available for visualization', () => {
  const h = portalGravityFixture();
  const cache = PG.bakePortalGravity(h, { maxPeriod: 1 });
  const s = PG.samplePortalGravity(cache, 170, 250, 0);
  assert.ok(Number.isFinite(s.phi), 'phi=' + s.phi);
});

(async () => {
  try {
    const h = portalGravityFixture();
    let last = 0;
    const cache = await PG.bakePortalGravityAsync(h, {
      maxPeriod: 1,
      onProgress(p) { last = p; },
    });
    assert.ok(cache && cache.frames.length >= 1);
    assert.ok(last >= 1 - 1e-9);
    assert.strictEqual(cache.method, 'bem-layers+accel');
    assert.ok(cache.fingerprint);
    // Async fingerprint matches sync bake
    const sync = PG.bakePortalGravity(h, { maxPeriod: 1 });
    assert.strictEqual(cache.fingerprint, sync.fingerprint);
    passed++;
    console.log('ok async BEM bake resolves + fingerprint lockstep');
  } catch (e) {
    console.error('FAIL async bake', e && e.message ? e.message : e);
    process.exitCode = 1;
  }
  console.log('portal-gravity-bake: %d tests passed', passed);
  if (process.exitCode) process.exit(process.exitCode);
})();
