// Pocket Putt — pure editor snap helpers (grid + vertices + midpoints + Shift-ortho).
// Browser: window.EditorSnap · Node: module.exports. No DOM dependency.
(function (root) {
  'use strict';

  const DEFAULT_RADIUS = 12;
  const DEFAULT_GRID = 5;

  function mid(x1, y1, x2, y2) {
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }

  function pushPt(out, x, y, kind) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    out.push({ x, y, kind: kind || 'vertex' });
  }

  function pushSegEndsAndMid(out, x1, y1, x2, y2) {
    pushPt(out, x1, y1, 'vertex');
    pushPt(out, x2, y2, 'vertex');
    pushPt(out, (x1 + x2) / 2, (y1 + y2) / 2, 'midpoint');
  }

  function pushRectCornersAndMids(out, x1, y1, x2, y2) {
    const ax = Math.min(x1, x2), bx = Math.max(x1, x2);
    const ay = Math.min(y1, y2), by = Math.max(y1, y2);
    pushPt(out, ax, ay, 'vertex');
    pushPt(out, bx, ay, 'vertex');
    pushPt(out, bx, by, 'vertex');
    pushPt(out, ax, by, 'vertex');
    // Edge midpoints
    pushPt(out, (ax + bx) / 2, ay, 'midpoint');
    pushPt(out, (ax + bx) / 2, by, 'midpoint');
    pushPt(out, ax, (ay + by) / 2, 'midpoint');
    pushPt(out, bx, (ay + by) / 2, 'midpoint');
  }

  function shouldSkip(skip, kind, index) {
    if (!skip) return false;
    if (skip.kind !== kind) return false;
    if (index == null) return true; // tee/cup
    return skip.index === index;
  }

  /**
   * Collect snap targets from a hole document.
   * opts.skip: { kind, index? } — omit the object being dragged so self-snap doesn't pin it.
   * @returns {{x:number,y:number,kind:string}[]}
   */
  function collectSnapPoints(hole, opts) {
    const out = [];
    if (!hole || typeof hole !== 'object') return out;
    const skip = opts && opts.skip;

    if (hole.tee && !shouldSkip(skip, 'tee')) pushPt(out, hole.tee.x, hole.tee.y, 'tee');
    if (hole.cup && !shouldSkip(skip, 'cup')) pushPt(out, hole.cup.x, hole.cup.y, 'cup');

    (hole.walls || []).forEach((w, i) => {
      if (shouldSkip(skip, 'walls', i)) return;
      pushSegEndsAndMid(out, w.x1, w.y1, w.x2, w.y2);
    });
    (hole.gates || []).forEach((g, i) => {
      if (shouldSkip(skip, 'gates', i)) return;
      pushSegEndsAndMid(out, g.x1, g.y1, g.x2, g.y2);
    });

    const rectKinds = [
      ['sand', hole.sand],
      ['water', hole.water],
      ['boost', hole.boost],
      ['sticky', hole.sticky],
    ];
    for (const [kind, list] of rectKinds) {
      (list || []).forEach((z, i) => {
        if (shouldSkip(skip, kind, i)) return;
        if (z && z.x1 != null) pushRectCornersAndMids(out, z.x1, z.y1, z.x2, z.y2);
      });
    }
    // Ramps: snap to oriented corners (pad rotates with launch angle)
    const Shared = root.Shared;
    (hole.ramps || []).forEach((z, i) => {
      if (shouldSkip(skip, 'ramps', i)) return;
      if (!z || z.x1 == null) return;
      if (Shared && typeof Shared.orientedRectCorners === 'function') {
        const cs = Shared.orientedRectCorners(z);
        for (let c = 0; c < cs.length; c++) pushPt(out, cs[c].x, cs[c].y, 'vertex');
        // edge mids
        for (let c = 0; c < cs.length; c++) {
          const n = cs[(c + 1) % cs.length];
          pushPt(out, (cs[c].x + n.x) / 2, (cs[c].y + n.y) / 2, 'midpoint');
        }
      } else {
        pushRectCornersAndMids(out, z.x1, z.y1, z.x2, z.y2);
      }
    });

    (hole.pendulums || []).forEach((p, i) => {
      if (shouldSkip(skip, 'pendulums', i)) return;
      pushPt(out, p.cx, p.cy, 'pivot');
    });
    (hole.windmills || []).forEach((m, i) => {
      if (shouldSkip(skip, 'windmills', i)) return;
      pushPt(out, m.cx, m.cy, 'hub');
    });
    (hole.gravityBodies || []).forEach((b, i) => {
      if (shouldSkip(skip, 'gravityBodies', i)) return;
      if (b.kind === 'moon' && b.orbitCenter) {
        pushPt(out, b.orbitCenter.x, b.orbitCenter.y, 'orbit');
        // Body center (current pose) is also useful
        pushPt(out, b.x, b.y, 'body');
      } else {
        pushPt(out, b.x, b.y, 'body');
      }
    });

    return out;
  }

  /**
   * Project (x,y) onto the horizontal or vertical line through origin (whichever is closer).
   * @returns {{x:number,y:number,axis:'h'|'v'}}
   */
  function projectOrtho(x, y, origin) {
    const ox = origin.x, oy = origin.y;
    const dx = Math.abs(x - ox);
    const dy = Math.abs(y - oy);
    // Prefer horizontal (lock y) when |dy| for free cursor is smaller relative to distance
    // i.e. if movement is more horizontal, lock to H; more vertical → lock to V.
    if (dx >= dy) {
      return { x, y: oy, axis: 'h' };
    }
    return { x: ox, y, axis: 'v' };
  }

  function snapToGrid(x, y, gridSize) {
    const g = gridSize > 0 ? gridSize : DEFAULT_GRID;
    return {
      x: Math.round(x / g) * g,
      y: Math.round(y / g) * g,
    };
  }

  /**
   * Nearest geometry snap within radius (optional axis filter for ortho).
   * @param {number} x
   * @param {number} y
   * @param {object} hole
   * @param {number} [radius]
   * @param {{axis?:'h'|'v', orthoFrom?:{x,y}, points?:array}} [filter]
   */
  function snapToGeometry(x, y, hole, radius, filter) {
    radius = radius == null ? DEFAULT_RADIUS : radius;
    filter = filter || {};
    const pts = filter.points || collectSnapPoints(hole, filter.skip ? { skip: filter.skip } : undefined);
    let best = null;
    let bestD = radius;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      let tx = p.x;
      let ty = p.y;

      if (filter.axis && filter.orthoFrom) {
        // Only snap along the ortho line: accept targets near the locked axis.
        if (filter.axis === 'h') {
          if (Math.abs(p.y - filter.orthoFrom.y) > 0.5) continue;
          ty = filter.orthoFrom.y;
        } else {
          if (Math.abs(p.x - filter.orthoFrom.x) > 0.5) continue;
          tx = filter.orthoFrom.x;
        }
      }

      const d = Math.hypot(tx - x, ty - y);
      if (d <= bestD) {
        bestD = d;
        best = { x: tx, y: ty, kind: p.kind, dist: d };
      }
    }

    if (!best) {
      return { x, y, snapped: false };
    }
    return {
      x: best.x,
      y: best.y,
      snapped: true,
      target: { x: best.x, y: best.y },
      kind: best.kind,
      dist: best.dist,
    };
  }

  /**
   * Full snap pipeline.
   * opts: { grid, gridSize, radius, orthoFrom, shift, skip }
   * If shift && orthoFrom: project H/V, then geometry along that line, else grid.
   * Geometry wins over grid when both in range.
   * skip: { kind, index? } excludes an object (editor selection) from geometry targets.
   */
  function snapPoint(x, y, hole, opts) {
    opts = opts || {};
    const radius = opts.radius == null ? DEFAULT_RADIUS : opts.radius;
    const gridSize = opts.gridSize == null ? DEFAULT_GRID : opts.gridSize;
    let px = x;
    let py = y;
    let axis = null;
    let orthoFrom = null;

    if (opts.shift && opts.orthoFrom) {
      const o = projectOrtho(x, y, opts.orthoFrom);
      px = o.x;
      py = o.y;
      axis = o.axis;
      orthoFrom = opts.orthoFrom;
    }

    const geoFilter = {};
    if (axis) {
      geoFilter.axis = axis;
      geoFilter.orthoFrom = orthoFrom;
    }
    if (opts.skip) geoFilter.skip = opts.skip;

    const geo = snapToGeometry(px, py, hole, radius, geoFilter);
    if (geo.snapped) {
      return {
        x: geo.x,
        y: geo.y,
        snapped: true,
        target: geo.target,
        kind: geo.kind,
        source: 'geometry',
      };
    }

    if (opts.grid) {
      const g = snapToGrid(px, py, gridSize);
      return {
        x: g.x,
        y: g.y,
        snapped: true,
        target: { x: g.x, y: g.y },
        source: 'grid',
      };
    }

    return {
      x: px,
      y: py,
      snapped: false,
      source: axis ? 'ortho' : null,
    };
  }

  const EditorSnap = {
    DEFAULT_RADIUS,
    DEFAULT_GRID,
    collectSnapPoints,
    projectOrtho,
    snapToGrid,
    snapToGeometry,
    snapPoint,
    mid,
  };

  root.EditorSnap = EditorSnap;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EditorSnap;
  }
})(typeof window !== 'undefined' ? window : globalThis);
