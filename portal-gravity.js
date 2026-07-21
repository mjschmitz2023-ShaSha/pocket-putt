// Material-space portal gravity (BEM + free-space Newton + accelerating-mouth Phi_xi).
//
// Bake when portalPairs AND (gravityBodies OR moving portal hosts).
//
// Model (docs/portal-poisson-gravity.md, docs/portal-theory-alignment.md):
//   Phi = Phi_direct + Phi_layers
//   Phi_direct = Phi_mass + Phi_xi
//     Phi_mass = sum -G m / r
//     Phi_xi   = -xi(r) a·(x-X)   (Theory of Portals §2.1.3.5 bump shell)
//   g_direct = -grad Phi_direct
//   Layers: independent single-layer sigma_A, sigma_B (Nystrom).
//   Transmission on TOTAL field (mass + xi):
//     Phi(A)=Phi(B),  g·n_A(A)+g·n_B(B)=0
//
// Loaded after shared.js → window.PortalGravity / Shared.PortalGravity.
(function (root) {
  'use strict';
  const S = root.Shared;
  if (!S) {
    console.error('portal-gravity.js requires Shared');
    return;
  }

  const {
    LOGICAL_W, LOGICAL_H, TICK_HZ, TICK_DT, GRAVITY_G,
    resolvePortalAperture, setHoleObstaclesAtTick, deepCloneHole,
  } = S;

  /** Coarse field grid cell (px). */
  const PG_CELL = 10;
  /**
   * Max period ticks. Built-in worst gravity-relevant LCM is Double Slit = 1584
   * (gate 144 × pend 132). Headroom for editor: 2400 (40s). No silent wrap below
   * true LCM for values under the cap — we use min(LCM, cap) only when LCM exceeds.
   */
  const PG_MAX_PERIOD_TICKS = 2400;
  /** Nyström panels per mouth. */
  const PG_PANELS = 32;
  /** Collocation offset along outward normal (fraction of panel length). */
  const PG_EPS_FRAC = 0.35;
  /**
   * Plummer soft length as a fraction of panel length (must be ≪ 1 so self-terms
   * still resolve panel-scale structure). Absolute floor in px for tiny panels.
   */
  const PG_SOFT_FRAC = 0.08;
  const PG_SOFT_MIN = 0.12;
  /** Ridge added to dense system diagonal (relative to mean |A_ii|). */
  const PG_SOLVE_RIDGE = 1e-8;
  /**
   * Accelerating-mouth bump (Theory of Portals §2.1.3.5).
   * R_in = max(PG_ACCEL_RIN_MIN, width * PG_ACCEL_RIN_FRAC)
   * R_out = R_in * PG_ACCEL_ROUT_FAC
   */
  const PG_ACCEL_RIN_FRAC = 0.5;
  const PG_ACCEL_RIN_MIN = 10;
  const PG_ACCEL_ROUT_FAC = 2.5;
  const PG_ACCEL_A_EPS = 1e-3;

  function gcd(a, b) {
    a = Math.abs(a | 0); b = Math.abs(b | 0);
    while (b) { const t = b; b = a % b; a = t; }
    return a || 1;
  }
  function lcm(a, b) {
    if (!a) return b;
    if (!b) return a;
    return Math.abs((a / gcd(a, b)) * b) | 0;
  }

  function holeHasMovingPortalHost(hole) {
    const pairs = hole && hole.portalPairs;
    if (!pairs || !pairs.length) return false;
    for (let pi = 0; pi < pairs.length; pi++) {
      const pair = pairs[pi];
      if (!pair) continue;
      for (const side of ['a', 'b']) {
        const end = pair[side];
        if (end && (end.host === 'gate' || end.host === 'pendulum')) return true;
      }
    }
    return false;
  }

  function holeNeedsPortalGravityBake(hole) {
    if (!hole) return false;
    if (!(hole.portalPairs && hole.portalPairs.length)) return false;
    if (hole.gravityBodies && hole.gravityBodies.length) return true;
    // Accelerating mouths need period bake even with no planets (portal paradox field).
    return holeHasMovingPortalHost(hole);
  }

  /**
   * Gravity-relevant period: moons + portal-host gates/pendulums only.
   * Returns { period, rawLcm, capped }.
   */
  function gravityPeriodInfo(hole) {
    let T = 1;
    const bodies = hole.gravityBodies || [];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.kind === 'moon') T = lcm(T, Math.max(1, Math.round(b.orbitPeriodTicks || 240)));
    }
    const pairs = hole.portalPairs || [];
    const seen = new Set();
    for (let pi = 0; pi < pairs.length; pi++) {
      const pair = pairs[pi];
      if (!pair) continue;
      for (const side of ['a', 'b']) {
        const end = pair[side];
        if (!end || (end.host !== 'gate' && end.host !== 'pendulum')) continue;
        const key = end.host + ':' + (end.index | 0);
        if (seen.has(key)) continue;
        seen.add(key);
        const arr = end.host === 'gate' ? hole.gates : hole.pendulums;
        const obj = arr && arr[end.index | 0];
        if (!obj || !(obj.period > 0)) continue;
        T = lcm(T, Math.max(1, Math.round(obj.period * TICK_HZ)));
      }
    }
    const rawLcm = Math.max(1, T);
    const capped = rawLcm > PG_MAX_PERIOD_TICKS;
    const period = capped ? PG_MAX_PERIOD_TICKS : rawLcm;
    return { period, rawLcm, capped };
  }

  function gravityPeriodTicks(hole) {
    return gravityPeriodInfo(hole).period;
  }

  function gridDims() {
    const nx = Math.max(8, Math.ceil(LOGICAL_W / PG_CELL));
    const ny = Math.max(8, Math.ceil(LOGICAL_H / PG_CELL));
    return { nx, ny, n: nx * ny, h: PG_CELL };
  }

  // ---- Free-space 3D Newton (planar) ----
  function phiDirect(x, y, bodies) {
    let phi = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || !(b.mass > 0)) continue;
      const dx = x - b.x, dy = y - b.y;
      const r = Math.hypot(dx, dy);
      if (r < 1e-9) continue;
      if (b.fieldRadius && r > b.fieldRadius) continue;
      // Φ = −G m / r  (matches g = −∇Φ = G m (x_m − x) / r³)
      phi += -GRAVITY_G * b.mass / r;
    }
    return phi;
  }

  function gDirect(x, y, bodies) {
    let ax = 0, ay = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || !(b.mass > 0)) continue;
      const dx = b.x - x, dy = b.y - y; // toward body
      const r = Math.hypot(dx, dy);
      if (r < 1e-9) continue;
      if (b.fieldRadius && r > b.fieldRadius) continue;
      if (b.kind === 'blackHole' && r <= b.radius) continue;
      const a = (GRAVITY_G * b.mass) / (r * r);
      ax += (dx / r) * a;
      ay += (dy / r) * a;
    }
    return { ax, ay };
  }

  // ---- Accelerating-mouth inertial field (Theory of Portals §2.1.3.5) ----
  //
  // Phi_xi = -xi(r) a·y ,  y = x - X
  // g_xi   = xi(r) a + xi'(r) (a·y) uhat
  // xi=1 for r<=Rin, xi=0 for r>=Rout, C1 smoothstep in the shell.

  /** xi(r) and dxi/dr for the compact bump. */
  function accelBump(r, rin, rout) {
    if (!(r >= 0) || r <= rin) return { xi: 1, dxi: 0 };
    if (r >= rout) return { xi: 0, dxi: 0 };
    const span = rout - rin;
    if (!(span > 1e-12)) return { xi: 0, dxi: 0 };
    const s = (r - rin) / span; // 0..1
    // Hermite: xi(0)=1, xi(1)=0, xi'(ends)=0
    // f(s)=3s^2-2s^3  (smoothstep 0→1), xi=1-f, dxi/ds=-(6s-6s^2)
    const f = s * s * (3 - 2 * s);
    const dfds = 6 * s * (1 - s);
    return { xi: 1 - f, dxi: -dfds / span };
  }

  /**
   * Closed-form Phi_xi and g_xi for one mouth source.
   * source: { x, y, ax, ay, rin, rout }
   */
  function fieldAccelOne(x, y, src) {
    const yx = x - src.x, yy = y - src.y;
    const r = Math.hypot(yx, yy);
    const { xi, dxi } = accelBump(r, src.rin, src.rout);
    const adot = src.ax * yx + src.ay * yy;
    const phi = -xi * adot;
    if (r < 1e-12) {
      // At mouth center: g = a (xi=1)
      return { phi: 0, ax: src.ax * xi, ay: src.ay * xi };
    }
    const ux = yx / r, uy = yy / r;
    // g = xi a + xi' (a·y) uhat
    return {
      phi,
      ax: xi * src.ax + dxi * adot * ux,
      ay: xi * src.ay + dxi * adot * uy,
    };
  }

  function phiAccelAt(x, y, mouths) {
    if (!mouths || !mouths.length) return 0;
    let phi = 0;
    for (let i = 0; i < mouths.length; i++) phi += fieldAccelOne(x, y, mouths[i]).phi;
    return phi;
  }

  function gAccelAt(x, y, mouths) {
    let ax = 0, ay = 0;
    if (!mouths || !mouths.length) return { ax, ay };
    for (let i = 0; i < mouths.length; i++) {
      const f = fieldAccelOne(x, y, mouths[i]);
      ax += f.ax;
      ay += f.ay;
    }
    return { ax, ay };
  }

  /**
   * Lab-frame mouth centers + accelerations at integer tick (period-wrapped).
   * Finite-differences aperture centers over neighboring ticks.
   */
  function buildMouthAccelSources(hole, tick, period) {
    const pairs = hole.portalPairs || [];
    if (!pairs.length) return [];
    const p = Math.max(1, period | 0 || 1);
    const t0 = ((tick % p) + p) % p;
    const tm = (t0 - 1 + p) % p;
    const tp = (t0 + 1) % p;
    const dt = TICK_DT > 0 ? TICK_DT : (1 / TICK_HZ);
    const dt2 = dt * dt;
    const seen = new Set();
    const sources = [];

    // Snapshot aperture center at a tick without permanently leaving t0.
    function centerAt(end, width, t) {
      setHoleObstaclesAtTick(hole, t);
      const ap = resolvePortalAperture(hole, end, width);
      if (!ap) return null;
      return { x: ap.cx, y: ap.cy, width: ap.width };
    }

    for (let pi = 0; pi < pairs.length; pi++) {
      const pair = pairs[pi];
      if (!pair) continue;
      const width = pair.width;
      for (const side of ['a', 'b']) {
        const end = pair[side];
        if (!end || (end.host !== 'gate' && end.host !== 'pendulum')) continue;
        const key = end.host + ':' + (end.index | 0);
        if (seen.has(key)) continue;
        seen.add(key);

        const c0 = centerAt(end, width, t0);
        if (!c0) continue;
        const cm = centerAt(end, width, tm);
        const cp = centerAt(end, width, tp);
        // Restore pose for callers (bake continues at t0).
        setHoleObstaclesAtTick(hole, t0);
        if (!cm || !cp) continue;

        const ax = (cp.x - 2 * c0.x + cm.x) / dt2;
        const ay = (cp.y - 2 * c0.y + cm.y) / dt2;
        if (Math.hypot(ax, ay) < PG_ACCEL_A_EPS) continue;

        const rin = Math.max(PG_ACCEL_RIN_MIN, c0.width * PG_ACCEL_RIN_FRAC);
        const rout = rin * PG_ACCEL_ROUT_FAC;
        sources.push({
          x: c0.x, y: c0.y, ax, ay, rin, rout,
          host: end.host, index: end.index | 0,
        });
      }
    }
    return sources;
  }

  /** Total direct field: free-space mass + accelerating-mouth shells. */
  function directField(x, y, hole, mouths) {
    const bodies = (hole && hole.gravityBodies) || [];
    const gm = gDirect(x, y, bodies);
    const pm = phiDirect(x, y, bodies);
    const ga = gAccelAt(x, y, mouths);
    const pa = phiAccelAt(x, y, mouths);
    return {
      ax: gm.ax + ga.ax,
      ay: gm.ay + ga.ay,
      phi: pm + pa,
    };
  }

  /**
   * C¹ Plummer regularizer: R = √(r²+ε²), Φ_unit = 1/R, ∇_x(1/R) = −(x−s)/R³.
   * Conjugate: g from single-layer mass density matches −∇Φ (unlike hard soft-floor).
   */
  function coulombKernel(x, y, sx, sy, eps) {
    const dx = x - sx, dy = y - sy;
    const r2 = dx * dx + dy * dy;
    const e2 = eps * eps;
    const R2 = r2 + e2;
    const R = Math.sqrt(R2);
    const R3 = R2 * R;
    return {
      invR: 1 / R,
      // ∇_x (1/R)
      dInvR_dx: -dx / R3,
      dInvR_dy: -dy / R3,
      R3,
      dx, dy,
    };
  }

  // Double-layer: ∂/∂n_s (1/R) = ∇_s(1/R)·n = (x−s)·n / R³
  function doubleLayerPhi(x, y, sx, sy, nx, ny, eps) {
    const k = coulombKernel(x, y, sx, sy, eps);
    return (k.dx * nx + k.dy * ny) / k.R3;
  }

  /**
   * Analytic g = −∇_x [∂n_s (1/R)] for unit double-layer density.
   * f = (x−s)·n / R³
   * ∂f/∂x_i = n_i/R³ − 3 ((x−s)·n)(x_i−s_i)/R⁵
   * g_i = −∂f/∂x_i
   */
  function doubleLayerG(x, y, sx, sy, nx, ny, eps) {
    const dx = x - sx, dy = y - sy;
    const r2 = dx * dx + dy * dy;
    const R2 = r2 + eps * eps;
    const R = Math.sqrt(R2);
    const R3 = R2 * R;
    const R5 = R3 * R2;
    const nd = dx * nx + dy * ny;
    // ∂f/∂x, ∂f/∂y
    const dfdx = nx / R3 - 3 * nd * dx / R5;
    const dfdy = ny / R3 - 3 * nd * dy / R5;
    return { gx: -dfdx, gy: -dfdy };
  }

  function panelSoft(panelLen) {
    return Math.max(PG_SOFT_MIN, panelLen * PG_SOFT_FRAC);
  }

  /**
   * Build panel geometry for one aperture end.
   * Panels along tangent, center, length, normal (outward face).
   */
  function buildPanels(ap, M) {
    const panels = [];
    const half = ap.width * 0.5;
    const plen = ap.width / M;
    for (let i = 0; i < M; i++) {
      const u = -half + (i + 0.5) * plen;
      const cx = ap.cx + ap.tx * u;
      const cy = ap.cy + ap.ty * u;
      panels.push({
        cx, cy,
        tx: ap.tx, ty: ap.ty,
        nx: ap.nx, ny: ap.ny,
        len: plen,
      });
    }
    return panels;
  }

  function collocationPoint(panel, eps) {
    return {
      x: panel.cx + panel.nx * eps,
      y: panel.cy + panel.ny * eps,
    };
  }

  // ---- Dense linear algebra (Gaussian elimination + ridge) ----
  function solveDense(A, b) {
    const n = b.length;
    // Mean |diag| for relative ridge
    let diagSum = 0, diagN = 0;
    for (let i = 0; i < n; i++) {
      const d = A[i][i];
      if (Number.isFinite(d)) { diagSum += Math.abs(d); diagN++; }
    }
    const ridge = PG_SOLVE_RIDGE * (diagN ? (diagSum / diagN) : 1);

    const M = new Array(n);
    for (let i = 0; i < n; i++) {
      M[i] = A[i].slice();
      M[i][i] += ridge;
      M[i].push(b[i]);
    }
    for (let col = 0; col < n; col++) {
      let piv = col;
      let best = Math.abs(M[col][col]);
      for (let r = col + 1; r < n; r++) {
        const v = Math.abs(M[r][col]);
        if (v > best) { best = v; piv = r; }
      }
      if (best < 1e-14) {
        // Rank-deficient: pin this DOF to 0 (no silent garbage from continue).
        for (let r = 0; r < n; r++) M[r][col] = 0;
        M[col][col] = 1;
        for (let c = col + 1; c < n; c++) M[col][c] = 0;
        M[col][n] = 0;
        continue;
      }
      if (piv !== col) {
        const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      }
      const div = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (Math.abs(f) < 1e-18) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = M[i][n];
      x[i] = Number.isFinite(v) ? v : 0;
    }
    return x;
  }

  /**
   * Resolve all portal pairs into panel pairs for current hole pose.
   * Collocation offset eps ~ panel scale and ≫ soft so mouths sit outside self-panels.
   */
  function resolvePairPanels(hole) {
    const pairs = hole.portalPairs || [];
    const out = [];
    const M = PG_PANELS;
    for (let pi = 0; pi < pairs.length; pi++) {
      const pair = pairs[pi];
      if (!pair || !pair.a || !pair.b) continue;
      const apA = resolvePortalAperture(hole, pair.a, pair.width);
      const apB = resolvePortalAperture(hole, pair.b, pair.width);
      if (!apA || !apB) continue;
      const panelsA = buildPanels(apA, M);
      const panelsB = buildPanels(apB, M);
      const plen = panelsA[0].len;
      const soft = panelSoft(plen);
      // Keep collocation outside the Plummer core (soft ≪ panel; eps ~ 0.35 plen).
      const eps = Math.max(soft * 3, plen * PG_EPS_FRAC);
      out.push({ apA, apB, panelsA, panelsB, eps, soft, M });
    }
    return out;
  }

  /**
   * Layer field at (x,y) from solved densities.
   * densities[pairIndex] = { sigmaA, sigmaB } independent single-layer densities
   * on each mouth (Float64Array length M).
   *
   * Why not free-portal σ_B=−σ_A? With outward normals n_B≈−n_A, free pairing
   * makes g·n_A(A)+g·n_B(B) identically zero for every density — flux BC is then
   * unenforceable and the dense system is rank-deficient. Independent σ_A, σ_B
   * spans both Φ-match and flux-match (verified by unit influence probes).
   *
   * Single layer: Φ = ∫ σ (−1/R), g = −∇Φ = σ len ∇(1/R)  (C¹ Plummer).
   */
  function layersAt(x, y, pairPanels, densities) {
    let phi = 0, ax = 0, ay = 0;
    for (let p = 0; p < pairPanels.length; p++) {
      const pp = pairPanels[p];
      const den = densities[p];
      if (!den) continue;
      const { panelsA, panelsB, M } = pp;
      const sigmaA = den.sigmaA || den.sigma;
      const sigmaB = den.sigmaB || (den.sigma ? negateArr(den.sigma) : null);
      if (!sigmaA || !sigmaB) continue;
      for (let i = 0; i < M; i++) {
        const sA = sigmaA[i];
        const sB = sigmaB[i];
        const pA = panelsA[i];
        const pB = panelsB[i];
        const softA = panelSoft(pA.len);
        const softB = panelSoft(pB.len);

        const cA = coulombKernel(x, y, pA.cx, pA.cy, softA);
        phi += sA * pA.len * (-cA.invR);
        ax += sA * pA.len * cA.dInvR_dx;
        ay += sA * pA.len * cA.dInvR_dy;

        const cB = coulombKernel(x, y, pB.cx, pB.cy, softB);
        phi += sB * pB.len * (-cB.invR);
        ax += sB * pB.len * cB.dInvR_dx;
        ay += sB * pB.len * cB.dInvR_dy;
      }
    }
    return { phi, ax, ay };
  }

  function negateArr(a) {
    const o = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = -a[i];
    return o;
  }

  /**
   * Single-layer influence of unit density on one mouth panel at (x,y).
   * mouth: 0 = A, 1 = B.
   */
  function unitSingleLayer(pp, mouth, panelIdx, x, y) {
    const p = mouth === 0 ? pp.panelsA[panelIdx] : pp.panelsB[panelIdx];
    const soft = panelSoft(p.len);
    const c = coulombKernel(x, y, p.cx, p.cy, soft);
    return {
      phi: p.len * (-c.invR),
      ax: p.len * c.dInvR_dx,
      ay: p.len * c.dInvR_dy,
    };
  }

  /**
   * Solve independent single-layer densities σ_A, σ_B for transmission BCs:
   *   Φ(A_ε)=Φ(B_ε),  g·n_A(A_ε)+g·n_B(B_ε)=0  on TOTAL direct (mass + Φ_ξ).
   * Unknowns per pair: 2M (σ_A[0..M), σ_B[0..M)).
   * opts.mouths — accel sources; opts.period / opts.tick for kinematics if omitted.
   */
  function solveLayers(hole, opts) {
    opts = opts || {};
    const pairPanels = resolvePairPanels(hole);
    if (!pairPanels.length) return { pairPanels, densities: [], mouths: [] };

    const period = opts.period != null ? opts.period : 1;
    const tick = opts.tick != null ? opts.tick : (hole._orbitTick | 0);
    const mouths = opts.mouths || buildMouthAccelSources(hole, tick, period);

    const pairN = pairPanels.length;
    const M = PG_PANELS;
    // Layout: [σ_A[0..M), σ_B[0..M)] per pair
    const uPer = 2 * M;
    const N = pairN * uPer;

    const A = new Array(N);
    for (let i = 0; i < N; i++) A[i] = new Float64Array(N);
    const rhs = new Float64Array(N);

    const colA = [];
    const colB = [];
    for (let p = 0; p < pairN; p++) {
      const pp = pairPanels[p];
      colA[p] = [];
      colB[p] = [];
      for (let i = 0; i < M; i++) {
        colA[p].push(collocationPoint(pp.panelsA[i], pp.eps));
        colB[p].push(collocationPoint(pp.panelsB[i], pp.eps));
      }
    }

    for (let p = 0; p < pairN; p++) {
      const pp = pairPanels[p];
      for (let i = 0; i < M; i++) {
        const rowPhi = p * uPer + i;
        const rowFlux = p * uPer + M + i;
        const cA = colA[p][i];
        const cB = colB[p][i];
        const nA = pp.panelsA[i];
        const nB = pp.panelsB[i];

        // TOTAL direct mismatch (mass + accelerating-mouth Φ_ξ)
        const dA = directField(cA.x, cA.y, hole, mouths);
        const dB = directField(cB.x, cB.y, hole, mouths);
        rhs[rowPhi] = -(dA.phi - dB.phi);
        rhs[rowFlux] = -(dA.ax * nA.nx + dA.ay * nA.ny + dB.ax * nB.nx + dB.ay * nB.ny);

        for (let ps = 0; ps < pairN; ps++) {
          const pps = pairPanels[ps];
          for (let k = 0; k < M; k++) {
            const colSA = ps * uPer + k;       // σ_A[k]
            const colSB = ps * uPer + M + k;   // σ_B[k]

            const lA_a = unitSingleLayer(pps, 0, k, cA.x, cA.y);
            const lB_a = unitSingleLayer(pps, 0, k, cB.x, cB.y);
            A[rowPhi][colSA] = lA_a.phi - lB_a.phi;
            A[rowFlux][colSA] =
              lA_a.ax * nA.nx + lA_a.ay * nA.ny +
              lB_a.ax * nB.nx + lB_a.ay * nB.ny;

            const lA_b = unitSingleLayer(pps, 1, k, cA.x, cA.y);
            const lB_b = unitSingleLayer(pps, 1, k, cB.x, cB.y);
            A[rowPhi][colSB] = lA_b.phi - lB_b.phi;
            A[rowFlux][colSB] =
              lA_b.ax * nA.nx + lA_b.ay * nA.ny +
              lB_b.ax * nB.nx + lB_b.ay * nB.ny;
          }
        }
      }
    }

    const Aarr = new Array(N);
    for (let i = 0; i < N; i++) Aarr[i] = Array.from(A[i]);
    const sol = solveDense(Aarr, Array.from(rhs));

    const densities = [];
    for (let p = 0; p < pairN; p++) {
      const sigmaA = new Float64Array(M);
      const sigmaB = new Float64Array(M);
      for (let i = 0; i < M; i++) {
        sigmaA[i] = sol[p * uPer + i];
        sigmaB[i] = sol[p * uPer + M + i];
      }
      densities.push({ sigmaA, sigmaB });
    }
    return { pairPanels, densities, mouths };
  }

  function fieldAt(x, y, hole, layerState) {
    const mouths = (layerState && layerState.mouths) || [];
    const d = directField(x, y, hole, mouths);
    if (!layerState || !layerState.densities || !layerState.densities.length) {
      return { ax: d.ax, ay: d.ay, phi: d.phi };
    }
    const L = layersAt(x, y, layerState.pairPanels, layerState.densities);
    return {
      ax: d.ax + L.ax,
      ay: d.ay + L.ay,
      phi: d.phi + L.phi,
    };
  }

  /**
   * Transmission BC residuals at collocation points after solve.
   * phiRes = Φ(A)−Φ(B), fluxRes = g·n_A(A)+g·n_B(B). Ideal = 0.
   */
  function transmissionResiduals(hole, layerState) {
    if (!layerState) layerState = solveLayers(hole);
    const pairPanels = layerState.pairPanels || [];
    const out = [];
    let maxAbsPhi = 0, maxAbsFlux = 0;
    for (let p = 0; p < pairPanels.length; p++) {
      const pp = pairPanels[p];
      for (let i = 0; i < pp.M; i++) {
        const cA = collocationPoint(pp.panelsA[i], pp.eps);
        const cB = collocationPoint(pp.panelsB[i], pp.eps);
        const fA = fieldAt(cA.x, cA.y, hole, layerState);
        const fB = fieldAt(cB.x, cB.y, hole, layerState);
        const nA = pp.panelsA[i], nB = pp.panelsB[i];
        const phiRes = fA.phi - fB.phi;
        const fluxRes =
          fA.ax * nA.nx + fA.ay * nA.ny +
          fB.ax * nB.nx + fB.ay * nB.ny;
        maxAbsPhi = Math.max(maxAbsPhi, Math.abs(phiRes));
        maxAbsFlux = Math.max(maxAbsFlux, Math.abs(fluxRes));
        out.push({ pair: p, panel: i, phiRes, fluxRes });
      }
    }
    return { panels: out, maxAbsPhi, maxAbsFlux };
  }

  /**
   * Compact fingerprint of a bake for host/client lockstep checks.
   * Deterministic from first-frame samples + metadata (not a crypto hash).
   */
  function bakeFingerprint(cache) {
    if (!cache || !cache.frames || !cache.frames.length) return '';
    const f0 = cache.frames[0];
    const n = Math.min(f0.length, 64);
    let h = (cache.version | 0) * 131 + (cache.period | 0) * 17 + (cache.nx | 0) * 3 + (cache.ny | 0);
    for (let i = 0; i < n; i++) {
      // Quantize to kill tiny float noise across engines
      const q = Math.round(f0[i] * 1e3);
      h = ((h * 33) ^ (q | 0)) | 0;
    }
    if (cache.phiFrames && cache.phiFrames[0]) {
      const p0 = cache.phiFrames[0];
      const m = Math.min(p0.length, 32);
      for (let i = 0; i < m; i++) {
        h = ((h * 33) ^ (Math.round(p0[i] * 1e3) | 0)) | 0;
      }
    }
    return (cache.method || 'bem') + ':' + cache.period + ':' + (h >>> 0).toString(16);
  }

  /**
   * Bake portal gravity for the full gravity period.
   * frames[t] = interleaved Float32 gx,gy (length 2n)
   * phiFrames[t] = Float32 phi (length n) for visualization
   */
  function bakePortalGravity(hole, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    if (!holeNeedsPortalGravityBake(hole)) {
      onProgress(1);
      return null;
    }
    const work = deepCloneHole(hole);
    const { nx, ny, n, h } = gridDims();
    const info = gravityPeriodInfo(work);
    let period = info.period;
    if (opts.maxPeriod != null) period = Math.min(period, opts.maxPeriod | 0);
    period = Math.max(1, period);

    const frames = new Array(period);
    const phiFrames = new Array(period);

    for (let t = 0; t < period; t++) {
      setHoleObstaclesAtTick(work, t);
      const mouths = buildMouthAccelSources(work, t, period);
      const layerState = solveLayers(work, { mouths, tick: t, period });
      const frame = new Float32Array(n * 2);
      const phiF = new Float32Array(n);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = (i + 0.5) * h;
          const y = (j + 0.5) * h;
          const f = fieldAt(x, y, work, layerState);
          const k = j * nx + i;
          frame[k * 2] = f.ax;
          frame[k * 2 + 1] = f.ay;
          phiF[k] = f.phi;
        }
      }
      frames[t] = frame;
      phiFrames[t] = phiF;
      onProgress((t + 1) / period);
    }

    const cache = {
      version: 3,
      method: 'bem-layers+accel',
      period,
      rawLcm: info.rawLcm,
      capped: info.capped || period < info.rawLcm,
      nx, ny, h,
      frames,
      phiFrames,
      cell: PG_CELL,
    };
    cache.fingerprint = bakeFingerprint(cache);
    return cache;
  }

  function bakePortalGravityAsync(hole, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    if (!holeNeedsPortalGravityBake(hole)) {
      onProgress(1);
      return Promise.resolve(null);
    }
    const work = deepCloneHole(hole);
    const { nx, ny, n, h } = gridDims();
    const info = gravityPeriodInfo(work);
    let period = info.period;
    if (opts.maxPeriod != null) period = Math.min(period, opts.maxPeriod | 0);
    period = Math.max(1, period);

    const frames = new Array(period);
    const phiFrames = new Array(period);
    let t = 0;

    return new Promise((resolve) => {
      function stepChunk() {
        const end = Math.min(period, t + 1); // 1 period-tick per frame (BEM is heavier)
        while (t < end) {
          setHoleObstaclesAtTick(work, t);
          const mouths = buildMouthAccelSources(work, t, period);
          const layerState = solveLayers(work, { mouths, tick: t, period });
          const frame = new Float32Array(n * 2);
          const phiF = new Float32Array(n);
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              const x = (i + 0.5) * h;
              const y = (j + 0.5) * h;
              const f = fieldAt(x, y, work, layerState);
              const k = j * nx + i;
              frame[k * 2] = f.ax;
              frame[k * 2 + 1] = f.ay;
              phiF[k] = f.phi;
            }
          }
          frames[t] = frame;
          phiFrames[t] = phiF;
          t++;
          onProgress(t / period);
        }
        if (t >= period) {
          const cache = {
            version: 3,
            method: 'bem-layers+accel',
            period,
            rawLcm: info.rawLcm,
            capped: info.capped || period < info.rawLcm,
            nx, ny, h,
            frames,
            phiFrames,
            cell: PG_CELL,
          };
          cache.fingerprint = bakeFingerprint(cache);
          resolve(cache);
        } else {
          const sched = root.requestAnimationFrame || function (cb) { setTimeout(cb, 0); };
          sched(stepChunk);
        }
      }
      stepChunk();
    });
  }

  function samplePortalGravity(cache, x, y, tick) {
    if (!cache || !cache.frames || !cache.frames.length) return { ax: 0, ay: 0, phi: 0 };
    const { nx, ny, h, period, frames, phiFrames } = cache;
    const t = ((tick % period) + period) % period;
    const frame = frames[t | 0];
    if (!frame) return { ax: 0, ay: 0, phi: 0 };

    let fx = x / h - 0.5;
    let fy = y / h - 0.5;
    fx = Math.max(0, Math.min(nx - 1.001, fx));
    fy = Math.max(0, Math.min(ny - 1.001, fy));
    const i0 = fx | 0;
    const j0 = fy | 0;
    const i1 = Math.min(nx - 1, i0 + 1);
    const j1 = Math.min(ny - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;

    function gAt(i, j) {
      const k = (j * nx + i) * 2;
      return { gx: frame[k], gy: frame[k + 1] };
    }
    function pAt(i, j) {
      if (!phiFrames || !phiFrames[t | 0]) return 0;
      return phiFrames[t | 0][j * nx + i];
    }
    const a = gAt(i0, j0), b = gAt(i1, j0), c = gAt(i0, j1), d = gAt(i1, j1);
    const ax =
      a.gx * (1 - tx) * (1 - ty) + b.gx * tx * (1 - ty) +
      c.gx * (1 - tx) * ty + d.gx * tx * ty;
    const ay =
      a.gy * (1 - tx) * (1 - ty) + b.gy * tx * (1 - ty) +
      c.gy * (1 - tx) * ty + d.gy * tx * ty;
    const phi =
      pAt(i0, j0) * (1 - tx) * (1 - ty) + pAt(i1, j0) * tx * (1 - ty) +
      pAt(i0, j1) * (1 - tx) * ty + pAt(i1, j1) * tx * ty;
    return { ax, ay, phi, mag: Math.hypot(ax, ay) };
  }

  function attachCacheToHole(hole, cache) {
    if (!hole) return;
    if (cache) hole._portalGravityCache = cache;
    else delete hole._portalGravityCache;
  }

  /**
   * Non-portal regression: with empty portalPairs, fieldAt must match gDirect.
   * Exposed for tests.
   */
  function fieldDirectOnly(x, y, hole) {
    return fieldAt(x, y, hole, { pairPanels: [], densities: [], mouths: [] });
  }

  const api = {
    PG_CELL,
    PG_MAX_PERIOD_TICKS,
    PG_PANELS,
    PG_SOFT_FRAC,
    PG_SOFT_MIN,
    PG_SOLVE_RIDGE,
    PG_ACCEL_RIN_FRAC,
    PG_ACCEL_RIN_MIN,
    PG_ACCEL_ROUT_FAC,
    PG_ACCEL_A_EPS,
    holeNeedsPortalGravityBake,
    holeHasMovingPortalHost,
    gravityPeriodTicks,
    gravityPeriodInfo,
    bakePortalGravity,
    bakePortalGravityAsync,
    samplePortalGravity,
    attachCacheToHole,
    bakeFingerprint,
    fieldDirectOnly,
    // testing / diagnostics hooks
    solveLayers,
    fieldAt,
    layersAt,
    transmissionResiduals,
    coulombKernel,
    doubleLayerPhi,
    doubleLayerG,
    panelSoft,
    gDirect,
    phiDirect,
    directField,
    phiAccelAt,
    gAccelAt,
    fieldAccelOne,
    accelBump,
    buildMouthAccelSources,
    solveDense,
  };

  root.PortalGravity = api;
  if (S) S.PortalGravity = api;
  // Explicit window bind for classic-script consumers (typeof PortalGravity is flaky).
  if (typeof window !== 'undefined') window.PortalGravity = api;
})(typeof self !== 'undefined' ? self : globalThis);
