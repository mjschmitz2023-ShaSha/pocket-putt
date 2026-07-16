// Pocket Putt — pure editor gizmo helpers (handles, hit-test, apply).
// Browser: window.EditorGizmos · Node: module.exports. No DOM dependency.
(function (root) {
  'use strict';

  const HANDLE_HIT_R = 10;
  const RING_HIT_TOL = 8;
  const MIN_RECT = 8;
  const MIN_LENGTH = 12;
  const MIN_RADIUS = 4;
  const MIN_FIELD = 12;
  const MIN_ORBIT = 10;
  const MIN_AMP = 0;
  const ARROW_LEN = 48;
  const ARROW_TIP_R = 12;

  function dist(ax, ay, bx, by) {
    return Math.hypot(ax - bx, ay - by);
  }

  function normalizeRect(x1, y1, x2, y2) {
    return {
      x1: Math.min(x1, x2),
      y1: Math.min(y1, y2),
      x2: Math.max(x1, x2),
      y2: Math.max(y1, y2),
    };
  }

  function rectCenter(z) {
    return { x: (z.x1 + z.x2) / 2, y: (z.y1 + z.y2) / 2 };
  }

  /** Corner handles for a rect zone: nw, ne, se, sw (axis-aligned). */
  function rectCornerHandles(z) {
    const r = normalizeRect(z.x1, z.y1, z.x2, z.y2);
    return [
      { id: 'nw', kind: 'corner', x: r.x1, y: r.y1 },
      { id: 'ne', kind: 'corner', x: r.x2, y: r.y1 },
      { id: 'se', kind: 'corner', x: r.x2, y: r.y2 },
      { id: 'sw', kind: 'corner', x: r.x1, y: r.y2 },
    ];
  }

  /**
   * Ramp corners in world space (local w×h box rotated by z.angle about center).
   * Uses Shared.orientedRectCorners when available.
   */
  function rampCornerHandles(z) {
    const S = (typeof root !== 'undefined' && root.Shared) || (typeof window !== 'undefined' && window.Shared);
    if (S && typeof S.orientedRectCorners === 'function') {
      return S.orientedRectCorners(z).map((c) => ({ id: c.id, kind: 'corner', x: c.x, y: c.y }));
    }
    return rectCornerHandles(z);
  }

  /**
   * Resize rect by dragging one corner; opposite corner stays fixed.
   * @returns {{x1,y1,x2,y2}}
   */
  function resizeRectFromCorner(start, cornerId, px, py, minSize) {
    minSize = minSize == null ? MIN_RECT : minSize;
    const r = normalizeRect(start.x1, start.y1, start.x2, start.y2);
    let x1 = r.x1, y1 = r.y1, x2 = r.x2, y2 = r.y2;
    if (cornerId === 'nw') {
      x1 = Math.min(px, r.x2 - minSize);
      y1 = Math.min(py, r.y2 - minSize);
    } else if (cornerId === 'ne') {
      x2 = Math.max(px, r.x1 + minSize);
      y1 = Math.min(py, r.y2 - minSize);
    } else if (cornerId === 'se') {
      x2 = Math.max(px, r.x1 + minSize);
      y2 = Math.max(py, r.y1 + minSize);
    } else if (cornerId === 'sw') {
      x1 = Math.min(px, r.x2 - minSize);
      y2 = Math.max(py, r.y1 + minSize);
    }
    return normalizeRect(x1, y1, x2, y2);
  }

  /**
   * Resize a ramp: x1..y2 store local w×h about center; pad is rotated by angle.
   * Corner drag keeps the opposite oriented corner fixed in world space.
   */
  function resizeRampFromCorner(start, cornerId, px, py, minSize) {
    minSize = minSize == null ? MIN_RECT : minSize;
    const cx = (start.x1 + start.x2) / 2, cy = (start.y1 + start.y2) / 2;
    const oldHw = Math.abs(start.x2 - start.x1) / 2;
    const oldHh = Math.abs(start.y2 - start.y1) / 2;
    const a = start.angle || 0;
    const ca = Math.cos(a), sa = Math.sin(a);
    // Local signs for each corner id (local +x = launch)
    const signs = { nw: [-1, -1], ne: [1, -1], se: [1, 1], sw: [-1, 1] };
    const sg = signs[cornerId] || [1, 1];
    const fixedLx = -sg[0] * oldHw, fixedLy = -sg[1] * oldHh;
    const fixedWx = cx + fixedLx * ca - fixedLy * sa;
    const fixedWy = cy + fixedLx * sa + fixedLy * ca;
    // New center = midpoint of fixed corner and drag point
    const ncx = (fixedWx + px) / 2, ncy = (fixedWy + py) / 2;
    // Both corners in local frame about new center
    function toLocal(wx, wy) {
      const dx = wx - ncx, dy = wy - ncy;
      return { lx: ca * dx + sa * dy, ly: -sa * dx + ca * dy };
    }
    const f = toLocal(fixedWx, fixedWy);
    const d = toLocal(px, py);
    let lx1 = Math.min(f.lx, d.lx), lx2 = Math.max(f.lx, d.lx);
    let ly1 = Math.min(f.ly, d.ly), ly2 = Math.max(f.ly, d.ly);
    if (lx2 - lx1 < minSize) {
      const mid = (lx1 + lx2) / 2;
      lx1 = mid - minSize / 2;
      lx2 = mid + minSize / 2;
    }
    if (ly2 - ly1 < minSize) {
      const mid = (ly1 + ly2) / 2;
      ly1 = mid - minSize / 2;
      ly2 = mid + minSize / 2;
    }
    const lcx = (lx1 + lx2) / 2, lcy = (ly1 + ly2) / 2;
    const nhw = (lx2 - lx1) / 2, nhh = (ly2 - ly1) / 2;
    // Shift world center by local mid offset (should be ~0 if fixed+drag symmetric)
    const wcx = ncx + lcx * ca - lcy * sa;
    const wcy = ncy + lcx * sa + lcy * ca;
    return {
      x1: wcx - nhw,
      y1: wcy - nhh,
      x2: wcx + nhw,
      y2: wcy + nhh,
    };
  }

  function wallEndpointHandles(w) {
    return [
      { id: 'p1', kind: 'endpoint', x: w.x1, y: w.y1 },
      { id: 'p2', kind: 'endpoint', x: w.x2, y: w.y2 },
    ];
  }

  /** Angle of vector from (cx,cy) to (px,py) in radians. */
  function angleFromPoint(cx, cy, px, py) {
    return Math.atan2(py - cy, px - cx);
  }

  /** Tip of a direction arrow of given length. */
  function angleArrowTip(cx, cy, angle, length) {
    length = length == null ? ARROW_LEN : length;
    return {
      x: cx + Math.cos(angle) * length,
      y: cy + Math.sin(angle) * length,
    };
  }

  function directionHandles(z, angle, arrowLen) {
    const c = rectCenter(z);
    const tip = angleArrowTip(c.x, c.y, angle, arrowLen);
    return [
      { id: 'angle', kind: 'angle', x: tip.x, y: tip.y, cx: c.x, cy: c.y, angle: angle || 0 },
    ];
  }

  function lengthFromPivot(cx, cy, px, py, minLen) {
    minLen = minLen == null ? MIN_LENGTH : minLen;
    return Math.max(minLen, dist(cx, cy, px, py));
  }

  /**
   * Pendulum handles: length tip along live (or design) angle, amplitude tip at extreme.
   * @param {object} p pendulum
   * @param {{x1,y1,x2,y2}|null} liveSeg from getPendulumSegment when available
   */
  function pendulumHandles(p, liveSeg) {
    const handles = [];
    let tipX, tipY, ang;
    if (liveSeg) {
      tipX = liveSeg.x2;
      tipY = liveSeg.y2;
      ang = Math.atan2(tipY - p.cy, tipX - p.cx);
    } else {
      ang = p.angleCenter || 0;
      tipX = p.cx + Math.cos(ang) * p.length;
      tipY = p.cy + Math.sin(ang) * p.length;
    }
    handles.push({ id: 'length', kind: 'length', x: tipX, y: tipY, cx: p.cx, cy: p.cy });

    // Amplitude: handle at angleCenter + amplitude (design extreme), same length
    const ampAng = (p.angleCenter || 0) + (p.amplitude || 0);
    handles.push({
      id: 'amplitude',
      kind: 'amplitude',
      x: p.cx + Math.cos(ampAng) * p.length,
      y: p.cy + Math.sin(ampAng) * p.length,
      cx: p.cx,
      cy: p.cy,
      angleCenter: p.angleCenter || 0,
    });
    return handles;
  }

  /**
   * Amplitude from drag: absolute angular offset from angleCenter, clamped [0, π].
   */
  function pendulumAmplitudeFromDrag(angleCenter, px, py, cx, cy) {
    const a = angleFromPoint(cx, cy, px, py);
    let d = a - angleCenter;
    // Normalize to [-π, π]
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.min(Math.PI, Math.max(MIN_AMP, Math.abs(d)));
  }

  /**
   * Gate amplitude handle: midpoint of rest segment offset by +amplitude along axis.
   * Uses rest coords (x1,y1,x2,y2), not the live sliding pose.
   */
  function gateAmplitudeHandle(g) {
    const mx = (g.x1 + g.x2) / 2;
    const my = (g.y1 + g.y2) / 2;
    const amp = g.amplitude || 0;
    if (g.axis === 'y') {
      return { id: 'amplitude', kind: 'amplitude', x: mx, y: my + amp, cx: mx, cy: my, axis: 'y' };
    }
    return { id: 'amplitude', kind: 'amplitude', x: mx + amp, y: my, cx: mx, cy: my, axis: 'x' };
  }

  /** Amplitude = signed projection of drag from rest midpoint along axis (abs, min 0). */
  function gateAmplitudeFromDrag(g, px, py) {
    const mx = (g.x1 + g.x2) / 2;
    const my = (g.y1 + g.y2) / 2;
    if (g.axis === 'y') {
      return Math.max(MIN_AMP, Math.abs(py - my));
    }
    return Math.max(MIN_AMP, Math.abs(px - mx));
  }

  function windmillArmHandle(m) {
    const ang = m.angle || 0;
    const L = m.armLength || 40;
    return {
      id: 'arm',
      kind: 'arm',
      x: m.cx + Math.cos(ang) * L,
      y: m.cy + Math.sin(ang) * L,
      cx: m.cx,
      cy: m.cy,
    };
  }

  function radiusFromCenter(cx, cy, px, py, minR) {
    minR = minR == null ? MIN_RADIUS : minR;
    return Math.max(minR, dist(cx, cy, px, py));
  }

  /**
   * Hit-test a circular ring (not filled disk): |dist - radius| <= tol.
   */
  function hitRadiusRing(cx, cy, radius, px, py, tol) {
    tol = tol == null ? RING_HIT_TOL : tol;
    if (!(radius > 0)) return false;
    return Math.abs(dist(cx, cy, px, py) - radius) <= tol;
  }

  function hitPointHandle(hx, hy, px, py, r) {
    r = r == null ? HANDLE_HIT_R : r;
    return dist(hx, hy, px, py) <= r;
  }

  /**
   * Build handle list for a selection.
   * @param {{kind:string,index?:number}} selection
   * @param {object} hole
   * @param {object} [helpers] { getPendulumSegment, getSlidingGateSegment }
   * @returns {object[]}
   */
  function getHandles(selection, hole, helpers) {
    if (!selection || !hole) return [];
    helpers = helpers || {};
    const kind = selection.kind;
    const idx = selection.index;

    if (kind === 'walls' && hole.walls && hole.walls[idx]) {
      return wallEndpointHandles(hole.walls[idx]);
    }

    const rectKinds = { sand: 1, water: 1, boost: 1, ramps: 1, sticky: 1 };
    if (rectKinds[kind] && hole[kind] && hole[kind][idx]) {
      const z = hole[kind][idx];
      // Ramps: corners follow rotated pad; boosts stay axis-aligned.
      const hs = kind === 'ramps' ? rampCornerHandles(z) : rectCornerHandles(z);
      if (kind === 'water' && z.dropPoint) {
        hs.push({
          id: 'drop',
          kind: 'drop',
          x: z.dropPoint.x,
          y: z.dropPoint.y,
        });
      }
      if (kind === 'boost' || kind === 'ramps') {
        hs.push.apply(hs, directionHandles(z, z.angle || 0, ARROW_LEN));
      }
      return hs;
    }

    if (kind === 'pendulums' && hole.pendulums && hole.pendulums[idx]) {
      const p = hole.pendulums[idx];
      const seg = typeof helpers.getPendulumSegment === 'function'
        ? helpers.getPendulumSegment(p)
        : null;
      return pendulumHandles(p, seg);
    }

    if (kind === 'gates' && hole.gates && hole.gates[idx]) {
      const g = hole.gates[idx];
      // Endpoint-style move of rest segment ends + amplitude
      const ends = wallEndpointHandles(g);
      ends.push(gateAmplitudeHandle(g));
      return ends;
    }

    if (kind === 'windmills' && hole.windmills && hole.windmills[idx]) {
      return [windmillArmHandle(hole.windmills[idx])];
    }

    if (kind === 'portalPairs' && hole.portalPairs && hole.portalPairs[idx]) {
      const pair = hole.portalPairs[idx];
      const S = (typeof root !== 'undefined' && root.Shared) || (typeof window !== 'undefined' && window.Shared);
      const resolve = S && S.resolvePortalAperture;
      const hs = [];
      if (resolve) {
        for (const side of ['a', 'b']) {
          const ap = resolve(hole, pair[side], pair.width);
          if (!ap) continue;
          const end = pair[side];
          // wSign: which side of the midpoint the width handle sits on (± along tangent).
          // Dragging it through the position handle flips face and keeps it on the far side.
          const wSign = end && end.wSign === -1 ? -1 : 1;
          // Position (midpoint): slide along host
          hs.push({ id: 't_' + side, kind: 'portalT', side, x: ap.cx, y: ap.cy });
          // Width: existing single endpoint gizmo (no extra handles)
          const half = pair.width * 0.5;
          hs.push({
            id: 'w_' + side,
            kind: 'portalW',
            side,
            x: ap.cx + ap.tx * half * wSign,
            y: ap.cy + ap.ty * half * wSign,
          });
        }
      }
      return hs;
    }

    if (kind === 'gravityBodies' && hole.gravityBodies && hole.gravityBodies[idx]) {
      const b = hole.gravityBodies[idx];
      if (b.kind === 'moon' && b.orbitCenter) {
        const oc = b.orbitCenter;
        // Orbit radius ring represented as a drag handle on the circle (toward body)
        const ang = Math.atan2(b.y - oc.y, b.x - oc.x);
        const or = b.orbitRadius || 80;
        return [
          {
            id: 'orbitRadius',
            kind: 'orbitRadius',
            x: oc.x + Math.cos(ang) * or,
            y: oc.y + Math.sin(ang) * or,
            cx: oc.x,
            cy: oc.y,
            radius: or,
            ring: true,
          },
          {
            id: 'orbitPhase',
            kind: 'orbitPhase',
            x: b.x,
            y: b.y,
            cx: oc.x,
            cy: oc.y,
          },
        ];
      }
      // planet / blackHole: body radius + field radius rings (handles on right side of rings)
      const r = b.radius || 10;
      const fr = b.fieldRadius != null ? b.fieldRadius : r * 6;
      return [
        {
          id: 'radius',
          kind: 'radius',
          x: b.x + r,
          y: b.y,
          cx: b.x,
          cy: b.y,
          radius: r,
          ring: true,
        },
        {
          id: 'fieldRadius',
          kind: 'fieldRadius',
          x: b.x + fr,
          y: b.y,
          cx: b.x,
          cy: b.y,
          radius: fr,
          ring: true,
        },
      ];
    }

    return [];
  }

  /**
   * Hit-test handles; first match wins (handles listed outer→inner for rings via reverse).
   * For ring handles, also accepts clicks anywhere on the ring.
   * @returns {object|null} handle descriptor
   */
  function hitTestHandles(handles, px, py, opts) {
    opts = opts || {};
    const pointR = opts.hitR == null ? HANDLE_HIT_R : opts.hitR;
    const ringTol = opts.ringTol == null ? RING_HIT_TOL : opts.ringTol;
    if (!handles || !handles.length) return null;

    // Reverse so outer rings / later handles win over corners when stacked
    for (let i = handles.length - 1; i >= 0; i--) {
      const h = handles[i];
      if (h.ring && h.cx != null && h.radius != null) {
        if (hitRadiusRing(h.cx, h.cy, h.radius, px, py, ringTol)) return h;
      }
      // Angle tip gets a slightly larger hit target
      const r = h.kind === 'angle' ? Math.max(pointR, ARROW_TIP_R) : pointR;
      if (hitPointHandle(h.x, h.y, px, py, r)) return h;
    }
    return null;
  }

  /**
   * Apply a handle drag to a cloned start object → mutated fields on `obj`.
   * Returns a small tag of what changed for callers that need rebuild (walls).
   * @param {string} selKind selection.kind
   * @param {object} obj live object
   * @param {object} start snapshot at pointerdown
   * @param {object} handle handle descriptor from hit/getHandles
   * @param {number} px
   * @param {number} py
   * @param {object} [opts] { setMoonPoseAtTick, tick }
   */
  function applyHandleDrag(selKind, obj, start, handle, px, py, opts) {
    opts = opts || {};
    const id = handle.id;

    if (selKind === 'walls') {
      if (id === 'p1') {
        obj.x1 = px; obj.y1 = py;
        obj.x2 = start.x2; obj.y2 = start.y2;
      } else if (id === 'p2') {
        obj.x1 = start.x1; obj.y1 = start.y1;
        obj.x2 = px; obj.y2 = py;
      }
      return { rebuildWall: true };
    }

    if (selKind === 'sand' || selKind === 'water' || selKind === 'boost' ||
        selKind === 'ramps' || selKind === 'sticky') {
      if (id === 'drop' && selKind === 'water') {
        if (!obj.dropPoint) obj.dropPoint = { x: px, y: py };
        else { obj.dropPoint.x = px; obj.dropPoint.y = py; }
        return { drop: true };
      }
      if (id === 'angle' && (selKind === 'boost' || selKind === 'ramps')) {
        const c = rectCenter(start);
        obj.angle = angleFromPoint(c.x, c.y, px, py);
        // Keep stored x1..y2 as local size about center (center unchanged).
        return { angle: true };
      }
      if (id === 'nw' || id === 'ne' || id === 'se' || id === 'sw') {
        const nr = selKind === 'ramps'
          ? resizeRampFromCorner(start, id, px, py, MIN_RECT)
          : resizeRectFromCorner(start, id, px, py, MIN_RECT);
        obj.x1 = nr.x1; obj.y1 = nr.y1; obj.x2 = nr.x2; obj.y2 = nr.y2;
        return { resize: true };
      }
    }

    if (selKind === 'pendulums') {
      if (id === 'length') {
        obj.length = lengthFromPivot(start.cx, start.cy, px, py, MIN_LENGTH);
        return { length: true };
      }
      if (id === 'amplitude') {
        obj.amplitude = pendulumAmplitudeFromDrag(
          start.angleCenter || 0, px, py, start.cx, start.cy
        );
        return { amplitude: true };
      }
    }

    if (selKind === 'gates') {
      if (id === 'p1') {
        obj.x1 = px; obj.y1 = py;
        obj.x2 = start.x2; obj.y2 = start.y2;
        return { gateEnd: true };
      }
      if (id === 'p2') {
        obj.x1 = start.x1; obj.y1 = start.y1;
        obj.x2 = px; obj.y2 = py;
        return { gateEnd: true };
      }
      if (id === 'amplitude') {
        obj.amplitude = gateAmplitudeFromDrag(start, px, py);
        return { amplitude: true };
      }
    }

    if (selKind === 'windmills' && id === 'arm') {
      obj.armLength = lengthFromPivot(start.cx, start.cy, px, py, MIN_LENGTH);
      return { arm: true };
    }

    if (selKind === 'portalPairs') {
      const S = (typeof root !== 'undefined' && root.Shared) || (typeof window !== 'undefined' && window.Shared);
      const resolveHost = S && S.resolvePortalHostSegment;
      if (id === 't_a' || id === 't_b') {
        const side = id === 't_a' ? 'a' : 'b';
        const end = obj[side];
        if (end && resolveHost) {
          // Need hole context — pass via opts.hole
          const hole = opts.hole;
          if (hole) {
            const seg = resolveHost(hole, end.host, end.index);
            if (seg) {
              const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
              const lenSq = dx * dx + dy * dy;
              if (lenSq > 1e-6) {
                let t = ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq;
                t = Math.max(0, Math.min(1, t));
                end.t = t;
                return { portalT: true, side };
              }
            }
          }
        }
      }
      if (id === 'w_a' || id === 'w_b') {
        const side = id === 'w_a' ? 'a' : 'b';
        const end = obj[side];
        const hole = opts.hole;
        // start snapshot (restored every move frame) — face flip is relative to gesture start
        const startEnd = start && start[side] ? start[side] : null;
        if (end && hole && resolveHost) {
          const seg = resolveHost(hole, end.host, end.index);
          if (seg) {
            const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
            const len = Math.hypot(dx, dy);
            if (len > 1e-6) {
              const tx = dx / len, ty = dy / len;
              // Use live t from end (already restored from start each frame, then t may match start)
              const cx = seg.x1 + end.t * dx, cy = seg.y1 + end.t * dy;
              const along = (px - cx) * tx + (py - cy) * ty;
              const minW = (S && S.PORTAL_MIN_WIDTH) || 18;
              obj.width = Math.max(minW, Math.abs(along) * 2);

              // Width handle side of midpoint (± along wall). Crossing the position
              // gizmo (along sign vs gesture start) flips face; handle stays on that side.
              const CROSS_EPS = 2;
              const startWSign = startEnd && startEnd.wSign === -1 ? -1 : 1;
              const startFace = startEnd && startEnd.face === -1 ? -1 : 1;
              if (Math.abs(along) > CROSS_EPS) {
                const curSign = along > 0 ? 1 : -1;
                end.wSign = curSign;
                // Flipped iff width handle is on the opposite side of midpoint from where drag began
                end.face = (curSign !== startWSign) ? -startFace : startFace;
              } else {
                // Dead zone on the midpoint — keep start face/side
                end.wSign = startWSign;
                end.face = startFace;
              }
              return { portalW: true, side };
            }
          }
        }
      }
      return null;
    }

    if (selKind === 'gravityBodies') {
      if (obj.kind === 'moon') {
        const oc = start.orbitCenter || obj.orbitCenter;
        if (id === 'orbitRadius') {
          obj.orbitRadius = Math.max(MIN_ORBIT, dist(oc.x, oc.y, px, py));
          if (typeof opts.setMoonPoseAtTick === 'function') {
            opts.setMoonPoseAtTick(obj, opts.tick || 0);
          }
          return { orbitRadius: true };
        }
        if (id === 'orbitPhase') {
          obj.orbitPhase0 = angleFromPoint(oc.x, oc.y, px, py);
          if (typeof opts.setMoonPoseAtTick === 'function') {
            opts.setMoonPoseAtTick(obj, opts.tick || 0);
          }
          return { orbitPhase: true };
        }
      } else {
        if (id === 'radius') {
          let r = radiusFromCenter(start.x, start.y, px, py, MIN_RADIUS);
          const fr = obj.fieldRadius != null ? obj.fieldRadius : r * 6;
          if (r > fr - 4) r = Math.max(MIN_RADIUS, fr - 4);
          obj.radius = r;
          return { radius: true };
        }
        if (id === 'fieldRadius') {
          let fr = radiusFromCenter(start.x, start.y, px, py, MIN_FIELD);
          const r = obj.radius || MIN_RADIUS;
          if (fr < r + 4) fr = r + 4;
          obj.fieldRadius = fr;
          return { fieldRadius: true };
        }
      }
    }

    return null;
  }

  const EditorGizmos = {
    HANDLE_HIT_R,
    RING_HIT_TOL,
    MIN_RECT,
    MIN_LENGTH,
    ARROW_LEN,
    dist,
    normalizeRect,
    rectCenter,
    rectCornerHandles,
    rampCornerHandles,
    resizeRectFromCorner,
    resizeRampFromCorner,
    wallEndpointHandles,
    angleFromPoint,
    angleArrowTip,
    directionHandles,
    lengthFromPivot,
    pendulumHandles,
    pendulumAmplitudeFromDrag,
    gateAmplitudeHandle,
    gateAmplitudeFromDrag,
    windmillArmHandle,
    radiusFromCenter,
    hitRadiusRing,
    hitPointHandle,
    getHandles,
    hitTestHandles,
    applyHandleDrag,
  };

  root.EditorGizmos = EditorGizmos;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EditorGizmos;
  }
})(typeof window !== 'undefined' ? window : globalThis);
