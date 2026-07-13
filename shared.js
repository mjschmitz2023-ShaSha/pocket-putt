// Pocket Putt — shared physics/course-data engine.
// Loaded as a classic <script> in the browser (attaches window.Shared) and via
// require() in the Node server (module.exports) — same bytes, both environments,
// so the client and the multiplayer host can never disagree about how the ball moves.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Shared = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

// ---- Constants ----
// Fixed sim rate shared by solo, multiplayer host, and (later) event-driven clients.
// Wall clocks are only for scheduling/UI — physics and multiplayer time use integer ticks.
const TICK_HZ = 60;
const TICK_DT = 1 / TICK_HZ;
const TICK_MS = 1000 / TICK_HZ;
function tickToElapsedMs(tick) { return Math.round((tick * 1000) / TICK_HZ); }
function elapsedMsToTick(ms) { return Math.round((ms * TICK_HZ) / 1000); }

const LOGICAL_W = 800, LOGICAL_H = 500;
const BALL_RADIUS = 7;
const FRICTION_GRASS = 1.15;
const FRICTION_SAND = 8.0;
// Max gravitational acceleration sand can cancel (Coulomb-style hold). If |g| is below this
// while you're in sand and nearly stopped, the well cannot drag you; excess |g| still pulls.
const SAND_GRAVITY_HOLD = 280;
const STOP_THRESHOLD = 18;
// Cup "divot": within this radius a slow-enough ball gets pulled toward the cup, so
// near-misses that would have trickled past the lip tend to drop in instead.
const CUP_GRAVITY_RADIUS = 34;
const CUP_GRAVITY_PULL = 1000;
const CUP_CAPTURE_MAX_SPEED = 300;
// Below this speed extra rolling resistance kicks in so the ball settles quickly
// instead of crawling across the green forever.
const LOW_SPEED_CUTOFF = 60;
const LOW_SPEED_DRAG = 3.5;
const WALL_RESTITUTION = 0.8;
/** Drawn stroke width for walls/blades/gates (must match draw.js WALL_DRAW_WIDTH). */
const WALL_THICKNESS = 10;
/** Half of stroke width — solid surface is this far from the segment centerline. */
const WALL_HALF_WIDTH = WALL_THICKNESS / 2;
const BUMPER_RESTITUTION = 1.05;
const PENDULUM_RESTITUTION = 0.95;
const GATE_RESTITUTION = 0.85;
const MAX_DRAG_DIST = 150;
const MIN_DRAG_DIST = 8;
const POWER_MULTIPLIER = 6.5;
const MAX_LAUNCH_SPEED = 950;
const BOOST_MAX_SPEED = 1250;
// Ramps: a ball rolling up the ramp fast enough launches airborne along the ramp's angle
// (fake z-height — it flies over interior walls/hazards); slower balls stall on the slope
// and roll back down.
const RAMP_MIN_SPEED = 300;
const RAMP_GRAVITY = 1400;
const RAMP_VZ_SCALE = 0.55;
const RAMP_VZ_MIN = 260;
const RAMP_VZ_MAX = 520;
const RAMP_UPHILL_ACCEL = 900;
const FRICTION_AIR = 0.1;
// Sticky goo is *real surface*, not a temporary trap:
//   - While the ball is inside a goo patch, FRICTION_STICKY always applies (even after a
//     putt launched from inside). No grass "escape latch" — that made goo feel temporary.
//   - When speed falls below STICKY_STOP_SPEED, velocity is zeroed (hard stick).
//   - Putts from inside goo are also weakened by STICKY_LAUNCH_FACTOR.
// Original numbers (d7e080d). stuckStickyIndex is bookkeeping (which patch last stuck us)
// for wire/state; it does NOT disable sticky friction.
//
// Wet (after water hazard): the next putt only treats goo as super-slick — less friction
// than grass, and no hard-stick. Clears when that putt's coast settles.
const FRICTION_STICKY = 22;
const STICKY_STOP_SPEED = 50;
const STICKY_LAUNCH_FACTOR = 0.45;
const FRICTION_WET_GOO = 0.35; // < FRICTION_GRASS (1.15) — slides through goo while wet
// Orbit pack: continuous 1/r² gravity (docs/orbit-spec.md). ε = 0; never sample inside solid/horizon.
const GRAVITY_G = 100;
const PLANET_RESTITUTION = WALL_RESTITUTION; // 0.8 — wall-like, not bumper gain
const ESCAPE_SPEED_MARGIN = 0.85; // v_esc must be < MAX_LAUNCH * margin
const BOUND = { left: 20, top: 20, right: 780, bottom: 480 };

/** Planet / moon / black-hole body. Centers are logical px; mass is abstract. */
function gravityBody(kind, x, y, radius, mass, opts) {
  opts = opts || {};
  const body = {
    kind: kind, // 'planet' | 'blackHole' | 'moon'
    x: x,
    y: y,
    radius: radius,
    mass: mass,
    fieldRadius: opts.fieldRadius != null ? opts.fieldRadius : radius * 6,
    drawRadius: opts.drawRadius != null ? opts.drawRadius : radius,
  };
  if (kind === 'moon') {
    body.orbitCenter = opts.orbitCenter || { x: x, y: y };
    body.orbitRadius = opts.orbitRadius != null ? opts.orbitRadius : 80;
    body.orbitPeriodTicks = opts.orbitPeriodTicks != null ? opts.orbitPeriodTicks : 240;
    body.orbitPhase0 = opts.orbitPhase0 || 0;
  }
  return body;
}

function planet(x, y, radius, mass, opts) {
  return gravityBody('planet', x, y, radius, mass, opts);
}
function blackHole(x, y, radius, mass, opts) {
  // Visually smaller than cup (11); horizon may be a few px larger than art.
  opts = opts || {};
  if (opts.drawRadius == null) opts.drawRadius = Math.min(radius, 5);
  return gravityBody('blackHole', x, y, radius, mass, opts);
}
function moon(orbitCx, orbitCy, orbitRadius, bodyRadius, mass, periodTicks, opts) {
  opts = opts || {};
  opts.orbitCenter = { x: orbitCx, y: orbitCy };
  opts.orbitRadius = orbitRadius;
  opts.orbitPeriodTicks = periodTicks;
  const ang = opts.orbitPhase0 || 0;
  const x = orbitCx + Math.cos(ang) * orbitRadius;
  const y = orbitCy + Math.sin(ang) * orbitRadius;
  return gravityBody('moon', x, y, bodyRadius, mass, opts);
}

/** Escape speed at contact radius for a solid body (planet/moon). */
function escapeSpeed(body) {
  const r = body.radius + BALL_RADIUS;
  if (r <= 0 || body.mass <= 0) return 0;
  return Math.sqrt((2 * GRAVITY_G * body.mass) / r);
}

function bodyCanEscapeAtMaxLaunch(body) {
  return escapeSpeed(body) < MAX_LAUNCH_SPEED * ESCAPE_SPEED_MARGIN;
}

/** Absolute moon pose from sim tick (host/client lockstep). */
function setMoonPoseAtTick(body, tick) {
  if (!body || body.kind !== 'moon') return;
  const period = body.orbitPeriodTicks || 240;
  const ang = body.orbitPhase0 + (tick / period) * Math.PI * 2;
  const c = body.orbitCenter;
  body.x = c.x + Math.cos(ang) * body.orbitRadius;
  body.y = c.y + Math.sin(ang) * body.orbitRadius;
  // rad/s for surface velocity on bounce
  body._omega = (Math.PI * 2) / (period * TICK_DT);
}

function planetContactRadius(body) {
  return body.radius + BALL_RADIUS;
}

/** True if ball center is on (or in) a planet/moon crust. */
function ballOnPlanetCrust(ball, hole, slack) {
  slack = slack == null ? 1.25 : slack;
  const bodies = hole.gravityBodies || [];
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.kind === 'blackHole') continue;
    const r = Math.hypot(ball.x - b.x, ball.y - b.y);
    if (r <= planetContactRadius(b) + slack) return true;
  }
  return false;
}

/**
 * True if the ball is inside some attractor's field but not resting on a crust.
 * Used to forbid "mid-air rest" (STOP freeze) and skip crawl drag that kills orbital fall.
 */
function ballFloatingInGravity(ball, hole) {
  if ((ball.z || 0) > 0) return false;
  if (ballOnPlanetCrust(ball, hole, 1.5)) return false;
  const bodies = hole.gravityBodies || [];
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const r = Math.hypot(ball.x - b.x, ball.y - b.y);
    if (b.fieldRadius && r > b.fieldRadius) continue;
    if (b.kind === 'blackHole') {
      if (r > b.radius) return true;
    } else if (r > planetContactRadius(b)) {
      return true;
    }
  }
  return false;
}

/**
 * Net gravitational acceleration at the ball (same sampling as applyGravityAcceleration).
 * Used to decide whether a "stopped" ball is truly at rest or about to be yanked by a
 * moving well (e.g. moon sliding its field over a stationary ball).
 *
 * When the ball is on a planet/moon crust, that body's *radial* pull is cancelled (surface
 * normal force). Tangential pulls from *other* bodies (a passing moon) still apply — so a
 * parked ball gets dragged when the moon's well sweeps over it.
 */
function gravityAccelAt(ball, hole) {
  let ax = 0;
  let ay = 0;
  const bodies = hole.gravityBodies || [];
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dx = b.x - ball.x; // toward body
    const dy = b.y - ball.y;
    const r = Math.hypot(dx, dy);
    if (r < 1e-6) continue;
    if (b.fieldRadius && r > b.fieldRadius) continue;
    if (b.kind === 'blackHole') {
      if (r <= b.radius) continue;
    } else if (r < planetContactRadius(b) - 0.5) {
      continue;
    }
    const a = (GRAVITY_G * b.mass) / (r * r);
    let gx = (dx / r) * a;
    let gy = (dy / r) * a;
    // On this body's crust: cancel into-surface component (normal force balances radial g).
    if (b.kind !== 'blackHole' && r <= planetContactRadius(b) + 1.5) {
      const onx = (ball.x - b.x) / r; // outward normal
      const ony = (ball.y - b.y) / r;
      const into = gx * (-onx) + gy * (-ony); // accel toward body (into surface)
      if (into > 0) {
        gx -= into * (-onx);
        gy -= into * (-ony);
      }
    }
    ax += gx;
    ay += gy;
  }
  return { ax, ay, mag: Math.hypot(ax, ay) };
}

// If |g| exceeds this while "stopped", keep simulating — moon (etc.) is pulling.
const REST_GRAVITY_EPS = 25;

function ballInSand(ball, hole) {
  for (const z of hole.sand || []) {
    if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) return true;
  }
  return false;
}

/** Effective |g| after sand hold (0 if sand fully cancels the well). */
function effectiveGravityMag(ball, hole) {
  const g = gravityAccelAt(ball, hole);
  if (!ballInSand(ball, hole) || g.mag < 1e-9) return g.mag;
  if (g.mag <= SAND_GRAVITY_HOLD) return 0;
  return g.mag - SAND_GRAVITY_HOLD;
}

/** Solo/MP: freeze for aim only when not floating and effective gravity is negligible. */
function ballMayRestForAim(ball, hole) {
  if ((ball.z || 0) > 0) return false;
  // On a planet/moon crust (optionally in sand): radial g is cancelled by the surface.
  // Always allow a putt once nearly stopped — prevents infinite crust-collision soft-loops.
  if (ballOnPlanetCrust(ball, hole, 2.0)) {
    if (Math.hypot(ball.vx || 0, ball.vy || 0) < STOP_THRESHOLD * 1.5) return true;
  }
  // Floating in a field on grass: keep falling. Sand can pin you in a field (hold).
  if (ballFloatingInGravity(ball, hole) && !ballInSand(ball, hole)) return false;
  // Free grass / sand bunker: still no rest if net pull (after sand) is strong (moon yank).
  if (effectiveGravityMag(ball, hole) >= REST_GRAVITY_EPS) return false;
  return true;
}

/**
 * Quasi-rest: if average |v| stays near zero for several seconds (e.g. endless
 * soft-bounce on a bumper in a gravity well), allow a putt even though the ball
 * is not a clean AIMING rest. Window + threshold are shared by solo/MP/editor.
 */
const QUASI_REST_WINDOW_S = 5;
const QUASI_REST_AVG_SPEED = 30; // mean speed "close to 0" (STOP_THRESHOLD is 18)

function createSpeedAvgTracker() {
  return { sumSpDt: 0, sumDt: 0, q: [] };
}

function resetSpeedAvgTracker(tr) {
  if (!tr) return createSpeedAvgTracker();
  tr.sumSpDt = 0;
  tr.sumDt = 0;
  tr.q.length = 0;
  return tr;
}

/** Record one speed sample over dt seconds (drops samples older than the window). */
function noteSpeedSample(tr, speed, dt) {
  if (!tr || !(dt > 0) || !Number.isFinite(speed)) return tr;
  const sp = Math.max(0, speed);
  tr.q.push(sp, dt);
  tr.sumSpDt += sp * dt;
  tr.sumDt += dt;
  while (tr.sumDt > QUASI_REST_WINDOW_S && tr.q.length >= 2) {
    const oldSp = tr.q.shift();
    const oldDt = tr.q.shift();
    tr.sumSpDt -= oldSp * oldDt;
    tr.sumDt -= oldDt;
  }
  return tr;
}

function speedAvg(tr) {
  if (!tr || tr.sumDt <= 1e-9) return Infinity;
  return tr.sumSpDt / tr.sumDt;
}

function isQuasiRest(tr) {
  return !!(tr && tr.sumDt >= QUASI_REST_WINDOW_S - 1e-6 && speedAvg(tr) < QUASI_REST_AVG_SPEED);
}

/**
 * True if the player may start a putt: clean rest, or quasi-rest escape hatch.
 * Does not require airborne false alone for quasi-rest — still blocks z>0.
 */
function mayPuttBall(ball, hole, speedTracker) {
  if (!ball || (ball.z || 0) > 0) return false;
  const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
  if (speed < STOP_THRESHOLD && ballMayRestForAim(ball, hole)) return true;
  if (isQuasiRest(speedTracker)) return true;
  return false;
}

/**
 * Apply gravity, optionally opposed by sand. Sand acts like a force that can balance a
 * weak well: static hold cancels g entirely when |g| ≤ SAND_GRAVITY_HOLD and speed is low;
 * when moving or overpowered, only the excess acceleration is applied (kinetic feel still
 * comes from FRICTION_SAND velocity damping).
 */
function applyGravityAcceleration(ball, hole, subDt, inSand) {
  let g = gravityAccelAt(ball, hole);
  if (inSand && g.mag > 1e-9) {
    const speed = Math.hypot(ball.vx, ball.vy);
    const hold = SAND_GRAVITY_HOLD;
    if (speed < STOP_THRESHOLD * 1.75 && g.mag <= hold) {
      // Sand wins — parked against the pull.
      g = { ax: 0, ay: 0, mag: 0 };
    } else {
      // Kinetic / overpower: sand subtracts up to `hold` along -ĝ.
      const scale = Math.max(0, 1 - hold / g.mag);
      g = { ax: g.ax * scale, ay: g.ay * scale, mag: g.mag * scale };
    }
  }
  ball.vx += g.ax * subDt;
  ball.vy += g.ay * subDt;
}

/** Circle collider for planet/moon. Restitution wall-like; soft impact settles on crust. */
function resolvePlanetCollision(ball, body) {
  if (body.kind === 'blackHole') return false;
  const minDist = planetContactRadius(body);
  let dx = ball.x - body.x;
  let dy = ball.y - body.y;
  let dist = Math.hypot(dx, dy);
  if (dist >= minDist) return false;
  if (dist < 1e-6) {
    dx = 1;
    dy = 0;
    dist = 1e-6;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  // Pin exactly to the crust — no +epsilon gap that looks like a hover dead-zone.
  ball.x = body.x + nx * minDist;
  ball.y = body.y + ny * minDist;

  let svx = 0;
  let svy = 0;
  if (body.kind === 'moon' && body._omega) {
    const rx = ball.x - body.x;
    const ry = ball.y - body.y;
    svx = -body._omega * ry;
    svy = body._omega * rx;
  }
  const rvx = ball.vx - svx;
  const rvy = ball.vy - svy;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return false;

  const tvx = rvx - vn * nx;
  const tvy = rvy - vn * ny;
  const tangential = Math.hypot(tvx, tvy);
  // Soft contact / settle: pin to crust and kill relative motion when slow.
  // Return false so we do NOT spam bounce events (infinite "wall collision" juice).
  if (-vn < 50 && tangential < LOW_SPEED_CUTOFF) {
    if (body.kind === 'moon') {
      // Ride the moon surface; kill only into-surface component.
      ball.vx = svx + tvx * 0.5;
      ball.vy = svy + tvy * 0.5;
    } else {
      // Static planet: full stop on crust so the player can putt again (incl. sand bunkers).
      ball.vx = 0;
      ball.vy = 0;
    }
    return false;
  }
  // Hard bounce (wall-like restitution).
  ball.vx = svx + rvx - (1 + PLANET_RESTITUTION) * vn * nx;
  ball.vy = svy + rvy - (1 + PLANET_RESTITUTION) * vn * ny;
  return true;
}

function blackHoleCaptures(ball, body) {
  if (body.kind !== 'blackHole') return false;
  const r = Math.hypot(ball.x - body.x, ball.y - body.y);
  return r < body.radius + BALL_RADIUS;
}

// ---- Small geometry / data helpers ----
function wall(x1, y1, x2, y2, opts) {
  opts = opts || {};
  return { x1, y1, x2, y2, bumper: !!opts.bumper, restitution: opts.bumper ? BUMPER_RESTITUTION : WALL_RESTITUTION };
}
function sandRect(x1, y1, x2, y2) { return { shape: 'rect', x1, y1, x2, y2 }; }
function waterRect(x1, y1, x2, y2, dropPoint) { return { shape: 'rect', x1, y1, x2, y2, dropPoint }; }
function boostRect(x1, y1, x2, y2, angle, power) { return { shape: 'rect', x1, y1, x2, y2, angle, power }; }
function rampRect(x1, y1, x2, y2, angle, minSpeed) {
  return { shape: 'rect', x1, y1, x2, y2, angle, minSpeed: minSpeed || RAMP_MIN_SPEED };
}
function stickyRect(x1, y1, x2, y2) { return { shape: 'rect', x1, y1, x2, y2 }; }
function pendulum(cx, cy, length, angleCenter, amplitude, period, phaseOffset) {
  // phase0 = design-time offset (seconds); phase = live clock used by getPendulumSegment.
  const p0 = phaseOffset || 0;
  return { cx, cy, length, angleCenter, amplitude, period, phase0: p0, phase: p0 };
}
function getPendulumSegment(p) {
  const angle = p.angleCenter + p.amplitude * Math.sin((2 * Math.PI * p.phase) / p.period);
  // Angular velocity right now (d/dt of the swing), so collisions know the bar's motion.
  const omega = p.amplitude * Math.cos((2 * Math.PI * p.phase) / p.period) * (2 * Math.PI / p.period);
  return {
    x1: p.cx, y1: p.cy,
    x2: p.cx + Math.cos(angle) * p.length, y2: p.cy + Math.sin(angle) * p.length,
    restitution: PENDULUM_RESTITUTION,
    pivot: { x: p.cx, y: p.cy }, omega,
  };
}
function slidingGate(x1, y1, x2, y2, axis, amplitude, period, phaseOffset) {
  // phase0 = design-time offset (seconds); phase = live clock used by getSlidingGateSegment.
  const p0 = phaseOffset || 0;
  return { x1, y1, x2, y2, axis, amplitude, period, phase0: p0, phase: p0 };
}
function getSlidingGateSegment(g) {
  const offset = g.amplitude * Math.sin((2 * Math.PI * g.phase) / g.period);
  const speed = g.amplitude * Math.cos((2 * Math.PI * g.phase) / g.period) * (2 * Math.PI / g.period);
  const dx = g.axis === 'x' ? offset : 0;
  const dy = g.axis === 'y' ? offset : 0;
  return {
    x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy, restitution: GATE_RESTITUTION,
    svx: g.axis === 'x' ? speed : 0, svy: g.axis === 'y' ? speed : 0,
  };
}
function ringBumpers(cx, cy, r, n, gapIndex) {
  const walls = [];
  for (let i = 0; i < n; i++) {
    if (i === gapIndex) continue;
    const a1 = i * (2 * Math.PI / n), a2 = (i + 1) * (2 * Math.PI / n);
    walls.push(wall(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, { bumper: true }));
  }
  return walls;
}
function pointInZone(x, y, z) {
  if (z.shape === 'circle') return Math.hypot(x - z.cx, y - z.cy) < z.r;
  return x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2;
}
// Circle-vs-zone overlap: true when any part of the ball's perimeter touches the zone,
// not just its center — closest-point projection onto the rect, radius-expanded circles.
function circleTouchesZone(x, y, r, z) {
  if (z.shape === 'circle') return Math.hypot(x - z.cx, y - z.cy) < z.r + r;
  const nx = Math.max(z.x1, Math.min(x, z.x2));
  const ny = Math.max(z.y1, Math.min(y, z.y2));
  return Math.hypot(x - nx, y - ny) < r;
}

/**
 * Ramp pads: x1,y1,x2,y2 define width/height of a local rect; `angle` rotates it about
 * the center so the long axis of the pad matches launch direction. Boosts stay AABB.
 * Local +x is the launch direction after rotation.
 */
function zoneCenterXY(z) {
  return { x: (z.x1 + z.x2) / 2, y: (z.y1 + z.y2) / 2 };
}
function orientedRectCorners(z) {
  const cx = (z.x1 + z.x2) / 2, cy = (z.y1 + z.y2) / 2;
  const hw = Math.abs(z.x2 - z.x1) / 2, hh = Math.abs(z.y2 - z.y1) / 2;
  const a = z.angle || 0;
  const ca = Math.cos(a), sa = Math.sin(a);
  // Local corners: NW, NE, SE, SW (y-up screen: -hh is "north")
  const locals = [
    { id: 'nw', lx: -hw, ly: -hh },
    { id: 'ne', lx: hw, ly: -hh },
    { id: 'se', lx: hw, ly: hh },
    { id: 'sw', lx: -hw, ly: hh },
  ];
  return locals.map((c) => ({
    id: c.id,
    kind: 'corner',
    x: cx + c.lx * ca - c.ly * sa,
    y: cy + c.lx * sa + c.ly * ca,
  }));
}
/** Circle vs oriented rect (ramp). Angle 0 matches axis-aligned circleTouchesZone. */
function circleTouchesOrientedRect(x, y, r, z) {
  const cx = (z.x1 + z.x2) / 2, cy = (z.y1 + z.y2) / 2;
  const hw = Math.abs(z.x2 - z.x1) / 2, hh = Math.abs(z.y2 - z.y1) / 2;
  const a = z.angle || 0;
  const ca = Math.cos(a), sa = Math.sin(a);
  // World → local: R(-a) * (p - center)
  const dx = x - cx, dy = y - cy;
  const lx = ca * dx + sa * dy;
  const ly = -sa * dx + ca * dy;
  const qx = Math.max(-hw, Math.min(hw, lx));
  const qy = Math.max(-hh, Math.min(hh, ly));
  const ex = lx - qx, ey = ly - qy;
  return ex * ex + ey * ey < r * r;
}
function circleTouchesRamp(x, y, r, z) {
  return circleTouchesOrientedRect(x, y, r, z);
}
// A cup whose divot area overlaps sticky goo loses its magnet entirely: goo-guarded
// holes are meant to be punishing, so the ball must be putt in clean - no assist.
// Cached per hole; holes and their goo are static data, identical on host and client.
function cupHasGravity(hole) {
  if (hole._cupMagnet === undefined) {
    hole._cupMagnet = !(hole.sticky || []).some((z) => circleTouchesZone(hole.cup.x, hole.cup.y, CUP_GRAVITY_RADIUS, z));
  }
  return hole._cupMagnet;
}
function zoneBounds(z) {
  return z.shape === 'circle'
    ? { x1: z.cx - z.r, y1: z.cy - z.r, x2: z.cx + z.r, y2: z.cy + z.r }
    : { x1: z.x1, y1: z.y1, x2: z.x2, y2: z.y2 };
}

const BOUNDARY_WALLS = [
  wall(BOUND.left, BOUND.top, BOUND.right, BOUND.top),
  wall(BOUND.right, BOUND.top, BOUND.right, BOUND.bottom),
  wall(BOUND.right, BOUND.bottom, BOUND.left, BOUND.bottom),
  wall(BOUND.left, BOUND.bottom, BOUND.left, BOUND.top),
];

// ---- Hole data ----
// Every hole carries the same set of arrays (walls, sand, water, boost, pendulums, gates,
// windmills) even when empty, so the physics/render loops never need to guard for undefined.
const HOLES = [
  {
    name: 'The Green Mile', par: 2,
    tee: { x: 90, y: 250 }, cup: { x: 710, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(300, 320, 400, 400) ],
    water: [], boost: [], pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'Bumper Alley', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [
      wall(340, 140, 520, 210, { bumper: true }),
      wall(340, 360, 520, 290, { bumper: true }),
    ],
    sand: [ sandRect(580, 220, 660, 280) ],
    water: [], boost: [], pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'The Dogleg', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [ wall(400, 20, 400, 300) ],
    sand: [ sandRect(320, 320, 420, 390) ],
    water: [ waterRect(60, 400, 220, 460, { x: 80, y: 340 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'Sandy Pass', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(350, 150, 500, 350) ],
    water: [ waterRect(340, 60, 510, 130, { x: 320, y: 140 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
  },
  {
    name: "Water's Edge", par: 4,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(580, 340, 680, 430) ],
    water: [
      waterRect(380, 20, 420, 320, { x: 350, y: 400 }),
      waterRect(600, 420, 660, 470, { x: 580, y: 400 }),
    ],
    boost: [], pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'Pinball Corner', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 730, y: 430, radius: 11 },
    walls: [
      wall(260, 130, 400, 210, { bumper: true }),
      wall(410, 250, 300, 330, { bumper: true }),
      wall(480, 180, 610, 250, { bumper: true }),
    ],
    sand: [ sandRect(560, 340, 680, 440) ],
    water: [ waterRect(300, 380, 400, 440, { x: 260, y: 340 }) ],
    boost: [ boostRect(60, 90, 150, 150, Math.atan2(1, 2), 600) ],
    pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'The Windmill', par: 5,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(590, 330, 690, 420) ],
    water: [
      waterRect(660, 20, 710, 140, { x: 640, y: 160 }),
      waterRect(660, 360, 710, 480, { x: 640, y: 340 }),
    ],
    boost: [], pendulums: [], gates: [],
    windmills: [ { cx: 400, cy: 250, armLength: 90, blades: 4, rotationSpeed: 1.3, angle: 0 } ],
  },
  {
    name: 'Serpentine', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 730, y: 430, radius: 11 },
    walls: [
      wall(260, 20, 260, 320),
      wall(520, 180, 520, 480),
    ],
    sand: [
      sandRect(280, 340, 380, 440),
      sandRect(560, 260, 640, 340),
    ],
    water: [],
    boost: [ boostRect(350, 40, 430, 100, Math.PI / 4, 700) ],
    pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'The Crater', par: 5,
    tee: { x: 60, y: 60 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [
      wall(340, 20, 340, 260),
      ...ringBumpers(720, 420, 55, 8, 4),
    ],
    sand: [ sandRect(400, 300, 500, 400) ],
    water: [ waterRect(560, 280, 650, 380, { x: 540, y: 320 }) ],
    boost: [ boostRect(580, 390, 640, 450, 0, 500) ],
    pendulums: [], gates: [], windmills: [],
  },
  {
    name: 'The Pendulum', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(620, 300, 700, 370) ],
    water: [], boost: [], gates: [], windmills: [],
    pendulums: [ pendulum(400, 20, 235, Math.PI / 2, 0.85, 2.2) ],
  },
  {
    name: 'Sliding Doors', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [
      wall(380, 20, 380, 220),
      wall(380, 280, 380, 480),
    ],
    sand: [ sandRect(500, 330, 600, 410) ],
    water: [], boost: [], pendulums: [], windmills: [],
    gates: [ slidingGate(380, 220, 380, 280, 'y', 70, 2.0) ],
  },
  {
    name: 'Twin Mills', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 730, y: 430, radius: 11 },
    walls: [],
    sand: [ sandRect(420, 250, 500, 320) ],
    water: [ waterRect(600, 380, 680, 450, { x: 560, y: 340 }) ],
    boost: [], pendulums: [], gates: [],
    windmills: [
      { cx: 280, cy: 170, armLength: 70, blades: 2, rotationSpeed: 1.8, angle: 0 },
      { cx: 520, cy: 330, armLength: 70, blades: 2, rotationSpeed: -1.6, angle: 0 },
    ],
  },
  {
    // Two full-height walls, each pierced by one gap guarded by a sliding gate. The gates
    // run half a period out of phase, so you must time two separate shots - there is no
    // route around, only through.
    name: 'The Gauntlet Gate', par: 4,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 430, radius: 11 },
    walls: [
      wall(300, 20, 300, 200),
      wall(300, 280, 300, 480),
      wall(520, 20, 520, 320),
      wall(520, 400, 520, 480),
    ],
    sand: [ sandRect(360, 300, 460, 400) ],
    water: [], boost: [], pendulums: [], windmills: [],
    gates: [
      slidingGate(300, 200, 300, 280, 'y', 90, 2.6, 0),
      slidingGate(520, 320, 520, 400, 'y', 90, 2.6, 1.3),
    ],
  },
  {
    name: 'Whirlwind', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [], water: [], boost: [], pendulums: [], gates: [],
    windmills: [ { cx: 400, cy: 250, armLength: 130, blades: 6, rotationSpeed: 2.2, angle: 0 } ],
  },
  {
    name: 'The Vault', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 730, y: 430, radius: 11 },
    walls: [
      wall(340, 20, 340, 260),
      wall(600, 340, 600, 380),
      wall(600, 430, 600, 480),
      ...ringBumpers(730, 430, 50, 8, 4),
    ],
    sand: [ sandRect(420, 300, 520, 380) ],
    water: [ waterRect(460, 380, 560, 440, { x: 420, y: 340 }) ],
    boost: [], pendulums: [], windmills: [],
    gates: [ slidingGate(600, 380, 600, 430, 'y', 60, 2.5) ],
  },
  {
    name: 'Bar Fight', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [], water: [], boost: [], gates: [], windmills: [],
    pendulums: [
      pendulum(300, 20, 230, Math.PI / 2, 0.8, 2.0, 0),
      pendulum(500, 480, 230, -Math.PI / 2, 0.8, 2.0, 1.0),
    ],
  },
  {
    name: 'Sand Trap Symphony', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [
      sandRect(250, 180, 340, 320),
      sandRect(450, 150, 540, 250),
      sandRect(550, 300, 650, 420),
    ],
    water: [], boost: [], pendulums: [], gates: [],
    windmills: [ { cx: 400, cy: 400, armLength: 60, blades: 3, rotationSpeed: 1.4, angle: 0 } ],
  },
  {
    // A river crossed by one narrow land bridge, guarded by a giant pendulum arm that
    // sweeps across the crossing like the bridge being raised and lowered. Time a gentle
    // putt through the swing window, or roll over the boost pad on the approach and blast
    // across at full speed - if the arm catches you, you're likely going in the drink.
    name: 'Drawbridge', par: 4,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(580, 340, 680, 430) ],
    water: [
      waterRect(370, 20, 450, 215, { x: 340, y: 250 }),
      waterRect(370, 285, 450, 480, { x: 340, y: 250 }),
    ],
    // Boost pad only covers the TOP half of the bridge lane: roll the low half slowly and
    // time the arm, or take the pad and gamble on blasting through the swing.
    boost: [ boostRect(240, 212, 310, 248, 0, 650) ],
    pendulums: [ pendulum(410, 20, 250, Math.PI / 2, 0.55, 2.2) ],
    windmills: [], gates: [],
  },
  {
    name: 'The 19th Hole', par: 5,
    tee: { x: 60, y: 60 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [
      wall(340, 20, 340, 260),
      ...ringBumpers(720, 420, 55, 8, 4),
    ],
    sand: [ sandRect(400, 300, 500, 400) ],
    water: [ waterRect(560, 280, 650, 380, { x: 540, y: 320 }) ],
    boost: [ boostRect(580, 390, 640, 450, 0, 500) ],
    pendulums: [], gates: [],
    windmills: [ { cx: 520, cy: 200, armLength: 80, blades: 4, rotationSpeed: 1.5, angle: 0 } ],
  },
];

// ---- Courses ----
// Design numbers for jump holes: a rolling ball loses ~1.15 px/s of speed per px of grass,
// and a ramp entered at speed v carries roughly 400→150, 500→200, 600→280, 700→390,
// 800→500, 900+→700 px (launch fires at the ramp's ENTRY edge). Landings keep their
// horizontal speed, so sand/goo pads downrange are the brakes.
const CANYON_HOLES = [
  {
    name: 'First Flight', par: 2,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [], sand: [],
    water: [ waterRect(390, 140, 510, 360, { x: 240, y: 250 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(300, 200, 360, 300, 0) ],
    sticky: [],
  },
  {
    name: 'Over the Hedge', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 720, y: 250, radius: 11 },
    walls: [ wall(430, 120, 430, 380) ],
    sand: [ sandRect(500, 190, 640, 310) ],
    water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(280, 205, 340, 295, 0) ],
    sticky: [],
  },
  {
    name: 'Commitment', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 710, y: 250, radius: 11 },
    walls: [ wall(240, 140, 330, 205), wall(240, 360, 330, 295) ],
    sand: [ sandRect(420, 160, 560, 340) ],
    water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(330, 205, 390, 295, 0, 450) ],
    sticky: [],
  },
  {
    name: 'The Long Way', par: 4,
    tee: { x: 70, y: 420 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [ wall(650, 160, 650, 370) ],
    sand: [],
    water: [ waterRect(260, 160, 620, 480, { x: 180, y: 420 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(190, 370, 250, 470, 0) ],
    sticky: [],
  },
  {
    name: 'Skee Ball', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 680, y: 250, radius: 11 },
    walls: [ ...ringBumpers(680, 250, 60, 8, 4) ],
    sand: [],
    water: [ waterRect(300, 60, 480, 170, { x: 240, y: 250 }), waterRect(300, 330, 480, 440, { x: 240, y: 250 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(340, 210, 400, 290, 0) ],
    sticky: [],
  },
  {
    name: 'Double Dare', par: 4,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [],
    water: [ waterRect(310, 150, 410, 350, { x: 180, y: 250 }), waterRect(550, 150, 650, 350, { x: 430, y: 250 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(220, 205, 280, 295, 0), rampRect(460, 205, 520, 295, 0) ],
    sticky: [],
  },
  {
    name: 'Windmill Hop', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(560, 190, 660, 310) ],
    water: [], boost: [], pendulums: [], gates: [],
    windmills: [ { cx: 420, cy: 250, armLength: 90, blades: 4, rotationSpeed: 1.6, angle: 0 } ],
    ramps: [ rampRect(280, 210, 340, 290, 0) ],
    sticky: [],
  },
  {
    name: 'The Moat', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 640, y: 250, radius: 11 },
    walls: [],
    sand: [],
    water: [
      waterRect(520, 130, 760, 210, { x: 460, y: 250 }),
      waterRect(520, 290, 760, 370, { x: 460, y: 250 }),
      waterRect(520, 210, 570, 290, { x: 460, y: 250 }),
      waterRect(710, 210, 760, 290, { x: 460, y: 250 }),
    ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(330, 210, 390, 290, 0) ],
    // Goo island: landings come in hot (~600 px/s) and the goo stops them dead — with
    // sand instead, every playable jump rolled off the far side into the moat.
    sticky: [ stickyRect(575, 215, 705, 285) ],
  },
  {
    name: 'Pinball Flight', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 720, y: 430, radius: 11 },
    walls: [ wall(560, 120, 660, 200, { bumper: true }), wall(150, 300, 250, 380, { bumper: true }) ],
    sand: [ sandRect(540, 340, 660, 440) ],
    water: [ waterRect(360, 200, 560, 360, { x: 300, y: 180 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(240, 90, 300, 170, Math.PI / 4) ],
    sticky: [],
  },
  {
    name: 'Halfpipe', par: 3,
    tee: { x: 70, y: 440 }, cup: { x: 700, y: 120, radius: 11 },
    walls: [],
    sand: [ sandRect(620, 60, 760, 220) ],
    water: [], boost: [],
    pendulums: [ pendulum(350, 480, 180, -Math.PI / 2, 0.7, 2.0) ],
    gates: [], windmills: [],
    ramps: [ rampRect(560, 360, 620, 440, -Math.PI / 4) ],
    sticky: [],
  },
  {
    name: 'Gate Crasher', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [ wall(450, 20, 450, 200), wall(450, 300, 450, 480) ],
    sand: [ sandRect(560, 200, 660, 300) ],
    water: [ waterRect(480, 60, 560, 180, { x: 420, y: 120 }), waterRect(480, 320, 560, 440, { x: 420, y: 380 }) ],
    boost: [], pendulums: [],
    gates: [ slidingGate(450, 200, 450, 300, 'y', 100, 2.2) ],
    windmills: [],
    ramps: [ rampRect(300, 205, 360, 295, 0) ],
    sticky: [],
  },
  {
    name: 'Boost & Soar', par: 4,
    tee: { x: 60, y: 250 }, cup: { x: 710, y: 100, radius: 11 },
    walls: [],
    sand: [ sandRect(640, 40, 760, 160) ],
    water: [ waterRect(420, 300, 650, 470, { x: 380, y: 250 }) ],
    boost: [ boostRect(140, 220, 220, 280, 0, 500) ],
    pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(300, 205, 360, 295, -0.35) ],
    sticky: [],
  },
  {
    name: 'Leap of Faith', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(580, 190, 680, 310) ],
    water: [ waterRect(400, 20, 540, 230, { x: 340, y: 120 }), waterRect(400, 270, 540, 480, { x: 340, y: 380 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(260, 205, 320, 295, 0) ],
    sticky: [],
  },
  {
    name: 'Pendulum Vault', par: 4,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [ pendulum(400, 20, 235, Math.PI / 2, 0.85, 2.2) ],
    gates: [], windmills: [],
    ramps: [ rampRect(250, 205, 310, 295, 0) ],
    sticky: [ stickyRect(600, 200, 690, 300) ],
  },
  {
    name: 'Twin Flyover', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [
      wall(300, 20, 300, 180), wall(300, 260, 300, 480),
      wall(540, 20, 540, 240), wall(540, 320, 540, 480),
    ],
    sand: [ sandRect(580, 320, 680, 440) ],
    water: [], boost: [], pendulums: [],
    gates: [
      slidingGate(300, 180, 300, 260, 'y', 80, 2.4, 0),
      slidingGate(540, 240, 540, 320, 'y', 80, 2.4, 1.2),
    ],
    windmills: [],
    ramps: [ rampRect(180, 30, 240, 110, Math.PI / 6) ],
    sticky: [],
  },
  {
    name: 'Stepping Stones', par: 4,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [ sandRect(395, 215, 445, 285), sandRect(535, 215, 585, 285) ],
    water: [
      waterRect(300, 100, 660, 210, { x: 150, y: 250 }),
      waterRect(300, 290, 660, 400, { x: 150, y: 250 }),
      waterRect(300, 210, 390, 290, { x: 150, y: 250 }),
      waterRect(450, 210, 530, 290, { x: 150, y: 250 }),
      waterRect(590, 210, 660, 290, { x: 150, y: 250 }),
    ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(210, 205, 270, 295, 0) ],
    sticky: [],
  },
  {
    name: 'Ricochet Range', par: 4,
    tee: { x: 70, y: 100 }, cup: { x: 710, y: 440, radius: 11 },
    walls: [ wall(640, 60, 720, 160, { bumper: true }) ],
    sand: [ sandRect(650, 300, 760, 410) ],
    water: [ waterRect(400, 40, 560, 160, { x: 350, y: 200 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(300, 60, 360, 140, 0) ],
    sticky: [],
  },
  {
    name: 'The Gauntlet', par: 4,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [],
    sand: [],
    water: [ waterRect(470, 130, 590, 370, { x: 350, y: 250 }) ],
    boost: [], pendulums: [], gates: [],
    windmills: [ { cx: 250, cy: 250, armLength: 80, blades: 3, rotationSpeed: 2.2, angle: 0 } ],
    ramps: [ rampRect(380, 205, 440, 295, 0) ],
    sticky: [ stickyRect(620, 200, 700, 300) ],
  },
  {
    name: 'Canyon Grande', par: 5,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [ ...ringBumpers(730, 250, 45, 8, 4) ],
    sand: [],
    water: [ waterRect(360, 20, 620, 480, { x: 220, y: 250 }) ],
    boost: [ boostRect(120, 215, 190, 285, 0, 450) ],
    pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(260, 200, 330, 300, 0, 350) ],
    sticky: [ stickyRect(625, 205, 680, 295) ],
  },
];

// Goo numbers: FRICTION_STICKY always applies inside a patch (crossing *and* escaping).
// Deep patches always trap; thin strips (~20 px) can still be punched through at full power.
// In-goo putts are 0.45× power and still fight sticky drag, so wide blobs need crawl-outs.
const STICKY_HOLES = [
  {
    name: 'Welcome Mat', par: 2,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(360, 140, 440, 360) ],
  },
  {
    name: 'The Brake Pad', par: 2,
    tee: { x: 70, y: 250 }, cup: { x: 620, y: 250, radius: 11 },
    walls: [], sand: [],
    water: [ waterRect(680, 150, 760, 350, { x: 600, y: 250 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(520, 180, 580, 320) ],
  },
  {
    name: 'Half Power', par: 2,
    tee: { x: 70, y: 250 }, cup: { x: 560, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(300, 150, 420, 350) ],
  },
  {
    name: 'Goo Corridors', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(250, 20, 310, 330), stickyRect(450, 170, 510, 480) ],
  },
  {
    name: 'The Filter', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 720, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(400, 60, 420, 440) ],
  },
  {
    name: 'Moat of Goo', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 650, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(560, 160, 740, 340) ],
  },
  {
    name: 'Boost Trap', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [],
    boost: [ boostRect(240, 220, 310, 280, 0, 600) ],
    pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(480, 180, 560, 320) ],
  },
  {
    name: 'Sticky Windmill', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [],
    windmills: [ { cx: 415, cy: 250, armLength: 85, blades: 3, rotationSpeed: 2.0, angle: 0 } ],
    ramps: [],
    sticky: [ stickyRect(380, 20, 450, 200), stickyRect(380, 300, 450, 480) ],
  },
  {
    name: 'Pendulum Rescue', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [ pendulum(400, 20, 240, Math.PI / 2, 0.8, 2.0) ],
    gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(340, 220, 460, 330) ],
  },
  {
    name: 'The Narrows', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 730, y: 430, radius: 11 },
    walls: [ wall(260, 20, 260, 320), wall(520, 180, 520, 480) ],
    sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(270, 380, 380, 460), stickyRect(530, 50, 640, 120) ],
  },
  {
    name: 'Gate & Goo', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [ wall(480, 20, 480, 200), wall(480, 300, 480, 480) ],
    sand: [], water: [], boost: [], pendulums: [],
    gates: [ slidingGate(480, 200, 480, 300, 'y', 90, 2.3) ],
    windmills: [],
    ramps: [],
    sticky: [ stickyRect(370, 190, 450, 310) ],
  },
  {
    name: 'Twin Ponds', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [],
    water: [ waterRect(360, 20, 560, 200, { x: 300, y: 250 }), waterRect(360, 300, 560, 480, { x: 300, y: 250 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(360, 200, 560, 300) ],
  },
  {
    name: 'Sticky Shortcut', par: 4,
    tee: { x: 60, y: 420 }, cup: { x: 720, y: 60, radius: 11 },
    walls: [ wall(560, 20, 560, 300) ],
    sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(300, 180, 520, 420) ],
  },
  {
    name: 'Honey Pot', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 660, y: 250, radius: 11 },
    walls: [ ...ringBumpers(660, 250, 70, 8, 4) ],
    sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(610, 215, 715, 285) ],
  },
  {
    name: 'Minefield', par: 4,
    tee: { x: 60, y: 250 }, cup: { x: 740, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [
      stickyRect(220, 120, 290, 190), stickyRect(300, 60, 370, 130),
      stickyRect(400, 190, 460, 250), stickyRect(350, 300, 420, 370),
      stickyRect(480, 120, 550, 190), stickyRect(560, 330, 630, 400),
    ],
  },
  {
    name: 'Ramp the Lagoon', par: 4,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(260, 205, 320, 295, 0) ],
    sticky: [ stickyRect(360, 140, 600, 360) ],
  },
  {
    name: 'Ledge Landing', par: 4,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [],
    water: [ waterRect(310, 20, 450, 480, { x: 160, y: 250 }), waterRect(510, 60, 650, 440, { x: 480, y: 250 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [ rampRect(220, 205, 280, 295, 0) ],
    sticky: [ stickyRect(450, 180, 510, 320) ],
  },
  {
    name: 'Pinball Goo', par: 4,
    tee: { x: 60, y: 60 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [ wall(300, 140, 420, 220, { bumper: true }), wall(480, 260, 600, 340, { bumper: true }) ],
    sand: [],
    water: [ waterRect(360, 380, 480, 460, { x: 320, y: 340 }) ],
    boost: [], pendulums: [], gates: [], windmills: [],
    ramps: [],
    sticky: [ stickyRect(200, 300, 280, 380), stickyRect(620, 120, 700, 200) ],
  },
  {
    name: 'The Final Boss', par: 5,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [],
    water: [ waterRect(430, 130, 560, 370, { x: 310, y: 250 }) ],
    boost: [],
    pendulums: [ pendulum(650, 20, 180, Math.PI / 2, 0.75, 2.1) ],
    gates: [],
    windmills: [ { cx: 230, cy: 250, armLength: 70, blades: 4, rotationSpeed: 2.4, angle: 0 } ],
    ramps: [ rampRect(340, 205, 400, 295, 0, 400) ],
    sticky: [ stickyRect(590, 190, 670, 310) ],
  },
];

// ---- Orbit (docs/orbit-spec.md) ----
// Curriculum: 1–4 teach, 5–12 puzzle, 13–19 spectacle (19 = moon).
// Toy box: walls/sand/water/boost/cup + gravity bodies. No ramps/windmills/pendulums/gates/goo.
// Masses tuned so every planet escapes at max launch (escapeSpeed tests enforce).
const ORBIT_HOLES = [
  // 1–4 teach
  {
    name: 'First Pull', par: 2,
    // Cup above the tee line so full-power pure +x cannot fall in without aim.
    tee: { x: 80, y: 280 }, cup: { x: 700, y: 180, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [planet(420, 360, 38, 24000, { fieldRadius: 210 })],
  },
  {
    name: 'Keep Clear', par: 2,
    tee: { x: 70, y: 250 }, cup: { x: 710, y: 200, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    // Stronger body near the lane so pure horizontal is deflected off the cup line.
    gravityBodies: [planet(400, 250, 36, 28000, { fieldRadius: 220 })],
  },
  {
    name: 'Bank the Crust', par: 3,
    tee: { x: 80, y: 400 }, cup: { x: 700, y: 100, radius: 11 },
    walls: [wall(300, 200, 500, 200)],
    sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [planet(250, 280, 34, 20000, { fieldRadius: 190 })],
  },
  {
    name: 'Event Horizon 101', par: 2,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    // Tiny high-mass BH below the line — pull then avoid the disk
    gravityBodies: [blackHole(400, 340, 6, 48000, { fieldRadius: 220, drawRadius: 4 })],
  },
  // 5–12 puzzle
  {
    name: 'Binary Drift', par: 3,
    tee: { x: 70, y: 250 }, cup: { x: 720, y: 200, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(320, 200, 32, 20000, { fieldRadius: 180 }),
      planet(500, 320, 32, 20000, { fieldRadius: 180 }),
    ],
  },
  {
    name: 'Dust Lane', par: 3,
    // Diagonal fairway: sand sits on the short-cut so the clean line arcs around the planet.
    tee: { x: 80, y: 120 }, cup: { x: 700, y: 380, radius: 11 },
    walls: [], sand: [sandRect(360, 220, 480, 300)], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [planet(400, 250, 32, 21000, { fieldRadius: 180 })],
  },
  {
    name: 'Sling Corridor', par: 3,
    tee: { x: 80, y: 380 }, cup: { x: 700, y: 120, radius: 11 },
    walls: [wall(400, 250, 400, 450)],
    sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    // Planet low-right; open diagonal above wall.
    gravityBodies: [planet(500, 380, 30, 14000, { fieldRadius: 140 })],
  },
  {
    name: 'Needle Thread', par: 3,
    tee: { x: 80, y: 250 }, cup: { x: 710, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(350, 160, 28, 16000, { fieldRadius: 150 }),
      blackHole(400, 250, 5, 42000, { fieldRadius: 160, drawRadius: 4 }),
      planet(450, 340, 28, 16000, { fieldRadius: 150 }),
    ],
  },
  {
    name: 'Well Between', par: 3,
    tee: { x: 80, y: 100 }, cup: { x: 700, y: 400, radius: 11 },
    walls: [], sand: [], water: [waterRect(360, 200, 440, 300, { x: 200, y: 250 })],
    boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [planet(520, 180, 34, 20000, { fieldRadius: 180 })],
  },
  {
    name: 'Twin Sling', par: 3,
    tee: { x: 60, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(300, 250, 36, 25000, { fieldRadius: 190 }),
      planet(520, 250, 36, 25000, { fieldRadius: 190 }),
    ],
  },
  {
    name: 'Thruster Assist', par: 3,
    tee: { x: 80, y: 400 }, cup: { x: 700, y: 100, radius: 11 },
    walls: [], sand: [], water: [],
    boost: [boostRect(200, 220, 280, 280, -Math.PI / 4, 420)],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [planet(450, 300, 34, 22000, { fieldRadius: 190 })],
  },
  {
    name: 'Horizon Gauntlet', par: 4,
    tee: { x: 70, y: 250 }, cup: { x: 720, y: 180, radius: 11 },
    // Sand on the low dodge past the first BH — the lazy low line pays a friction tax.
    walls: [], sand: [sandRect(300, 290, 390, 360)], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      blackHole(340, 250, 5, 38000, { fieldRadius: 140, drawRadius: 4 }),
      planet(500, 360, 30, 16000, { fieldRadius: 150 }),
      blackHole(600, 140, 5, 36000, { fieldRadius: 130, drawRadius: 4 }),
    ],
  },
  // 13–19 spectacle
  {
    name: 'Grand Tour', par: 4,
    tee: { x: 80, y: 400 }, cup: { x: 700, y: 100, radius: 11 },
    walls: [],
    sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(280, 160, 32, 15000, { fieldRadius: 140 }),
      planet(520, 340, 32, 15000, { fieldRadius: 140 }),
    ],
  },
  {
    name: 'Lagrange Squeeze', par: 3,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [], sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(350, 250, 42, 30000, { fieldRadius: 200 }),
      planet(520, 250, 28, 16000, { fieldRadius: 160 }),
    ],
  },
  {
    name: 'Aphelion Run', par: 3,
    tee: { x: 70, y: 80 }, cup: { x: 720, y: 420, radius: 11 },
    walls: [], sand: [], water: [], boost: [boostRect(150, 200, 210, 260, Math.PI / 5, 380)],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(400, 250, 38, 26000, { fieldRadius: 200 }),
      blackHole(560, 140, 5, 45000, { fieldRadius: 160, drawRadius: 4 }),
    ],
  },
  {
    name: 'Three Body Problem', par: 4,
    tee: { x: 80, y: 400 }, cup: { x: 700, y: 100, radius: 11 },
    // Sand on the lower corner shortcut between planets 2 and 3.
    walls: [], sand: [sandRect(420, 280, 520, 360)], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(250, 200, 30, 18000, { fieldRadius: 160 }),
      planet(400, 350, 34, 22000, { fieldRadius: 170 }),
      planet(560, 200, 30, 18000, { fieldRadius: 160 }),
    ],
  },
  {
    name: 'Dark Matter', par: 3,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [wall(250, 100, 250, 200), wall(250, 300, 250, 400)],
    sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      blackHole(400, 250, 6, 55000, { fieldRadius: 200, drawRadius: 5 }),
      planet(580, 140, 30, 17000, { fieldRadius: 150 }),
    ],
  },
  {
    name: 'Periapsis', par: 4,
    tee: { x: 70, y: 420 }, cup: { x: 720, y: 80, radius: 11 },
    walls: [], sand: [], water: [waterRect(200, 180, 280, 280, { x: 160, y: 380 })],
    boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(420, 300, 34, 18000, { fieldRadius: 160 }),
      blackHole(580, 400, 5, 32000, { fieldRadius: 130, drawRadius: 4 }),
    ],
  },
  {
    name: 'Lunar Window', par: 4,
    // Central world blocks the fairway; top/bottom walls kill free bypasses. The moon's
    // gravity assist is required for a clean HIO — same seed must fail if the moon is removed.
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [
      wall(250, 90, 550, 90),
      wall(250, 410, 550, 410),
      wall(250, 90, 250, 170),
      wall(250, 330, 250, 410),
      wall(550, 90, 550, 170),
      wall(550, 330, 550, 410),
    ],
    sand: [], water: [], boost: [],
    pendulums: [], gates: [], windmills: [], ramps: [], sticky: [],
    gravityBodies: [
      planet(400, 250, 52, 32000, { fieldRadius: 160 }),
      // Wide field so a park next to the planet still feels the moon as it slides by.
      moon(400, 250, 118, 24, 22000, 280, { fieldRadius: 200, orbitPhase0: 0 }),
    ],
  },
];

const COURSES = [
  { id: 'classic', name: 'Classic', holes: HOLES },
  { id: 'canyon', name: 'Canyon Jumps', holes: CANYON_HOLES },
  { id: 'goo', name: 'Goo Lagoon', holes: STICKY_HOLES },
  { id: 'orbit', name: 'Orbit', holes: ORBIT_HOLES },
];

// Classic's hole literals predate ramps/sticky/gravity — fill arrays in one pass so the
// "every hole carries every array" invariant keeps holding without editing every literal.
for (const c of COURSES) {
  for (const h of c.holes) {
    h.ramps = h.ramps || [];
    h.sticky = h.sticky || [];
    h.gravityBodies = h.gravityBodies || [];
  }
}

// ---- Physics ----
/**
 * Circle (ball surface) vs thick segment (wall centerline ± WALL_HALF_WIDTH).
 * Contact when center is within BALL_RADIUS + WALL_HALF_WIDTH of the segment —
 * not centroid-vs-centerline (which sank the ball into the drawn stroke).
 */
function resolveWallCollision(ball, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((ball.x - w.x1) * dx + (ball.y - w.y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = w.x1 + t * dx, cy = w.y1 + t * dy;
  const distX = ball.x - cx, distY = ball.y - cy;
  const dist = Math.hypot(distX, distY);
  // Surface-to-surface: ball disk vs stadium (capsule) around the segment.
  const contactR = BALL_RADIUS + WALL_HALF_WIDTH;
  if (dist < contactR && dist > 0.0001) {
    const nx = distX / dist, ny = distY / dist;
    const overlap = contactR - dist;
    ball.x += nx * (overlap + 0.1);
    ball.y += ny * (overlap + 0.1);
    // Moving obstacles (windmill blades, pendulums, gates) carry surface velocity at the
    // contact point. Reflecting the ball's velocity RELATIVE to the surface (then adding
    // the surface velocity back) means a sweeping blade smacks the ball away with its own
    // momentum instead of re-penetrating every substep and dragging the ball around.
    let wvx = 0, wvy = 0;
    if (w.pivot) {
      wvx = -w.omega * (cy - w.pivot.y);
      wvy = w.omega * (cx - w.pivot.x);
    } else if (w.svx || w.svy) {
      wvx = w.svx || 0;
      wvy = w.svy || 0;
    }
    const rvx = ball.vx - wvx, rvy = ball.vy - wvy;
    const dot = rvx * nx + rvy * ny;
    if (dot < 0) {
      const restitution = w.restitution || WALL_RESTITUTION;
      ball.vx = wvx + rvx - (1 + restitution) * dot * nx;
      ball.vy = wvy + rvy - (1 + restitution) * dot * ny;
      return true;
    }
  }
  return false;
}
function getWindmillBlades(wm) {
  const blades = [];
  for (let i = 0; i < wm.blades; i++) {
    const angle = wm.angle + i * (2 * Math.PI / wm.blades);
    blades.push({
      x1: wm.cx, y1: wm.cy, x2: wm.cx + Math.cos(angle) * wm.armLength, y2: wm.cy + Math.sin(angle) * wm.armLength,
      restitution: WALL_RESTITUTION,
      pivot: { x: wm.cx, y: wm.cy }, omega: wm.rotationSpeed,
    });
  }
  return blades;
}

// ---- Per-ball state and stepping (used by both solo game.js and the multiplayer server) ----
// stuckStickyIndex: -1 = free / not stuck. >=0 = last patch that hard-stopped us (wire/state).
// MUST be an index, never a zone object ref — host/client each have their own hole.sticky[].
// Friction does NOT depend on this field: any ball inside goo always gets FRICTION_STICKY.
function createBallState(tee) {
  return {
    x: tee.x, y: tee.y, vx: 0, vy: 0, z: 0, vz: 0,
    squash: 0, spin: 0, angleDir: 0,
    firedBoosts: new Set(), // boost zone indices (numbers), not object refs
    stuckStickyIndex: -1,
    wet: false,       // true after a water drop until the wet stroke settles
    wetStroke: false, // true once the post-water putt has been taken
  };
}

/** Call when the ball is dropped from water — arms wet for the next putt. */
function markWetFromWater(ball) {
  ball.wet = true;
  ball.wetStroke = false;
}

/** Call on every putt: if wet, this coast is the wet stroke (clears on settle). */
function noteWetPutt(ball) {
  if (ball.wet) ball.wetStroke = true;
}

function stickyIndexAt(ball, hole) {
  const list = hole.sticky || [];
  for (let i = 0; i < list.length; i++) {
    if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, list[i])) return i;
  }
  return -1;
}

// Legacy no-op kept so putt sites stay call-compatible. Goo is always sticky while inside
// the patch — we deliberately do NOT latch to grass friction on escape putts anymore.
function latchStickyAfterPutt(ball, hole) {
  // no-op
}

// Advances one ball by dt against a hole's current obstacle positions. Mutates `ball` in
// place and returns what happened this step so the caller (solo game.js or the server) can
// react with sound/particles/scoring - this function itself never touches audio/DOM/score.
//
// CRITICAL for multiplayer: host and client must call this with the SAME dt schedule per
// sim tick. Sticky stop thresholds are speed-based and fork hard if one side microsteps more.
function stepBallPhysics(ball, hole, dt) {
  let walls = BOUNDARY_WALLS.concat(hole.walls);
  for (const wm of hole.windmills) walls = walls.concat(getWindmillBlades(wm));
  if (hole.pendulums.length) walls = walls.concat(hole.pendulums.map(getPendulumSegment));
  if (hole.gates.length) walls = walls.concat(hole.gates.map(getSlidingGateSegment));

  // Normalize legacy balls that still have stuckTo object refs.
  if (typeof ball.stuckStickyIndex !== 'number') {
    ball.stuckStickyIndex = -1;
    delete ball.stuckTo;
  }
  if (!(ball.firedBoosts instanceof Set)) ball.firedBoosts = new Set();

  const substeps = 4;
  const subDt = dt / substeps;
  let inSandLastStep = false;
  const events = {
    holed: false, water: null, blackHole: null, boosts: [],
    bounced: false, enteredSand: false, launched: false, landed: false, stuck: false,
  };

  for (let s = 0; s < substeps; s++) {
    const airborne = (ball.z || 0) > 0;
    let friction = FRICTION_GRASS;
    let inSand = false;
    let trappingIndex = -1; // sticky index actively dragging toward a stop this substep
    if (airborne) {
      friction = FRICTION_AIR;
    } else {
      const stickyIdx = stickyIndexAt(ball, hole);
      if (stickyIdx < 0) {
        ball.stuckStickyIndex = -1;
        for (const z of hole.sand) {
          if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) {
            friction = FRICTION_SAND;
            inSand = true;
            break;
          }
        }
      } else if (ball.wet) {
        // Wet after water: goo is slicker than grass for this one stroke — no hard stick.
        friction = FRICTION_WET_GOO;
      } else {
        // Inside goo: always sticky drag, including shots launched from within the patch.
        friction = FRICTION_STICKY;
        trappingIndex = stickyIdx;
      }
    }
    if (inSand && !inSandLastStep) events.enteredSand = true;
    inSandLastStep = inSand;

    // Orbit gravity (grounded only — airborne ramps are non-Orbit; still skip z>0 for purity).
    // Sand can oppose g (see SAND_GRAVITY_HOLD) so a bunker may hold you against a weak well.
    if (!airborne) {
      applyGravityAcceleration(ball, hole, subDt, inSand);
    }

    // Cup divot: slow balls near the cup get tugged toward it, fast ones fly over.
    const dcx = hole.cup.x - ball.x, dcy = hole.cup.y - ball.y;
    const dCup0 = Math.hypot(dcx, dcy);
    const speedNow = Math.hypot(ball.vx, ball.vy);
    if (!airborne && cupHasGravity(hole) && dCup0 < CUP_GRAVITY_RADIUS && dCup0 > 0.001 && speedNow < CUP_CAPTURE_MAX_SPEED) {
      const pull = CUP_GRAVITY_PULL * (1 - dCup0 / CUP_GRAVITY_RADIUS);
      ball.vx += (dcx / dCup0) * pull * subDt;
      ball.vy += (dcy / dCup0) * pull * subDt;
    }

    const decay = Math.exp(-friction * subDt);
    ball.vx *= decay;
    ball.vy *= decay;
    // Rolling resistance at crawl speeds (outside the divot) so the ball settles fast
    // instead of trickling on forever. Skip while floating in a gravity field on grass —
    // but keep it in sand so bunker friction still fights residual creep.
    const floating = !airborne && ballFloatingInGravity(ball, hole) && !inSand;
    if (
      !airborne &&
      !floating &&
      (dCup0 >= CUP_GRAVITY_RADIUS || !cupHasGravity(hole)) &&
      Math.hypot(ball.vx, ball.vy) < LOW_SPEED_CUTOFF
    ) {
      const extra = Math.exp(-LOW_SPEED_DRAG * subDt);
      ball.vx *= extra;
      ball.vy *= extra;
    }
    if (trappingIndex >= 0 && Math.hypot(ball.vx, ball.vy) < STICKY_STOP_SPEED) {
      // Exact zero — no float crawl that would diverge host/client under sticky drag.
      ball.vx = 0;
      ball.vy = 0;
      ball.stuckStickyIndex = trappingIndex;
      events.stuck = true;
    }
    ball.x += ball.vx * subDt;
    ball.y += ball.vy * subDt;

    if (airborne) {
      ball.z += ball.vz * subDt;
      ball.vz -= RAMP_GRAVITY * subDt;
      if (ball.z <= 0) { ball.z = 0; ball.vz = 0; events.landed = true; }
    }

    // Airborne balls fly over interior walls and moving obstacles; only the perimeter
    // fence is "tall" enough to knock them back in.
    const wallList = ball.z > 0 ? BOUNDARY_WALLS : walls;
    for (const w of wallList) {
      if (resolveWallCollision(ball, w)) events.bounced = true;
    }

    // Planets / moons: solid bounce (Orbit). Airborne skips interior solids like walls.
    if (ball.z <= 0) {
      const bodies = hole.gravityBodies || [];
      for (let bi = 0; bi < bodies.length; bi++) {
        if (resolvePlanetCollision(ball, bodies[bi])) events.bounced = true;
      }
    }

    if (ball.z <= 0) {
      for (const z of hole.ramps) {
        // Oriented pad: rectangle rotates with launch angle (boosts stay AABB).
        if (!circleTouchesRamp(ball.x, ball.y, BALL_RADIUS, z)) continue;
        // Launch only fires for balls moving UP the slope fast enough — the dot-product
        // gate means a ball rolling back down (or crossing against the ramp's direction)
        // can never launch.
        const along = ball.vx * Math.cos(z.angle) + ball.vy * Math.sin(z.angle);
        const speed = Math.hypot(ball.vx, ball.vy);
        if (along > 0 && speed >= z.minSpeed) {
          // Snap the direction fully to the ramp's angle so landing corridors are designable.
          ball.vx = Math.cos(z.angle) * speed;
          ball.vy = Math.sin(z.angle) * speed;
          ball.vz = Math.min(Math.max(speed * RAMP_VZ_SCALE, RAMP_VZ_MIN), RAMP_VZ_MAX);
          ball.z = 0.001;
          ball.angleDir = z.angle;
          events.launched = true;
        } else {
          // Constant downhill slope force: too-slow climbers stall AND roll back off the
          // ramp (a ball can never come to rest on the slope).
          ball.vx -= Math.cos(z.angle) * RAMP_UPHILL_ACCEL * subDt;
          ball.vy -= Math.sin(z.angle) * RAMP_UPHILL_ACCEL * subDt;
        }
        break;
      }
    }

    // Grounded-only interactions from here down: an airborne ball sails over boost pads,
    // water, and the cup alike.
    if (ball.z > 0) continue;

    let inBoost = null;
    let inBoostIndex = -1;
    for (let bi = 0; bi < hole.boost.length; bi++) {
      if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, hole.boost[bi])) {
        inBoost = hole.boost[bi];
        inBoostIndex = bi;
        break;
      }
    }
    // Each pad fires at most once per stroke (index-keyed so host/client agree).
    if (inBoost && !ball.firedBoosts.has(inBoostIndex)) {
      ball.vx += Math.cos(inBoost.angle) * inBoost.power;
      ball.vy += Math.sin(inBoost.angle) * inBoost.power;
      const boostedSpeed = Math.hypot(ball.vx, ball.vy);
      if (boostedSpeed > BOOST_MAX_SPEED) {
        ball.vx *= BOOST_MAX_SPEED / boostedSpeed;
        ball.vy *= BOOST_MAX_SPEED / boostedSpeed;
      }
      ball.firedBoosts.add(inBoostIndex);
      ball.squash = 0.7;
      ball.angleDir = Math.atan2(ball.vy, ball.vx);
      events.boosts.push(inBoost);
    }

    for (const z of hole.water) {
      if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) { events.water = z; return events; }
    }

    // Black hole capture: +1 stroke + tee reset handled by caller (not the cup win).
    {
      const bodies = hole.gravityBodies || [];
      for (let bi = 0; bi < bodies.length; bi++) {
        if (blackHoleCaptures(ball, bodies[bi])) {
          events.blackHole = bodies[bi];
          return events;
        }
      }
    }

    const dCup = Math.hypot(ball.x - hole.cup.x, ball.y - hole.cup.y);
    if (dCup < hole.cup.radius) { events.holed = true; return events; }
  }

  // Wet lasts for exactly one post-water putt: clear once that stroke settles.
  if (ball.wet && ball.wetStroke) {
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp < STOP_THRESHOLD && (ball.z || 0) === 0) {
      ball.wet = false;
      ball.wetStroke = false;
    }
  }

  return events;
}

function advanceHoleObstacles(hole, dt) {
  // Live angles/phases advance from their phase0-seeded start (see reset / setAtTick).
  for (const wm of hole.windmills) wm.angle += wm.rotationSpeed * dt;
  for (const p of hole.pendulums) p.phase += dt;
  for (const g of hole.gates) g.phase += dt;
  // Solo path: accumulate fractional ticks so moons stay tick-formula compatible.
  hole._orbitTick = (hole._orbitTick || 0) + dt / TICK_DT;
  const bodies = hole.gravityBodies || [];
  const tick = Math.floor(hole._orbitTick);
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i].kind === 'moon') setMoonPoseAtTick(bodies[i], tick);
  }
}

// Absolute obstacle pose from an integer sim tick. Multiplayer host and clients both use
// this so windmills/pendulums never drift from each other (and never need mid-roll
// obstacle snapshots that hard-reset phases and fork ball paths).
// Design-time phase0 / orbitPhase0 is preserved: pose = phase0 + rate * elapsed.
function setHoleObstaclesAtTick(hole, tick) {
  const t = tick * TICK_DT;
  for (const wm of hole.windmills) {
    const p0 = wm.phase0 || 0;
    wm.angle = p0 + wm.rotationSpeed * t;
  }
  for (const p of hole.pendulums) p.phase = (p.phase0 || 0) + t;
  for (const g of hole.gates) g.phase = (g.phase0 || 0) + t;
  const bodies = hole.gravityBodies || [];
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i].kind === 'moon') setMoonPoseAtTick(bodies[i], tick);
  }
  hole._orbitTick = tick;
}

function resetHoleObstacles(hole) {
  for (const wm of hole.windmills) wm.angle = wm.phase0 || 0;
  for (const p of hole.pendulums) p.phase = p.phase0 || 0;
  for (const g of hole.gates) g.phase = g.phase0 || 0;
  hole._orbitTick = 0;
  const bodies = hole.gravityBodies || [];
  for (let i = 0; i < bodies.length; i++) {
    if (bodies[i].kind === 'moon') setMoonPoseAtTick(bodies[i], 0);
  }
}

// Equal-mass elastic collision between two balls. Separates the overlap and exchanges the
// velocity component along the contact normal. Returns true when an impulse was applied
// (i.e. a real hit, not just resting contact) so the caller can play a clack sound.
function resolveBallBallCollision(a, b) {
  // Airborne balls pass clean over grounded ones (and each other at different heights is
  // close enough to never matter). `|| 0` guards older ball objects without a z field.
  if ((a.z || 0) > 0 || (b.z || 0) > 0) return false;
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const minDist = BALL_RADIUS * 2;
  if (dist >= minDist || dist < 0.0001) return false;
  const nx = dx / dist, ny = dy / dist;
  const overlap = (minDist - dist) / 2;
  a.x -= nx * overlap;
  a.y -= ny * overlap;
  b.x += nx * overlap;
  b.y += ny * overlap;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel < 0) {
    const j = -(1 + 0.92) * rel / 2;
    a.vx -= j * nx;
    a.vy -= j * ny;
    b.vx += j * nx;
    b.vy += j * ny;
    return true;
  }
  return false;
}

// Multiplayer tee-off spots: players line up perpendicular to the tee->cup play line with
// ample spacing, clamped inside the course walls.
function teePositionFor(index, count, hole) {
  const dx = hole.cup.x - hole.tee.x, dy = hole.cup.y - hole.tee.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len, py = dx / len;
  const spacing = 32;
  const offset = (index - (count - 1) / 2) * spacing;
  const margin = BALL_RADIUS * 2;
  return {
    x: Math.min(Math.max(hole.tee.x + px * offset, BOUND.left + margin), BOUND.right - margin),
    y: Math.min(Math.max(hole.tee.y + py * offset, BOUND.top + margin), BOUND.bottom - margin),
  };
}

// Launch-power multiplier for a ball sitting in sticky goo — every launch site (server putt
// handler, solo launch, client prediction) applies this identically so the authoritative and
// predicted escape shots match. Deliberately keyed off position, not `stuckTo`, so even a
// ball that rolled into goo and stopped short of "stuck" putts out weakened.
function stickyLaunchFactor(ball, hole) {
  return stickyIndexAt(ball, hole) >= 0 ? STICKY_LAUNCH_FACTOR : 1;
}

// Given a raw drag vector (pull-back from the ball), returns the launch velocity. Shared so
// the server can independently (and authoritatively) recompute it from a client's raw drag
// rather than ever trusting a client-sent speed.
function computeLaunchVelocity(pointerVec) {
  const dragLen = Math.hypot(pointerVec.x, pointerVec.y);
  const dirX = -pointerVec.x / dragLen, dirY = -pointerVec.y / dragLen;
  const speed = Math.min(dragLen * POWER_MULTIPLIER, MAX_LAUNCH_SPEED);
  return { vx: dirX * speed, vy: dirY * speed, speed };
}

// Same clamp host and clients use before computeLaunchVelocity — keeps optimistic putts
// bit-identical to puttApplied when the raw drag is accepted.
function clampDragVector(v) {
  const dragLen = Math.hypot(v.x, v.y);
  if (dragLen < MIN_DRAG_DIST || !Number.isFinite(dragLen)) return null;
  const clampedLen = Math.min(dragLen, MAX_DRAG_DIST);
  return { x: (v.x / dragLen) * clampedLen, y: (v.y / dragLen) * clampedLen, len: clampedLen };
}

// ---- Custom level codec (URL ?lvl= base64url, independent of ?room=) ----
// v2: windmill phase0 (radians) packed after rotationSpeed. v1 decodes with phase0=0.
const LEVEL_CODEC_VERSION = 2;
const LEVEL_MAX_B64_LEN = 4096;
const LEVEL_MAX_NAME_LEN = 40;
const LEVEL_CAPS = {
  walls: 40,
  sand: 20,
  water: 20,
  boost: 20,
  ramps: 20,
  sticky: 20,
  pendulums: 6,
  gates: 6,
  windmills: 6,
  gravityBodies: 8,
};

function blankHole(overrides) {
  const h = {
    name: 'Custom Hole',
    par: 3,
    tee: { x: 90, y: 250 },
    cup: { x: 710, y: 250, radius: 11 },
    walls: [],
    sand: [],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    ramps: [],
    sticky: [],
    gravityBodies: [],
  };
  if (overrides && typeof overrides === 'object') Object.assign(h, overrides);
  return h;
}

function qCoord(v) {
  const n = Math.round(Number(v) * 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-32768, Math.min(32767, n));
}
function uqCoord(n) { return n / 10; }
function qF100(v) {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-32768, Math.min(32767, n));
}
function uqF100(n) { return n / 100; }
function qF10(v) {
  const n = Math.round(Number(v) * 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-32768, Math.min(32767, n));
}
function uqF10(n) { return n / 10; }

function bytesFromBase64Url(str) {
  if (typeof str !== 'string' || !str) return null;
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  try {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

function base64UrlFromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  let b64;
  if (typeof Buffer !== 'undefined') b64 = Buffer.from(bytes).toString('base64');
  else b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function ByteWriter(cap) {
  this.buf = new Uint8Array(cap || 4096);
  this.i = 0;
}
ByteWriter.prototype.ensure = function (n) {
  if (this.i + n <= this.buf.length) return;
  const next = new Uint8Array(Math.max(this.buf.length * 2, this.i + n));
  next.set(this.buf);
  this.buf = next;
};
ByteWriter.prototype.u8 = function (v) {
  this.ensure(1);
  this.buf[this.i++] = v & 0xff;
};
ByteWriter.prototype.i16 = function (v) {
  this.ensure(2);
  const x = v | 0;
  this.buf[this.i++] = x & 0xff;
  this.buf[this.i++] = (x >> 8) & 0xff;
};
ByteWriter.prototype.bytes = function () {
  return this.buf.subarray(0, this.i);
};

function ByteReader(bytes) {
  this.buf = bytes;
  this.i = 0;
}
ByteReader.prototype.remaining = function () { return this.buf.length - this.i; };
ByteReader.prototype.u8 = function () {
  if (this.i >= this.buf.length) throw new Error('eof');
  return this.buf[this.i++];
};
ByteReader.prototype.i16 = function () {
  if (this.i + 2 > this.buf.length) throw new Error('eof');
  const lo = this.buf[this.i++];
  const hi = this.buf[this.i++];
  let v = lo | (hi << 8);
  if (v & 0x8000) v = v - 0x10000;
  return v;
};

function normalizeGravityBody(b) {
  if (!b || typeof b !== 'object') return null;
  const kind = b.kind;
  if (kind !== 'planet' && kind !== 'blackHole' && kind !== 'moon') return null;
  const radius = Number(b.radius) || 10;
  const mass = Number(b.mass) || 1;
  const body = {
    kind,
    x: Number(b.x) || 0,
    y: Number(b.y) || 0,
    radius,
    mass,
    fieldRadius: b.fieldRadius != null ? Number(b.fieldRadius) : radius * 6,
    drawRadius: b.drawRadius != null ? Number(b.drawRadius) : (kind === 'blackHole' ? Math.min(radius, 5) : radius),
  };
  if (kind === 'moon') {
    const oc = b.orbitCenter || { x: body.x, y: body.y };
    body.orbitCenter = { x: Number(oc.x) || 0, y: Number(oc.y) || 0 };
    body.orbitRadius = b.orbitRadius != null ? Number(b.orbitRadius) : 80;
    body.orbitPeriodTicks = b.orbitPeriodTicks != null ? Number(b.orbitPeriodTicks) : 240;
    body.orbitPhase0 = b.orbitPhase0 != null ? Number(b.orbitPhase0) : 0;
    setMoonPoseAtTick(body, 0);
  }
  return body;
}

function normalizeHole(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.slice(0, LEVEL_MAX_NAME_LEN) : 'Custom Hole';
  let par = Math.round(Number(raw.par));
  if (!Number.isFinite(par) || par < 1) par = 3;
  if (par > 10) par = 10;
  const tee = raw.tee && typeof raw.tee === 'object'
    ? { x: Number(raw.tee.x) || 90, y: Number(raw.tee.y) || 250 }
    : { x: 90, y: 250 };
  const cupIn = raw.cup && typeof raw.cup === 'object' ? raw.cup : {};
  const cup = {
    x: Number(cupIn.x) || 710,
    y: Number(cupIn.y) || 250,
    radius: cupIn.radius != null ? Number(cupIn.radius) : 11,
  };
  if (!Number.isFinite(cup.radius) || cup.radius <= 0) cup.radius = 11;

  function mapWalls(arr) {
    return (arr || []).map((w) => wall(w.x1, w.y1, w.x2, w.y2, { bumper: !!w.bumper }));
  }
  function mapRects(arr, kind) {
    return (arr || []).map((z) => {
      if (z.shape === 'circle') {
        // Codec v1 is rect-only; expand circle to AABB for import safety.
        return { shape: 'rect', x1: z.cx - z.r, y1: z.cy - z.r, x2: z.cx + z.r, y2: z.cy + z.r };
      }
      return { shape: 'rect', x1: Number(z.x1), y1: Number(z.y1), x2: Number(z.x2), y2: Number(z.y2) };
    }).filter((z) => Number.isFinite(z.x1) && Number.isFinite(z.y1) && Number.isFinite(z.x2) && Number.isFinite(z.y2));
  }
  function mapWater(arr) {
    return (arr || []).map((z) => {
      const drop = z.dropPoint && typeof z.dropPoint === 'object'
        ? { x: Number(z.dropPoint.x), y: Number(z.dropPoint.y) }
        : { x: (Number(z.x1) + Number(z.x2)) / 2, y: Number(z.y1) - 20 };
      return waterRect(z.x1, z.y1, z.x2, z.y2, drop);
    }).filter((z) => Number.isFinite(z.x1));
  }
  function mapBoost(arr) {
    return (arr || []).map((z) => boostRect(z.x1, z.y1, z.x2, z.y2, Number(z.angle) || 0, Number(z.power) || 500));
  }
  function mapRamp(arr) {
    return (arr || []).map((z) => rampRect(z.x1, z.y1, z.x2, z.y2, Number(z.angle) || 0, Number(z.minSpeed) || RAMP_MIN_SPEED));
  }
  function mapPend(arr) {
    return (arr || []).map((p) => {
      // Prefer stable design offset phase0 so live phase (advanced in editor/game) is not baked in.
      const p0 = p.phase0 != null ? p.phase0 : (p.phaseOffset != null ? p.phaseOffset : (p.phase || 0));
      return pendulum(p.cx, p.cy, p.length, p.angleCenter, p.amplitude, p.period, p0);
    });
  }
  function mapGates(arr) {
    return (arr || []).map((g) => {
      const p0 = g.phase0 != null ? g.phase0 : (g.phaseOffset != null ? g.phaseOffset : (g.phase || 0));
      return slidingGate(g.x1, g.y1, g.x2, g.y2, g.axis === 'y' ? 'y' : 'x', g.amplitude, g.period, p0);
    });
  }
  function mapMills(arr) {
    return (arr || []).map((wm) => {
      const phase0 = wm.phase0 != null ? Number(wm.phase0) : 0;
      const p0 = Number.isFinite(phase0) ? phase0 : 0;
      return {
        cx: Number(wm.cx),
        cy: Number(wm.cy),
        armLength: Number(wm.armLength) || 80,
        blades: Math.max(2, Math.min(8, Math.round(Number(wm.blades) || 4))),
        rotationSpeed: Number(wm.rotationSpeed) || 1,
        phase0: p0,
        // Live angle starts at design offset; game/editor advance from here.
        angle: p0,
      };
    });
  }
  function mapBodies(arr) {
    return (arr || []).map(normalizeGravityBody).filter(Boolean);
  }

  const hole = {
    name,
    par,
    tee,
    cup,
    walls: mapWalls(raw.walls),
    sand: mapRects(raw.sand),
    water: mapWater(raw.water),
    boost: mapBoost(raw.boost),
    ramps: mapRamp(raw.ramps),
    sticky: mapRects(raw.sticky),
    pendulums: mapPend(raw.pendulums),
    gates: mapGates(raw.gates),
    windmills: mapMills(raw.windmills),
    gravityBodies: mapBodies(raw.gravityBodies),
  };
  delete hole._cupMagnet;
  hole._orbitTick = 0;
  return hole;
}

function holeObjectCounts(hole) {
  return {
    walls: (hole.walls || []).length,
    sand: (hole.sand || []).length,
    water: (hole.water || []).length,
    boost: (hole.boost || []).length,
    ramps: (hole.ramps || []).length,
    sticky: (hole.sticky || []).length,
    pendulums: (hole.pendulums || []).length,
    gates: (hole.gates || []).length,
    windmills: (hole.windmills || []).length,
    gravityBodies: (hole.gravityBodies || []).length,
  };
}

function validateHole(raw) {
  const hole = normalizeHole(raw);
  if (!hole) return { ok: false, error: 'invalid_hole' };
  if (typeof hole.name !== 'string' || hole.name.length === 0 || hole.name.length > LEVEL_MAX_NAME_LEN) {
    return { ok: false, error: 'bad_name' };
  }
  if (hole.par < 1 || hole.par > 10) return { ok: false, error: 'bad_par' };
  const counts = holeObjectCounts(hole);
  for (const key of Object.keys(LEVEL_CAPS)) {
    if (counts[key] > LEVEL_CAPS[key]) {
      return { ok: false, error: 'over_cap', field: key, count: counts[key], max: LEVEL_CAPS[key] };
    }
  }
  const margin = 40;
  function inBounds(x, y) {
    return x >= -margin && x <= LOGICAL_W + margin && y >= -margin && y <= LOGICAL_H + margin;
  }
  if (!inBounds(hole.tee.x, hole.tee.y) || !inBounds(hole.cup.x, hole.cup.y)) {
    return { ok: false, error: 'out_of_bounds' };
  }
  for (const w of hole.water) {
    if (!w.dropPoint || !Number.isFinite(w.dropPoint.x) || !Number.isFinite(w.dropPoint.y)) {
      return { ok: false, error: 'water_drop' };
    }
  }
  // Size budget: pack and measure (reject if encoded share string would exceed budget).
  try {
    const packed = packHoleBytes(hole);
    const b64 = base64UrlFromBytes(packed);
    if (b64.length > LEVEL_MAX_B64_LEN) {
      return { ok: false, error: 'oversize', size: b64.length, max: LEVEL_MAX_B64_LEN };
    }
  } catch (e) {
    return { ok: false, error: 'pack_failed' };
  }
  return { ok: true, hole };
}

function packHoleBytes(hole) {
  const w = new ByteWriter(2048);
  w.u8(LEVEL_CODEC_VERSION);
  w.u8(hole.par & 0xff);
  const nameBytes = [];
  const nameStr = String(hole.name || '').slice(0, LEVEL_MAX_NAME_LEN);
  for (let i = 0; i < nameStr.length; i++) {
    const c = nameStr.charCodeAt(i);
    nameBytes.push(c < 128 ? c : 63); // ASCII-ish; '?' for non-ascii
  }
  w.u8(nameBytes.length);
  for (let i = 0; i < nameBytes.length; i++) w.u8(nameBytes[i]);
  w.i16(qCoord(hole.tee.x));
  w.i16(qCoord(hole.tee.y));
  w.i16(qCoord(hole.cup.x));
  w.i16(qCoord(hole.cup.y));
  w.i16(qCoord(hole.cup.radius));

  function writeWalls(arr) {
    w.u8(arr.length);
    for (const x of arr) {
      w.i16(qCoord(x.x1)); w.i16(qCoord(x.y1)); w.i16(qCoord(x.x2)); w.i16(qCoord(x.y2));
      w.u8(x.bumper ? 1 : 0);
    }
  }
  function writeRects(arr) {
    w.u8(arr.length);
    for (const z of arr) {
      w.i16(qCoord(z.x1)); w.i16(qCoord(z.y1)); w.i16(qCoord(z.x2)); w.i16(qCoord(z.y2));
    }
  }
  function writeWater(arr) {
    w.u8(arr.length);
    for (const z of arr) {
      w.i16(qCoord(z.x1)); w.i16(qCoord(z.y1)); w.i16(qCoord(z.x2)); w.i16(qCoord(z.y2));
      w.i16(qCoord(z.dropPoint.x)); w.i16(qCoord(z.dropPoint.y));
    }
  }
  function writeBoost(arr) {
    w.u8(arr.length);
    for (const z of arr) {
      w.i16(qCoord(z.x1)); w.i16(qCoord(z.y1)); w.i16(qCoord(z.x2)); w.i16(qCoord(z.y2));
      w.i16(qF100(z.angle)); w.i16(qF10(z.power));
    }
  }
  function writeRamp(arr) {
    w.u8(arr.length);
    for (const z of arr) {
      w.i16(qCoord(z.x1)); w.i16(qCoord(z.y1)); w.i16(qCoord(z.x2)); w.i16(qCoord(z.y2));
      w.i16(qF100(z.angle)); w.i16(qF10(z.minSpeed || RAMP_MIN_SPEED));
    }
  }
  function writePend(arr) {
    w.u8(arr.length);
    for (const p of arr) {
      w.i16(qCoord(p.cx)); w.i16(qCoord(p.cy)); w.i16(qCoord(p.length));
      w.i16(qF100(p.angleCenter)); w.i16(qF100(p.amplitude)); w.i16(qF100(p.period));
      // Store design-time phase offset (seconds), not the live advanced phase.
      w.i16(qF100(p.phase0 != null ? p.phase0 : (p.phase || 0)));
    }
  }
  function writeGates(arr) {
    w.u8(arr.length);
    for (const g of arr) {
      w.i16(qCoord(g.x1)); w.i16(qCoord(g.y1)); w.i16(qCoord(g.x2)); w.i16(qCoord(g.y2));
      w.u8(g.axis === 'y' ? 1 : 0);
      w.i16(qCoord(g.amplitude)); w.i16(qF100(g.period));
      w.i16(qF100(g.phase0 != null ? g.phase0 : (g.phase || 0)));
    }
  }
  function writeMills(arr) {
    w.u8(arr.length);
    for (const m of arr) {
      w.i16(qCoord(m.cx)); w.i16(qCoord(m.cy)); w.i16(qCoord(m.armLength));
      w.u8(m.blades & 0xff); w.i16(qF100(m.rotationSpeed));
      // v2: design-time angular phase offset (radians). angle = phase0 + rotationSpeed * t
      w.i16(qF100(m.phase0 || 0));
    }
  }
  function writeBodies(arr) {
    w.u8(arr.length);
    for (const b of arr) {
      const kindCode = b.kind === 'blackHole' ? 1 : b.kind === 'moon' ? 2 : 0;
      w.u8(kindCode);
      w.i16(qCoord(b.x)); w.i16(qCoord(b.y));
      w.i16(qCoord(b.radius)); w.i16(qF10(b.mass));
      w.i16(qCoord(b.fieldRadius)); w.i16(qCoord(b.drawRadius));
      if (kindCode === 2) {
        w.i16(qCoord(b.orbitCenter.x)); w.i16(qCoord(b.orbitCenter.y));
        w.i16(qCoord(b.orbitRadius));
        w.i16(Math.max(1, Math.round(b.orbitPeriodTicks || 240)));
        w.i16(qF100(b.orbitPhase0 || 0));
      }
    }
  }

  writeWalls(hole.walls);
  writeRects(hole.sand);
  writeWater(hole.water);
  writeBoost(hole.boost);
  writeRamp(hole.ramps);
  writeRects(hole.sticky);
  writePend(hole.pendulums);
  writeGates(hole.gates);
  writeMills(hole.windmills);
  writeBodies(hole.gravityBodies);
  return w.bytes();
}

function unpackHoleBytes(bytes) {
  const r = new ByteReader(bytes);
  const ver = r.u8();
  // Accept current and prior (v1) layouts; unknown versions reject.
  if (ver !== LEVEL_CODEC_VERSION && ver !== 1) {
    const err = new Error('bad_version');
    err.code = 'bad_version';
    err.version = ver;
    throw err;
  }
  const par = r.u8();
  const nameLen = r.u8();
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(r.u8());
  const tee = { x: uqCoord(r.i16()), y: uqCoord(r.i16()) };
  const cup = { x: uqCoord(r.i16()), y: uqCoord(r.i16()), radius: uqCoord(r.i16()) };

  function readWalls() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const x1 = uqCoord(r.i16()), y1 = uqCoord(r.i16()), x2 = uqCoord(r.i16()), y2 = uqCoord(r.i16());
      const bumper = r.u8() === 1;
      arr.push(wall(x1, y1, x2, y2, { bumper }));
    }
    return arr;
  }
  function readRects() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      arr.push({ shape: 'rect', x1: uqCoord(r.i16()), y1: uqCoord(r.i16()), x2: uqCoord(r.i16()), y2: uqCoord(r.i16()) });
    }
    return arr;
  }
  function readWater() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const x1 = uqCoord(r.i16()), y1 = uqCoord(r.i16()), x2 = uqCoord(r.i16()), y2 = uqCoord(r.i16());
      const dx = uqCoord(r.i16()), dy = uqCoord(r.i16());
      arr.push(waterRect(x1, y1, x2, y2, { x: dx, y: dy }));
    }
    return arr;
  }
  function readBoost() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const x1 = uqCoord(r.i16()), y1 = uqCoord(r.i16()), x2 = uqCoord(r.i16()), y2 = uqCoord(r.i16());
      const angle = uqF100(r.i16()), power = uqF10(r.i16());
      arr.push(boostRect(x1, y1, x2, y2, angle, power));
    }
    return arr;
  }
  function readRamp() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const x1 = uqCoord(r.i16()), y1 = uqCoord(r.i16()), x2 = uqCoord(r.i16()), y2 = uqCoord(r.i16());
      const angle = uqF100(r.i16()), minSpeed = uqF10(r.i16());
      arr.push(rampRect(x1, y1, x2, y2, angle, minSpeed));
    }
    return arr;
  }
  function readPend() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const cx = uqCoord(r.i16()), cy = uqCoord(r.i16()), length = uqCoord(r.i16());
      const angleCenter = uqF100(r.i16()), amplitude = uqF100(r.i16()), period = uqF100(r.i16());
      const phase = uqF100(r.i16());
      arr.push(pendulum(cx, cy, length, angleCenter, amplitude, period, phase));
    }
    return arr;
  }
  function readGates() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const x1 = uqCoord(r.i16()), y1 = uqCoord(r.i16()), x2 = uqCoord(r.i16()), y2 = uqCoord(r.i16());
      const axis = r.u8() === 1 ? 'y' : 'x';
      const amplitude = uqCoord(r.i16()), period = uqF100(r.i16()), phase = uqF100(r.i16());
      arr.push(slidingGate(x1, y1, x2, y2, axis, amplitude, period, phase));
    }
    return arr;
  }
  function readMills() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const cx = uqCoord(r.i16()), cy = uqCoord(r.i16()), armLength = uqCoord(r.i16());
      const blades = r.u8(), rotationSpeed = uqF100(r.i16());
      // v2 packs phase0 (rad); v1 has no field → default 0 so old share links still load.
      const phase0 = ver >= 2 ? uqF100(r.i16()) : 0;
      arr.push({
        cx, cy, armLength, blades, rotationSpeed, phase0, angle: phase0,
      });
    }
    return arr;
  }
  function readBodies() {
    const n = r.u8();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const kindCode = r.u8();
      const x = uqCoord(r.i16()), y = uqCoord(r.i16());
      const radius = uqCoord(r.i16()), mass = uqF10(r.i16());
      const fieldRadius = uqCoord(r.i16()), drawRadius = uqCoord(r.i16());
      if (kindCode === 2) {
        const ocx = uqCoord(r.i16()), ocy = uqCoord(r.i16());
        const orbitRadius = uqCoord(r.i16());
        const periodTicks = r.i16();
        const phase0 = uqF100(r.i16());
        arr.push(moon(ocx, ocy, orbitRadius, radius, mass, periodTicks, {
          fieldRadius, drawRadius, orbitPhase0: phase0,
        }));
      } else if (kindCode === 1) {
        arr.push(blackHole(x, y, radius, mass, { fieldRadius, drawRadius }));
      } else {
        arr.push(planet(x, y, radius, mass, { fieldRadius, drawRadius }));
      }
    }
    return arr;
  }

  const raw = {
    name, par, tee, cup,
    walls: readWalls(),
    sand: readRects(),
    water: readWater(),
    boost: readBoost(),
    ramps: readRamp(),
    sticky: readRects(),
    pendulums: readPend(),
    gates: readGates(),
    windmills: readMills(),
    gravityBodies: readBodies(),
  };
  return normalizeHole(raw);
}

function encodeHole(raw) {
  const v = validateHole(raw);
  if (!v.ok) {
    const err = new Error(v.error || 'invalid');
    err.code = v.error;
    err.detail = v;
    throw err;
  }
  return base64UrlFromBytes(packHoleBytes(v.hole));
}

function decodeHole(str) {
  if (typeof str !== 'string' || !str.length) {
    return { ok: false, error: 'empty' };
  }
  if (str.length > LEVEL_MAX_B64_LEN) {
    return { ok: false, error: 'oversize', size: str.length, max: LEVEL_MAX_B64_LEN };
  }
  // Reject characters outside base64url alphabet early.
  if (!/^[A-Za-z0-9\-_]+$/.test(str)) {
    return { ok: false, error: 'garbage' };
  }
  const bytes = bytesFromBase64Url(str);
  if (!bytes || !bytes.length) return { ok: false, error: 'garbage' };
  let hole;
  try {
    hole = unpackHoleBytes(bytes);
  } catch (e) {
    if (e && e.code === 'bad_version') return { ok: false, error: 'bad_version', version: e.version };
    return { ok: false, error: 'garbage' };
  }
  const v = validateHole(hole);
  if (!v.ok) return v;
  return { ok: true, hole: v.hole };
}

/**
 * Absolute ceiling so pathological paths (stable gravity orbits that never rest)
 * cannot run forever. Not a design target for normal putts — progressive ghost
 * stops at natural end well before this.
 */
const TRAJECTORY_SAFETY_MAX_TICKS = TICK_HZ * 120; // 2 minutes of sim time

/**
 * Start a ghost trajectory sim (clones hole; does not mutate inputs).
 * Call stepTrajectorySim repeatedly with a soft per-frame budget until sim.done.
 *
 * @param {object} hole
 * @param {{x,y,z?,vz?,stuckStickyIndex?,wet?,wetStroke?}} startBall
 * @param {number} vx
 * @param {number} vy
 * @param {{sampleEvery?,advanceMovers?,safetyMaxTicks?}} opts
 *   advanceMovers: when true (editor default), clone advances windmills/gates/etc.
 *   from the snapshot pose so the ghost path matches a live putt. Default false
 *   for one-shot callers that want a frozen world.
 * @returns {object} sim — { pts, done, endReason, ticksRun, ... }
 */
function createTrajectorySim(hole, startBall, vx, vy, opts) {
  opts = opts || {};
  const sampleEvery = opts.sampleEvery != null ? opts.sampleEvery : 2;
  const advanceMovers = opts.advanceMovers === true;
  const safetyMaxTicks = opts.safetyMaxTicks != null ? opts.safetyMaxTicks : TRAJECTORY_SAFETY_MAX_TICKS;

  const h = normalizeHole(JSON.parse(JSON.stringify({
    name: hole.name,
    par: hole.par,
    tee: hole.tee,
    cup: hole.cup,
    walls: hole.walls,
    sand: hole.sand,
    water: hole.water,
    boost: hole.boost,
    ramps: hole.ramps,
    sticky: hole.sticky,
    pendulums: hole.pendulums,
    gates: hole.gates,
    windmills: hole.windmills,
    gravityBodies: hole.gravityBodies,
  })));
  // Preserve current obstacle phases from the live hole when frozen.
  if (hole.windmills) {
    for (let i = 0; i < h.windmills.length && i < hole.windmills.length; i++) {
      h.windmills[i].angle = hole.windmills[i].angle || 0;
    }
  }
  if (hole.pendulums) {
    for (let i = 0; i < h.pendulums.length && i < hole.pendulums.length; i++) {
      h.pendulums[i].phase = hole.pendulums[i].phase || 0;
    }
  }
  if (hole.gates) {
    for (let i = 0; i < h.gates.length && i < hole.gates.length; i++) {
      h.gates[i].phase = hole.gates[i].phase || 0;
    }
  }
  h._orbitTick = hole._orbitTick || 0;
  if (hole.gravityBodies) {
    for (let i = 0; i < h.gravityBodies.length && i < hole.gravityBodies.length; i++) {
      const src = hole.gravityBodies[i];
      const dst = h.gravityBodies[i];
      if (src.kind === 'moon' && dst.kind === 'moon') {
        dst.x = src.x; dst.y = src.y;
        if (src._omega != null) dst._omega = src._omega;
      }
    }
  }

  const ball = createBallState(h.tee);
  ball.x = startBall.x;
  ball.y = startBall.y;
  ball.z = startBall.z || 0;
  ball.vz = startBall.vz || 0;
  ball.stuckStickyIndex = typeof startBall.stuckStickyIndex === 'number' ? startBall.stuckStickyIndex : -1;
  ball.wet = !!startBall.wet;
  ball.wetStroke = !!startBall.wetStroke;
  ball.vx = vx;
  ball.vy = vy;
  ball.firedBoosts = new Set();

  return {
    h,
    ball,
    pts: [{ x: ball.x, y: ball.y }],
    sampleEvery,
    advanceMovers,
    safetyMaxTicks,
    ticksRun: 0,
    done: false,
    /** @type {null|'holed'|'water'|'blackHole'|'rest'|'safety'} */
    endReason: null,
  };
}

/**
 * Advance a trajectory sim by up to budgetTicks physics steps.
 * Soft per-frame budgets: same inputs → keep stepping until natural end.
 * @returns {object} sim (mutated)
 */
function stepTrajectorySim(sim, budgetTicks) {
  if (!sim || sim.done) return sim;
  const budget = Math.max(0, budgetTicks | 0);
  for (let i = 0; i < budget; i++) {
    if (sim.ticksRun >= sim.safetyMaxTicks) {
      sim.done = true;
      sim.endReason = 'safety';
      break;
    }
    if (sim.advanceMovers) advanceHoleObstacles(sim.h, TICK_DT);
    const ev = stepBallPhysics(sim.ball, sim.h, TICK_DT);
    if (sim.ticksRun % sim.sampleEvery === 0) {
      sim.pts.push({ x: sim.ball.x, y: sim.ball.y });
    }
    sim.ticksRun++;
    if (ev.holed || ev.water || ev.blackHole) {
      sim.pts.push({ x: sim.ball.x, y: sim.ball.y });
      sim.done = true;
      sim.endReason = ev.holed ? 'holed' : (ev.water ? 'water' : 'blackHole');
      break;
    }
    const speed = Math.hypot(sim.ball.vx, sim.ball.vy);
    if (speed < STOP_THRESHOLD && (sim.ball.z || 0) === 0 && ballMayRestForAim(sim.ball, sim.h)) {
      sim.pts.push({ x: sim.ball.x, y: sim.ball.y });
      sim.done = true;
      sim.endReason = 'rest';
      break;
    }
  }
  return sim;
}

/**
 * One-shot ghost path (runs until natural end or maxTicks / safety).
 * Prefer createTrajectorySim + stepTrajectorySim for progressive UI.
 * @param {{maxTicks?,sampleEvery?,advanceMovers?,safetyMaxTicks?}} opts
 *   maxTicks: optional hard budget for this call (tests / one-shot). Default = safety ceiling.
 */
function simulateTrajectory(hole, startBall, vx, vy, opts) {
  opts = opts || {};
  const sim = createTrajectorySim(hole, startBall, vx, vy, opts);
  const maxTicks = opts.maxTicks != null ? opts.maxTicks : sim.safetyMaxTicks;
  stepTrajectorySim(sim, maxTicks);
  return sim.pts;
}

function deepCloneHole(hole) {
  return normalizeHole(JSON.parse(JSON.stringify(hole)));
}

return {
  TICK_HZ, TICK_DT, TICK_MS, tickToElapsedMs, elapsedMsToTick,
  LOGICAL_W, LOGICAL_H, BALL_RADIUS, FRICTION_GRASS, FRICTION_SAND, SAND_GRAVITY_HOLD, STOP_THRESHOLD,
  CUP_GRAVITY_RADIUS,
  WALL_RESTITUTION, WALL_THICKNESS, WALL_HALF_WIDTH,
  BUMPER_RESTITUTION, PENDULUM_RESTITUTION, GATE_RESTITUTION,
  MAX_DRAG_DIST, MIN_DRAG_DIST, POWER_MULTIPLIER, MAX_LAUNCH_SPEED, BOOST_MAX_SPEED, BOUND,
  RAMP_MIN_SPEED, RAMP_GRAVITY, RAMP_VZ_SCALE, RAMP_VZ_MIN, RAMP_VZ_MAX,
  FRICTION_STICKY, STICKY_STOP_SPEED, STICKY_LAUNCH_FACTOR, FRICTION_WET_GOO,
  GRAVITY_G, PLANET_RESTITUTION, ESCAPE_SPEED_MARGIN,
  wall, sandRect, waterRect, boostRect, rampRect, stickyRect, pendulum, getPendulumSegment, slidingGate,
  getSlidingGateSegment, ringBumpers, pointInZone, circleTouchesZone, zoneBounds, cupHasGravity,
  zoneCenterXY, orientedRectCorners, circleTouchesOrientedRect, circleTouchesRamp,
  gravityBody, planet, blackHole, moon, escapeSpeed, bodyCanEscapeAtMaxLaunch,
  planetContactRadius, ballOnPlanetCrust, ballFloatingInGravity, ballMayRestForAim,
  QUASI_REST_WINDOW_S, QUASI_REST_AVG_SPEED,
  createSpeedAvgTracker, resetSpeedAvgTracker, noteSpeedSample, speedAvg, isQuasiRest, mayPuttBall,
  ballInSand, effectiveGravityMag, gravityAccelAt, REST_GRAVITY_EPS, SAND_GRAVITY_HOLD,
  setMoonPoseAtTick, applyGravityAcceleration, resolvePlanetCollision, blackHoleCaptures,
  BOUNDARY_WALLS, HOLES, ORBIT_HOLES, COURSES,
  resolveWallCollision, getWindmillBlades,
  createBallState, stepBallPhysics, advanceHoleObstacles, setHoleObstaclesAtTick, resetHoleObstacles,
  computeLaunchVelocity, clampDragVector, stickyLaunchFactor, stickyIndexAt, latchStickyAfterPutt,
  markWetFromWater, noteWetPutt,
  resolveBallBallCollision, teePositionFor,
  LEVEL_CODEC_VERSION, LEVEL_MAX_B64_LEN, LEVEL_CAPS, LEVEL_MAX_NAME_LEN,
  blankHole, normalizeHole, validateHole, encodeHole, decodeHole,
  packHoleBytes, unpackHoleBytes, simulateTrajectory, createTrajectorySim, stepTrajectorySim,
  TRAJECTORY_SAFETY_MAX_TICKS, deepCloneHole, holeObjectCounts,
};

});
