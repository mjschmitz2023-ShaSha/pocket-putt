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
// Sticky goo: drags a ball to a dead stop on entry; the escape putt leaves at reduced power.
// Keep friction high enough to stop, but not so high that a 1-substep host/client skew
// (or soft pose correction) turns into a multi-metre fork. Escape uses a latch (see
// stuckStickyIndex) so the ball can roll out at grass friction after a putt.
const FRICTION_STICKY = 14;
const STICKY_STOP_SPEED = 40;
const STICKY_LAUNCH_FACTOR = 0.55;
const BOUND = { left: 20, top: 20, right: 780, bottom: 480 };

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

// Goo numbers: FRICTION_STICKY bleeds ~22 px/s of speed per px, so patches deeper than
// ~45 px always trap a crossing ball; a ~20 px strip is a speed filter only max-power putts
// punch through. Escape putts cap at MAX_LAUNCH_SPEED * 0.45 ≈ 427 (~370 px of reach).
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

const COURSES = [
  { id: 'classic', name: 'Classic', holes: HOLES },
  { id: 'canyon', name: 'Canyon Jumps', holes: CANYON_HOLES },
  { id: 'goo', name: 'Goo Lagoon', holes: STICKY_HOLES },
];

// Classic's hole literals predate ramps/sticky — fill the two new arrays in one pass so the
// "every hole carries every array" invariant keeps holding without editing 19 literals.
for (const c of COURSES) {
  for (const h of c.holes) {
    h.ramps = h.ramps || [];
    h.sticky = h.sticky || [];
  }
}

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
// stuckStickyIndex: -1 = free / re-armed. >=0 = latched to hole.sticky[i] (escape uses grass
// friction while still inside that patch). MUST be an index, never a zone object reference —
// host and client each have their own hole.sticky arrays, so object identity never matches.
function createBallState(tee) {
  return {
    x: tee.x, y: tee.y, vx: 0, vy: 0, z: 0, vz: 0,
    squash: 0, spin: 0, angleDir: 0,
    firedBoosts: new Set(), // boost zone indices (numbers), not object refs
    stuckStickyIndex: -1,
  };
}

function stickyIndexAt(ball, hole) {
  const list = hole.sticky || [];
  for (let i = 0; i < list.length; i++) {
    if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, list[i])) return i;
  }
  return -1;
}

// After a putt while sitting in goo: latch to that patch so the escape rolls on grass
// friction until the ball leaves. Re-arms (index = -1) only once fully clear of goo.
function latchStickyAfterPutt(ball, hole) {
  ball.stuckStickyIndex = stickyIndexAt(ball, hole);
}

// Advances one ball by dt against a hole's current obstacle positions. Mutates `ball` in
// place and returns what happened this step so the caller (solo game.js or the server) can
// react with sound/particles/scoring - this function itself never touches audio/DOM/score.
//
// CRITICAL for multiplayer: host and client must call this with the SAME dt schedule per
// sim tick. Sticky latch thresholds are speed-based and fork hard if one side microsteps more.
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
  const events = { holed: false, water: null, boosts: [], bounced: false, enteredSand: false, launched: false, landed: false, stuck: false };

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
        // Off the goo entirely: re-arm so the next patch entry traps again.
        ball.stuckStickyIndex = -1;
        for (const z of hole.sand) {
          if (circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) {
            friction = FRICTION_SAND;
            inSand = true;
            break;
          }
        }
      } else if (ball.stuckStickyIndex !== stickyIdx) {
        // Entering goo (or a different patch) without a latch — sticky drag.
        friction = FRICTION_STICKY;
        trappingIndex = stickyIdx;
      }
      // stuckStickyIndex === stickyIdx: escape latch — grass friction until exit.
    }
    if (inSand && !inSandLastStep) events.enteredSand = true;
    inSandLastStep = inSand;

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
    // instead of trickling on forever.
    if (!airborne && (dCup0 >= CUP_GRAVITY_RADIUS || !cupHasGravity(hole)) && Math.hypot(ball.vx, ball.vy) < LOW_SPEED_CUTOFF) {
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

    if (ball.z <= 0) {
      for (const z of hole.ramps) {
        if (!circleTouchesZone(ball.x, ball.y, BALL_RADIUS, z)) continue;
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

return {
  TICK_HZ, TICK_DT, TICK_MS, tickToElapsedMs, elapsedMsToTick,
  LOGICAL_W, LOGICAL_H, BALL_RADIUS, FRICTION_GRASS, FRICTION_SAND, STOP_THRESHOLD,
  CUP_GRAVITY_RADIUS,
  WALL_RESTITUTION, BUMPER_RESTITUTION, PENDULUM_RESTITUTION, GATE_RESTITUTION,
  MAX_DRAG_DIST, MIN_DRAG_DIST, POWER_MULTIPLIER, MAX_LAUNCH_SPEED, BOOST_MAX_SPEED, BOUND,
  RAMP_MIN_SPEED, RAMP_GRAVITY, RAMP_VZ_SCALE, RAMP_VZ_MIN, RAMP_VZ_MAX,
  FRICTION_STICKY, STICKY_STOP_SPEED, STICKY_LAUNCH_FACTOR,
  wall, sandRect, waterRect, boostRect, rampRect, stickyRect, pendulum, getPendulumSegment, slidingGate,
  getSlidingGateSegment, ringBumpers, pointInZone, circleTouchesZone, zoneBounds, cupHasGravity,
  BOUNDARY_WALLS, HOLES, COURSES,
  resolveWallCollision, getWindmillBlades,
  createBallState, stepBallPhysics, advanceHoleObstacles, setHoleObstaclesAtTick, resetHoleObstacles,
  computeLaunchVelocity, clampDragVector, stickyLaunchFactor, stickyIndexAt, latchStickyAfterPutt,
  resolveBallBallCollision, teePositionFor,
};

});
