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
const BUMPER_RESTITUTION = 1.05;
const PENDULUM_RESTITUTION = 0.95;
const GATE_RESTITUTION = 0.85;
const MAX_DRAG_DIST = 150;
const MIN_DRAG_DIST = 8;
const POWER_MULTIPLIER = 6.5;
const MAX_LAUNCH_SPEED = 950;
const BOOST_MAX_SPEED = 1250;
const BOUND = { left: 20, top: 20, right: 780, bottom: 480 };

// ---- Small geometry / data helpers ----
function wall(x1, y1, x2, y2, opts) {
  opts = opts || {};
  return { x1, y1, x2, y2, bumper: !!opts.bumper, restitution: opts.bumper ? BUMPER_RESTITUTION : WALL_RESTITUTION };
}
function sandRect(x1, y1, x2, y2) { return { shape: 'rect', x1, y1, x2, y2 }; }
function waterRect(x1, y1, x2, y2, dropPoint) { return { shape: 'rect', x1, y1, x2, y2, dropPoint }; }
function boostRect(x1, y1, x2, y2, angle, power) { return { shape: 'rect', x1, y1, x2, y2, angle, power }; }
function pendulum(cx, cy, length, angleCenter, amplitude, period, phaseOffset) {
  return { cx, cy, length, angleCenter, amplitude, period, phase: phaseOffset || 0 };
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
  return { x1, y1, x2, y2, axis, amplitude, period, phase: phaseOffset || 0 };
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

// ---- Physics ----
function resolveWallCollision(ball, w) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((ball.x - w.x1) * dx + (ball.y - w.y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = w.x1 + t * dx, cy = w.y1 + t * dy;
  const distX = ball.x - cx, distY = ball.y - cy;
  const dist = Math.hypot(distX, distY);
  if (dist < BALL_RADIUS && dist > 0.0001) {
    const nx = distX / dist, ny = distY / dist;
    const overlap = BALL_RADIUS - dist;
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
function createBallState(tee) {
  return { x: tee.x, y: tee.y, vx: 0, vy: 0, squash: 0, spin: 0, angleDir: 0, firedBoosts: new Set() };
}

// Advances one ball by dt against a hole's current obstacle positions. Mutates `ball` in
// place and returns what happened this step so the caller (solo game.js or the server) can
// react with sound/particles/scoring - this function itself never touches audio/DOM/score.
function stepBallPhysics(ball, hole, dt) {
  let walls = BOUNDARY_WALLS.concat(hole.walls);
  for (const wm of hole.windmills) walls = walls.concat(getWindmillBlades(wm));
  if (hole.pendulums.length) walls = walls.concat(hole.pendulums.map(getPendulumSegment));
  if (hole.gates.length) walls = walls.concat(hole.gates.map(getSlidingGateSegment));

  const substeps = 4;
  const subDt = dt / substeps;
  let inSandLastStep = false;
  const events = { holed: false, water: null, boosts: [], bounced: false, enteredSand: false };

  for (let s = 0; s < substeps; s++) {
    let friction = FRICTION_GRASS;
    let inSand = false;
    for (const z of hole.sand) { if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) { friction = FRICTION_SAND; inSand = true; break; } }
    if (inSand && !inSandLastStep) events.enteredSand = true;
    inSandLastStep = inSand;

    // Cup divot: slow balls near the cup get tugged toward it, fast ones fly over.
    const dcx = hole.cup.x - ball.x, dcy = hole.cup.y - ball.y;
    const dCup0 = Math.hypot(dcx, dcy);
    const speedNow = Math.hypot(ball.vx, ball.vy);
    if (dCup0 < CUP_GRAVITY_RADIUS && dCup0 > 0.001 && speedNow < CUP_CAPTURE_MAX_SPEED) {
      const pull = CUP_GRAVITY_PULL * (1 - dCup0 / CUP_GRAVITY_RADIUS);
      ball.vx += (dcx / dCup0) * pull * subDt;
      ball.vy += (dcy / dCup0) * pull * subDt;
    }

    const decay = Math.exp(-friction * subDt);
    ball.vx *= decay;
    ball.vy *= decay;
    // Rolling resistance at crawl speeds (outside the divot) so the ball settles fast
    // instead of trickling on forever.
    if (dCup0 >= CUP_GRAVITY_RADIUS && Math.hypot(ball.vx, ball.vy) < LOW_SPEED_CUTOFF) {
      const extra = Math.exp(-LOW_SPEED_DRAG * subDt);
      ball.vx *= extra;
      ball.vy *= extra;
    }
    ball.x += ball.vx * subDt;
    ball.y += ball.vy * subDt;

    for (const w of walls) {
      if (resolveWallCollision(ball, w)) events.bounced = true;
    }

    let inBoost = null;
    for (const z of hole.boost) { if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) { inBoost = z; break; } }
    // Each pad fires at most once per stroke (re-armed on the next putt) so a bumper that
    // knocks the ball back across a pad can never re-trigger it into an endless loop.
    if (inBoost && !ball.firedBoosts.has(inBoost)) {
      // Add to the ball's existing velocity rather than overwriting it, so the shot you set
      // up still matters - the pad kicks the ball harder along its trajectory instead of
      // always snapping it to one fixed direction.
      ball.vx += Math.cos(inBoost.angle) * inBoost.power;
      ball.vy += Math.sin(inBoost.angle) * inBoost.power;
      const boostedSpeed = Math.hypot(ball.vx, ball.vy);
      if (boostedSpeed > BOOST_MAX_SPEED) {
        ball.vx *= BOOST_MAX_SPEED / boostedSpeed;
        ball.vy *= BOOST_MAX_SPEED / boostedSpeed;
      }
      ball.firedBoosts.add(inBoost);
      ball.squash = 0.7;
      ball.angleDir = Math.atan2(ball.vy, ball.vx);
      events.boosts.push(inBoost);
    }

    for (const z of hole.water) {
      if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) { events.water = z; return events; }
    }

    const dCup = Math.hypot(ball.x - hole.cup.x, ball.y - hole.cup.y);
    if (dCup < hole.cup.radius) { events.holed = true; return events; }
  }

  return events;
}

function advanceHoleObstacles(hole, dt) {
  for (const wm of hole.windmills) wm.angle += wm.rotationSpeed * dt;
  for (const p of hole.pendulums) p.phase += dt;
  for (const g of hole.gates) g.phase += dt;
}

// Absolute obstacle pose from an integer sim tick. Multiplayer host and clients both use
// this so windmills/pendulums never drift from each other (and never need mid-roll
// obstacle snapshots that hard-reset phases and fork ball paths).
function setHoleObstaclesAtTick(hole, tick) {
  const t = tick * TICK_DT;
  for (const wm of hole.windmills) wm.angle = wm.rotationSpeed * t;
  for (const p of hole.pendulums) p.phase = t;
  for (const g of hole.gates) g.phase = t;
}

function resetHoleObstacles(hole) {
  for (const wm of hole.windmills) wm.angle = 0;
  for (const p of hole.pendulums) p.phase = 0;
  for (const g of hole.gates) g.phase = 0;
}

// Equal-mass elastic collision between two balls. Separates the overlap and exchanges the
// velocity component along the contact normal. Returns true when an impulse was applied
// (i.e. a real hit, not just resting contact) so the caller can play a clack sound.
function resolveBallBallCollision(a, b) {
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

return {
  TICK_HZ, TICK_DT, TICK_MS, tickToElapsedMs, elapsedMsToTick,
  LOGICAL_W, LOGICAL_H, BALL_RADIUS, FRICTION_GRASS, FRICTION_SAND, STOP_THRESHOLD,
  CUP_GRAVITY_RADIUS,
  WALL_RESTITUTION, BUMPER_RESTITUTION, PENDULUM_RESTITUTION, GATE_RESTITUTION,
  MAX_DRAG_DIST, MIN_DRAG_DIST, POWER_MULTIPLIER, MAX_LAUNCH_SPEED, BOOST_MAX_SPEED, BOUND,
  wall, sandRect, waterRect, boostRect, pendulum, getPendulumSegment, slidingGate,
  getSlidingGateSegment, ringBumpers, pointInZone, circleTouchesZone, zoneBounds,
  BOUNDARY_WALLS, HOLES,
  resolveWallCollision, getWindmillBlades,
  createBallState, stepBallPhysics, advanceHoleObstacles, setHoleObstaclesAtTick, resetHoleObstacles,
  computeLaunchVelocity, clampDragVector,
  resolveBallBallCollision, teePositionFor,
};

});
