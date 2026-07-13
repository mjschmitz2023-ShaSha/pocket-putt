// Pocket Putt — shared canvas drawing for game + level editor (plain script, file:// ok).
// Depends on shared.js (window.Shared) loaded first. Exposes window.Draw.
(function (root) {
  'use strict';

  const S = root.Shared || {};
  const LOGICAL_W = S.LOGICAL_W || 800;
  const LOGICAL_H = S.LOGICAL_H || 500;
  const BOUNDARY_WALLS = S.BOUNDARY_WALLS || [];
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

  const BOOST_COLOR_A = '#8b2fd1';
  const BOOST_COLOR_B = '#2fd1c8';
  /** Match game wall stroke thickness (physics contact is separate). */
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

  function drawSandZone(ctx, z) {
    ctx.fillStyle = '#dcc27a';
    drawZonePath(ctx, z);
    ctx.fill();
    if (!z._speckles) {
      z._speckles = [];
      const b = zoneBounds(z);
      for (let i = 0; i < 40; i++) {
        z._speckles.push({
          x: b.x1 + Math.random() * (b.x2 - b.x1),
          y: b.y1 + Math.random() * (b.y2 - b.y1),
          r: 1 + Math.random() * 1.5,
        });
      }
    }
    ctx.fillStyle = 'rgba(150,120,60,0.28)';
    for (const d of z._speckles) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawWaterZone(ctx, z, timeSec) {
    ctx.fillStyle = '#3b82c4';
    drawZonePath(ctx, z);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    const b = zoneBounds(z);
    const t = timeSec != null ? timeSec : nowSec();
    for (let i = 0; i < 3; i++) {
      const yOff = b.y1 + ((b.y2 - b.y1) * (i + 1)) / 4 + Math.sin(t * 1.5 + i) * 4;
      ctx.beginPath();
      ctx.moveTo(b.x1 + 6, yOff);
      ctx.lineTo(b.x2 - 6, yOff);
      ctx.stroke();
    }
  }

  function drawStickyZone(ctx, z, timeSec) {
    ctx.fillStyle = '#d99a1f';
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
    const sheenY = b.y1 + ((t * 12) % Math.max(1, b.y2 - b.y1));
    ctx.strokeStyle = 'rgba(255,230,160,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x1 + 6, sheenY);
    ctx.lineTo(b.x2 - 6, sheenY);
    ctx.stroke();
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

  function drawWallSegment(ctx, wall) {
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

  function drawGravityBody(ctx, body) {
    // Black holes are warped + overlaid later (need fairway pixels first).
    if (body.kind === 'blackHole') return;
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
    const diskR = BH_LENS.diskDraw;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.arc(body.x, body.y, diskR, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawHoleAndFlag(ctx, hole, flagPhase) {
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

    drawGrass(ctx);
    for (const z of hole.sand || []) drawSandZone(ctx, z);
    for (const z of hole.water || []) drawWaterZone(ctx, z, t);
    for (const z of hole.sticky || []) drawStickyZone(ctx, z, t);
    for (const z of hole.boost || []) drawBoostZone(ctx, z, t);
    for (const z of hole.ramps || []) drawRampZone(ctx, z);
    // Planets/moons first (solid bodies sit under lens warp if a BH is nearby).
    for (const b of hole.gravityBodies || []) drawGravityBody(ctx, b);
    drawBoundary(ctx);
    for (const w of hole.walls || []) drawWallSegment(ctx, w);
    for (const wm of hole.windmills || []) drawWindmill(ctx, wm);
    for (const p of hole.pendulums || []) drawPendulum(ctx, p);
    for (const g of hole.gates || []) drawSlidingGate(ctx, g);
    drawHoleAndFlag(ctx, hole, flagPhase);

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
    warpBlackHoleLens,
    drawHoleAndFlag,
    drawHoleStatic,
  };

  root.Draw = Draw;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Draw;
  }
})(typeof window !== 'undefined' ? window : globalThis);
