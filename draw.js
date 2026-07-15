// Pocket Putt — shared canvas drawing for game + level editor (plain script, file:// ok).
// Depends on shared.js (window.Shared) loaded first. Exposes window.Draw.
(function (root) {
  'use strict';

  const S = root.Shared || {};
  const LOGICAL_W = S.LOGICAL_W || 800;
  const LOGICAL_H = S.LOGICAL_H || 500;
  const BOUNDARY_WALLS = S.BOUNDARY_WALLS || [];
  const BOUND = S.BOUND || { left: 20, top: 20, right: 780, bottom: 480 };
  const zoneBounds = S.zoneBounds || function (z) {
    return { x1: z.x1, y1: z.y1, x2: z.x2, y2: z.y2 };
  };
  const getWindmillBlades = S.getWindmillBlades || function () { return []; };
  const getPendulumSegment = S.getPendulumSegment || function (p) {
    return { x1: p.cx, y1: p.cy, x2: p.cx, y2: p.cy + (p.length || 0) };
  };
  const getSlidingGateSegment = S.getSlidingGateSegment || function (g) {
    return { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 };
  };

  const GRAVITY_G = S.GRAVITY_G || 100;

  const BOOST_COLOR_A = '#8b2fd1';
  const BOOST_COLOR_B = '#2fd1c8';
  /**
   * Wall stroke width (must match Shared.WALL_THICKNESS = 10).
   * Physics uses WALL_HALF_WIDTH so ball surface meets the drawn solid, not the centerline.
   */
  const WALL_DRAW_WIDTH = 10;

  // Black-hole lens look — dialed in via bh-lens-demo.html
  const BH_LENS = {
    rsLogical: 7,
    rOutLogical: 108,
    lensK: 1.45,
    fallPow: 0.8,
    denMin: 0.11,
    mix: 0.7,
    diskDraw: 2.5,
  };

  function nowSec(opts) {
    if (opts && opts.time != null) return opts.time;
    if (typeof performance !== 'undefined' && performance.now) return performance.now() / 1000;
    return Date.now() / 1000;
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawZonePath(ctx, z) {
    if (z.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(z.cx, z.cy, z.r, 0, Math.PI * 2);
    } else {
      roundRectPath(ctx, z.x1, z.y1, z.x2 - z.x1, z.y2 - z.y1, 8);
    }
  }

  function drawGrass(ctx) {
    ctx.fillStyle = '#3a7d44';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    const stripeW = 42;
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let x = 0, i = 0; x < LOGICAL_W; x += stripeW, i++) {
      if (i % 2 === 0) ctx.fillRect(x, 0, stripeW, LOGICAL_H);
    }
  }

  // ---- Space backdrop (holes with gravity bodies) ----
  // Decorative debris drifts in from the screen edges and falls along the hole's real
  // 1/r² field (same GRAVITY_G * mass / r² as the ball, scaled down so it pans, not
  // plummets). Visual only — sim state lives on hole._space and never touches physics.
  const SPACE = {
    stars: 110,
    dust: 26,
    comets: 3,
    planetoids: 2,
    gravityScale: 0.3,
    maxSpeed: 320,
    maxDt: 0.1, // clamp per-frame step so tab-back doesn't teleport debris
  };

  function spaceRand(min, max) {
    return min + Math.random() * (max - min);
  }

  // ---- Black-hole tracer trails ----
  // 1000 unique random RGB colors; trails cycle through the palette per segment and
  // per frame for a constantly-shifting rainbow as things spiral in. Visual only.
  const TRACER_COLORS = (() => {
    const seen = new Set();
    const out = [];
    while (out.length < 1000) {
      const r = (Math.random() * 256) | 0;
      const g = (Math.random() * 256) | 0;
      const b = (Math.random() * 256) | 0;
      const key = (r << 16) | (g << 8) | b;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([r, g, b]);
    }
    return out;
  })();

  /** Pull radius inside which an object counts as "interacting" with a black hole. */
  function blackHolePullRadius(body) {
    return body.fieldRadius != null ? body.fieldRadius : BH_LENS.rOutLogical;
  }

  function nearBlackHole(x, y, hole) {
    for (const b of hole.gravityBodies || []) {
      if (b.kind !== 'blackHole') continue;
      if (Math.hypot(x - b.x, y - b.y) <= blackHolePullRadius(b)) return true;
    }
    return false;
  }

  /** 0 at the pull edge → 1 at the black-hole center (max over all BHs; 0 if none). */
  function blackHoleProximity(x, y, hole) {
    let best = 0;
    for (const b of hole.gravityBodies || []) {
      if (b.kind !== 'blackHole') continue;
      const p = 1 - Math.hypot(x - b.x, y - b.y) / blackHolePullRadius(b);
      if (p > best) best = p;
    }
    return Math.max(0, Math.min(1, best));
  }

  // One color per interaction: a global cursor starts at a random seed in [1,1000]
  // and each NEW object entering a black hole's pull claims the current color and
  // advances the cursor (wrapping past 1000 and looping forever — back through the
  // seed and around again).
  let tracerCursor = Math.floor(Math.random() * 1000); // random seed 1..1000 (0-based)
  function claimTracerColor() {
    const c = TRACER_COLORS[tracerCursor];
    tracerCursor = (tracerCursor + 1) % 1000;
    return c;
  }

  /** Draw an object's tracer trail (oldest → newest) in its single claimed color. */
  function drawTracerTrail(ctx, obj) {
    const pts = obj && obj._bhTrail;
    const c = obj && obj._bhColor;
    if (!pts || pts.length < 2 || !c) return;
    ctx.save();
    ctx.lineCap = 'round';
    const n = pts.length;
    for (let i = 1; i < n; i++) {
      const frac = i / (n - 1); // 0 = tail, 1 = head
      // Proximity scale (captured per point): gradual fade-in at the pull edge,
      // ramping hard near the horizon — reads as acceleration, keeps far trails quiet.
      const prox = pts[i].prox != null ? pts[i].prox : 0.5;
      const proxScale = 0.12 + 0.88 * Math.pow(prox, 1.6);
      ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + ((0.15 + 0.85 * frac) * proxScale).toFixed(3) + ')';
      ctx.lineWidth = (1 + 2.2 * frac) * (0.7 + 0.5 * prox);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Append (or decay) a tracer trail on `obj` based on black-hole proximity.
   * A fresh interaction (no active trail) claims the next palette color.
   */
  function updateTracerTrail(obj, x, y, hole, maxLen) {
    if (nearBlackHole(x, y, hole)) {
      if (!obj._bhTrail) obj._bhTrail = [];
      if (obj._bhTrail.length === 0) obj._bhColor = claimTracerColor();
      const last = obj._bhTrail[obj._bhTrail.length - 1];
      if (!last || Math.hypot(x - last.x, y - last.y) > 1.2) {
        obj._bhTrail.push({ x, y, prox: blackHoleProximity(x, y, hole) });
        if (obj._bhTrail.length > maxLen) obj._bhTrail.shift();
      }
    } else if (obj._bhTrail && obj._bhTrail.length) {
      obj._bhTrail.splice(0, 2); // fade out once clear of the pull
      if (obj._bhTrail.length === 0) obj._bhColor = null; // next entry = new color
    }
  }

  function spawnSpaceDebris(p, hole, kind) {
    // Enter from a random screen edge, aimed loosely at a gravity body (or map center).
    const side = Math.floor(Math.random() * 4);
    if (side === 0) { p.x = -12; p.y = spaceRand(0, LOGICAL_H); }
    else if (side === 1) { p.x = LOGICAL_W + 12; p.y = spaceRand(0, LOGICAL_H); }
    else if (side === 2) { p.x = spaceRand(0, LOGICAL_W); p.y = -12; }
    else { p.x = spaceRand(0, LOGICAL_W); p.y = LOGICAL_H + 12; }
    const bodies = hole.gravityBodies || [];
    const target = bodies.length
      ? bodies[Math.floor(Math.random() * bodies.length)]
      : { x: LOGICAL_W / 2, y: LOGICAL_H / 2 };
    const ang = Math.atan2(target.y + spaceRand(-90, 90) - p.y, target.x + spaceRand(-90, 90) - p.x);
    const speed = kind === 'comet' ? spaceRand(24, 46) : kind === 'planetoid' ? spaceRand(5, 11) : spaceRand(9, 22);
    p.kind = kind;
    p._bhTrail = [];
    p.vx = Math.cos(ang) * speed;
    p.vy = Math.sin(ang) * speed;
    p.r = kind === 'comet' ? spaceRand(1.6, 2.4) : kind === 'planetoid' ? spaceRand(3, 5.5) : spaceRand(0.6, 1.4);
    if (kind === 'planetoid') {
      const icy = Math.random() < 0.5;
      p.c1 = icy ? '#aebdd0' : '#b3a68f';
      p.c2 = icy ? '#4e5b70' : '#5d5648';
    }
    return p;
  }

  function stepSpace(space, hole, dt) {
    const bodies = hole.gravityBodies || [];
    for (const p of space.debris) {
      let ax = 0;
      let ay = 0;
      let eaten = false;
      for (const b of bodies) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const r = Math.hypot(dx, dy);
        if (r < b.radius + p.r + 1) {
          eaten = true;
          break;
        }
        const a = (GRAVITY_G * b.mass * SPACE.gravityScale) / (r * r);
        ax += (dx / r) * a;
        ay += (dy / r) * a;
      }
      if (eaten) {
        spawnSpaceDebris(p, hole, p.kind);
        continue;
      }
      p.vx += ax * dt;
      p.vy += ay * dt;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > SPACE.maxSpeed) {
        p.vx *= SPACE.maxSpeed / sp;
        p.vy *= SPACE.maxSpeed / sp;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      updateTracerTrail(p, p.x, p.y, hole, 26);
      const m = 60;
      if (p.x < -m || p.x > LOGICAL_W + m || p.y < -m || p.y > LOGICAL_H + m) {
        spawnSpaceDebris(p, hole, p.kind);
      }
    }
  }

  function initSpace(hole) {
    const stars = [];
    for (let i = 0; i < SPACE.stars; i++) {
      stars.push({
        x: Math.random() * LOGICAL_W,
        y: Math.random() * LOGICAL_H,
        r: spaceRand(0.4, 1.3),
        base: spaceRand(0.25, 0.7),
        amp: spaceRand(0.08, 0.3),
        w: spaceRand(0.6, 2.2),
        ph: spaceRand(0, Math.PI * 2),
      });
    }
    const debris = [];
    for (let i = 0; i < SPACE.dust; i++) debris.push(spawnSpaceDebris({}, hole, 'dust'));
    for (let i = 0; i < SPACE.comets; i++) debris.push(spawnSpaceDebris({}, hole, 'comet'));
    for (let i = 0; i < SPACE.planetoids; i++) debris.push(spawnSpaceDebris({}, hole, 'planetoid'));
    const space = { stars, debris, lastT: null };
    // Pre-roll ~10s so the first frame is a lived-in field, not everyone hugging the edges.
    for (let i = 0; i < 240; i++) stepSpace(space, hole, 1 / 24);
    return space;
  }

  function drawSpace(ctx, hole, timeSec) {
    const t = timeSec != null ? timeSec : nowSec();
    if (!hole._space) hole._space = initSpace(hole);
    const space = hole._space;
    const dt = space.lastT == null ? 0 : Math.min(Math.max(t - space.lastT, 0), SPACE.maxDt);
    space.lastT = t;
    if (dt > 0) stepSpace(space, hole, dt);

    ctx.fillStyle = '#04060c';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    let neb = ctx.createRadialGradient(LOGICAL_W * 0.72, LOGICAL_H * 0.25, 20, LOGICAL_W * 0.72, LOGICAL_H * 0.25, 340);
    neb.addColorStop(0, 'rgba(96,72,160,0.10)');
    neb.addColorStop(1, 'rgba(96,72,160,0)');
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    neb = ctx.createRadialGradient(LOGICAL_W * 0.2, LOGICAL_H * 0.8, 20, LOGICAL_W * 0.2, LOGICAL_H * 0.8, 300);
    neb.addColorStop(0, 'rgba(40,110,150,0.08)');
    neb.addColorStop(1, 'rgba(40,110,150,0)');
    ctx.fillStyle = neb;
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    for (const s of space.stars) {
      const a = Math.max(0, Math.min(1, s.base + Math.sin(t * s.w + s.ph) * s.amp));
      ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tracers for debris being pulled into a black hole (under the debris dots) —
    // each interaction wears its own claimed palette color.
    for (const p of space.debris) drawTracerTrail(ctx, p);

    for (const p of space.debris) {
      if (p.kind === 'dust') {
        ctx.fillStyle = 'rgba(200,210,230,0.5)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === 'comet') {
        const sp = Math.hypot(p.vx, p.vy) || 1;
        const tail = Math.min(46, 10 + sp * 0.18);
        const tx = p.x - (p.vx / sp) * tail;
        const ty = p.y - (p.vy / sp) * tail;
        const grad = ctx.createLinearGradient(p.x, p.y, tx, ty);
        grad.addColorStop(0, 'rgba(180,220,255,0.85)');
        grad.addColorStop(1, 'rgba(180,220,255,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = p.r * 1.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.fillStyle = '#eaf6ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const g = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.35, p.r * 0.2, p.x, p.y, p.r);
        g.addColorStop(0, p.c1);
        g.addColorStop(1, p.c2);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawSandZone(ctx, z, space) {
    const b = zoneBounds(z);
    if (space) {
      // Moon dust: gray→white sweep with crater-gray speckling.
      const grad = ctx.createLinearGradient(b.x1, b.y1, b.x2, b.y2);
      grad.addColorStop(0, '#aeb4bd');
      grad.addColorStop(0.55, '#d8dce2');
      grad.addColorStop(1, '#f2f4f7');
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = '#dcc27a';
    }
    drawZonePath(ctx, z);
    ctx.fill();
    if (!z._speckles) {
      z._speckles = [];
      for (let i = 0; i < 40; i++) {
        z._speckles.push({
          x: b.x1 + Math.random() * (b.x2 - b.x1),
          y: b.y1 + Math.random() * (b.y2 - b.y1),
          r: 1 + Math.random() * 1.5,
        });
      }
    }
    ctx.fillStyle = space ? 'rgba(96,102,112,0.4)' : 'rgba(150,120,60,0.28)';
    for (const d of z._speckles) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (space) {
      // A few catching-the-light rim highlights on the larger "craters".
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      for (const d of z._speckles) {
        if (d.r < 1.8) continue;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, Math.PI * 0.75, Math.PI * 1.45);
        ctx.stroke();
      }
    }
  }

  function drawZonePathExpanded(ctx, z, pad) {
    if (z.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(z.cx, z.cy, z.r + pad, 0, Math.PI * 2);
    } else {
      roundRectPath(ctx, z.x1 - pad, z.y1 - pad, z.x2 - z.x1 + pad * 2, z.y2 - z.y1 + pad * 2, 8 + pad);
    }
  }

  function drawWaterZone(ctx, z, timeSec) {
    // Visuals live ENTIRELY inside the hazard rect — physics (circleTouchesZone on
    // the zone) is the single source of truth for where water begins, and the drawn
    // feature never covers playable green. The dirt bank is the zone's outer band;
    // the waterline is inset within it (a ball at the muddy shore is in the hazard,
    // same as a real penalty area).
    const b = zoneBounds(z);
    const t = timeSec != null ? timeSec : nowSec();
    const pad = Math.min(5, (Math.min(b.x2 - b.x1, b.y2 - b.y1) / 6) | 0);
    const ib = { x1: b.x1 + pad, y1: b.y1 + pad, x2: b.x2 - pad, y2: b.y2 - pad };

    // Raised dirt bank: outer band of the hazard, rim highlight right on the physics edge.
    const bank = ctx.createLinearGradient(b.x1, b.y1, b.x2, b.y2);
    bank.addColorStop(0, '#96714a');
    bank.addColorStop(1, '#6b4d2e');
    ctx.fillStyle = bank;
    drawZonePath(ctx, z);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    drawZonePathExpanded(ctx, z, -0.75);
    ctx.stroke();

    // Water body inset within the bank: deeper toward the far corner.
    const body = ctx.createLinearGradient(ib.x1, ib.y1, ib.x2, ib.y2);
    body.addColorStop(0, '#4a94d4');
    body.addColorStop(1, '#2a5f9e');
    ctx.fillStyle = body;
    drawZonePathExpanded(ctx, z, -pad);
    ctx.fill();

    ctx.save();
    drawZonePathExpanded(ctx, z, -pad);
    ctx.clip();
    // Contact shadow under the bank lip, strongest along the top edge (light from above).
    ctx.strokeStyle = 'rgba(8,18,48,0.4)';
    ctx.lineWidth = 9;
    drawZonePathExpanded(ctx, z, -pad);
    ctx.stroke();
    const lip = ctx.createLinearGradient(0, ib.y1, 0, ib.y1 + 12);
    lip.addColorStop(0, 'rgba(5,15,40,0.35)');
    lip.addColorStop(1, 'rgba(5,15,40,0)');
    ctx.fillStyle = lip;
    ctx.fillRect(ib.x1, ib.y1, ib.x2 - ib.x1, 12);

    // Waves: one lead front line + 3 followers, each slightly slower, all bouncing
    // off the banks (the waterline is the physics boundary). Four strokes per pond
    // instead of a rendered heightfield — huge draw-call reduction, same motion story.
    drawWaterWaves(ctx, z, ib, t);
    ctx.restore();
  }

  const WATER_WAVES = {
    speed: 17,        // px/s, lead front; followers are each a step slower
    followers: 3,
    slowdown: 0.85,   // per-follower speed multiplier
    bow: 4,           // px the line bows in its direction of travel
  };

  // One lead wave line + followers sweeping the pond's long axis, reflecting off the
  // banks (the inset waterline is the boundary). Four strokes per pond, no heightfield.
  function drawWaterWaves(ctx, z, b, t) {
    if (!z._waves) {
      const vertical = (b.y2 - b.y1) > (b.x2 - b.x1);
      const lo = vertical ? b.y1 : b.x1;
      const span = (vertical ? b.y2 - b.y1 : b.x2 - b.x1);
      // Randomize phase + jitter speeds per pond so same-sized neighbors never sync —
      // synchronized lines in adjacent zones read as one line crossing the terrain between.
      const fronts = [];
      const phase = Math.random() * 0.6;
      const jitter = 0.9 + Math.random() * 0.2;
      for (let k = 0; k <= WATER_WAVES.followers; k++) {
        fronts.push({
          pos: lo + span * ((phase + 0.16 * k) % 0.92 + 0.04),
          dir: Math.random() < 0.5 ? 1 : -1,
          speed: WATER_WAVES.speed * jitter * Math.pow(WATER_WAVES.slowdown, k),
        });
      }
      z._waves = { vertical, fronts, wisps: [], nextWispAt: t + 0.4, lastT: null };
    }
    const w = z._waves;
    const dt = w.lastT == null ? 0 : Math.min(0.1, Math.max(0, t - w.lastT));
    w.lastT = t;
    const lo = (w.vertical ? b.y1 : b.x1) + 3;
    const hi = (w.vertical ? b.y2 : b.x2) - 3;
    ctx.lineCap = 'round';

    // Wake: small foam wisps that peel off a wave's path and get gently left behind,
    // spreading and fading as the line moves on. Drawn under the lines.
    if (t >= w.nextWispAt && dt > 0) {
      w.nextWispAt = t + 0.35 + Math.random() * 0.6;
      const f = w.fronts[Math.floor(Math.random() * w.fronts.length)];
      w.wisps.push({
        across: 0.15 + Math.random() * 0.7,
        pos: f.pos - f.dir * 2,
        dir: f.dir,
        len: 7 + Math.random() * 8,
        age: 0,
      });
      if (w.wisps.length > 12) w.wisps.shift();
    }
    const WISP_LIFE = 1.3;
    for (let i = w.wisps.length - 1; i >= 0; i--) {
      const s = w.wisps[i];
      s.age += dt;
      if (s.age >= WISP_LIFE) { w.wisps.splice(i, 1); continue; }
      s.pos -= s.dir * 3 * dt; // drift softly astern of the wave that shed it
      const life = s.age / WISP_LIFE;
      const alpha = 0.16 * (1 - life);
      const half = (s.len * (1 + 0.45 * life)) / 2;
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (w.vertical) {
        const cx = b.x1 + 4 + s.across * (b.x2 - b.x1 - 8);
        ctx.moveTo(cx - half, s.pos);
        ctx.quadraticCurveTo(cx, s.pos + s.dir * 2, cx + half, s.pos);
      } else {
        const cy = b.y1 + 4 + s.across * (b.y2 - b.y1 - 8);
        ctx.moveTo(s.pos, cy - half);
        ctx.quadraticCurveTo(s.pos + s.dir * 2, cy, s.pos, cy + half);
      }
      ctx.stroke();
    }
    for (let k = w.fronts.length - 1; k >= 0; k--) {
      const f = w.fronts[k];
      f.pos += f.dir * f.speed * dt;
      if (f.pos > hi) { f.pos = hi; f.dir = -1; }
      if (f.pos < lo) { f.pos = lo; f.dir = 1; }
      ctx.strokeStyle = 'rgba(255,255,255,' + (k === 0 ? 0.22 : 0.16 - 0.035 * k).toFixed(3) + ')';
      ctx.lineWidth = k === 0 ? 2 : 1.4;
      const bow = f.dir * WATER_WAVES.bow;
      ctx.beginPath();
      if (w.vertical) {
        ctx.moveTo(b.x1 + 4, f.pos);
        ctx.quadraticCurveTo((b.x1 + b.x2) / 2, f.pos + bow, b.x2 - 4, f.pos);
      } else {
        ctx.moveTo(f.pos, b.y1 + 4);
        ctx.quadraticCurveTo(f.pos + bow, (b.y1 + b.y2) / 2, f.pos, b.y2 - 4);
      }
      ctx.stroke();
    }
  }

  function drawStickyZone(ctx, z, timeSec) {
    // Deeper amber than sand's pale tan so goo and bunkers never read as the same surface.
    ctx.fillStyle = '#c9861c';
    drawZonePath(ctx, z);
    ctx.fill();
    if (!z._speckles) {
      z._speckles = [];
      const b = zoneBounds(z);
      const n = Math.max(6, Math.floor((b.x2 - b.x1) * (b.y2 - b.y1) / 2200));
      for (let i = 0; i < n; i++) {
        z._speckles.push({
          x: b.x1 + Math.random() * (b.x2 - b.x1),
          y: b.y1 + Math.random() * (b.y2 - b.y1),
          r: 2 + Math.random() * 3,
        });
      }
    }
    ctx.fillStyle = 'rgba(120,70,10,0.4)';
    for (const d of z._speckles) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    const b = zoneBounds(z);
    const t = timeSec != null ? timeSec : nowSec();
    // Glossy wet-goo highlights that slowly pulse in place — no panning line, so goo
    // can never be mistaken for water's traveling waves.
    if (!z._gloss) {
      z._gloss = [];
      const n = Math.max(2, Math.min(4, Math.floor(((b.x2 - b.x1) * (b.y2 - b.y1)) / 6000)));
      for (let i = 0; i < n; i++) {
        z._gloss.push({
          x: b.x1 + (0.2 + Math.random() * 0.6) * (b.x2 - b.x1),
          y: b.y1 + (0.2 + Math.random() * 0.6) * (b.y2 - b.y1),
          rx: 6 + Math.random() * 8,
          ry: 3 + Math.random() * 3,
          ph: Math.random() * Math.PI * 2,
        });
      }
    }
    for (const g of z._gloss) {
      const pulse = 0.16 + 0.08 * Math.sin(t * 1.1 + g.ph);
      ctx.fillStyle = 'rgba(255,225,150,' + pulse.toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, g.rx, g.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBoostZone(ctx, z, timeSec) {
    const b = zoneBounds(z);
    const grad = ctx.createLinearGradient(b.x1, b.y1, b.x2, b.y2);
    grad.addColorStop(0, BOOST_COLOR_A);
    grad.addColorStop(1, BOOST_COLOR_B);
    ctx.fillStyle = grad;
    roundRectPath(ctx, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 6);
    ctx.fill();

    ctx.save();
    roundRectPath(ctx, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 6);
    ctx.clip();
    const t = timeSec != null ? timeSec : nowSec();
    const dirX = Math.cos(z.angle), dirY = Math.sin(z.angle);
    const perpX = -dirY, perpY = dirX;
    const spacing = 30;
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    const diag = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
    const offset = ((t * 170) % spacing + spacing) % spacing;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (let d = -diag; d < diag; d += spacing) {
      const along = d + offset;
      const bx = cx + dirX * along, by = cy + dirY * along;
      const wing = 9;
      ctx.beginPath();
      ctx.moveTo(bx - dirX * wing + perpX * wing, by - dirY * wing + perpY * wing);
      ctx.lineTo(bx + dirX * wing, by + dirY * wing);
      ctx.lineTo(bx - dirX * wing - perpX * wing, by - dirY * wing - perpY * wing);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRampZone(ctx, z) {
    // Pad is a local w×h rect rotated by launch angle about its center (boosts stay AABB).
    const b = zoneBounds(z);
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    const w = Math.abs(b.x2 - b.x1), h = Math.abs(b.y2 - b.y1);
    const hw = w / 2, hh = h / 2;
    const ang = z.angle || 0;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    // Cast shadow, sheared by height: hugs the base at the low end, pushed past the
    // lip and sideways at the high end so the launch edge reads as raised off the green.
    const drop = Math.min(10, Math.max(6, hh * 0.28));
    const shadowQuad = (grow, alpha) => {
      ctx.fillStyle = 'rgba(0,0,0,' + alpha + ')';
      ctx.beginPath();
      ctx.moveTo(-hw + 1, -hh + 1.5 - grow * 0.4);
      ctx.lineTo(hw + drop + grow, -hh + drop * 0.55 - grow);
      ctx.lineTo(hw + drop + grow, hh + drop + grow);
      ctx.lineTo(-hw + 1, hh + 1.5 + grow * 0.4);
      ctx.closePath();
      ctx.fill();
    };
    shadowQuad(2.5, 0.12); // soft penumbra
    shadowQuad(0, 0.28);   // core shadow
    // Local +x = launch direction after rotation.
    const grad = ctx.createLinearGradient(-hw, 0, hw, 0);
    grad.addColorStop(0, '#8a6a3f');
    grad.addColorStop(1, '#e0c188');
    ctx.fillStyle = grad;
    roundRectPath(ctx, -hw, -hh, w, h, 6);
    ctx.fill();
    ctx.save();
    roundRectPath(ctx, -hw, -hh, w, h, 6);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let d = -hw + 14; d < hw - 4; d += 22) {
      const wing = 8;
      ctx.beginPath();
      ctx.moveTo(d - wing, wing);
      ctx.lineTo(d + wing, 0);
      ctx.lineTo(d - wing, -wing);
      ctx.stroke();
    }
    ctx.restore();
    // Bright lip at the high / launch end (local +x)
    const lipHalf = Math.min(hw, hh);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hw, -lipHalf);
    ctx.lineTo(hw, lipHalf);
    ctx.stroke();
    ctx.restore();
  }

  // Space-hole wall skin: one satellite spanning the segment — central bus with two
  // smooth solar-panel wings — instead of wooden planks. Purely visual; collision
  // stays WALL_DRAW_WIDTH.
  function drawSatelliteSegment(ctx, wall) {
    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    ctx.save();
    ctx.translate((wall.x1 + wall.x2) / 2, (wall.y1 + wall.y2) / 2);
    ctx.rotate(Math.atan2(dy, dx));
    const half = len / 2;
    const hw = WALL_DRAW_WIDTH / 2; // panel half-height
    const busHalf = Math.min(14, half * 0.28); // central body half-length

    // Boom arms connecting bus to wings
    ctx.strokeStyle = '#7d8694';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(-half, 0);
    ctx.lineTo(half, 0);
    ctx.stroke();

    // Two smooth panel wings: continuous gradient sheets with sparse cell seams
    const wing = (x0, x1) => {
      if (x1 - x0 < 6) return;
      const panel = ctx.createLinearGradient(0, -hw, 0, hw);
      panel.addColorStop(0, '#3a3e45');
      panel.addColorStop(0.45, '#17191d');
      panel.addColorStop(1, '#060708');
      ctx.fillStyle = panel;
      roundRectPath(ctx, x0, -hw, x1 - x0, WALL_DRAW_WIDTH, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      roundRectPath(ctx, x0 + 0.5, -hw + 0.5, x1 - x0 - 1, WALL_DRAW_WIDTH - 1, 3);
      ctx.stroke();
      // sparse seams so the sheet reads as an array without getting busy
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      const seams = Math.max(1, Math.round((x1 - x0) / 26));
      for (let s = 1; s < seams + 1; s++) {
        const x = x0 + ((x1 - x0) * s) / (seams + 1);
        ctx.beginPath();
        ctx.moveTo(x, -hw + 1.5);
        ctx.lineTo(x, hw - 1.5);
        ctx.stroke();
      }
      // long center seam down the wing
      ctx.beginPath();
      ctx.moveTo(x0 + 2, 0);
      ctx.lineTo(x1 - 2, 0);
      ctx.stroke();
    };
    wing(-half, -busHalf - 3);
    wing(busHalf + 3, half);

    // Central bus: dark-gray body with white trim and a small dish
    const bus = ctx.createLinearGradient(0, -hw - 2, 0, hw + 2);
    bus.addColorStop(0, '#6b7078');
    bus.addColorStop(0.5, '#42464d');
    bus.addColorStop(1, '#26292e');
    ctx.fillStyle = bus;
    roundRectPath(ctx, -busHalf, -hw - 1, busHalf * 2, WALL_DRAW_WIDTH + 2, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    roundRectPath(ctx, -busHalf + 0.5, -hw - 0.5, busHalf * 2 - 1, WALL_DRAW_WIDTH + 1, 3);
    ctx.stroke();
    // dish + nav light
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#26292e';
    ctx.beginPath();
    ctx.arc(0, 0, 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawWallSegment(ctx, wall, space) {
    if (space && !wall.bumper) {
      drawSatelliteSegment(ctx, wall);
      return;
    }
    ctx.lineCap = 'round';
    if (wall.bumper) {
      ctx.strokeStyle = '#e6483f';
      ctx.lineWidth = WALL_DRAW_WIDTH;
      ctx.beginPath();
      ctx.moveTo(wall.x1, wall.y1);
      ctx.lineTo(wall.x2, wall.y2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 8]);
      ctx.beginPath();
      ctx.moveTo(wall.x1, wall.y1);
      ctx.lineTo(wall.x2, wall.y2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = '#6b4a2b';
      ctx.lineWidth = WALL_DRAW_WIDTH;
      ctx.beginPath();
      ctx.moveTo(wall.x1, wall.y1);
      ctx.lineTo(wall.x2, wall.y2);
      ctx.stroke();
      ctx.strokeStyle = '#5a3d22';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(wall.x1, wall.y1);
      ctx.lineTo(wall.x2, wall.y2);
      ctx.stroke();
    }
  }

  // Visual border skin — separate from the physics boundary system. Physics owns
  // WHERE the walls are (Shared.BOUNDARY_WALLS, flush with the canvas edge on all
  // courses); this only decides how the frame looks. The 10px wooden stroke centered
  // on the 5px line spans exactly 0..10 — visual band ≡ physics band, no apron.
  function drawBoundary(ctx) {
    for (const w of BOUNDARY_WALLS) drawWallSegment(ctx, w);
  }

  function drawWindmill(ctx, wm) {
    const blades = getWindmillBlades(wm);
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(wm.cx - 6, wm.cy, 12, 70);
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    for (const b of blades) {
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
    }
    ctx.fillStyle = '#444';
    ctx.beginPath();
    ctx.arc(wm.cx, wm.cy, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPendulum(ctx, p) {
    const seg = getPendulumSegment(p);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#9aa0a6';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#444';
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e6483f';
    ctx.beginPath();
    ctx.arc(seg.x2, seg.y2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawSlidingGate(ctx, g) {
    const seg = getSlidingGateSegment(g);
    const dx = g.axis === 'x' ? g.amplitude : 0, dy = g.axis === 'y' ? g.amplitude : 0;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(g.x1 - dx, g.y1 - dy);
    ctx.lineTo(g.x2 - dx, g.y2 - dy);
    ctx.moveTo(g.x1 + dx, g.y1 + dy);
    ctx.lineTo(g.x2 + dx, g.y2 + dy);
    ctx.stroke();
    ctx.strokeStyle = '#c9a24b';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Accretion disk painted BEFORE the lens pass so the warp bends it like the
   * starfield — hot doppler-offset glow with slowly orbiting filament arcs.
   * The crisp shadow + photon ring go on top afterwards (drawBlackHoleOverlay).
   */
  function drawBlackHoleAccretion(ctx, body, timeSec) {
    const t = timeSec != null ? timeSec : nowSec();
    const rs = BH_LENS.rsLogical;
    const diskR = rs * 4.8;
    // Ambient glow, center offset a touch so one side runs hotter (doppler beaming).
    const ox = body.x - rs * 0.45;
    const oy = body.y + rs * 0.25;
    const glow = ctx.createRadialGradient(ox, oy, rs * 0.7, ox, oy, diskR);
    glow.addColorStop(0, 'rgba(255,214,140,0.95)');
    glow.addColorStop(0.3, 'rgba(255,140,40,0.6)');
    glow.addColorStop(0.65, 'rgba(200,70,15,0.25)');
    glow.addColorStop(1, 'rgba(120,30,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(body.x, body.y, diskR, 0, Math.PI * 2);
    ctx.fill();
    // Orbiting filaments: uneven arcs of superheated matter, inner ones faster.
    const FILS = [
      { r: rs * 1.8, w: 1.9, span: 2.4, speed: 0.9, a: 'rgba(255,240,215,0.85)' },
      { r: rs * 2.6, w: 1.5, span: 1.7, speed: 0.55, a: 'rgba(255,190,120,0.6)' },
      { r: rs * 3.5, w: 1.2, span: 2.9, speed: 0.33, a: 'rgba(255,140,70,0.4)' },
    ];
    ctx.lineCap = 'round';
    for (let i = 0; i < FILS.length; i++) {
      const f = FILS[i];
      const a0 = t * f.speed + i * 2.1;
      ctx.strokeStyle = f.a;
      ctx.lineWidth = f.w;
      ctx.beginPath();
      ctx.arc(body.x, body.y, f.r, a0, a0 + f.span);
      ctx.stroke();
    }
  }

  function drawGravityBody(ctx, body, timeSec) {
    // Black holes: paint the accretion disk now (so the lens warps it); the
    // shadow + photon ring are overlaid after the warp.
    if (body.kind === 'blackHole') {
      drawBlackHoleAccretion(ctx, body, timeSec);
      return;
    }
    const r = body.radius;
    const bodyGrad = ctx.createRadialGradient(body.x - r * 0.3, body.y - r * 0.3, r * 0.2, body.x, body.y, r);
    if (body.kind === 'moon') {
      bodyGrad.addColorStop(0, '#d8dce8');
      bodyGrad.addColorStop(1, '#6a7388');
    } else {
      bodyGrad.addColorStop(0, '#7ec8ff');
      bodyGrad.addColorStop(0.55, '#2a6db0');
      bodyGrad.addColorStop(1, '#0d2a4a');
    }
    // Halo at true gravity cutoff (fieldRadius), not a capped decorative multiple of r.
    const fieldR = body.fieldRadius != null ? body.fieldRadius : r * 6;
    if (fieldR > 0) {
      ctx.strokeStyle = 'rgba(120,180,255,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(body.x, body.y, fieldR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.arc(body.x, body.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function sampleBilinearRGBA(data, w, h, x, y) {
    x = Math.max(0, Math.min(w - 1.001, x));
    y = Math.max(0, Math.min(h - 1.001, y));
    const x0 = x | 0;
    const y0 = y | 0;
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    const fx = x - x0;
    const fy = y - y0;
    const i00 = (y0 * w + x0) * 4;
    const i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4;
    const i11 = (y1 * w + x1) * 4;
    const ifx = 1 - fx;
    const ify = 1 - fy;
    return [
      data[i00] * ifx * ify + data[i10] * fx * ify + data[i01] * ifx * fy + data[i11] * fx * fy,
      data[i00 + 1] * ifx * ify + data[i10 + 1] * fx * ify + data[i01 + 1] * ifx * fy + data[i11 + 1] * fx * fy,
      data[i00 + 2] * ifx * ify + data[i10 + 2] * fx * ify + data[i01 + 2] * ifx * fy + data[i11 + 2] * fx * fy,
      data[i00 + 3] * ifx * ify + data[i10 + 3] * fx * ify + data[i01 + 3] * ifx * fy + data[i11 + 3] * fx * fy,
    ];
  }

  /**
   * Approach B: screen-space gravitational lens.
   * getImageData is in device pixels; scale by buffer/logical ratio (or opts.dpr).
   */
  function warpBlackHoleLens(ctx, body, opts) {
    opts = opts || {};
    const canvas = opts.canvas || ctx.canvas;
    if (!canvas) return;
    let dpr = opts.dpr;
    if (dpr == null) {
      dpr = canvas.width / LOGICAL_W || 1;
    }
    const cx = body.x * dpr;
    const cy = body.y * dpr;
    const rs = BH_LENS.rsLogical * dpr;
    const rOut = BH_LENS.rOutLogical * dpr;
    const lensK = BH_LENS.lensK;
    const fallPow = BH_LENS.fallPow;
    const denMin = BH_LENS.denMin;
    const mix = BH_LENS.mix;

    const pad = Math.ceil(rOut) + 2;
    const x0 = Math.max(0, Math.floor(cx - pad));
    const y0 = Math.max(0, Math.floor(cy - pad));
    const x1 = Math.min(canvas.width, Math.ceil(cx + pad));
    const y1 = Math.min(canvas.height, Math.ceil(cy + pad));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 4 || h < 4) return;

    let src;
    try {
      src = ctx.getImageData(x0, y0, w, h);
    } catch (err) {
      return;
    }
    const dst = ctx.createImageData(w, h);
    const s = src.data;
    const d = dst.data;

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const di = (j * w + i) * 4;
        const px = x0 + i + 0.5;
        const py = y0 + j + 0.5;
        const dx = px - cx;
        const dy = py - cy;
        const r = Math.hypot(dx, dy);

        if (r < rs) {
          d[di] = 0;
          d[di + 1] = 0;
          d[di + 2] = 0;
          d[di + 3] = 255;
          continue;
        }
        if (r >= rOut || r < 1e-4) {
          d[di] = s[di];
          d[di + 1] = s[di + 1];
          d[di + 2] = s[di + 2];
          d[di + 3] = s[di + 3];
          continue;
        }

        const fall = 1 - (r - rs) / (rOut - rs);
        const schwarz = r / Math.max(denMin, 1 - (lensK * rs) / r);
        let rSrc = r + (schwarz - r) * mix * Math.pow(Math.max(0, fall), fallPow);
        rSrc = Math.min(Math.max(rSrc, r), rOut * 0.998);

        const scale = rSrc / r;
        const sx = cx + dx * scale - x0;
        const sy = cy + dy * scale - y0;
        const rgba = sampleBilinearRGBA(s, w, h, sx, sy);
        d[di] = rgba[0];
        d[di + 1] = rgba[1];
        d[di + 2] = rgba[2];
        d[di + 3] = rgba[3];
      }
    }
    ctx.putImageData(dst, x0, y0);
  }

  function drawBlackHoleOverlay(ctx, body) {
    const rs = BH_LENS.rsLogical;
    // Event-horizon shadow: dead black, swallowing the warped glow behind it.
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(body.x, body.y, rs * 1.18, 0, Math.PI * 2);
    ctx.fill();
    // Photon ring hugging the shadow — white-hot, with a faint warm bloom.
    ctx.save();
    ctx.shadowColor = 'rgba(255,190,110,0.9)';
    ctx.shadowBlur = 6;
    ctx.strokeStyle = 'rgba(255,244,224,0.95)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(body.x, body.y, rs * 1.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // Faint secondary lensed image of the ring.
    ctx.strokeStyle = 'rgba(255,200,150,0.3)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(body.x, body.y, rs * 1.8, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawHoleAndFlag(ctx, hole, flagPhase, space) {
    const phase = flagPhase != null ? flagPhase : 0;
    const { x, y } = hole.cup;
    const grad = ctx.createRadialGradient(x, y, 2, x, y, hole.cup.radius + 6);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, hole.cup.radius + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(x, y, hole.cup.radius, 0, Math.PI * 2);
    ctx.fill();
    if (space) {
      // A dark cup vanishes on a black sky — ring the outside edge so it always reads.
      // Soft white drop shadow under the ring keeps it from getting lost in the debris field.
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,0.75)';
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, hole.cup.radius + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const stickTop = y - 46;
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, stickTop);
    ctx.stroke();
    const flutter = Math.sin(phase * 3) * 3;
    ctx.fillStyle = '#e6483f';
    ctx.beginPath();
    ctx.moveTo(x, stickTop);
    ctx.lineTo(x + 18 + flutter, stickTop + 6);
    ctx.lineTo(x, stickTop + 12);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Full static hole layer in game drawWorld order (no balls/aim/particles).
   * opts: { time, flagPhase, skipBalls, dpr, canvas }
   */
  function drawHoleStatic(ctx, hole, opts) {
    opts = opts || {};
    const t = nowSec(opts);
    const flagPhase = opts.flagPhase != null ? opts.flagPhase : 0;

    // Gravity holes play in space: black canvas + starfield instead of fairway grass,
    // moon-dust sand, satellite walls, and outlined cup so everything reads on black.
    const space = (hole.gravityBodies || []).length > 0;
    if (space) drawSpace(ctx, hole, t);
    else drawGrass(ctx);
    for (const z of hole.sand || []) drawSandZone(ctx, z, space);
    for (const z of hole.water || []) drawWaterZone(ctx, z, t);
    for (const z of hole.sticky || []) drawStickyZone(ctx, z, t);
    for (const z of hole.boost || []) drawBoostZone(ctx, z, t);
    for (const z of hole.ramps || []) drawRampZone(ctx, z);
    // Planets/moons first (solid bodies sit under lens warp if a BH is nearby).
    for (const b of hole.gravityBodies || []) drawGravityBody(ctx, b, t);
    drawBoundary(ctx);
    for (const w of hole.walls || []) drawWallSegment(ctx, w, space);
    for (const wm of hole.windmills || []) drawWindmill(ctx, wm);
    for (const p of hole.pendulums || []) drawPendulum(ctx, p);
    for (const g of hole.gates || []) drawSlidingGate(ctx, g);
    drawHoleAndFlag(ctx, hole, flagPhase, space);

    // Black holes: warp fairway/walls, then disk. Balls stay unwarped on top.
    const blackHoles = (hole.gravityBodies || []).filter((b) => b.kind === 'blackHole');
    for (const b of blackHoles) warpBlackHoleLens(ctx, b, opts);
    for (const b of blackHoles) drawBlackHoleOverlay(ctx, b);
  }

  const Draw = {
    WALL_DRAW_WIDTH,
    BH_LENS,
    roundRectPath,
    drawGrass,
    drawSpace,
    drawSandZone,
    drawWaterZone,
    drawStickyZone,
    drawBoostZone,
    drawRampZone,
    drawWallSegment,
    drawBoundary,
    drawWindmill,
    drawPendulum,
    drawSlidingGate,
    drawGravityBody,
    drawBlackHoleOverlay,
    drawTracerTrail,
    updateTracerTrail,
    nearBlackHole,
    warpBlackHoleLens,
    drawHoleAndFlag,
    drawHoleStatic,
  };

  root.Draw = Draw;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Draw;
  }
})(typeof window !== 'undefined' ? window : globalThis);
