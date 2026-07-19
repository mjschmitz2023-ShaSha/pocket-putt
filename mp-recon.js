// Multiplayer hard residual + path catch-up + free-run trail (client).
// Dual load: browser (window.MpRecon) and Node (module.exports).
// Residual bands come from Shared physics constants when available — not invented px/v.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./shared.js'));
  } else {
    root.MpRecon = factory(root.Shared);
  }
})(typeof self !== 'undefined' ? self : this, function (Shared) {
  'use strict';

  // Residual "already matches" band — physics scale, not display magic.
  const MATCH_PX =
    Shared && typeof Shared.BALL_RADIUS === 'number' ? Shared.BALL_RADIUS : 7;
  const MATCH_V =
    Shared && typeof Shared.STOP_THRESHOLD === 'number' ? Shared.STOP_THRESHOLD : 18;
  /** Host wire path sample budget (must match gameSession PATH_CATCHUP_SAMPLES). */
  const PATH_CATCHUP_N = 10;
  /** Cosmetic trail stamp spacing (same as free-run; stamps only real render poses). */
  const FREE_RUN_TRAIL_GAP = 4;
  const TRAIL_MAX_AGE_MS = 600;

  /**
   * Display frames for catch-up = host path sample count (wire keyframes).
   * No px→frame conversion — duration is exactly the data the host sent.
   */
  function catchupFrameCount(path) {
    if (!path || path.length < 1) return 1;
    return path.length;
  }

  function residualMatched(before, after, hitCap) {
    if (hitCap) return false;
    const dPos = Math.hypot(after.x - before.x, after.y - before.y);
    const dV = Math.hypot(
      (after.vx || 0) - (before.vx || 0),
      (after.vy || 0) - (before.vy || 0)
    );
    return dPos < MATCH_PX && dV < MATCH_V;
  }

  /**
   * Catch-up polyline (one rule for every hard):
   *   current board draw → host path from nearest sample forward → live (T2)
   * Does not rewind to last-hard path[0] if the board is already past that.
   * Live is retargeted every frame.
   */
  function catchupPolyline(hostPath, startX, startY, liveX, liveY) {
    const pts = [{ x: startX, y: startY }];
    if (hostPath && hostPath.length) {
      let nearest = 0;
      let bestD = Infinity;
      for (let k = 0; k < hostPath.length; k++) {
        const d = Math.hypot(hostPath[k].x - startX, hostPath[k].y - startY);
        if (d < bestD) {
          bestD = d;
          nearest = k;
        }
      }
      for (let k = nearest; k < hostPath.length; k++) {
        const s = hostPath[k];
        const last = pts[pts.length - 1];
        if (Math.hypot(s.x - last.x, s.y - last.y) > 1e-6) {
          pts.push({ x: s.x, y: s.y });
        }
      }
    }
    const live = { x: liveX, y: liveY };
    const last = pts[pts.length - 1];
    if (Math.hypot(live.x - last.x, live.y - last.y) > 1e-6) {
      pts.push(live);
    } else {
      pts[pts.length - 1] = live;
    }
    return pts;
  }

  /** Point at fraction u∈[0,1] along polyline arc length. */
  function pointAtArcFraction(pts, u) {
    if (!pts || pts.length === 0) return { x: 0, y: 0 };
    if (pts.length === 1 || u <= 0) return { x: pts[0].x, y: pts[0].y };
    if (u >= 1) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
    let total = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      seg.push(d);
      total += d;
    }
    if (total < 1e-9) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
    let dist = u * total;
    for (let i = 0; i < seg.length; i++) {
      if (dist <= seg[i] || i === seg.length - 1) {
        const a = pts[i];
        const b = pts[i + 1];
        const t = seg[i] > 1e-9 ? dist / seg[i] : 1;
        return {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
        };
      }
      dist -= seg[i];
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }

  /**
   * Pose at progress u along: fixed board start → host path (forward) → live.
   */
  function catchupPoseAt(hostPath, startX, startY, liveX, liveY, u) {
    const pts = catchupPolyline(hostPath, startX, startY, liveX, liveY);
    return pointAtArcFraction(pts, u);
  }

  /**
   * Start visual catch-up. Host path is shape/samples since last hard; draw start is
   * the *current board* (p.rx/ry), not path[0] — never rewind a finished catch-up.
   */
  function startVisualPath(p, path, nowMs, opts) {
    opts = opts || {};
    if (!p || !Array.isArray(path) || path.length === 0) {
      if (p) {
        p.visPath = null;
        p.visPathFrames = 0;
        p.visPathTargetFrames = 0;
        p.visCatchStartX = null;
        p.visCatchStartY = null;
      }
      return;
    }
    const samples = path.slice();
    const nFrames =
      typeof opts.frames === 'number' && opts.frames > 0
        ? Math.floor(opts.frames)
        : catchupFrameCount(samples);

    p.visPath = samples;
    p.visPathFrames = 0;
    p.visPathTargetFrames = nFrames;
    p.errX = 0;
    p.errY = 0;
    // Board state is catch-up start (caller should leave rx/ry as current draw).
    p.visCatchStartX = p.rx;
    p.visCatchStartY = p.ry;
    p.rz = p.z || 0;

    if (p.trail) {
      if (!p.trailPts) p.trailPts = [];
      const now = typeof nowMs === 'number' ? nowMs : 0;
      const lastPt = p.trailPts[p.trailPts.length - 1];
      if (!lastPt || lastPt.x !== p.rx || lastPt.y !== p.ry) {
        p.trailPts.push({ x: p.rx, y: p.ry, t: now });
      }
    }
  }

  function finishVisualPath(p) {
    p.visPath = null;
    p.visPathFrames = 0;
    p.visPathTargetFrames = 0;
    p.visCatchStartX = null;
    p.visCatchStartY = null;
    p.rx = p.x;
    p.ry = p.y;
    p.rz = p.z || 0;
    p.errX = 0;
    p.errY = 0;
  }

  /**
   * Advance one display frame. u: board start → host path forward → live (T2).
   */
  function advanceVisualPathOne(p, nowMs) {
    if (!p.visPath || p.visPath.length === 0) {
      if (p.visPath) p.visPath = null;
      return true;
    }
    const N = Math.max(1, p.visPathTargetFrames || p.visPath.length || 1);
    p.visPathFrames = (p.visPathFrames || 0) + 1;
    const u = Math.min(1, p.visPathFrames / N);
    const sx = p.visCatchStartX != null ? p.visCatchStartX : p.rx;
    const sy = p.visCatchStartY != null ? p.visCatchStartY : p.ry;
    const pose = catchupPoseAt(p.visPath, sx, sy, p.x, p.y, u);
    p.rx = pose.x;
    p.ry = pose.y;
    p.rz = p.z || 0;

    if (u >= 1) {
      finishVisualPath(p);
      return true;
    }
    return false;
  }

  /**
   * Trail stamp + age prune from render pose (rx) — catch-up and free-run.
   * Only real drawn poses; never invents intermediate host samples.
   */
  function freeRunTrailAndPrune(p, nowMs) {
    if (!p.trail) {
      p.trailPts = null;
      return;
    }
    if (!p.trailPts) p.trailPts = [];
    const lastPt = p.trailPts[p.trailPts.length - 1];
    const now = typeof nowMs === 'number' ? nowMs : 0;
    if (
      !lastPt ||
      Math.hypot(p.rx - lastPt.x, p.ry - lastPt.y) > FREE_RUN_TRAIL_GAP
    ) {
      p.trailPts.push({ x: p.rx, y: p.ry, t: now });
    }
    while (p.trailPts.length && now - p.trailPts[0].t > TRAIL_MAX_AGE_MS) {
      p.trailPts.shift();
    }
  }

  /**
   * After sim is host-resimmed present on p, apply residual visual policy.
   * Mutates p. before = snapshot prior to seed/resim.
   * @returns {{ matched: boolean, pathCatchup: boolean, dPos: number, dV: number }}
   */
  function applyHardBallVisual(p, before, path, opts) {
    opts = opts || {};
    const hitCap = !!opts.hitCap;
    const nowMs = opts.nowMs;
    const after = { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    const dPos = Math.hypot(after.x - before.x, after.y - before.y);
    const dV = Math.hypot(
      (after.vx || 0) - (before.vx || 0),
      (after.vy || 0) - (before.vy || 0)
    );
    const matched = residualMatched(before, after, hitCap);

    // Residual match → visual no-op only (free-run already agreed with host present).
    // !matched + path → catch-up. No extra draw-at-start exceptions.
    if (matched) {
      p.x = before.x;
      p.y = before.y;
      p.vx = before.vx;
      p.vy = before.vy;
      p.z = before.z;
      p.vz = before.vz;
      p.errX = before.errX || 0;
      p.errY = before.errY || 0;
      p.rx = before.rx;
      p.ry = before.ry;
      p.rz = before.z;
      p.visPath = null;
      if (typeof before.strokes === 'number') p.strokes = before.strokes;
      if (before.holedOut !== undefined) p.holedOut = before.holedOut;
      return { matched: true, pathCatchup: false, dPos, dV };
    }

    p.errX = 0;
    p.errY = 0;
    p.rz = p.z || 0;
    if (path && path.length > 0) {
      // Catch-up starts from board draw (before), not path[0] / last hard.
      p.rx = before.rx != null ? before.rx : before.x;
      p.ry = before.ry != null ? before.ry : before.y;
      startVisualPath(p, path, nowMs);
      return { matched: false, pathCatchup: true, dPos, dV };
    }
    p.rx = p.x;
    p.ry = p.y;
    p.visPath = null;
    return { matched: false, pathCatchup: false, dPos, dV };
  }

  /**
   * Remote puttApplied: juice only — do not launch sim/draw (production rule).
   * Mutates nothing about pose; returns whether pose was left untouched.
   */
  function applyRemotePuttAppliedJuiceOnly(p) {
    // Intentional no-op on pose — caller plays SFX outside.
    return {
      poseUntouched: true,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      rx: p.rx,
      ry: p.ry,
    };
  }

  return {
    MATCH_PX,
    MATCH_V,
    PATH_CATCHUP_N,
    FREE_RUN_TRAIL_GAP,
    TRAIL_MAX_AGE_MS,
    residualMatched,
    catchupFrameCount,
    catchupPolyline,
    pointAtArcFraction,
    catchupPoseAt,
    startVisualPath,
    finishVisualPath,
    advanceVisualPathOne,
    freeRunTrailAndPrune,
    applyHardBallVisual,
    applyRemotePuttAppliedJuiceOnly,
  };
});
