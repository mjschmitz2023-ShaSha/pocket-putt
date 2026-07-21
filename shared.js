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
  // Portal dual-sample can pull without a world-side field — treat as floating so
  // low-speed crawl drag does not cancel the mapped well (editor Test / solo).
  if (getPortalGravityMode(hole) !== 'off') {
    const dual = portalGravityDualSample(ball, hole);
    if (Math.hypot(dual.ax, dual.ay) >= REST_GRAVITY_EPS) return true;
  }
  // Material portal bake: g may be non-zero far from any world fieldRadius.
  if (hole && hole._portalGravityCache) {
    const g = gravityAccelAt(ball, hole);
    if (g.mag >= REST_GRAVITY_EPS_PORTAL) return true;
  }
  return false;
}

/**
 * World-space gravity only (no portal dual-sample). `sample` is {x,y} (ball or virtual point).
 * When the sample is on a planet/moon crust, that body's *radial* pull is cancelled (surface
 * normal force). Tangential pulls from *other* bodies still apply.
 */
function gravityAccelAtWorld(sample, hole) {
  let ax = 0;
  let ay = 0;
  const sx = sample.x, sy = sample.y;
  const bodies = hole.gravityBodies || [];
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dx = b.x - sx; // toward body
    const dy = b.y - sy;
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
      const onx = (sx - b.x) / r; // outward normal
      const ony = (sy - b.y) / r;
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

/**
 * Net gravitational acceleration at the ball (same sampling as applyGravityAcceleration).
 *
 * When a portal-gravity bake is attached (hole._portalGravityCache), that field is the
 * sole source of g — material-space mass BEM + accelerating-mouth Φ_ξ over the level
 * period (see portal-gravity.js). Otherwise: world sample + optional dual-sample modes.
 */
function gravityAccelAt(ball, hole) {
  const cache = hole && hole._portalGravityCache;
  if (cache && cache.frames && cache.frames.length) {
    const PG = (typeof globalThis !== 'undefined' && globalThis.PortalGravity)
      || (typeof self !== 'undefined' && self.PortalGravity)
      || null;
    if (PG && typeof PG.samplePortalGravity === 'function') {
      const tick = Math.floor(hole._orbitTick || 0);
      const g = PG.samplePortalGravity(cache, ball.x, ball.y, tick);
      const mag = Math.hypot(g.ax || 0, g.ay || 0);
      return { ax: g.ax || 0, ay: g.ay || 0, mag };
    }
  }
  const world = gravityAccelAtWorld(ball, hole);
  const dual = portalGravityDualSample(ball, hole);
  const ax = world.ax + dual.ax;
  const ay = world.ay + dual.ay;
  return { ax, ay, mag: Math.hypot(ax, ay) };
}

// If |g| exceeds this while "stopped", keep simulating — moon (etc.) is pulling.
const REST_GRAVITY_EPS = 25;
/** Lower rest band when material portal bake is active (through-portal wells are often weaker). */
const REST_GRAVITY_EPS_PORTAL = 2.5;

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
  // Portal material fields are often weaker than local Orbit wells — use a lower floor.
  const restEps = (hole && hole._portalGravityCache) ? REST_GRAVITY_EPS_PORTAL : REST_GRAVITY_EPS;
  if (effectiveGravityMag(ball, hole) >= restEps) return false;
  return true;
}

/**
 * Quasi-rest: if average |v| stays near zero for several seconds (e.g. endless
 * soft-bounce on a bumper in a gravity well), allow a putt even though the ball
 * is not a clean AIMING rest. Window + threshold are shared by solo/MP/editor.
 */
const QUASI_REST_WINDOW_S = 5;
const QUASI_REST_AVG_SPEED = 30; // mean speed "close to 0" (STOP_THRESHOLD is 18)
/**
 * Instantaneous crawl putt: still moving, but slow enough to "catch" a stroke.
 * Intentionally does NOT require ballMayRestForAim — floating slowly in a gravity
 * field must still be puttable (editor Test used to re-wake and cancel the drag).
 */
const CRAWL_PUTT_SPEED = STOP_THRESHOLD * 2.5; // ~45

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
 * True if the player may start a putt while grounded:
 *  - crawl / near-stop (even if a gravity field would refuse clean rest)
 *  - or quasi-rest (sustained near-zero average with bounce spikes)
 * Does not require ballMayRestForAim — that gates auto-settle, not strikeability.
 */
function mayPuttBall(ball, hole, speedTracker) {
  if (!ball || (ball.z || 0) > 0) return false;
  const speed = Math.hypot(ball.vx || 0, ball.vy || 0);
  if (speed < CRAWL_PUTT_SPEED) return true;
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

// ---- Portals (Valve-style pairs; max 2) ----
// Data: hole.portalPairs[{ width, a:{host,index,t,face}, b:{...} }]
// host: 'wall' | 'gate' | 'pendulum'. face ±1 picks enterable side. width shared by pair.
const PORTAL_MAX_PAIRS = 2;
const PORTAL_MIN_WIDTH = 2 * BALL_RADIUS + 4; // ball diameter + margin
const PORTAL_DEFAULT_WIDTH = 48;
/** Relative velocity into the face (along inward normal) must exceed this. */
const PORTAL_ENTER_DOT_EPS = 8;
/** Place ball this far past exit face along outward normal (clear thick wall). */
const PORTAL_EXIT_CLEAR = BALL_RADIUS + WALL_HALF_WIDTH + 1.5;
const PORTAL_HOST_CODES = { wall: 0, gate: 1, pendulum: 2 };
const PORTAL_HOST_NAMES = ['wall', 'gate', 'pendulum'];

/** Runtime colors: not stored. 1 pair orange↔blue; 2 pairs coop orange↔red + blue↔purple. */
function portalPairColors(pairCount) {
  if (pairCount <= 1) {
    return [{ a: '#f97316', b: '#38bdf8' }]; // orange, blue
  }
  return [
    { a: '#f97316', b: '#ef4444' }, // orange, red
    { a: '#38bdf8', b: '#a855f7' }, // blue, purple
  ];
}

function portalHostArray(hole, host) {
  if (host === 'wall') return hole.walls || [];
  if (host === 'gate') return hole.gates || [];
  if (host === 'pendulum') return hole.pendulums || [];
  return null;
}

/** Live segment for a portal host (walls static; gates/pendulums move). */
function resolvePortalHostSegment(hole, host, index) {
  const arr = portalHostArray(hole, host);
  if (!arr || index < 0 || index >= arr.length) return null;
  if (host === 'wall') {
    const w = arr[index];
    return {
      x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
      restitution: w.restitution != null ? w.restitution : (w.bumper ? BUMPER_RESTITUTION : WALL_RESTITUTION),
      bumper: !!w.bumper,
      svx: 0, svy: 0,
    };
  }
  if (host === 'gate') return getSlidingGateSegment(arr[index]);
  if (host === 'pendulum') return getPendulumSegment(arr[index]);
  return null;
}

/**
 * Resolved aperture frame for one portal end.
 * n points from the wall into the enterable room (outward face normal).
 * Surface velocity is at the aperture center (includes pendulum omega).
 */
function resolvePortalAperture(hole, end, width) {
  if (!end || !hole) return null;
  const host = end.host;
  const index = end.index | 0;
  const seg = resolvePortalHostSegment(hole, host, index);
  if (!seg) return null;
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  const tx = dx / len, ty = dy / len;
  // Left normal when walking (x1→x2); face multiplies for designer side.
  const n0x = -ty, n0y = tx;
  const face = end.face === -1 ? -1 : 1;
  const nx = n0x * face, ny = n0y * face;
  let t = Number(end.t);
  if (!Number.isFinite(t)) t = 0.5;
  t = Math.max(0, Math.min(1, t));
  const w = Math.max(PORTAL_MIN_WIDTH, Number(width) || PORTAL_DEFAULT_WIDTH);
  const halfT = Math.min(0.5, (w * 0.5) / len);
  // Keep aperture fully on the segment.
  t = Math.max(halfT, Math.min(1 - halfT, t));
  const cx = seg.x1 + t * dx, cy = seg.y1 + t * dy;
  let svx = seg.svx || 0, svy = seg.svy || 0;
  if (seg.pivot && seg.omega) {
    svx = -seg.omega * (cy - seg.pivot.y);
    svy = seg.omega * (cx - seg.pivot.x);
  }
  return {
    host, index, t, face, width: w,
    cx, cy, nx, ny, tx, ty, len,
    t0: t - halfT, t1: t + halfT,
    halfT, svx, svy,
    x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2,
    restitution: seg.restitution,
    pivot: seg.pivot || null,
    omega: seg.omega || 0,
  };
}

/** Open t-intervals [t0,t1] on a host segment from all portal ends. */
function portalOpenIntervalsOnHost(hole, host, index) {
  const pairs = hole.portalPairs || [];
  const out = [];
  for (let pi = 0; pi < pairs.length; pi++) {
    const pair = pairs[pi];
    if (!pair) continue;
    for (const side of ['a', 'b']) {
      const end = pair[side];
      if (!end || end.host !== host || (end.index | 0) !== index) continue;
      const ap = resolvePortalAperture(hole, end, pair.width);
      if (ap) out.push({ t0: ap.t0, t1: ap.t1 });
    }
  }
  out.sort((u, v) => u.t0 - v.t0);
  // Merge overlaps
  const merged = [];
  for (const iv of out) {
    if (!merged.length || iv.t0 > merged[merged.length - 1].t1 + 1e-9) {
      merged.push({ t0: iv.t0, t1: iv.t1 });
    } else {
      merged[merged.length - 1].t1 = Math.max(merged[merged.length - 1].t1, iv.t1);
    }
  }
  return merged;
}

/** Solid t-ranges on [0,1] after subtracting open portal intervals. */
function solidTRangesFromOpens(opens) {
  const solids = [];
  let cursor = 0;
  for (const iv of opens) {
    const a = Math.max(0, Math.min(1, iv.t0));
    const b = Math.max(0, Math.min(1, iv.t1));
    if (a > cursor + 1e-9) solids.push({ t0: cursor, t1: a });
    cursor = Math.max(cursor, b);
  }
  if (cursor < 1 - 1e-9) solids.push({ t0: cursor, t1: 1 });
  return solids;
}

function subsegmentFromT(seg, t0, t1) {
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const out = {
    x1: seg.x1 + t0 * dx,
    y1: seg.y1 + t0 * dy,
    x2: seg.x1 + t1 * dx,
    y2: seg.y1 + t1 * dy,
    restitution: seg.restitution != null ? seg.restitution : WALL_RESTITUTION,
  };
  if (seg.bumper) out.bumper = true;
  if (seg.svx != null) out.svx = seg.svx;
  if (seg.svy != null) out.svy = seg.svy;
  if (seg.pivot) {
    out.pivot = seg.pivot;
    out.omega = seg.omega || 0;
  }
  return out;
}

/** Carve portal apertures out of a host segment → 0..N solid pieces. */
function carvePortalOpenings(hole, host, index, seg) {
  if (!seg) return [];
  const opens = portalOpenIntervalsOnHost(hole, host, index);
  if (!opens.length) return [seg];
  const solids = solidTRangesFromOpens(opens);
  const pieces = [];
  for (const r of solids) {
    if (r.t1 - r.t0 < 1e-6) continue;
    pieces.push(subsegmentFromT(seg, r.t0, r.t1));
  }
  return pieces;
}

/**
 * Map velocity through a portal pair (Valve local-frame).
 * n = outward face normal (into room). vn_in = dot(v_rel, n_entry) is negative when entering.
 * Exit: v_rel_out = (-vn) * n_exit + vt * t_exit, then add exit surface velocity.
 */
function mapVelocityThroughPortals(vx, vy, entryAp, exitAp) {
  const rvx = vx - entryAp.svx;
  const rvy = vy - entryAp.svy;
  const vn = rvx * entryAp.nx + rvy * entryAp.ny;
  const vt = rvx * entryAp.tx + rvy * entryAp.ty;
  const outRelX = (-vn) * exitAp.nx + vt * exitAp.tx;
  const outRelY = (-vn) * exitAp.ny + vt * exitAp.ty;
  return {
    vx: outRelX + exitAp.svx,
    vy: outRelY + exitAp.svy,
  };
}

/**
 * Map a free vector (velocity-without-surface, acceleration) through portal local frames.
 * Same basis flip as mapVelocityThroughPortals but ignores surface velocity.
 */
function mapVectorThroughPortal(vx, vy, entryAp, exitAp) {
  const vn = vx * entryAp.nx + vy * entryAp.ny;
  const vt = vx * entryAp.tx + vy * entryAp.ty;
  return {
    x: (-vn) * exitAp.nx + vt * exitAp.tx,
    y: (-vn) * exitAp.ny + vt * exitAp.ty,
  };
}

/**
 * Map a world point from the entry aperture frame into the exit aperture frame.
 * Preserves along-tangent offset and signed distance along face normal (Valve-style).
 */
function mapPointThroughPortal(x, y, entryAp, exitAp) {
  const along = (x - entryAp.cx) * entryAp.tx + (y - entryAp.cy) * entryAp.ty;
  const normal = (x - entryAp.cx) * entryAp.nx + (y - entryAp.cy) * entryAp.ny;
  return {
    x: exitAp.cx + along * exitAp.tx + normal * exitAp.nx,
    y: exitAp.cy + along * exitAp.ty + normal * exitAp.ny,
  };
}

// ---- Portal dual-sample gravity (prototype; default off) ----
// Modes from portals-implementation-goal non-goals: always / SOI / LOS.
// Runtime switch for A/B feel — not LEVEL_CODEC. Hole may override via portalGravityMode.
const PORTAL_GRAVITY_MODES = ['off', 'always', 'soi', 'los'];
/** Near-aperture radius for SOI mode (px). Ball must be this close to entry center. */
const PORTAL_GRAVITY_SOI_RADIUS = 220;
/** Max distance along face normal for LOS mode (px). */
const PORTAL_GRAVITY_LOS_MAX = 360;
/** Global default; overridden by hole.portalGravityMode or setPortalGravityMode. */
let _portalGravityMode = 'off';

function normalizePortalGravityMode(mode) {
  if (mode == null || mode === '') return 'off';
  const m = String(mode).toLowerCase().trim();
  if (m === 'off' || m === 'none' || m === 'world' || m === '0') return 'off';
  if (m === 'always' || m === 'on' || m === '1') return 'always';
  if (m === 'soi' || m === 'sphere') return 'soi';
  if (m === 'los' || m === 'lineofsight' || m === 'line-of-sight') return 'los';
  return 'off';
}

/**
 * Active dual-sample mode. Session (`setPortalGravityMode`) is the sole authority.
 *
 * hole.portalGravityMode is NOT read — it was a stale-override footgun: editor
 * deepCloneHole / draft snapshots could keep an old mode on the hole object while
 * the dropdown + global said something else, so switching back to "always" still
 * simulated as soi/los/off until a full page refresh rebuilt everything.
 * (Fixtures/tests must call setPortalGravityMode.)
 */
function getPortalGravityMode(/* hole */) {
  return _portalGravityMode;
}

function setPortalGravityMode(mode) {
  _portalGravityMode = normalizePortalGravityMode(mode);
  return _portalGravityMode;
}

/**
 * Project ball center onto segment parametric t and signed distance along outward normal n.
 * Returns null if segment degenerate.
 */
function projectOntoAperture(ball, ap) {
  const dx = ap.x2 - ap.x1, dy = ap.y2 - ap.y1;
  const lenSq = dx * dx + dy * dy;
  if (!(lenSq > 1e-12)) return null;
  const t = ((ball.x - ap.x1) * dx + (ball.y - ap.y1) * dy) / lenSq;
  const px = ap.x1 + t * dx, py = ap.y1 + t * dy;
  // signed distance from centerline along face normal
  const side = (ball.x - px) * ap.nx + (ball.y - py) * ap.ny;
  return { t, side, px, py };
}

/**
 * Whether this entry aperture can contribute dual-sample gravity for the mode.
 * Never samples from the solid back face (side < 0).
 * Returns projection when eligible, else null (so callers can rank by distance).
 */
function portalGravityEligible(mode, ball, entryAp) {
  if (mode === 'off') return null;
  const proj = projectOntoAperture(ball, entryAp);
  if (!proj) return null;
  // One-sided: only the enterable half-plane (outward normal).
  // (Earlier side > -1 let both ends of a same-room pair fire and sum toward map center.)
  if (proj.side < 0) return null;

  if (mode === 'always') return proj;

  if (mode === 'soi') {
    const dist = Math.hypot(ball.x - entryAp.cx, ball.y - entryAp.cy);
    return dist <= PORTAL_GRAVITY_SOI_RADIUS ? proj : null;
  }

  if (mode === 'los') {
    // Geometric view through the open aperture: on face, within width, not too far.
    if (proj.side > PORTAL_GRAVITY_LOS_MAX) return null;
    if (proj.t < entryAp.t0 || proj.t > entryAp.t1) return null;
    return proj;
  }
  return null;
}

/**
 * Extra gravity from sampling the other side of each portal and mapping accel back.
 * World-only sample at the virtual point (no recursive dual-sample).
 *
 * Per pair, only the **strongest** eligible direction contributes (max |mapped g|).
 * Summing both a→b and b→a double-counted when both faces open into the same room and
 * averaged into a bogus pull toward the hole center after roaming / mode switching mid-map.
 */
function portalGravityDualSample(ball, hole) {
  const mode = getPortalGravityMode(hole);
  if (mode === 'off') return { ax: 0, ay: 0 };
  const pairs = hole.portalPairs || [];
  if (!pairs.length) return { ax: 0, ay: 0 };

  let ax = 0, ay = 0;
  for (let pi = 0; pi < pairs.length; pi++) {
    const pair = pairs[pi];
    if (!pair || !pair.a || !pair.b) continue;
    const sides = [
      { end: pair.a, other: pair.b },
      { end: pair.b, other: pair.a },
    ];
    let bestMag = 0;
    let bestMapped = null;
    for (const s of sides) {
      const entryAp = resolvePortalAperture(hole, s.end, pair.width);
      const exitAp = resolvePortalAperture(hole, s.other, pair.width);
      if (!entryAp || !exitAp) continue;
      if (!portalGravityEligible(mode, ball, entryAp)) continue;
      const virt = mapPointThroughPortal(ball.x, ball.y, entryAp, exitAp);
      const g = gravityAccelAtWorld(virt, hole);
      if (g.mag < 1e-12) continue;
      // g lives in exit-room world axes; map exit → entry (swap frames).
      const mapped = mapVectorThroughPortal(g.ax, g.ay, exitAp, entryAp);
      const mag = Math.hypot(mapped.x, mapped.y);
      if (mag > bestMag) {
        bestMag = mag;
        bestMapped = mapped;
      }
    }
    if (bestMapped) {
      ax += bestMapped.x;
      ay += bestMapped.y;
    }
  }
  return { ax, ay };
}

/**
 * Try teleport through any portal pair. Mutates ball; returns event or null.
 * Requires grounded, not sticky-latched, center in aperture, inward relative velocity.
 * Exit position preserves along-aperture offset (not always aperture center).
 */
function tryPortalTeleport(ball, hole) {
  if ((ball.z || 0) > 0.001) return null;
  if (typeof ball.stuckStickyIndex === 'number' && ball.stuckStickyIndex >= 0) return null;
  const pairs = hole.portalPairs || [];
  for (let pi = 0; pi < pairs.length; pi++) {
    const pair = pairs[pi];
    if (!pair || !pair.a || !pair.b) continue;
    const sides = [
      { from: 'a', to: 'b', end: pair.a, other: pair.b },
      { from: 'b', to: 'a', end: pair.b, other: pair.a },
    ];
    for (const s of sides) {
      const entryAp = resolvePortalAperture(hole, s.end, pair.width);
      const exitAp = resolvePortalAperture(hole, s.other, pair.width);
      if (!entryAp || !exitAp) continue;
      const proj = projectOntoAperture(ball, entryAp);
      if (!proj) continue;
      // Center must lie in open aperture along the wall.
      if (proj.t < entryAp.t0 || proj.t > entryAp.t1) continue;
      // Must approach from enterable face (side > 0) or be crossing the slab from that side.
      // Back face (side << 0) never teleports — wall stays solid there.
      if (proj.side > WALL_HALF_WIDTH + 2) continue;
      if (proj.side < -1) continue;
      const rvx = ball.vx - entryAp.svx;
      const rvy = ball.vy - entryAp.svy;
      // Inward = into portal = opposite outward normal → -dot(v_rel, n) > eps
      const into = -(rvx * entryAp.nx + rvy * entryAp.ny);
      if (into <= PORTAL_ENTER_DOT_EPS) continue;
      // Along-aperture offset from entry center (local tangent); clamp to half-width.
      let along = (ball.x - entryAp.cx) * entryAp.tx + (ball.y - entryAp.cy) * entryAp.ty;
      const half = pair.width * 0.5;
      if (along > half) along = half;
      if (along < -half) along = -half;
      // Map local-t offset onto exit aperture (same basis convention as velocity map).
      const mapped = mapVelocityThroughPortals(ball.vx, ball.vy, entryAp, exitAp);
      ball.x = exitAp.cx + exitAp.tx * along + exitAp.nx * PORTAL_EXIT_CLEAR;
      ball.y = exitAp.cy + exitAp.ty * along + exitAp.ny * PORTAL_EXIT_CLEAR;
      ball.vx = mapped.vx;
      ball.vy = mapped.vy;
      return { type: 'portal', pairIndex: pi, from: s.from, to: s.to };
    }
  }
  return null;
}

/**
 * Attach one-sided portal opens to a host segment for collision.
 * Opens are only passable from the enterable face; the back remains solid.
 */
function attachPortalOpens(hole, host, index, seg) {
  if (!seg) return seg;
  const pairs = hole.portalPairs || [];
  if (!pairs.length) return seg;
  const opens = [];
  for (let pi = 0; pi < pairs.length; pi++) {
    const pair = pairs[pi];
    if (!pair) continue;
    for (const side of ['a', 'b']) {
      const end = pair[side];
      if (!end || end.host !== host || (end.index | 0) !== index) continue;
      const ap = resolvePortalAperture(hole, end, pair.width);
      if (!ap) continue;
      opens.push({ t0: ap.t0, t1: ap.t1, nx: ap.nx, ny: ap.ny });
    }
  }
  if (opens.length) seg.portalOpens = opens;
  return seg;
}

/**
 * Build collision wall list. Portal apertures are NOT fully carved out — the wall stays
 * solid on the back face. resolveWallCollision skips only the enterable face of opens.
 */
function collisionWallsForHole(hole, ballZ) {
  if (ballZ > 0) return boundaryWallsFor(hole);
  let walls = boundaryWallsFor(hole).slice();
  for (let i = 0; i < (hole.walls || []).length; i++) {
    const w = hole.walls[i];
    const seg = {
      x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
      restitution: w.restitution != null ? w.restitution : (w.bumper ? BUMPER_RESTITUTION : WALL_RESTITUTION),
      bumper: !!w.bumper,
    };
    walls.push(attachPortalOpens(hole, 'wall', i, seg));
  }
  for (const wm of hole.windmills || []) {
    walls = walls.concat(getWindmillBlades(wm));
  }
  for (let i = 0; i < (hole.pendulums || []).length; i++) {
    const seg = getPendulumSegment(hole.pendulums[i]);
    walls.push(attachPortalOpens(hole, 'pendulum', i, seg));
  }
  for (let i = 0; i < (hole.gates || []).length; i++) {
    const seg = getSlidingGateSegment(hole.gates[i]);
    walls.push(attachPortalOpens(hole, 'gate', i, seg));
  }
  return walls;
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

// The frame hugs the canvas edge on EVERY course — no dead apron between the border
// and the canvas. Centerline at 5px, so the bounce face sits 10px from the edge and
// visual band (10px wall stroke) spans exactly 0..10. BOUND (above) remains only as
// the conservative clamp box for tee placement/aim helpers.
const SPACE_BOUND = { left: 5, top: 5, right: LOGICAL_W - 5, bottom: LOGICAL_H - 5 };
const BOUNDARY_WALLS = [
  wall(SPACE_BOUND.left, SPACE_BOUND.top, SPACE_BOUND.right, SPACE_BOUND.top),
  wall(SPACE_BOUND.right, SPACE_BOUND.top, SPACE_BOUND.right, SPACE_BOUND.bottom),
  wall(SPACE_BOUND.right, SPACE_BOUND.bottom, SPACE_BOUND.left, SPACE_BOUND.bottom),
  wall(SPACE_BOUND.left, SPACE_BOUND.bottom, SPACE_BOUND.left, SPACE_BOUND.top),
];
const SPACE_BOUNDARY_WALLS = BOUNDARY_WALLS; // kept for compat; one geometry everywhere now
function boundaryWallsFor(hole) {
  return BOUNDARY_WALLS;
}

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
    // Water top edge at 204 (not 200): leaves an ace corridor over the hazard from the
    // leftmost multiplayer tee slots (verified for every slot at lobby sizes 1..5).
    walls: [], sand: [], water: [waterRect(360, 204, 440, 300, { x: 200, y: 250 })],
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

// ---- Portal campaign ("Portals" course) ----
// 19 holes designed around Valve-style portal pairs. Every hole is aceable: the committed
// seeds in test/portal-aces.json replay through stepBallPhysics in test/portal-hio.js.
// Difficulty contract: pars never decrease; holes 1-18 use EITHER two portal pairs OR a
// moving-host portal (never both); only hole 19 combines them, and its ace threads both
// pairs with putt timing. Blind-shot ace-rate caps are enforced per hole by the test.
const PORTAL_HOLES = [
  {
    name: 'First Contact', par: 2,
    tee: { x: 70, y: 250 }, cup: { x: 730, y: 250, radius: 11 },
    walls: [
      wall(20, 20, 780, 20),
      wall(780, 20, 780, 480),
      wall(780, 480, 20, 480),
      wall(20, 480, 20, 20),
      wall(380, 110, 380, 390),
      wall(600, 205, 600, 295),
    ],
    sand: [ sandRect(230, 140, 350, 200), sandRect(230, 300, 350, 360), sandRect(745, 200, 775, 300) ],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 44,
        a: { host: 'wall', index: 4, t: 0.5, face: 1 },
        b: { host: 'wall', index: 5, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Threading the Veil', par: 2,
    tee: { x: 80, y: 250 }, cup: { x: 660, y: 250, radius: 11 },
    walls: [
      wall(380, 20, 380, 480),
      wall(520, 190, 520, 310),
    ],
    sand: [ sandRect(690, 210, 760, 290), sandRect(295, 100, 370, 200), sandRect(295, 300, 370, 400) ],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 44,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Corner Office', par: 3,
    tee: { x: 70, y: 410 }, cup: { x: 700, y: 90, radius: 11 },
    walls: [
      wall(580, 340, 580, 480),
      wall(620, 160, 780, 160),
    ],
    sand: [ sandRect(250, 445, 450, 480) ],
    water: [ waterRect(20, 20, 540, 280, { x: 90, y: 320 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Pinch Point Passage', par: 3,
    tee: { x: 80, y: 250 }, cup: { x: 710, y: 250, radius: 11 },
    walls: [
      wall(230, 140, 230, 360),
      wall(660, 140, 760, 140),
    ],
    sand: [ sandRect(310, 100, 490, 180), sandRect(310, 320, 490, 400) ],
    water: [ waterRect(320, 180, 480, 320, { x: 290, y: 250 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 44,
        a: { host: 'wall', index: 0, t: 0.77, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: 1 } },
    ],
  },
  {
    name: 'Off-Center of Attention', par: 3,
    tee: { x: 80, y: 158 }, cup: { x: 700, y: 264, radius: 11 },
    walls: [
      wall(400, 20, 400, 480),
      wall(520, 320, 520, 406),
    ],
    sand: [ sandRect(415, 322, 510, 408) ],
    water: [ waterRect(140, 20, 390, 75, { x: 100, y: 110 }), waterRect(540, 20, 770, 190, { x: 505, y: 230 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 110,
        a: { host: 'wall', index: 0, t: 0.3, face: 1 },
        b: { host: 'wall', index: 0, t: 0.72, face: -1 } },
    ],
  },
  {
    name: 'Carom Conduit', par: 3,
    tee: { x: 110, y: 420 }, cup: { x: 185, y: 80, radius: 11 },
    walls: [
      wall(560, 470, 660, 370, { bumper: true }),
      wall(540, 180, 700, 180),
      wall(260, 20, 260, 160),
      wall(20, 160, 180, 160),
    ],
    sand: [ sandRect(150, 190, 230, 250) ],
    water: [ waterRect(340, 250, 520, 360, { x: 310, y: 385 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 44,
        a: { host: 'wall', index: 1, t: 0.36, face: 1 },
        b: { host: 'wall', index: 2, t: 0.5, face: 1 } },
    ],
  },
  {
    name: 'Double Slipstream', par: 4,
    tee: { x: 80, y: 420 }, cup: { x: 480, y: 410, radius: 11 },
    walls: [
      wall(310, 340, 310, 480),
      wall(200, 60, 200, 190),
      wall(620, 60, 620, 190),
      wall(560, 340, 560, 480),
      wall(310, 340, 560, 340),
    ],
    sand: [ sandRect(150, 350, 290, 388), sandRect(320, 352, 400, 470) ],
    water: [ waterRect(360, 210, 540, 300, { x: 430, y: 320 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.571, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
      { width: 40,
        a: { host: 'wall', index: 2, t: 0.5, face: 1 },
        b: { host: 'wall', index: 3, t: 0.5, face: 1 } },
    ],
  },
  {
    name: 'Slipstream Gate', par: 4,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 410, radius: 11 },
    walls: [
      wall(380, 20, 380, 160),
      wall(380, 340, 380, 480),
      wall(620, 340, 620, 480),
      wall(620, 340, 700, 340),
    ],
    sand: [ sandRect(220, 290, 320, 350), sandRect(690, 345, 775, 385) ],
    water: [ waterRect(470, 120, 570, 210, { x: 440, y: 250 }) ],
    boost: [],
    pendulums: [],
    gates: [ slidingGate(380, 210, 380, 290, 'y', 50, 3) ],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'gate', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 2, t: 0.46, face: -1 } },
    ],
  },
  {
    name: 'Double Cross', par: 4,
    tee: { x: 80, y: 250 }, cup: { x: 660, y: 150, radius: 11 },
    walls: [
      wall(400, 20, 400, 140),
      wall(400, 140, 400, 220),
      wall(400, 220, 400, 280),
      wall(400, 280, 400, 360),
      wall(400, 360, 400, 420),
      wall(560, 100, 560, 220),
      wall(600, 370, 720, 370),
      wall(600, 370, 600, 480),
    ],
    sand: [ sandRect(605, 375, 778, 478) ],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 36,
        a: { host: 'wall', index: 1, t: 0.25, face: 1 },
        b: { host: 'wall', index: 5, t: 0.4167, face: -1 } },
      { width: 44,
        a: { host: 'wall', index: 3, t: 0.5, face: 1 },
        b: { host: 'wall', index: 6, t: 0.5, face: 1 } },
    ],
  },
  {
    name: 'Foucault\'s Flingshot', par: 4,
    tee: { x: 80, y: 410 }, cup: { x: 700, y: 205, radius: 11 },
    walls: [
      wall(200, 320, 200, 480),
      wall(600, 20, 600, 150),
      wall(600, 260, 600, 480),
    ],
    sand: [ sandRect(740, 150, 780, 260) ],
    water: [ waterRect(240, 260, 560, 340, { x: 210, y: 300 }) ],
    boost: [],
    pendulums: [ pendulum(430, 20, 240, 1.5708, 0.8, 2.2) ],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },
        b: { host: 'pendulum', index: 0, t: 0.85, face: -1 } },
    ],
  },
  {
    name: 'Wrong Way Round', par: 4,
    tee: { x: 140, y: 250 }, cup: { x: 680, y: 250, radius: 11 },
    walls: [
      wall(400, 20, 400, 390),
      wall(70, 200, 70, 300),
      wall(735, 210, 735, 290),
      wall(640, 210, 735, 210),
      wall(640, 290, 735, 290),
      wall(170, 370, 260, 370),
    ],
    sand: [ sandRect(150, 380, 280, 460) ],
    water: [],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.6216, face: 1 },
        b: { host: 'wall', index: 5, t: 0.5, face: 1 } },
      { width: 26,
        a: { host: 'wall', index: 1, t: 0.5, face: -1 },
        b: { host: 'wall', index: 2, t: 0.5, face: 1 } },
    ],
  },
  {
    name: 'Sluicegate Sprint', par: 4,
    tee: { x: 80, y: 250 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [
      wall(600, 200, 600, 300),
      wall(600, 200, 760, 200),
      wall(600, 300, 760, 300),
    ],
    sand: [ sandRect(180, 60, 270, 170), sandRect(180, 330, 270, 440), sandRect(605, 205, 755, 228), sandRect(605, 272, 755, 295) ],
    water: [ waterRect(295, 20, 585, 480, { x: 230, y: 250 }) ],
    boost: [],
    pendulums: [],
    gates: [ slidingGate(280, 285, 280, 385, 'y', 85, 2) ],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'gate', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 0, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Chimney Sweep', par: 5,
    tee: { x: 70, y: 446 }, cup: { x: 170, y: 80, radius: 11 },
    walls: [
      wall(450, 380, 450, 480),
      wall(590, 340, 650, 340),
      wall(590, 140, 650, 140),
      wall(110, 170, 230, 170),
      wall(20, 380, 200, 380),
      wall(260, 380, 450, 380),
      wall(590, 140, 590, 340),
      wall(650, 140, 650, 340),
      wall(110, 20, 110, 170, { bumper: true }),
      wall(230, 20, 230, 170, { bumper: true }),
    ],
    sand: [ sandRect(180, 300, 280, 378), sandRect(150, 382, 398, 400), sandRect(150, 460, 398, 478), sandRect(400, 382, 448, 408), sandRect(400, 452, 448, 478), sandRect(112, 22, 140, 58), sandRect(200, 22, 228, 58) ],
    water: [ waterRect(300, 300, 430, 376, { x: 160, y: 350 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
      { width: 40,
        a: { host: 'wall', index: 2, t: 0.5, face: 1 },
        b: { host: 'wall', index: 3, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Grandfather Clause', par: 5,
    tee: { x: 80, y: 250 }, cup: { x: 710, y: 300, radius: 11 },
    walls: [
      wall(310, 20, 310, 330),
      wall(660, 250, 770, 250),
      wall(620, 350, 770, 350),
    ],
    sand: [ sandRect(620, 360, 770, 430), sandRect(190, 440, 610, 475) ],
    water: [ waterRect(700, 40, 760, 140, { x: 430, y: 350 }) ],
    boost: [],
    pendulums: [ pendulum(560, 20, 240, 1.5708, 0.85, 2.2) ],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.742, face: 1 },
        b: { host: 'pendulum', index: 0, t: 0.8, face: -1 } },
    ],
  },
  {
    name: 'Slingshot Circuit', par: 5,
    tee: { x: 80, y: 420 }, cup: { x: 430, y: 250, radius: 11 },
    walls: [
      wall(750, 360, 750, 480),
      wall(50, 60, 50, 160),
      wall(750, 20, 750, 200),
      wall(330, 210, 330, 290),
      wall(120, 185, 750, 185),
      wall(20, 360, 620, 360),
      wall(500, 200, 500, 300),
      wall(350, 310, 500, 310),
    ],
    sand: [ sandRect(350, 315, 500, 355), sandRect(20, 365, 55, 478), sandRect(280, 458, 745, 478) ],
    water: [ waterRect(150, 220, 280, 330, { x: 120, y: 420 }) ],
    boost: [ boostRect(160, 390, 260, 450, 0, 600), boostRect(350, 80, 460, 140, 0, 600) ],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
      { width: 40,
        a: { host: 'wall', index: 2, t: 0.5, face: 1 },
        b: { host: 'wall', index: 3, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Shutter Speed', par: 5,
    tee: { x: 90, y: 320 }, cup: { x: 700, y: 250, radius: 11 },
    walls: [
      wall(340, 20, 340, 400),
      wall(560, 200, 560, 300),
    ],
    sand: [ sandRect(360, 410, 560, 470), sandRect(220, 390, 320, 450), sandRect(720, 210, 770, 290) ],
    water: [ waterRect(210, 20, 320, 105, { x: 160, y: 150 }), waterRect(600, 140, 720, 203, { x: 480, y: 250 }), waterRect(600, 297, 720, 360, { x: 480, y: 250 }) ],
    boost: [],
    pendulums: [],
    gates: [ slidingGate(260, 190, 260, 310, 'y', 80, 1.6) ],
    windmills: [],
    portalPairs: [
      { width: 22,
        a: { host: 'gate', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 1, t: 0.5, face: -1 } },
    ],
  },
  {
    name: 'Hindsight Bay', par: 5,
    tee: { x: 250, y: 250 }, cup: { x: 725, y: 250, radius: 11 },
    walls: [
      wall(60, 205, 60, 295),
      wall(700, 60, 780, 60),
      wall(400, 120, 400, 380),
      wall(530, 130, 610, 130),
      wall(690, 290, 760, 290),
      wall(690, 250, 690, 290),
      wall(760, 205, 760, 290),
    ],
    sand: [ sandRect(540, 165, 600, 225) ],
    water: [ waterRect(430, 30, 530, 115, { x: 330, y: 70 }), waterRect(430, 385, 530, 470, { x: 330, y: 430 }) ],
    boost: [],
    pendulums: [],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 2, t: 0.5, face: 1 },
        b: { host: 'wall', index: 3, t: 0.5, face: 1 } },
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.5, face: -1 },
        b: { host: 'wall', index: 1, t: 0.5, face: 1 } },
    ],
  },
  {
    name: 'Gallows Swing', par: 5,
    tee: { x: 70, y: 250 }, cup: { x: 720, y: 250, radius: 11 },
    walls: [
      wall(140, 210, 140, 290),
    ],
    sand: [ sandRect(640, 150, 760, 195), sandRect(640, 305, 760, 350) ],
    water: [ waterRect(260, 410, 620, 470, { x: 95, y: 330 }) ],
    boost: [],
    pendulums: [ pendulum(310, 20, 245, 1.5708, 0.7, 2.2), pendulum(460, 20, 245, 1.5708, 0.7, 2.2, 0.73), pendulum(610, 20, 245, 1.5708, 0.7, 2.2, 1.47) ],
    gates: [],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.5, face: 1 },
        b: { host: 'pendulum', index: 1, t: 0.9, face: -1 } },
    ],
  },
  {
    name: 'The Double Slit', par: 6,
    tee: { x: 80, y: 420 }, cup: { x: 750, y: 78, radius: 11 },
    walls: [
      wall(250, 370, 250, 480),
      wall(640, 20, 640, 145),
      wall(640, 145, 732, 145),
      wall(545, 160, 640, 160),
      wall(460, 240, 640, 240),
      wall(640, 145, 640, 250),
    ],
    sand: [ sandRect(480, 162, 576, 238), sandRect(700, 150, 780, 212) ],
    water: [ waterRect(640, 310, 720, 390, { x: 560, y: 430 }) ],
    boost: [],
    pendulums: [ pendulum(400, 20, 200, 1.5708, 0.8, 2.2) ],
    gates: [ slidingGate(600, 160, 600, 240, 'y', 70, 2.4) ],
    windmills: [],
    portalPairs: [
      { width: 40,
        a: { host: 'wall', index: 0, t: 0.4545, face: 1 },
        b: { host: 'pendulum', index: 0, t: 0.85, face: -1 } },
      { width: 44,
        a: { host: 'gate', index: 0, t: 0.5, face: 1 },
        b: { host: 'wall', index: 1, t: 0.56, face: -1 } },
    ],
  },
];

const COURSES = [
  { id: 'classic', name: 'Classic', holes: HOLES },
  { id: 'canyon', name: 'Canyon Jumps', holes: CANYON_HOLES },
  { id: 'goo', name: 'Goo Lagoon', holes: STICKY_HOLES },
  { id: 'orbit', name: 'Orbit', holes: ORBIT_HOLES },
  { id: 'portals', name: 'Portals', holes: PORTAL_HOLES },
];

// Classic's hole literals predate ramps/sticky/gravity/portals — fill arrays in one pass so the
// "every hole carries every array" invariant keeps holding without editing every literal.
for (const c of COURSES) {
  for (const h of c.holes) {
    h.ramps = h.ramps || [];
    h.sticky = h.sticky || [];
    h.gravityBodies = h.gravityBodies || [];
    h.portalPairs = h.portalPairs || [];
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
    // One-sided portal: within aperture, skip collision only on the enterable face.
    // Back face of the wall stays solid (cannot walk through the portal hole from behind).
    if (w.portalOpens && w.portalOpens.length) {
      for (let oi = 0; oi < w.portalOpens.length; oi++) {
        const op = w.portalOpens[oi];
        if (t < op.t0 || t > op.t1) continue;
        // Positive = ball is on the enterable-room side of the centerline.
        const faceSide = distX * op.nx + distY * op.ny;
        if (faceSide >= -WALL_HALF_WIDTH * 0.25) {
          return false;
        }
        break; // in aperture but on back — solid bounce below
      }
    }
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
    portals: [],
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
    // fence is "tall" enough to knock them back in. Portal apertures are open holes.
    // Rebuild each substep so moving gate/pendulum portals track live segments.
    const walls = collisionWallsForHole(hole, ball.z || 0);
    for (const w of walls) {
      if (resolveWallCollision(ball, w)) events.bounced = true;
    }

    // Portal teleport after collision so open-hole + inward velocity can fire this substep.
    if ((ball.z || 0) <= 0) {
      const pe = tryPortalTeleport(ball, hole);
      if (pe) events.portals.push(pe);
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

    // Boost pads: edge-triggered — fire on enter, re-arm when the ball fully leaves
    // the pad (so loops/re-crosses work). Not once-per-putt. While still overlapping,
    // stay latched so resting / soft snaps on the pad cannot re-fire every tick.
    if (ball.firedBoosts && ball.firedBoosts.size) {
      for (const bi of [...ball.firedBoosts]) {
        const z = hole.boost[bi];
        if (!z || !circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) {
          ball.firedBoosts.delete(bi);
        }
      }
    }
    let inBoost = null;
    let inBoostIndex = -1;
    for (let bi = 0; bi < hole.boost.length; bi++) {
      if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, hole.boost[bi])) {
        inBoost = hole.boost[bi];
        inBoostIndex = bi;
        break;
      }
    }
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

/**
 * Water drop ZONE: the authored dropPoint plus a deterministic radial fan of extra
 * spots arranged ring by ring "behind" it (away from the water), so a full lobby
 * never stacks penalized balls on one point. Index 0 = the original drop point;
 * ring 1 fans 5 spots at one ball-spacing, ring 2 fans 8 further out, and so on.
 * Deterministic for a given (zone, index) — host and clients agree by slot.
 */
function waterDropPointFor(zone, index, hole) {
  const dp = zone.dropPoint || { x: BOUND.left + 40, y: BOUND.top + 40 };
  if (!index || index <= 0) return { x: dp.x, y: dp.y };
  const b = zoneBounds(zone);
  // "Behind" = from the water's center out through the drop point.
  let ax = dp.x - (b.x1 + b.x2) / 2;
  let ay = dp.y - (b.y1 + b.y2) / 2;
  const al = Math.hypot(ax, ay);
  if (al < 1) { ax = -1; ay = 0; } else { ax /= al; ay /= al; }
  const baseAng = Math.atan2(ay, ax);
  const spacing = BALL_RADIUS * 2 + 6;
  let i = index - 1;
  let ring = 1;
  let slots = 5;
  while (i >= slots) { i -= slots; ring++; slots += 3; }
  const spread = Math.PI * 0.9; // fan across the away-from-water half
  const ang = baseAng + (i - (slots - 1) / 2) * (spread / Math.max(1, slots - 1));
  const margin = BALL_RADIUS * 2;
  for (let r = ring * spacing; r <= ring * spacing + spacing * 3; r += spacing) {
    const x = Math.min(Math.max(dp.x + Math.cos(ang) * r, BOUND.left + margin), BOUND.right - margin);
    const y = Math.min(Math.max(dp.y + Math.sin(ang) * r, BOUND.top + margin), BOUND.bottom - margin);
    // Never drop back into water (this zone or any other on the hole).
    let wet = circleTouchesZone(x, y, BALL_RADIUS + 1, zone);
    if (!wet && hole && hole.water) {
      for (const wz of hole.water) {
        if (circleTouchesZone(x, y, BALL_RADIUS + 1, wz)) { wet = true; break; }
      }
    }
    if (!wet) return { x, y };
  }
  return { x: dp.x, y: dp.y }; // pathological zone: fall back to the original point
}

// ---- Water waves + hazard float (deterministic, shared by server, clients, renderer) ----
// Waves are a closed-form triangle sweep along the pond's long axis, seeded by zone
// geometry: same (zone, k, tSec) → same front everywhere, no state to sync. The float
// (penalized ball bobbing 1.5s before its drop) drifts with front 0, so the authoritative
// drift on the server matches the waves every client draws.
const WATER_WAVE = { speed: 17, followers: 3, slowdown: 0.85, margin: 4 };
const WATER_FLOAT_TICKS = 45;      // 1.5s at TICK_HZ 30
const WATER_FLOAT_DRIFT = 14;      // px/s along the lead wave's travel
const WATER_FLOAT_CARRY = 0.22;    // entry momentum carried into the float (decays)

function zoneWaveSeed(zone) {
  const b = zoneBounds(zone);
  return (((b.x1 * 73856093) ^ (b.y1 * 19349663) ^ (b.x2 * 83492791) ^ (b.y2 * 15485863)) >>> 0);
}

/** Front k of a pond's wave set at time tSec: { pos, dir, vertical }. */
function waterWaveFrontAt(zone, k, tSec) {
  const b = zoneBounds(zone);
  const vertical = (b.y2 - b.y1) > (b.x2 - b.x1);
  const lo = (vertical ? b.y1 : b.x1) + WATER_WAVE.margin;
  const hi = (vertical ? b.y2 : b.x2) - WATER_WAVE.margin;
  const span = Math.max(1, hi - lo);
  const seed = zoneWaveSeed(zone);
  const jitter = 0.9 + ((seed % 1000) / 1000) * 0.2;
  const speed = WATER_WAVE.speed * jitter * Math.pow(WATER_WAVE.slowdown, k);
  const phase0 = (((seed >>> 10) % 1000) / 1000 + k * 0.16) * span;
  const dir0 = ((seed >>> 20) & 1) ? 1 : -1;
  let u = (phase0 + dir0 * speed * tSec) % (2 * span);
  if (u < 0) u += 2 * span;
  return u < span
    ? { pos: lo + u, dir: 1, vertical }
    : { pos: hi - (u - span), dir: -1, vertical };
}

/**
 * One float step: drift `ball` with the lead wave + decaying entry momentum, clamped
 * inside the waterline. `float` = { vx, vy } entry carry (mutated). Deterministic given
 * the same tSec/dt schedule — server and predicting clients stay in lockstep.
 */
function stepWaterFloat(ball, float, zone, tSec, dt) {
  const f = waterWaveFrontAt(zone, 0, tSec);
  const dx = f.vertical ? 0 : f.dir * WATER_FLOAT_DRIFT;
  const dy = f.vertical ? f.dir * WATER_FLOAT_DRIFT : 0;
  ball.x += (dx + float.vx) * dt;
  ball.y += (dy + float.vy) * dt;
  const decay = Math.exp(-3 * dt);
  float.vx *= decay;
  float.vy *= decay;
  const b = zoneBounds(zone);
  const pad = 5 + BALL_RADIUS;
  if (b.x2 - b.x1 > pad * 2) ball.x = Math.min(Math.max(ball.x, b.x1 + pad), b.x2 - pad);
  else ball.x = (b.x1 + b.x2) / 2;
  if (b.y2 - b.y1 > pad * 2) ball.y = Math.min(Math.max(ball.y, b.y1 + pad), b.y2 - pad);
  else ball.y = (b.y1 + b.y2) / 2;
}

/** Drop index for a drowning: roster slot keeps players separated, the per-player
 *  dunk counter rotates rings so repeat dunks vary. Slots 0..4 plus ring offsets
 *  {0,5,10} can never collide across different slots. */
function waterDropIndexFor(slot, dunkCount) {
  return Math.max(0, slot) + ((Math.max(1, dunkCount) - 1) % 3) * 5;
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
// v3: gravity body radius/mass/fieldRadius/drawRadius as f32 (v1/v2 used i16 qCoord/qF10:
//     mass clamped at 3276.7; radius quantum 0.1 so sub-0.05 radii became 0 then
//     normalizeGravityBody's `|| 10` reset them to 10).
// v4: portalPairs after gravityBodies (max 2 complete pairs).
const LEVEL_CODEC_VERSION = 4;
const LEVEL_MAX_B64_LEN = 4096;
const LEVEL_MAX_NAME_LEN = 40;
// Array lengths are packed as u8 in the share codec — hard ceiling per kind is 255.
// The real design budget is LEVEL_MAX_B64_LEN (total share string); we do not impose
// lower per-kind art limits (old LEVEL_CAPS walls:40, sand:20, … were arbitrary).
const LEVEL_MAX_KIND_COUNT = 255;
/** @deprecated Use LEVEL_MAX_KIND_COUNT; kept so callers reading LEVEL_CAPS.* still get 255. */
const LEVEL_CAPS = {
  walls: LEVEL_MAX_KIND_COUNT,
  sand: LEVEL_MAX_KIND_COUNT,
  water: LEVEL_MAX_KIND_COUNT,
  boost: LEVEL_MAX_KIND_COUNT,
  ramps: LEVEL_MAX_KIND_COUNT,
  sticky: LEVEL_MAX_KIND_COUNT,
  pendulums: LEVEL_MAX_KIND_COUNT,
  gates: LEVEL_MAX_KIND_COUNT,
  windmills: LEVEL_MAX_KIND_COUNT,
  gravityBodies: LEVEL_MAX_KIND_COUNT,
  portalPairs: PORTAL_MAX_PAIRS,
};

// ---- Level share links (long ?lvl= / short ?lvl_short= via TinyURL) ----
const LVL_PARAM = 'lvl';
const LVL_SHORT_PARAM = 'lvl_short';
/** Free TinyURL create endpoint (returns plain-text short URL). */
const TINYURL_CREATE_API = 'https://tinyurl.com/api-create.php';
const TINYURL_OPEN_BASE = 'https://tinyurl.com/';
/** Alias characters TinyURL issues; also our open-redirect allowlist for lvl_short. */
const TINYURL_ALIAS_RE = /^[A-Za-z0-9_-]{2,40}$/;

function isValidTinyAlias(alias) {
  return typeof alias === 'string' && TINYURL_ALIAS_RE.test(alias);
}

/** Extract alias from a TinyURL create response (`https://tinyurl.com/abc123`). */
function extractTinyAlias(tinyUrl) {
  if (typeof tinyUrl !== 'string') return null;
  const m = tinyUrl.trim().match(/^https?:\/\/(?:www\.)?tinyurl\.com\/([A-Za-z0-9_-]{2,40})\/?$/i);
  return m && isValidTinyAlias(m[1]) ? m[1] : null;
}

/**
 * Normalize a page URL to the main game entry (index), stripping query/hash.
 * Accepts absolute href or origin+path; editor.html → index.html.
 */
function gameEntryUrl(baseHref) {
  const u = new URL(baseHref || 'https://pocketputt.net/');
  let path = u.pathname || '/';
  if (/editor\.html$/i.test(path)) {
    path = path.replace(/editor\.html$/i, 'index.html');
  } else if (path.endsWith('/') || path === '') {
    // keep directory root (production often serves / as index)
  } else if (!/index\.html$/i.test(path) && !path.includes('.')) {
    // path-only routes: leave as-is
  }
  u.pathname = path;
  u.search = '';
  u.hash = '';
  return u;
}

/** Permanent share link: full level payload in ?lvl=. */
function buildLongLevelUrl(lvl, baseHref) {
  if (typeof lvl !== 'string' || !lvl) throw new Error('missing level payload');
  const u = gameEntryUrl(baseHref);
  u.searchParams.set(LVL_PARAM, lvl);
  return u.toString();
}

/** Compact share link: pocketputt hosts ?lvl_short=alias which expands via TinyURL. */
function buildShortLevelUrl(alias, baseHref) {
  if (!isValidTinyAlias(alias)) throw new Error('invalid short alias');
  const u = gameEntryUrl(baseHref);
  u.searchParams.set(LVL_SHORT_PARAM, alias);
  return u.toString();
}

/** Browser navigates here; TinyURL 301s to the long ?lvl= URL (may hit preview pages). */
function tinyurlExpandUrl(alias) {
  if (!isValidTinyAlias(alias)) throw new Error('invalid short alias');
  return TINYURL_OPEN_BASE + alias;
}

/** Pull `lvl` query value from an absolute or relative URL string. */
function extractLvlFromUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) return null;
  try {
    const u = new URL(urlStr, 'https://pocketputt.net/');
    const lvl = (u.searchParams.get(LVL_PARAM) || '').trim();
    return lvl || null;
  } catch {
    // last-ditch: raw query parse
    const m = urlStr.match(/[?&]lvl=([^&]+)/i);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch {
      return m[1] || null;
    }
  }
}

/**
 * Parse HTML for meta-refresh or common redirect targets (TinyURL preview pages).
 * Returns an absolute URL string or null.
 */
function extractRedirectFromHtml(html, baseUrl) {
  if (typeof html !== 'string' || !html) return null;
  const patterns = [
    /http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*['"]?([^"'>\s]+)/i,
    /content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*['"]?([^"'>]+)["'][^>]*http-equiv\s*=\s*["']refresh["']/i,
    /content\s*=\s*["']\s*\d+\s*;\s*url\s*=\s*['"]?([^"'>]+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    let next = m[1].replace(/^['"]|['"]$/g, '').replace(/&amp;/g, '&').trim();
    if (!next) continue;
    try {
      return new URL(next, baseUrl || 'https://tinyurl.com/').href;
    } catch {
      /* try next */
    }
  }
  return null;
}

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
    portalPairs: [],
  };
  if (overrides && typeof overrides === 'object') Object.assign(h, overrides);
  return h;
}

function normalizePortalEnd(end) {
  if (!end || typeof end !== 'object') return null;
  const host = end.host === 'gate' || end.host === 'pendulum' ? end.host : (end.host === 'wall' ? 'wall' : null);
  if (!host) return null;
  let index = Math.round(Number(end.index));
  if (!Number.isFinite(index) || index < 0) index = 0;
  if (index > 255) index = 255;
  let t = Number(end.t);
  if (!Number.isFinite(t)) t = 0.5;
  t = Math.max(0, Math.min(1, t));
  const face = end.face === -1 || end.face === 0 || end.face === false ? -1 : 1;
  return { host, index, t, face };
}

/**
 * Normalize portal pairs: max 2, complete pairs only, shared width, clamp width to hosts,
 * no overlapping apertures on the same host segment.
 */
function normalizePortalPairs(rawPairs, hole) {
  const src = Array.isArray(rawPairs) ? rawPairs : [];
  const out = [];
  for (let i = 0; i < src.length && out.length < PORTAL_MAX_PAIRS; i++) {
    const p = src[i];
    if (!p || typeof p !== 'object') continue;
    const a = normalizePortalEnd(p.a);
    const b = normalizePortalEnd(p.b);
    if (!a || !b) continue;
    // Host indices must exist on the hole.
    const aArr = portalHostArray(hole, a.host);
    const bArr = portalHostArray(hole, b.host);
    if (!aArr || a.index >= aArr.length) continue;
    if (!bArr || b.index >= bArr.length) continue;
    let width = Number(p.width);
    if (!Number.isFinite(width)) width = PORTAL_DEFAULT_WIDTH;
    width = Math.max(PORTAL_MIN_WIDTH, width);
    // Clamp width to both host segment lengths.
    const segA = resolvePortalHostSegment(hole, a.host, a.index);
    const segB = resolvePortalHostSegment(hole, b.host, b.index);
    if (!segA || !segB) continue;
    const lenA = Math.hypot(segA.x2 - segA.x1, segA.y2 - segA.y1);
    const lenB = Math.hypot(segB.x2 - segB.x1, segB.y2 - segB.y1);
    const maxW = Math.min(lenA, lenB);
    if (!(maxW >= PORTAL_MIN_WIDTH)) continue;
    width = Math.min(width, maxW);
    // Keep t so aperture fits on segment.
    const halfTA = (width * 0.5) / lenA;
    const halfTB = (width * 0.5) / lenB;
    a.t = Math.max(halfTA, Math.min(1 - halfTA, a.t));
    b.t = Math.max(halfTB, Math.min(1 - halfTB, b.t));
    out.push({ width, a, b });
  }
  // Drop pairs that overlap apertures on the same host segment.
  function intervalsOverlap(t0a, t1a, t0b, t1b) {
    return t0a < t1b - 1e-9 && t0b < t1a - 1e-9;
  }
  function pairIntervals(pair) {
    const list = [];
    for (const side of ['a', 'b']) {
      const end = pair[side];
      const seg = resolvePortalHostSegment(hole, end.host, end.index);
      if (!seg) continue;
      const len = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1);
      if (!(len > 1e-6)) continue;
      const halfT = (pair.width * 0.5) / len;
      list.push({ host: end.host, index: end.index, t0: end.t - halfT, t1: end.t + halfT });
    }
    return list;
  }
  const kept = [];
  for (const pair of out) {
    const ivs = pairIntervals(pair);
    let bad = false;
    // Self-overlap on same segment (both ends)
    if (ivs.length === 2 && ivs[0].host === ivs[1].host && ivs[0].index === ivs[1].index) {
      if (intervalsOverlap(ivs[0].t0, ivs[0].t1, ivs[1].t0, ivs[1].t1)) bad = true;
    }
    // Overlap with already kept pairs
    if (!bad) {
      for (const other of kept) {
        const oivs = pairIntervals(other);
        for (const u of ivs) {
          for (const v of oivs) {
            if (u.host === v.host && u.index === v.index && intervalsOverlap(u.t0, u.t1, v.t0, v.t1)) {
              bad = true;
            }
          }
        }
      }
    }
    if (!bad) kept.push(pair);
  }
  return kept;
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

// ---- Share-link quantizer limits (i16 fields still used outside gravity v3 f32) ----
// Editor should refuse values outside these so users never author something that
// silently clamps on encode. Gravity radius/mass/field/draw use f32 in v3+ (no max here).
const CODEC_I16_MAX = 32767;
const CODEC_I16_MIN = -32768;
const CODEC_QCOORD_STEP = 0.1;
const CODEC_QCOORD_MAX = CODEC_I16_MAX / 10; // 3276.7
const CODEC_QCOORD_MIN = CODEC_I16_MIN / 10; // -3276.8
const CODEC_QF10_STEP = 0.1;
const CODEC_QF10_MAX = CODEC_I16_MAX / 10; // 3276.7
const CODEC_QF10_MIN = 0; // boost power / ramp minSpeed — non-negative
const CODEC_QF100_STEP = 0.01;
const CODEC_QF100_MAX = CODEC_I16_MAX / 100; // 327.67
const CODEC_QF100_MIN = CODEC_I16_MIN / 100; // -327.68

function codecClamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function codecQuantize(v, step) {
  if (!(step > 0)) return v;
  const q = Math.round(v / step) * step;
  // Avoid ugly float noise (e.g. 1.0000000002)
  const decimals = step >= 1 ? 0 : Math.max(0, Math.round(-Math.log10(step)));
  return Number(q.toFixed(decimals));
}
/** Positions / lengths / moon orbit radius — qCoord (0.1). */
function clampCodecQCoord(v, opts) {
  opts = opts || {};
  const lo = opts.min != null ? opts.min : CODEC_QCOORD_MIN;
  const hi = opts.max != null ? opts.max : CODEC_QCOORD_MAX;
  let n = codecClamp(v, lo, hi);
  if (opts.quantize !== false) n = codecQuantize(n, CODEC_QCOORD_STEP);
  return n;
}
/** Boost power / ramp minSpeed — qF10 (0.1), ≥0. */
function clampCodecQF10(v, opts) {
  opts = opts || {};
  const lo = opts.min != null ? opts.min : CODEC_QF10_MIN;
  const hi = opts.max != null ? opts.max : CODEC_QF10_MAX;
  let n = codecClamp(v, lo, hi);
  if (opts.quantize !== false) n = codecQuantize(n, CODEC_QF10_STEP);
  return n;
}
/** Angles / periods / phase0 / rotationSpeed — qF100 (0.01). */
function clampCodecQF100(v, opts) {
  opts = opts || {};
  const lo = opts.min != null ? opts.min : CODEC_QF100_MIN;
  const hi = opts.max != null ? opts.max : CODEC_QF100_MAX;
  let n = codecClamp(v, lo, hi);
  if (opts.quantize !== false) n = codecQuantize(n, CODEC_QF100_STEP);
  return n;
}
/**
 * Clamp a single editor property to share-link-legal range for its selection kind.
 * Gravity radius/mass/field/draw are codec-v3 f32 (only positivity enforced).
 */
function clampEditorProp(selKind, key, value) {
  const k = key;
  // Gravity body free floats (v3)
  if (selKind === 'gravityBodies') {
    if (k === 'radius' || k === 'fieldRadius' || k === 'drawRadius') {
      return Math.max(0.001, Number(value) || 0.001);
    }
    if (k === 'mass') {
      return Math.max(0.01, Number(value) || 0.01);
    }
    if (k === 'orbitPeriodTicks') {
      return Math.max(1, Math.min(CODEC_I16_MAX, Math.round(Number(value) || 1)));
    }
    if (k === 'orbitRadius') {
      return clampCodecQCoord(value, { min: 0 });
    }
    if (k === 'orbitPhase0') {
      return clampCodecQF100(value);
    }
    if (k === 'ocx' || k === 'ocy' || k === 'x' || k === 'y') {
      return clampCodecQCoord(value);
    }
  }
  if (k === 'blades') {
    return Math.max(2, Math.min(255, Math.round(Number(value) || 4)));
  }
  if (k === 'power' || k === 'minSpeed') {
    return clampCodecQF10(value);
  }
  // Spatial qCoord
  if (
    k === 'x' || k === 'y' || k === 'x1' || k === 'y1' || k === 'x2' || k === 'y2' ||
    k === 'cx' || k === 'cy' || k === 'dropX' || k === 'dropY' ||
    k === 'length' || k === 'armLength'
  ) {
    const min = (k === 'length' || k === 'armLength') ? 0 : CODEC_QCOORD_MIN;
    return clampCodecQCoord(value, { min });
  }
  if (k === 'radius' && selKind === 'cup') {
    return clampCodecQCoord(value, { min: 0.1 });
  }
  if (selKind === 'portalPairs') {
    if (k === 'width') return clampCodecQCoord(value, { min: PORTAL_MIN_WIDTH });
    if (k === 't') {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0.5;
      return Math.max(0, Math.min(1, codecQuantize(n, CODEC_QF100_STEP)));
    }
    if (k === 'face') return Number(value) === -1 ? -1 : 1;
    if (k === 'index') return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
  }
  // Gate travel is spatial; pendulum amplitude is angular
  if (k === 'amplitude') {
    if (selKind === 'gates') return clampCodecQCoord(value, { min: 0 });
    return clampCodecQF100(value);
  }
  if (
    k === 'angle' || k === 'angleCenter' || k === 'period' ||
    k === 'phase0' || k === 'rotationSpeed'
  ) {
    const min = (k === 'period') ? 0.01 : CODEC_QF100_MIN;
    return clampCodecQF100(value, { min });
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Mutate object in place so every numeric field is share-link legal. */
function clampObjectForCodec(selKind, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (k === 'dropPoint' && obj.dropPoint) {
      obj.dropPoint.x = clampEditorProp(selKind, 'dropX', obj.dropPoint.x);
      obj.dropPoint.y = clampEditorProp(selKind, 'dropY', obj.dropPoint.y);
      continue;
    }
    if (k === 'orbitCenter' && obj.orbitCenter) {
      obj.orbitCenter.x = clampEditorProp(selKind, 'ocx', obj.orbitCenter.x);
      obj.orbitCenter.y = clampEditorProp(selKind, 'ocy', obj.orbitCenter.y);
      continue;
    }
    if (typeof obj[k] === 'number') {
      // bumper bool skip; kind string skip — already numbers only
      if (k === 'bumper' || k === 'shape' || k === 'kind' || k === 'axis') continue;
      obj[k] = clampEditorProp(selKind, k, obj[k]);
    }
  }
  return obj;
}

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
/** IEEE-754 little-endian float32. Used by codec v3+ for gravity scalars. */
ByteWriter.prototype.f32 = function (v) {
  this.ensure(4);
  const n = Number(v);
  const f = Number.isFinite(n) ? n : 0;
  const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.i, 4);
  dv.setFloat32(0, f, true);
  this.i += 4;
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
ByteReader.prototype.f32 = function () {
  if (this.i + 4 > this.buf.length) throw new Error('eof');
  const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.i, 4);
  const v = dv.getFloat32(0, true);
  this.i += 4;
  return Number.isFinite(v) ? v : 0;
};

function normalizeGravityBody(b) {
  if (!b || typeof b !== 'object') return null;
  const kind = b.kind;
  if (kind !== 'planet' && kind !== 'blackHole' && kind !== 'moon') return null;
  // Do not use `|| default` for radius/mass: codec v1/v2 could quantize tiny radii to 0,
  // and `0 || 10` silently rewrote them to 10 on every normalize/load.
  let radius = Number(b.radius);
  if (!Number.isFinite(radius) || radius <= 0) radius = 10;
  let mass = Number(b.mass);
  if (!Number.isFinite(mass) || mass <= 0) mass = 1;
  const body = {
    kind,
    x: Number(b.x) || 0,
    y: Number(b.y) || 0,
    radius,
    mass,
    fieldRadius: b.fieldRadius != null && Number.isFinite(Number(b.fieldRadius))
      ? Number(b.fieldRadius)
      : radius * 6,
    drawRadius: b.drawRadius != null && Number.isFinite(Number(b.drawRadius))
      ? Number(b.drawRadius)
      : (kind === 'blackHole' ? Math.min(radius, 5) : radius),
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
    portalPairs: [],
  };
  hole.portalPairs = normalizePortalPairs(raw.portalPairs, hole);
  // Prototype only — not in LEVEL_CODEC. Lets tests / editor override dual-sample mode per hole.
  if (raw.portalGravityMode != null && raw.portalGravityMode !== '') {
    const pgm = normalizePortalGravityMode(raw.portalGravityMode);
    if (pgm !== 'off') hole.portalGravityMode = pgm;
  }
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
    portalPairs: (hole.portalPairs || []).length,
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
  for (const key of Object.keys(counts)) {
    const max = key === 'portalPairs' ? PORTAL_MAX_PAIRS : LEVEL_MAX_KIND_COUNT;
    if (counts[key] > max) {
      // Codec packs each array length as u8 — more than 255 of one kind cannot be encoded.
      // portalPairs hard-cap at PORTAL_MAX_PAIRS (2).
      return {
        ok: false,
        error: 'over_cap',
        field: key,
        count: counts[key],
        max,
      };
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
      // v3+: full float range for gravity scalars (tiny BH horizons + Orbit-scale mass).
      w.f32(b.radius); w.f32(b.mass);
      w.f32(b.fieldRadius); w.f32(b.drawRadius);
      if (kindCode === 2) {
        w.i16(qCoord(b.orbitCenter.x)); w.i16(qCoord(b.orbitCenter.y));
        w.i16(qCoord(b.orbitRadius));
        w.i16(Math.max(1, Math.round(b.orbitPeriodTicks || 240)));
        w.i16(qF100(b.orbitPhase0 || 0));
      }
    }
  }
  function writePortalEnd(end) {
    const code = PORTAL_HOST_CODES[end.host];
    w.u8(code != null ? code : 0);
    w.u8(end.index & 0xff);
    w.i16(qF100(end.t));
    w.u8(end.face === -1 ? 0 : 1);
  }
  function writePortalPairs(arr) {
    const n = Math.min(PORTAL_MAX_PAIRS, (arr || []).length);
    w.u8(n);
    for (let i = 0; i < n; i++) {
      const p = arr[i];
      w.i16(qCoord(p.width));
      writePortalEnd(p.a);
      writePortalEnd(p.b);
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
  // v4+: portal pairs (always written at current codec version).
  writePortalPairs(hole.portalPairs || []);
  return w.bytes();
}

function unpackHoleBytes(bytes) {
  const r = new ByteReader(bytes);
  const ver = r.u8();
  // Accept current and prior layouts; unknown versions reject.
  if (ver < 1 || ver > LEVEL_CODEC_VERSION) {
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
      let radius, mass, fieldRadius, drawRadius;
      if (ver >= 3) {
        radius = r.f32();
        mass = r.f32();
        fieldRadius = r.f32();
        drawRadius = r.f32();
      } else {
        // v1/v2: 0.1 px radius, mass×10 in i16 (mass max 3276.7).
        radius = uqCoord(r.i16());
        mass = uqF10(r.i16());
        fieldRadius = uqCoord(r.i16());
        drawRadius = uqCoord(r.i16());
      }
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

  function readPortalEnd() {
    const code = r.u8();
    const host = PORTAL_HOST_NAMES[code] || 'wall';
    const index = r.u8();
    const t = uqF100(r.i16());
    const face = r.u8() === 0 ? -1 : 1;
    return { host, index, t, face };
  }
  function readPortalPairs() {
    if (ver < 4) return [];
    const n = r.u8();
    const arr = [];
    const count = Math.min(PORTAL_MAX_PAIRS, n);
    for (let i = 0; i < count; i++) {
      const width = uqCoord(r.i16());
      const a = readPortalEnd();
      const b = readPortalEnd();
      arr.push({ width, a, b });
    }
    // Consume any extra pairs beyond max without corrupting stream (defensive).
    for (let i = count; i < n; i++) {
      r.i16(); readPortalEnd(); readPortalEnd();
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
    portalPairs: readPortalPairs(),
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
    portalPairs: hole.portalPairs || [],
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
    // Portal teleports: insert a path break so the ghost dotted line does not draw
    // a diagonal across the map between entry and exit.
    if (ev.portals && ev.portals.length) {
      sim.pts.push(null); // break sentinel
      sim.pts.push({ x: sim.ball.x, y: sim.ball.y });
    } else if (sim.ticksRun % sim.sampleEvery === 0) {
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
  PORTAL_MAX_PAIRS, PORTAL_MIN_WIDTH, PORTAL_DEFAULT_WIDTH, PORTAL_ENTER_DOT_EPS, PORTAL_EXIT_CLEAR,
  wall, sandRect, waterRect, boostRect, rampRect, stickyRect, pendulum, getPendulumSegment, slidingGate,
  getSlidingGateSegment, ringBumpers, pointInZone, circleTouchesZone, zoneBounds, cupHasGravity,
  zoneCenterXY, orientedRectCorners, circleTouchesOrientedRect, circleTouchesRamp,
  gravityBody, planet, blackHole, moon, escapeSpeed, bodyCanEscapeAtMaxLaunch,
  planetContactRadius, ballOnPlanetCrust, ballFloatingInGravity, ballMayRestForAim,
  QUASI_REST_WINDOW_S, QUASI_REST_AVG_SPEED, CRAWL_PUTT_SPEED,
  createSpeedAvgTracker, resetSpeedAvgTracker, noteSpeedSample, speedAvg, isQuasiRest, mayPuttBall,
  ballInSand, effectiveGravityMag, gravityAccelAt, gravityAccelAtWorld, REST_GRAVITY_EPS, SAND_GRAVITY_HOLD,
  setMoonPoseAtTick, applyGravityAcceleration, resolvePlanetCollision, blackHoleCaptures,
  BOUNDARY_WALLS, SPACE_BOUND, SPACE_BOUNDARY_WALLS, boundaryWallsFor, HOLES, ORBIT_HOLES, COURSES,
  resolveWallCollision, getWindmillBlades,
  portalPairColors, resolvePortalHostSegment, resolvePortalAperture, mapVelocityThroughPortals,
  mapVectorThroughPortal, mapPointThroughPortal,
  PORTAL_GRAVITY_MODES, PORTAL_GRAVITY_SOI_RADIUS, PORTAL_GRAVITY_LOS_MAX,
  normalizePortalGravityMode, getPortalGravityMode, setPortalGravityMode,
  portalGravityEligible, portalGravityDualSample,
  tryPortalTeleport, carvePortalOpenings, collisionWallsForHole, normalizePortalPairs,
  createBallState, stepBallPhysics, advanceHoleObstacles, setHoleObstaclesAtTick, resetHoleObstacles,
  computeLaunchVelocity, clampDragVector, stickyLaunchFactor, stickyIndexAt, latchStickyAfterPutt,
  markWetFromWater, noteWetPutt,
  resolveBallBallCollision, teePositionFor, waterDropPointFor, waterDropIndexFor,
  WATER_WAVE, WATER_FLOAT_TICKS, WATER_FLOAT_DRIFT, WATER_FLOAT_CARRY,
  waterWaveFrontAt, stepWaterFloat,
  LEVEL_CODEC_VERSION, LEVEL_MAX_B64_LEN, LEVEL_MAX_KIND_COUNT, LEVEL_CAPS, LEVEL_MAX_NAME_LEN,
  LVL_PARAM, LVL_SHORT_PARAM, TINYURL_CREATE_API, TINYURL_OPEN_BASE,
  isValidTinyAlias, extractTinyAlias, gameEntryUrl, buildLongLevelUrl, buildShortLevelUrl, tinyurlExpandUrl,
  extractLvlFromUrl, extractRedirectFromHtml,
  CODEC_I16_MAX, CODEC_I16_MIN, CODEC_QCOORD_STEP, CODEC_QCOORD_MAX, CODEC_QCOORD_MIN,
  CODEC_QF10_STEP, CODEC_QF10_MAX, CODEC_QF10_MIN, CODEC_QF100_STEP, CODEC_QF100_MAX, CODEC_QF100_MIN,
  clampCodecQCoord, clampCodecQF10, clampCodecQF100, clampEditorProp, clampObjectForCodec,
  blankHole, normalizeHole, validateHole, encodeHole, decodeHole,
  packHoleBytes, unpackHoleBytes, simulateTrajectory, createTrajectorySim, stepTrajectorySim,
  TRAJECTORY_SAFETY_MAX_TICKS, deepCloneHole, holeObjectCounts,
};

});
