// Pocket Putt — classic (non-module) script, runs fine over file:// with no build step.
// Physics/course-data now live in shared.js (loaded before this file) so the same code
// can run authoritatively on the multiplayer host — see MULTIPLAYER below.
const {
  TICK_HZ, TICK_DT, tickToElapsedMs, elapsedMsToTick,
  LOGICAL_W, LOGICAL_H, BALL_RADIUS, FRICTION_GRASS, FRICTION_SAND, STOP_THRESHOLD,
  CUP_GRAVITY_RADIUS, cupHasGravity,
  WALL_RESTITUTION, BUMPER_RESTITUTION, PENDULUM_RESTITUTION, GATE_RESTITUTION,
  MAX_DRAG_DIST, MIN_DRAG_DIST, POWER_MULTIPLIER, MAX_LAUNCH_SPEED, BOOST_MAX_SPEED, BOUND,
  BOUNDARY_WALLS, COURSES, pointInZone, zoneBounds, resolveWallCollision, getWindmillBlades,
  getPendulumSegment, getSlidingGateSegment,
  createBallState, stepBallPhysics, advanceHoleObstacles, setHoleObstaclesAtTick, resetHoleObstacles,
  computeLaunchVelocity, clampDragVector, stickyLaunchFactor, stickyIndexAt, latchStickyAfterPutt,
} = window.Shared;
// Must match gameSession PHYSICS_SUBTICKS — same dt schedule keeps sticky latch deterministic.
const MP_PHYSICS_SUBTICKS = 4;
// Every hole lookup goes through the selected course.
function currentHoles() { return COURSES[Game.courseIndex].holes; }

const BOOST_COLOR_A = '#8b2fd1';
const BOOST_COLOR_B = '#2fd1c8';

// ---- Game state ----
const Game = {
  state: 'START',
  courseIndex: 0,
  currentHoleIndex: 0,
  strokes: 0,
  totalStrokes: 0,
  scorecard: [],
  ball: createBallState({ x: 0, y: 0 }),
  trail: [],
  drag: { active: false, pointerVec: { x: 0, y: 0 } },
  particles: [],
  hazardTimer: 0,
  flagPhase: 0,
  lastTime: 0,
  lastBounceSoundAt: 0,
  players: new Map(), // multiplayer only: id -> latest snapshot ball {x,y,vx,vy,hue,name,strokes,holedOut}
};

// ---- Canvas setup ----
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const hud = document.getElementById('hud');
const hudHole = document.getElementById('hud-hole');
const hudPar = document.getElementById('hud-par');
const hudStrokes = document.getElementById('hud-strokes');
const hudTotal = document.getElementById('hud-total');
const powerLabelEl = document.getElementById('power-label');

function setupCanvasDPR() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = LOGICAL_W * dpr;
  canvas.height = LOGICAL_H * dpr;
  canvas.style.width = LOGICAL_W + 'px';
  canvas.style.height = LOGICAL_H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function fitStage() {
  const margin = 40;
  const scale = Math.min(1, (window.innerWidth - margin) / LOGICAL_W, (window.innerHeight - margin) / LOGICAL_H);
  stage.style.transform = `scale(${scale})`;
}
function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left) * (LOGICAL_W / rect.width), y: (clientY - rect.top) * (LOGICAL_H / rect.height) };
}

// ---- Audio (Web Audio API oscillators only, no sound files) ----
let audioCtx = null;
const SFX_FILES = { putt: 'putt.wav', bounce: 'echoey_putt.wav', holeIn: 'putt_go_in.wav' };
const sfxBuffers = {}; // name -> decoded AudioBuffer (primary playback path)
const sfxPools = {};   // name -> pool of <audio> elements (fallback when fetch is blocked, e.g. Chrome over file://)
let sfxPoolsBlessed = false;
for (const [name, file] of Object.entries(SFX_FILES)) {
  const els = [];
  for (let i = 0; i < 4; i++) {
    const a = new Audio(file);
    a.preload = 'auto';
    els.push(a);
  }
  sfxPools[name] = { els, next: 0 };
}

function unlockAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    for (const [name, file] of Object.entries(SFX_FILES)) {
      fetch(file)
        .then((r) => r.arrayBuffer())
        .then((buf) => audioCtx.decodeAudioData(buf))
        .then((decoded) => { sfxBuffers[name] = decoded; })
        .catch(() => {}); // fetch unavailable here -> playSfx falls back to the element pool
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!sfxPoolsBlessed) {
    sfxPoolsBlessed = true;
    // Safari only allows programmatic .play() on an <audio> element that was started at
    // least once during a user gesture - start each pool element (muted) now, while we
    // are inside one, so later event-driven playback isn't silently rejected.
    for (const pool of Object.values(sfxPools)) {
      for (const a of pool.els) {
        a.muted = true;
        a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
      }
    }
  }
}
function playTone(opts) {
  if (!audioCtx) return;
  const { freq = 440, duration = 0.15, type = 'sine', vol = 0.3, sweepTo = null, delay = 0 } = opts;
  const t0 = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), t0 + duration);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}
function playNoiseBurst(opts) {
  if (!audioCtx) return;
  const { duration = 0.15, vol = 0.25, filterFreq = 800, delay = 0 } = opts;
  const t0 = audioCtx.currentTime + delay;
  const bufferSize = Math.floor(audioCtx.sampleRate * duration);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  noise.start(t0);
}
// Recorded sound effects: prefer decoded Web Audio buffers (overlap freely, no autoplay
// restrictions once the context is unlocked), fall back to the blessed element pool.
function playSfx(name, vol) {
  const v = vol == null ? 1 : Math.max(0, Math.min(1, vol));
  const buf = sfxBuffers[name];
  if (audioCtx && buf) {
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.value = v;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start();
    return;
  }
  const pool = sfxPools[name];
  const a = pool.els[pool.next];
  pool.next = (pool.next + 1) % pool.els.length;
  a.volume = v;
  a.currentTime = 0;
  a.play().catch(() => {});
}
function soundPutt(power) { playSfx('putt', 0.45 + power * 0.55); }
function soundBounce() { playSfx('bounce', 0.5); }
function soundSand() { playNoiseBurst({ duration: 0.25, vol: 0.2, filterFreq: 400 }); }
function soundWater() {
  playTone({ freq: 500, duration: 0.4, type: 'sine', vol: 0.2, sweepTo: 80 });
  playNoiseBurst({ duration: 0.3, vol: 0.15, filterFreq: 1200, delay: 0.02 });
}
function soundHole(special) {
  playSfx('holeIn', 0.9);
  // Layer the synth fanfare on top for hole-in-one / eagle moments.
  if (special) {
    [523, 659, 784, 1046, 1318].forEach((f, i) => playTone({ freq: f, duration: 0.18, type: 'triangle', vol: 0.22, delay: 0.15 + i * 0.09 }));
  }
}
function soundClick() { playTone({ freq: 700, duration: 0.05, type: 'square', vol: 0.1 }); }
function soundBoost() {
  playTone({ freq: 180, duration: 0.28, type: 'sawtooth', vol: 0.28, sweepTo: 1100 });
  playNoiseBurst({ duration: 0.15, vol: 0.15, filterFreq: 2000 });
}

// ---- Physics ----
// resolveWallCollision / getWindmillBlades / getPendulumSegment / getSlidingGateSegment
// come from shared.js (destructured above) so solo play and the multiplayer host agree exactly.
function maybePlayBounceSound() {
  const now = performance.now();
  if (now - Game.lastBounceSoundAt > 70) {
    soundBounce();
    Game.lastBounceSoundAt = now;
    achvOnBounce();
  }
}
function handleWaterHazard(zone) {
  Game.strokes++;
  Game.totalStrokes++;
  Game.ball.x = zone.dropPoint.x;
  Game.ball.y = zone.dropPoint.y;
  Game.ball.vx = 0;
  Game.ball.vy = 0;
  Game.trail = [];
  spawnSplash(zone.dropPoint.x, zone.dropPoint.y);
  soundWater();
  achvOnSplash();
  updateHUD();
  Game.hazardTimer = 0.9;
  Game.state = 'HAZARD_RESET';
  showScreen('screen-hazard');
}
// Thin wrapper around shared.js's stepBallPhysics: the physics itself is identical to what
// the multiplayer server runs, this just reacts to the returned events with solo-mode
// sound/particles/scoring so the two never have to agree on anything beyond ball motion.
function updateBallPhysics(dt) {
  const hole = currentHoles()[Game.currentHoleIndex];
  const events = stepBallPhysics(Game.ball, hole, dt);

  if (events.bounced) maybePlayBounceSound();
  if (events.enteredSand) soundSand();
  for (const z of events.boosts) {
    spawnBoostSpark(Game.ball.x, Game.ball.y, Game.ball.angleDir);
    soundBoost();
  }
  if (events.water) { handleWaterHazard(events.water); return; }
  if (events.holed) { onHoleComplete(); return; }

  const speed = Math.hypot(Game.ball.vx, Game.ball.vy);
  Game.ball.spin += (speed / BALL_RADIUS) * dt;
  Game.ball.squash *= Math.exp(-10 * dt);
  if (speed > 5) {
    Game.trail.push({ x: Game.ball.x, y: Game.ball.y, age: 0 });
    if (Game.trail.length > 14) Game.trail.shift();
  }
  if (speed < STOP_THRESHOLD) {
    // Inside the cup divot, let gravity keep working instead of freezing the ball on the lip.
    // On goo-guarded holes the magnet is off, so never hold the ball "live" near the cup.
    const nearCup = cupHasGravity(hole) && Math.hypot(Game.ball.x - hole.cup.x, Game.ball.y - hole.cup.y) < CUP_GRAVITY_RADIUS;
    if (!nearCup) {
      Game.ball.vx = 0;
      Game.ball.vy = 0;
      Game.state = 'AIMING';
    }
  }
}

// ---- Particles ----
function spawnConfetti(x, y) {
  const colors = ['#f4c542', '#e6483f', '#4ac16d', '#3b82c4', '#ffffff'];
  for (let i = 0; i < 40; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
    const speed = 80 + Math.random() * 160;
    Game.particles.push({
      type: 'confetti', x, y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 1 + Math.random() * 0.6, maxLife: 1.6,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 3,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 10,
    });
  }
}
function spawnSplash(x, y) {
  for (let i = 0; i < 20; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI;
    const speed = 60 + Math.random() * 120;
    Game.particles.push({
      type: 'splash', x, y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 0.5 + Math.random() * 0.3, maxLife: 0.8,
      color: '#bfe4ff', size: 2 + Math.random() * 2,
    });
  }
}
function spawnBoostSpark(x, y, angle) {
  const colors = ['#8b2fd1', '#2fd1c8', '#ffffff'];
  for (let i = 0; i < 18; i++) {
    const spread = angle + Math.PI + (Math.random() - 0.5) * 1.1;
    const speed = 100 + Math.random() * 220;
    Game.particles.push({
      type: 'splash', x, y,
      vx: Math.cos(spread) * speed, vy: Math.sin(spread) * speed,
      life: 0.25 + Math.random() * 0.25, maxLife: 0.5,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 2 + Math.random() * 2.5,
    });
  }
}
function updateParticles(dt) {
  for (const p of Game.particles) {
    p.vy += 260 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.rotation !== undefined) p.rotation += (p.rotSpeed || 0) * dt;
  }
  Game.particles = Game.particles.filter((p) => p.life > 0);
}
function drawParticles() {
  for (const p of Game.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    if (p.type === 'confetti') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation || 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.6);
      ctx.restore();
    } else {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- Rendering ----
function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function drawZonePath(z) {
  if (z.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(z.cx, z.cy, z.r, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, z.x1, z.y1, z.x2 - z.x1, z.y2 - z.y1, 8);
  }
}
function drawSandZone(z) {
  ctx.fillStyle = '#dcc27a';
  drawZonePath(z);
  ctx.fill();
  if (!z._speckles) {
    z._speckles = [];
    const b = zoneBounds(z);
    for (let i = 0; i < 40; i++) {
      z._speckles.push({ x: b.x1 + Math.random() * (b.x2 - b.x1), y: b.y1 + Math.random() * (b.y2 - b.y1), r: 1 + Math.random() * 1.5 });
    }
  }
  ctx.fillStyle = 'rgba(150,120,60,0.28)';
  for (const d of z._speckles) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawWaterZone(z) {
  ctx.fillStyle = '#3b82c4';
  drawZonePath(z);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  const b = zoneBounds(z);
  const t = performance.now() / 1000;
  for (let i = 0; i < 3; i++) {
    const yOff = b.y1 + ((b.y2 - b.y1) * (i + 1)) / 4 + Math.sin(t * 1.5 + i) * 4;
    ctx.beginPath();
    ctx.moveTo(b.x1 + 6, yOff);
    ctx.lineTo(b.x2 - 6, yOff);
    ctx.stroke();
  }
}
function drawBoostZone(z) {
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
  const t = performance.now() / 1000;
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
function drawWallSegment(w) {
  ctx.lineCap = 'round';
  if (w.bumper) {
    ctx.strokeStyle = '#e6483f';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.strokeStyle = '#6b4a2b';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
    ctx.strokeStyle = '#5a3d22';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
  }
}
function drawWindmill(wm) {
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
function drawPendulum(p) {
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
function drawSlidingGate(g) {
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
function drawHoleAndFlag(hole) {
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
  const flutter = Math.sin(Game.flagPhase * 3) * 3;
  ctx.fillStyle = '#e6483f';
  ctx.beginPath();
  ctx.moveTo(x, stickTop);
  ctx.lineTo(x + 18 + flutter, stickTop + 6);
  ctx.lineTo(x, stickTop + 12);
  ctx.closePath();
  ctx.fill();
}
function drawGrass() {
  ctx.fillStyle = '#3a7d44';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  const stripeW = 42;
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let x = 0, i = 0; x < LOGICAL_W; x += stripeW, i++) {
    if (i % 2 === 0) ctx.fillRect(x, 0, stripeW, LOGICAL_H);
  }
}
function trailColor(style, alpha, x) {
  switch (style) {
    case 'comet': return `rgba(255,255,255,${alpha * 0.55})`;
    case 'fire': return `hsla(${18 + Math.random() * 22}, 100%, 55%, ${alpha * 0.55})`;
    case 'water': return `hsla(205, 90%, 72%, ${alpha * 0.5})`;
    default: return `hsla(${(performance.now() / 1000 * 130 + (x || 0)) % 360}, 100%, 70%, ${alpha * 0.45})`; // rainbow
  }
}
// Unlockable trails in multiplayer: points carry a wall-clock timestamp, fading over 600ms.
function drawTrailPts(pts, style) {
  const now = performance.now();
  for (const pt of pts) {
    const age = (now - pt.t) / 600;
    if (age >= 1) continue;
    ctx.fillStyle = trailColor(style, 1 - age, pt.x);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, BALL_RADIUS * 0.6 * (1 - age * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawTrail() {
  const style = myStyle.trail || 'rainbow';
  for (const pt of Game.trail) {
    const alpha = Math.max(0, 1 - pt.age / 0.6);
    if (alpha <= 0) continue;
    ctx.fillStyle = trailColor(style, alpha, pt.x);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, BALL_RADIUS * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawBall() {
  const b = Game.ball;
  const t = performance.now() / 1000;
  const baseHue = (t * 130) % 360;
  const zh = b.z || 0;
  if (zh > 0) drawBallShadow(b.x, b.y, zh);

  ctx.save();
  ctx.translate(b.x, b.y - zh * 0.35);
  if (zh > 0) {
    const airScale = 1 + zh / 260;
    ctx.scale(airScale, airScale);
  }
  ctx.rotate(b.angleDir || 0);
  const stretch = b.squash || 0;
  ctx.scale(1 + stretch * 0.5, 1 - stretch * 0.35);

  // outer glow, pulsing gently
  const glowR = BALL_RADIUS + 5 + Math.sin(t * 4) * 1.5;
  const glow = ctx.createRadialGradient(0, 0, BALL_RADIUS * 0.5, 0, 0, glowR);
  glow.addColorStop(0, `hsla(${baseHue}, 100%, 65%, 0.55)`);
  glow.addColorStop(1, `hsla(${baseHue}, 100%, 65%, 0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, glowR, 0, Math.PI * 2);
  ctx.fill();

  // rainbow gradient body
  const bodyGrad = ctx.createLinearGradient(-BALL_RADIUS, -BALL_RADIUS, BALL_RADIUS, BALL_RADIUS);
  for (let i = 0; i <= 6; i++) {
    bodyGrad.addColorStop(i / 6, `hsl(${(baseHue + i * 55) % 360}, 100%, 62%)`);
  }
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // little shine + spin dots
  ctx.rotate(b.spin || 0);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath();
  ctx.arc(BALL_RADIUS * 0.4, 0, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-BALL_RADIUS * 0.4, 0, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function powerColor(power) {
  if (power < 0.33) return '#8be07c';
  if (power < 0.66) return '#f4d548';
  return '#f4543f';
}
function powerLabelText(power) {
  if (power < 0.33) return 'Gentle';
  if (power < 0.66) return 'Firm';
  if (power < 0.9) return 'Strong';
  return 'MAX POWER!';
}
function drawAimLine() {
  const b = Game.ball;
  const v = Game.drag.pointerVec;
  const len = Math.hypot(v.x, v.y);
  const power = Math.min(len / MAX_DRAG_DIST, 1);
  const color = powerColor(power);

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + v.x, b.y + v.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const dirX = -v.x / (len || 1), dirY = -v.y / (len || 1);
  const indicatorLen = 30 + power * 90;
  const tipX = b.x + dirX * indicatorLen, tipY = b.y + dirY * indicatorLen;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  const ah = 8, ang = Math.atan2(dirY, dirX);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ah * Math.cos(ang - 0.4), tipY - ah * Math.sin(ang - 0.4));
  ctx.lineTo(tipX - ah * Math.cos(ang + 0.4), tipY - ah * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();

  powerLabelEl.classList.remove('hidden');
  powerLabelEl.style.left = (b.x / LOGICAL_W) * 100 + '%';
  powerLabelEl.style.top = (b.y / LOGICAL_H) * 100 + '%';
  powerLabelEl.style.color = color;
  powerLabelEl.textContent = powerLabelText(power);
}
function drawMultiplayerBall(b, isSelf) {
  const bx = b.rx, by = b.ry;
  const zh = b.rz || b.z || 0;
  if (zh > 0) drawBallShadow(bx, by, zh);
  ctx.save();
  ctx.translate(bx, by - zh * 0.35);
  if (zh > 0) {
    const airScale = 1 + zh / 260;
    ctx.scale(airScale, airScale);
  }
  if (isSelf) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (b.special === 'sunburst') {
    const glow = ctx.createRadialGradient(0, 0, BALL_RADIUS * 0.4, 0, 0, BALL_RADIUS + 6);
    glow.addColorStop(0, 'rgba(255,210,90,0.65)');
    glow.addColorStop(1, 'rgba(255,210,90,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 6, 0, Math.PI * 2);
    ctx.fill();
    const body = ctx.createRadialGradient(-2, -2, 1, 0, 0, BALL_RADIUS);
    body.addColorStop(0, '#fff3b8');
    body.addColorStop(1, '#f4a020');
    ctx.fillStyle = body;
  } else if (b.special === 'galaxy') {
    const glow = ctx.createRadialGradient(0, 0, BALL_RADIUS * 0.4, 0, 0, BALL_RADIUS + 6);
    glow.addColorStop(0, 'rgba(140,90,255,0.55)');
    glow.addColorStop(1, 'rgba(140,90,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 6, 0, Math.PI * 2);
    ctx.fill();
    const body = ctx.createRadialGradient(-2, -2, 1, 0, 0, BALL_RADIUS);
    body.addColorStop(0, '#6a4fc9');
    body.addColorStop(1, '#191230');
    ctx.fillStyle = body;
  } else if (b.isHost && !b.styled) {
    // The host's default rainbow ball: hue tracks speed — cool violet at rest, blazing
    // red at full send — with a matching glow so it reads across the room.
    const speed = Math.hypot(b.vx, b.vy);
    const speedHue = 270 - Math.min(speed / BOOST_MAX_SPEED, 1) * 270;
    const glowR = BALL_RADIUS + 6;
    const glow = ctx.createRadialGradient(0, 0, BALL_RADIUS * 0.5, 0, 0, glowR);
    glow.addColorStop(0, `hsla(${speedHue}, 100%, 65%, 0.6)`);
    glow.addColorStop(1, `hsla(${speedHue}, 100%, 65%, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();
    const bodyGrad = ctx.createLinearGradient(-BALL_RADIUS, -BALL_RADIUS, BALL_RADIUS, BALL_RADIUS);
    for (let i = 0; i <= 6; i++) {
      bodyGrad.addColorStop(i / 6, `hsl(${(speedHue + i * 30) % 360}, 100%, 60%)`);
    }
    ctx.fillStyle = bodyGrad;
  } else {
    ctx.fillStyle = `hsl(${b.hue}, 90%, 60%)`;
  }
  ctx.beginPath();
  ctx.arc(0, 0, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  if (b.special === 'galaxy') {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const [sx, sy, sr] of [[-2.5, 1.5, 0.8], [2, -2.5, 1.0], [1, 3, 0.6]]) {
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = isSelf ? '#ffffff' : 'rgba(0,0,0,0.25)';
  ctx.lineWidth = isSelf ? 2 : 1;
  ctx.stroke();
  ctx.restore();

  const label = b.holedOut ? `${b.name} ⛳` : b.name;
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  const textW = ctx.measureText(label).width;
  const boxW = textW + 12;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRectPath(ctx, bx - boxW / 2, by - BALL_RADIUS - 22, boxW, 16, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx, by - BALL_RADIUS - 14);
}
function drawStickyZone(z) {
  ctx.fillStyle = '#d99a1f';
  drawZonePath(z);
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
  const t = performance.now() / 1000;
  const sheenY = b.y1 + ((t * 12) % Math.max(1, b.y2 - b.y1));
  ctx.strokeStyle = 'rgba(255,230,160,0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(b.x1 + 6, sheenY);
  ctx.lineTo(b.x2 - 6, sheenY);
  ctx.stroke();
}
function drawRampZone(z) {
  const b = zoneBounds(z);
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const hw = (b.x2 - b.x1) / 2, hh = (b.y2 - b.y1) / 2;
  const dx = Math.cos(z.angle), dy = Math.sin(z.angle);
  const ext = Math.abs(dx) * hw + Math.abs(dy) * hh;
  const grad = ctx.createLinearGradient(cx - dx * ext, cy - dy * ext, cx + dx * ext, cy + dy * ext);
  grad.addColorStop(0, '#8a6a3f');
  grad.addColorStop(1, '#e0c188');
  ctx.fillStyle = grad;
  roundRectPath(ctx, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 6);
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 6);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const perpX = -dy, perpY = dx;
  for (let d = -ext + 14; d < ext - 4; d += 22) {
    const bx = cx + dx * d, by = cy + dy * d;
    const wing = 8;
    ctx.beginPath();
    ctx.moveTo(bx - dx * wing + perpX * wing, by - dy * wing + perpY * wing);
    ctx.lineTo(bx + dx * wing, by + dy * wing);
    ctx.lineTo(bx - dx * wing - perpX * wing, by - dy * wing - perpY * wing);
    ctx.stroke();
  }
  ctx.restore();
  const lipX = cx + dx * ext, lipY = cy + dy * ext;
  const lipHalf = Math.min(hw, hh);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(lipX - perpX * lipHalf, lipY - perpY * lipHalf);
  ctx.lineTo(lipX + perpX * lipHalf, lipY + perpY * lipHalf);
  ctx.stroke();
}
function drawBallShadow(x, y, z) {
  const shrink = Math.max(0.45, 1 - z / 600);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x, y + 2, BALL_RADIUS * shrink, BALL_RADIUS * 0.55 * shrink, 0, 0, Math.PI * 2);
  ctx.fill();
}
function drawWorld() {
  const hole = currentHoles()[Game.currentHoleIndex];
  drawGrass();
  for (const z of hole.sand) drawSandZone(z);
  for (const z of hole.water) drawWaterZone(z);
  for (const z of hole.sticky || []) drawStickyZone(z);
  for (const z of hole.boost) drawBoostZone(z);
  for (const z of hole.ramps || []) drawRampZone(z);
  for (const w of BOUNDARY_WALLS) drawWallSegment(w);
  for (const w of hole.walls) drawWallSegment(w);
  for (const wm of hole.windmills) drawWindmill(wm);
  for (const p of hole.pendulums) drawPendulum(p);
  for (const g of hole.gates) drawSlidingGate(g);
  drawHoleAndFlag(hole);

  if (MULTIPLAYER) {
    for (const b of Game.players.values()) {
      if (b.trail && b.trailPts) drawTrailPts(b.trailPts, b.trail);
    }
    for (const [id, b] of Game.players) drawMultiplayerBall(b, id === mpPlayerId);
  } else {
    drawTrail();
    drawBall();
  }

  const aiming = MULTIPLAYER ? mpCanPutt : Game.state === 'AIMING';
  if (aiming && Game.drag.active) {
    drawAimLine();
  } else {
    powerLabelEl.classList.add('hidden');
  }
  drawParticles();
}

// ---- Screens / HUD ----
const SCREEN_IDS = ['screen-start', 'screen-lobby', 'screen-hole-complete', 'screen-hazard', 'screen-scorecard', 'screen-hole-results', 'screen-final-results'];
function hideAllScreens() { SCREEN_IDS.forEach((id) => document.getElementById(id).classList.add('hidden')); }
function showScreen(id) { hideAllScreens(); document.getElementById(id).classList.remove('hidden'); }
function updateHUD() {
  const hole = currentHoles()[Game.currentHoleIndex];
  hudHole.textContent = `Hole ${Game.currentHoleIndex + 1}/${currentHoles().length} — ${hole.name}`;
  hudPar.textContent = `Par ${hole.par}`;
  hudStrokes.textContent = `Strokes: ${Game.strokes}`;
  hudTotal.textContent = `Total: ${Game.totalStrokes}`;
}
const hudTextCache = new Map();
// Snapshots arrive at network rate; only touch the DOM when the text actually changed,
// otherwise Safari repaints the HUD every message for nothing.
function setHudText(el, text) {
  if (hudTextCache.get(el) !== text) {
    hudTextCache.set(el, text);
    el.textContent = text;
  }
}
function mpUpdateHUD(msg) {
  const hole = currentHoles()[msg.holeIndex];
  const me = Game.players.get(mpPlayerId);
  setHudText(hudHole, `Hole ${msg.holeIndex + 1}/${currentHoles().length} — ${hole.name}`);
  setHudText(hudPar, `Par ${hole.par}`);
  setHudText(hudStrokes, `Strokes: ${me ? me.strokes : 0}`);
  // Timer text is driven per-frame by mpInterpolateBalls' extrapolated clock instead.
}
function ratingText(diff, strokes) {
  if (strokes === 1) return 'HOLE IN ONE!';
  if (diff <= -2) return 'EAGLE!';
  if (diff === -1) return 'BIRDIE!';
  if (diff === 0) return 'PAR';
  if (diff === 1) return 'BOGEY';
  if (diff === 2) return 'DOUBLE BOGEY';
  return `+${diff}`;
}
function ratingLine(totalDiff) {
  if (totalDiff <= -5) return '🏆 Mini Golf Legend!';
  if (totalDiff <= -1) return '🌟 Mini Golf Champion!';
  if (totalDiff === 0) return 'Nice round — right on par!';
  if (totalDiff <= 5) return 'Good round — keep practicing!';
  return "There's always next time!";
}

// ---- Game flow ----
function loadHole(i) {
  Game.currentHoleIndex = i;
  const hole = currentHoles()[i];
  Game.strokes = 0;
  Game.ball = createBallState(hole.tee);
  Game.trail = [];
  Game.drag.active = false;
  resetAchvHoleCounters();
  resetHoleObstacles(hole);
  hud.classList.remove('hidden');
  hideAllScreens();
  Game.state = 'AIMING';
  updateHUD();
}
function startGame() {
  Game.scorecard = [];
  Game.totalStrokes = 0;
  document.getElementById('game-menu').classList.remove('hidden');
  loadHole(0);
}
function onHoleComplete() {
  const hole = currentHoles()[Game.currentHoleIndex];
  const diff = Game.strokes - hole.par;
  Game.scorecard.push({ hole: Game.currentHoleIndex + 1, name: hole.name, par: hole.par, strokes: Game.strokes });
  spawnConfetti(hole.cup.x, hole.cup.y);
  soundHole(Game.strokes === 1 || diff <= -2);
  if (Game.strokes === 1) unlockAchievement('ace');
  document.getElementById('banner-text').textContent = ratingText(diff, Game.strokes);
  document.getElementById('hole-complete-strokes').textContent = `${Game.strokes} stroke${Game.strokes === 1 ? '' : 's'} (Par ${hole.par})`;
  document.getElementById('btn-next').textContent = Game.currentHoleIndex === currentHoles().length - 1 ? 'See Scorecard →' : 'Next Hole →';
  Game.state = 'HOLE_COMPLETE';
  showScreen('screen-hole-complete');
}
function showRoundComplete() {
  const tbody = document.getElementById('scorecard-body');
  tbody.innerHTML = '';
  let totalPar = 0, totalStrokes = 0;
  for (const row of Game.scorecard) {
    totalPar += row.par;
    totalStrokes += row.strokes;
    const diff = row.strokes - row.par;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.hole}</td><td>${row.name}</td><td>${row.par}</td><td>${row.strokes}</td><td>${diff > 0 ? '+' : ''}${diff}</td>`;
    tbody.appendChild(tr);
  }
  const totalDiff = totalStrokes - totalPar;
  const totalRow = document.createElement('tr');
  totalRow.innerHTML = `<td></td><td><strong>Total</strong></td><td><strong>${totalPar}</strong></td><td><strong>${totalStrokes}</strong></td><td><strong>${totalDiff > 0 ? '+' : ''}${totalDiff}</strong></td>`;
  tbody.appendChild(totalRow);
  document.getElementById('scorecard-rating').textContent = ratingLine(totalDiff);
  hud.classList.add('hidden');
  Game.state = 'ROUND_COMPLETE';
  showScreen('screen-scorecard');
}

// ---- Input ----
function handlePointerDown(x, y) {
  if (Game.drag.active) return;
  if (MULTIPLAYER ? !mpCanPutt : Game.state !== 'AIMING') return;
  Game.drag.active = true;
  Game.drag.pointerVec = { x: 0, y: 0 };
}
function handlePointerMove(x, y) {
  if (!Game.drag.active) return;
  let vx = x - Game.ball.x, vy = y - Game.ball.y;
  const len = Math.hypot(vx, vy);
  if (len > MAX_DRAG_DIST) {
    vx = (vx / len) * MAX_DRAG_DIST;
    vy = (vy / len) * MAX_DRAG_DIST;
  }
  Game.drag.pointerVec = { x: vx, y: vy };
}
function launchBall(dragLen, pointerVec) {
  Game.ball.firedBoosts = new Set();
  const hole = currentHoles()[Game.currentHoleIndex];
  const v = computeLaunchVelocity(pointerVec);
  const factor = stickyLaunchFactor(Game.ball, hole);
  latchStickyAfterPutt(Game.ball, hole);
  Game.ball.vx = v.vx * factor;
  Game.ball.vy = v.vy * factor;
  Game.ball.squash = 0.6;
  Game.ball.angleDir = Math.atan2(v.vy, v.vx);
  Game.strokes++;
  Game.totalStrokes++;
  updateHUD();
  soundPutt(v.speed / MAX_LAUNCH_SPEED);
  Game.state = 'BALL_MOVING';
}
function handlePointerUp(x, y) {
  if (!Game.drag.active) return;
  Game.drag.active = false;
  const v = Game.drag.pointerVec;
  const len = Math.hypot(v.x, v.y);
  if (len < MIN_DRAG_DIST) return;
  if (MULTIPLAYER) {
    // Optimistic local putt; host validates and broadcasts puttApplied so everyone
    // coasts from the same input (no mid-flight pose stream).
    mpApplyPuttLocal(mpPlayerId, v, null, true);
    mpSocket.send(JSON.stringify({ type: 'putt', dragVector: v }));
    mpCanPutt = false;
  } else {
    launchBall(len, v);
  }
}

canvas.addEventListener('mousedown', (e) => { unlockAudio(); const p = getCanvasPos(e.clientX, e.clientY); handlePointerDown(p.x, p.y); });
window.addEventListener('mousemove', (e) => { const p = getCanvasPos(e.clientX, e.clientY); handlePointerMove(p.x, p.y); });
window.addEventListener('mouseup', (e) => { const p = getCanvasPos(e.clientX, e.clientY); handlePointerUp(p.x, p.y); });

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  unlockAudio();
  const t = e.touches[0];
  const p = getCanvasPos(t.clientX, t.clientY);
  handlePointerDown(p.x, p.y);
}, { passive: false });
window.addEventListener('touchmove', (e) => {
  if (!Game.drag.active) return;
  e.preventDefault();
  const t = e.touches[0];
  const p = getCanvasPos(t.clientX, t.clientY);
  handlePointerMove(p.x, p.y);
}, { passive: false });
window.addEventListener('touchend', (e) => {
  if (!Game.drag.active) return;
  const t = e.changedTouches[0];
  const p = getCanvasPos(t.clientX, t.clientY);
  handlePointerUp(p.x, p.y);
});

document.getElementById('btn-play').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  const soloCourse = document.getElementById('solo-course-select');
  if (soloCourse) Game.courseIndex = Number(soloCourse.value) || 0;
  startGame();
});
document.getElementById('btn-next').addEventListener('click', () => {
  soundClick();
  if (Game.currentHoleIndex === currentHoles().length - 1) showRoundComplete();
  else loadHole(Game.currentHoleIndex + 1);
});
document.getElementById('btn-replay').addEventListener('click', () => { soundClick(); startGame(); });

// ---- Main loop ----
function update(dt) {
  const hole = currentHoles()[Game.currentHoleIndex];
  if (MULTIPLAYER) {
    // Fixed-tick local sim (obstacles + all balls) tick-locked to the host clock.
    // Motion does not depend on a mid-flight snapshot stream.
    mpUpdateLocalSim(dt);
  } else {
    advanceHoleObstacles(hole, dt);
  }
  Game.flagPhase += dt;
  if (Game.state === 'BALL_MOVING') updateBallPhysics(dt);
  if (Game.state === 'HAZARD_RESET') {
    Game.hazardTimer -= dt;
    if (Game.hazardTimer <= 0) {
      hideAllScreens();
      Game.state = 'AIMING';
    }
  }
  for (const pt of Game.trail) pt.age += dt;
  Game.trail = Game.trail.filter((pt) => pt.age < 0.6);
  updateParticles(dt);
}
function render() {
  ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
  drawWorld();
}
function loop(ts) {
  if (!Game.lastTime) Game.lastTime = ts;
  const dt = Math.min((ts - Game.lastTime) / 1000, 1 / 30);
  Game.lastTime = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

// ---- Hidden achievements & unlockable cosmetics ----
// No gallery, no checklist — they pop the moment you earn them and permanently unlock
// ball skins/trails in this browser (localStorage), usable in the multiplayer lobby.
const ACHIEVEMENTS = {
  ace:     { title: 'One and Done!', reward: { type: 'color', id: 'sunburst', label: 'Sunburst ball' } },
  champ:   { title: 'Champion', reward: { type: 'color', id: 'galaxy', label: 'Galaxy ball' } },
  speed5:  { title: 'Speed Demon', reward: { type: 'trail', id: 'comet', label: 'Comet trail' } },
  pond3:   { title: 'Pond Lover', reward: { type: 'trail', id: 'water', label: 'Bubble trail' } },
  menace:  { title: 'MENACE', reward: { type: 'trail', id: 'fire', label: 'Fire trail' } },
  wall100: { title: 'Wall Whisperer', reward: { type: 'trail', id: 'rainbow', label: 'Rainbow trail' } },
};
const CLIENT_HUES = [0, 45, 190, 270, 130, 320, 25, 210];

let unlocks = { done: {}, counters: { bounces: 0 } };
try {
  const saved = JSON.parse(localStorage.getItem('pocketPuttUnlocks'));
  if (saved && saved.done) unlocks = { done: saved.done, counters: saved.counters || { bounces: 0 } };
} catch (e) { /* fresh start */ }
function saveUnlocks() { localStorage.setItem('pocketPuttUnlocks', JSON.stringify(unlocks)); }
function unlockedRewards(type) {
  return Object.entries(ACHIEVEMENTS)
    .filter(([k, a]) => unlocks.done[k] && a.reward.type === type)
    .map(([k, a]) => a.reward);
}
function hasReward(type, id) { return unlockedRewards(type).some((r) => r.id === id); }

function unlockAchievement(key) {
  if (unlocks.done[key]) return;
  unlocks.done[key] = true;
  saveUnlocks();
  const a = ACHIEVEMENTS[key];
  mpShowBanner(`🏆 ${a.title} — ${a.reward.label} unlocked!`);
  [880, 1108, 1318, 1760].forEach((f, i) => playTone({ freq: f, duration: 0.22, type: 'triangle', vol: 0.2, delay: i * 0.11 }));
  if (MULTIPLAYER) buildCustomizeUI();
}

// Per-hole progress toward the sneakier achievements.
const achvHole = { splashes: 0, clashes: 0 };
function resetAchvHoleCounters() { achvHole.splashes = 0; achvHole.clashes = 0; }
function achvOnSplash() { achvHole.splashes++; if (achvHole.splashes >= 3) unlockAchievement('pond3'); }
function achvOnBounce() {
  unlocks.counters.bounces++;
  if (unlocks.counters.bounces % 10 === 0) saveUnlocks();
  if (unlocks.counters.bounces >= 100) unlockAchievement('wall100');
}

// ---- Cosmetic style (persisted, applied in the lobby) ----
let myStyle = { hue: null, special: null, trail: null };
try {
  const saved = JSON.parse(localStorage.getItem('pocketPuttStyle'));
  if (saved) myStyle = saved;
} catch (e) { /* default */ }
// Never wear cosmetics this browser hasn't actually unlocked.
if (myStyle.special && !hasReward('color', myStyle.special)) myStyle.special = null;
if (myStyle.trail && !hasReward('trail', myStyle.trail)) myStyle.trail = null;
function saveMyStyle() { localStorage.setItem('pocketPuttStyle', JSON.stringify(myStyle)); }
function sendMyStyle() {
  if (mpSocket && mpSocket.readyState === WebSocket.OPEN) {
    mpSocket.send(JSON.stringify({
      type: 'setStyle',
      hue: myStyle.hue === null ? undefined : myStyle.hue,
      special: myStyle.special,
      trail: myStyle.trail,
    }));
  }
}

const SPECIAL_SWATCH_CSS = {
  sunburst: 'radial-gradient(circle at 35% 35%, #ffe680, #f4a020)',
  galaxy: 'radial-gradient(circle at 35% 35%, #6a4fc9, #191230)',
};
function buildCustomizeUI() {
  const swatches = document.getElementById('color-swatches');
  swatches.innerHTML = '';
  const pick = (mut) => { mut(); saveMyStyle(); sendMyStyle(); buildCustomizeUI(); };
  for (const hue of CLIENT_HUES) {
    const b = document.createElement('button');
    b.className = 'ball-swatch' + (myStyle.special === null && myStyle.hue === hue ? ' is-selected' : '');
    b.style.background = `hsl(${hue}, 90%, 55%)`;
    b.title = 'Ball color';
    b.addEventListener('click', () => pick(() => { myStyle.hue = hue; myStyle.special = null; }));
    swatches.appendChild(b);
  }
  for (const r of unlockedRewards('color')) {
    const b = document.createElement('button');
    b.className = 'ball-swatch' + (myStyle.special === r.id ? ' is-selected' : '');
    b.style.background = SPECIAL_SWATCH_CSS[r.id];
    b.title = r.label;
    b.addEventListener('click', () => pick(() => { myStyle.special = r.id; }));
    swatches.appendChild(b);
  }
  const trailRow = document.getElementById('trail-picker');
  const trails = unlockedRewards('trail');
  trailRow.classList.toggle('hidden', trails.length === 0);
  trailRow.innerHTML = '';
  if (trails.length) {
    const none = document.createElement('button');
    none.className = 'trail-chip' + (myStyle.trail === null ? ' is-selected' : '');
    none.textContent = 'No trail';
    none.addEventListener('click', () => pick(() => { myStyle.trail = null; }));
    trailRow.appendChild(none);
    for (const r of trails) {
      const chip = document.createElement('button');
      chip.className = 'trail-chip' + (myStyle.trail === r.id ? ' is-selected' : '');
      chip.textContent = r.label;
      chip.addEventListener('click', () => pick(() => { myStyle.trail = r.id; }));
      trailRow.appendChild(chip);
    }
  }
}

// ---- Multiplayer (lobby) ----
// ---- Multiplayer ----
// Coast netcode: puttApplied + local tick-locked sim + sparse soft/hard corrections.
// Multi-room relay protocol (create/join). Cosmetics + menu from main still apply.
const MULTIPLAYER = location.protocol !== 'file:';
const MP_PARAMS = new URLSearchParams(location.search);
function resolveWsUrl() {
  const r = MP_PARAMS.get('relay');
  if (r) {
    if (r.startsWith('ws://') || r.startsWith('wss://')) {
      return r.includes('/ws') ? r : r.replace(/\/$/, '') + '/ws';
    }
    const proto = location.protocol === 'https:' || r.includes('onrender.com') ? 'wss:' : 'ws:';
    return `${proto}//${r.replace(/^\/\//, '').replace(/\/$/, '')}/ws`;
  }
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${location.host}/ws`;
}
const RELAY_WS = resolveWsUrl();
let mpSocket = null;
let mpPlayerId = null;
let mpIsHost = false;
let mpCanPutt = false;
let mpPlaying = false;
let mpRoomCode = null;
// Local sim tick (integer). Host clock sample drives how far we may advance.
let mpSimTick = 0;
let mpHostTick = 0;
let mpHostTickAt = 0;
const MP_MAX_CATCH_UP = 8;
const MP_SOFT_ERR_PX = 10;
const MP_HARD_ERR_PX = 80;
const MP_ERR_DECAY_TAU = 0.12;

function mpSetRelayStatus(text) {
  const el = document.getElementById('lobby-relay-status');
  if (el) el.textContent = text || '';
}

function mpLobbyName() {
  return document.getElementById('lobby-name-input').value.trim() || 'Player';
}

let mpCourseIndex = 0;
function populateCourseSelect(el) {
  if (!el || el.options.length) return;
  COURSES.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = c.name;
    el.appendChild(opt);
  });
}

function mpRenderLobby(msg) {
  const me = msg.players.find((p) => p.id === mpPlayerId);
  if (me) mpIsHost = me.isHost;

  if (msg.roomCode) mpRoomCode = msg.roomCode;
  mpCourseIndex = msg.courseIndex ?? 0;
  const courseSelect = document.getElementById('course-select');
  const courseDisplay = document.getElementById('course-display');
  if (courseSelect) {
    populateCourseSelect(courseSelect);
    if (document.activeElement !== courseSelect) courseSelect.value = String(mpCourseIndex);
    courseSelect.classList.toggle('hidden', !mpIsHost);
  }
  if (courseDisplay) {
    courseDisplay.classList.toggle('hidden', mpIsHost);
    courseDisplay.textContent = COURSES[mpCourseIndex].name;
  }
  const joinUrlEl = document.getElementById('lobby-join-url');
  const labelEl = document.getElementById('lobby-join-label');
  const display = msg.joinUrl || msg.roomCode || '';
  if (labelEl) labelEl.textContent = msg.roomCode ? 'Share with friends:' : 'Friends open:';
  joinUrlEl.textContent = display;
  joinUrlEl.onclick = () => {
    navigator.clipboard.writeText(display).then(() => {
      const original = joinUrlEl.textContent;
      joinUrlEl.textContent = 'Copied!';
      setTimeout(() => { joinUrlEl.textContent = original; }, 1000);
    });
  };
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  for (const p of msg.players) {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('is-disconnected');
    const dotBg = p.special ? SPECIAL_SWATCH_CSS[p.special] : `hsl(${p.hue},85%,55%)`;
    const dot = `<span class="hue-dot" style="color:hsl(${p.hue},85%,55%);background:${dotBg}"></span>`;
    const hostTag = p.isHost ? '<span class="host-tag">Host</span>' : '';
    li.innerHTML = `${dot}<span>${p.name}</span>${hostTag}`;
    list.appendChild(li);
  }
  const startBtn = document.getElementById('btn-start-round');
  const waitingText = document.getElementById('lobby-waiting-text');
  startBtn.classList.toggle('hidden', !mpIsHost);
  waitingText.classList.toggle('hidden', mpIsHost);
}

let mpConnectGeneration = 0;
let mpPendingAction = null; // { type: 'create' } | { type: 'join', code }

function mpClearRoomCreds() {
  localStorage.removeItem('pocketPuttRoomCode');
  localStorage.removeItem('pocketPuttReconnectToken');
  mpRoomCode = null;
}

function mpSocketOpen() {
  return mpSocket && mpSocket.readyState === WebSocket.OPEN;
}

function mpConnect(opts = {}) {
  const skipAutoRejoin = !!opts.skipAutoRejoin;
  // Drop a half-open socket so create/join always get a clean handshake.
  if (mpSocket && (mpSocket.readyState === WebSocket.OPEN || mpSocket.readyState === WebSocket.CONNECTING)) {
    try { mpSocket.close(); } catch { /* ignore */ }
  }
  const gen = ++mpConnectGeneration;
  mpSetRelayStatus('Connecting…');
  mpSocket = new WebSocket(RELAY_WS);
  mpSocket.addEventListener('open', () => {
    if (gen !== mpConnectGeneration) return;
    const savedToken = localStorage.getItem('pocketPuttReconnectToken');
    const savedName = localStorage.getItem('pocketPuttName') || '';
    const savedRoom = localStorage.getItem('pocketPuttRoomCode') || '';
    const queryRoom = (MP_PARAMS.get('room') || '').trim().toUpperCase();
    document.getElementById('lobby-name-input').value = savedName;
    // Prefill the join field ONLY from ?room= in the URL — never from localStorage,
    // so a hard refresh doesn't look like a leftover "cookie" room code.
    const roomInput = document.getElementById('lobby-room-input');
    if (roomInput && queryRoom) roomInput.value = queryRoom;
    mpSetRelayStatus('Connected. Create a room or join with a code.');

    // Pending user action after a reconnect wins over auto-rejoin.
    if (mpPendingAction) {
      const action = mpPendingAction;
      mpPendingAction = null;
      if (action.type === 'create') {
        mpDoCreateRoom();
      } else if (action.type === 'join') {
        mpDoJoinRoom(action.code);
      }
      return;
    }

    if (skipAutoRejoin) return;

    // Deep link: https://host/?room=ABCDEF — join that room once.
    // Do not auto-rejoin from localStorage alone (stale codes after free-tier sleep
    // were closing sessions and stuffing the input field on every visit).
    if (queryRoom) {
      mpSetRelayStatus(`Joining ${queryRoom}…`);
      mpSocket.send(JSON.stringify({
        type: 'relay_join',
        room_code: queryRoom,
        player_name: savedName || 'Player',
      }));
    } else if (savedRoom && savedToken) {
      // Silent resume only — leave the join field empty.
      mpSetRelayStatus(`Reconnecting to last room…`);
      mpSocket.send(JSON.stringify({
        type: 'relay_reconnect',
        room_code: savedRoom,
        token: savedToken,
        player_name: savedName,
      }));
    }
  });
  mpSocket.addEventListener('close', () => {
    if (gen !== mpConnectGeneration) return;
    mpSetRelayStatus('Disconnected — click Create or Join to reconnect.');
  });
  mpSocket.addEventListener('error', () => {
    if (gen !== mpConnectGeneration) return;
    mpSetRelayStatus('Connection failed (free tier cold start can take ~1 min). Retry Create/Join.');
  });
  mpSocket.addEventListener('message', (e) => {
    if (gen !== mpConnectGeneration) return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'relay_error') {
      const hints = {
        room_not_found: 'Room not found (expired or wrong code). Create a new room or join another.',
        room_full: 'That room is full.',
        server_full: 'Relay is full — try later.',
        bad_token: 'Session expired — create or join again.',
        bad_handshake: 'Still connecting — try Create/Join once more.',
        join_failed: 'Could not join — try again.',
      };
      // Stale room/token must not block a fresh create on the same socket.
      if (msg.code === 'room_not_found' || msg.code === 'bad_token') {
        mpClearRoomCreds();
      }
      mpSetRelayStatus(hints[msg.code] || `Error: ${msg.code || 'unknown'}`);
      return;
    }
    if (msg.type === 'relay_created' || msg.type === 'relay_reconnected') {
      mpRoomCode = msg.room_code;
      if (msg.room_code) localStorage.setItem('pocketPuttRoomCode', msg.room_code);
      if (msg.token) localStorage.setItem('pocketPuttReconnectToken', msg.token);
      mpSetRelayStatus(msg.room_code ? `In room ${msg.room_code}` : '');
      return;
    }
    if (msg.type === 'welcome') {
      mpPlayerId = msg.playerId;
      mpIsHost = msg.isHost;
      localStorage.setItem('pocketPuttReconnectToken', msg.reconnectToken);
      if (msg.roomCode) {
        mpRoomCode = msg.roomCode;
        localStorage.setItem('pocketPuttRoomCode', msg.roomCode);
      }
      document.getElementById('lobby-join').classList.add('hidden');
      document.getElementById('lobby-joined').classList.remove('hidden');
      const rename = document.getElementById('lobby-rename-input');
      if (rename) rename.value = localStorage.getItem('pocketPuttName') || '';
      buildCustomizeUI();
      sendMyStyle();
    } else if (msg.type === 'notice') {
      mpShowBanner(msg.text);
    } else if (msg.type === 'lobbyState') {
      mpRenderLobby(msg);
      if (msg.state === 'WAITING_FOR_PLAYERS' && mpInRound) {
        mpInRound = false;
        mpPlaying = false;
        gameMenuEl.classList.add('hidden');
        hud.classList.add('hidden');
        Game.players.clear();
        mpCanPutt = false;
        showScreen('screen-lobby');
      }
    } else if (msg.type === 'roundState') {
      mpBeginHole(msg);
    } else if (msg.type === 'puttApplied') {
      mpOnPuttApplied(msg);
    } else if (msg.type === 'snapshot') {
      mpApplyCorrection(msg);
    } else if (msg.type === 'holeResults') {
      mpPlaying = false;
      mpRenderHoleResults(msg);
    } else if (msg.type === 'finalResults') {
      mpPlaying = false;
      mpRenderFinalResults(msg);
    }
  });
}

function mpBeginHole(msg) {
  if (msg.courseIndex !== undefined) Game.courseIndex = msg.courseIndex;
  Game.currentHoleIndex = msg.holeIndex;
  Game.players.clear();
  const hole = currentHoles()[msg.holeIndex];
  resetHoleObstacles(hole);
  const startTick = typeof msg.tick === 'number' ? msg.tick : 0;
  mpSimTick = startTick;
  mpNoteHostTick(startTick);
  setHoleObstaclesAtTick(hole, startTick);
  mpCanPutt = false;
  mpPlaying = true;
  resetAchvHoleCounters();
  mpInRound = true;
  gameMenuEl.classList.remove('hidden');
  hud.classList.remove('hidden');
  hideAllScreens();
}

function mpNoteHostTick(tick) {
  mpHostTick = tick;
  mpHostTickAt = performance.now();
}

function mpHostTargetTick() {
  return Math.floor(mpHostTick + ((performance.now() - mpHostTickAt) / 1000) * TICK_HZ);
}

function mpEstimatedElapsedMs() {
  return tickToElapsedMs(Math.max(mpSimTick, mpHostTargetTick()));
}

function mpUpsertPlayer(b) {
  let p = Game.players.get(b.id);
  if (!p) {
    p = {
      id: b.id, name: b.name, hue: b.hue, isHost: !!b.isHost,
      special: b.special || null, trail: b.trail || null, styled: !!b.styled,
      x: b.x, y: b.y, vx: b.vx || 0, vy: b.vy || 0,
      z: b.z || 0, vz: b.vz || 0,
      strokes: b.strokes || 0, holedOut: !!b.holedOut,
      rx: b.x, ry: b.y, rz: b.z || 0,
      errX: 0, errY: 0,
      squash: 0, spin: 0, angleDir: 0,
      firedBoosts: new Set(),
      stuckStickyIndex: typeof b.stuckStickyIndex === 'number' ? b.stuckStickyIndex : -1,
      trailPts: null,
    };
    Game.players.set(b.id, p);
  } else {
    p.name = b.name;
    p.hue = b.hue;
    p.isHost = !!b.isHost;
    if (b.special !== undefined) p.special = b.special || null;
    if (b.trail !== undefined) p.trail = b.trail || null;
    if (b.styled !== undefined) p.styled = !!b.styled;
  }
  return p;
}

function mpSyncSelfFromPlayer(p) {
  if (!p || p.id !== mpPlayerId) return;
  Game.ball.x = p.x;
  Game.ball.y = p.y;
  Game.ball.vx = p.vx;
  Game.ball.vy = p.vy;
  Game.ball.z = p.z || 0;
  Game.ball.vz = p.vz || 0;
  const speed = Math.hypot(p.vx, p.vy);
  mpCanPutt = !p.holedOut && speed < STOP_THRESHOLD && (p.z || 0) === 0;
  setHudText(hudStrokes, `Strokes: ${p.strokes}`);
}

function mpApplyAuthorityPose(p, b, hard) {
  const visX = p.rx, visY = p.ry;
  const dist = Math.hypot((p.x - b.x), (p.y - b.y));
  p.strokes = b.strokes;
  p.holedOut = !!b.holedOut;
  p.x = b.x;
  p.y = b.y;
  p.vx = b.vx;
  p.vy = b.vy;
  p.z = b.z || 0;
  p.vz = b.vz || 0;
  if (typeof b.stuckStickyIndex === 'number') p.stuckStickyIndex = b.stuckStickyIndex;
  if (Math.hypot(b.vx, b.vy) < STOP_THRESHOLD && p.z === 0) p.firedBoosts = new Set();

  const forceHard = hard || dist >= MP_HARD_ERR_PX || b.holedOut;
  if (forceHard) {
    p.errX = 0;
    p.errY = 0;
    p.rx = b.x;
    p.ry = b.y;
    p.rz = p.z;
  } else {
    p.errX = visX - b.x;
    p.errY = visY - b.y;
    const elen = Math.hypot(p.errX, p.errY);
    if (elen < MP_SOFT_ERR_PX) {
      p.errX = 0;
      p.errY = 0;
      p.rx = b.x;
      p.ry = b.y;
    }
    p.rz = p.z;
  }
}

function mpApplyPuttLocal(playerId, dragVector, fromServer, playSound) {
  const p = Game.players.get(playerId);
  if (!p || p.holedOut) return;
  const clamped = clampDragVector(dragVector);
  if (!clamped && !fromServer) return;
  const launch = clamped ? computeLaunchVelocity(clamped) : null;
  p.firedBoosts = new Set();
  p.errX = 0;
  p.errY = 0;
  const hole = currentHoles()[Game.currentHoleIndex];
  if (fromServer) {
    p.x = fromServer.x;
    p.y = fromServer.y;
    p.vx = fromServer.vx;
    p.vy = fromServer.vy;
    p.z = fromServer.z || 0;
    p.vz = fromServer.vz || 0;
    p.strokes = fromServer.strokes;
    if (typeof fromServer.stuckStickyIndex === 'number') {
      p.stuckStickyIndex = fromServer.stuckStickyIndex;
    } else {
      latchStickyAfterPutt(p, hole);
    }
  } else {
    const factor = stickyLaunchFactor(p, hole);
    latchStickyAfterPutt(p, hole);
    p.vx = launch.vx * factor;
    p.vy = launch.vy * factor;
    p.z = 0;
    p.vz = 0;
    p.strokes += 1;
  }
  p.angleDir = Math.atan2(p.vy, p.vx);
  p.squash = 0.6;
  p.rx = p.x;
  p.ry = p.y;
  if (playSound) soundPutt(Math.hypot(p.vx, p.vy) / MAX_LAUNCH_SPEED);
  if (playerId === mpPlayerId) {
    mpSyncSelfFromPlayer(p);
    mpCanPutt = false;
  }
}

function mpOnPuttApplied(msg) {
  if (!mpPlaying) return;
  if (typeof msg.tick === 'number') {
    mpNoteHostTick(msg.tick);
    if (msg.tick >= mpSimTick) {
      mpSimTick = msg.tick;
      setHoleObstaclesAtTick(currentHoles()[Game.currentHoleIndex], mpSimTick);
    }
  }
  const isSelf = msg.playerId === mpPlayerId;
  const p = Game.players.get(msg.playerId);
  if (isSelf && p) {
    const dist = Math.hypot(p.x - msg.x, p.y - msg.y);
    const dv = Math.hypot(p.vx - msg.vx, p.vy - msg.vy);
    if (dist > 1 || dv > 1) {
      mpApplyPuttLocal(msg.playerId, msg.dragVector, {
        x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, strokes: msg.strokes,
      }, false);
    } else {
      p.strokes = msg.strokes;
      mpSyncSelfFromPlayer(p);
    }
  } else {
    mpApplyPuttLocal(msg.playerId, msg.dragVector, {
      x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, strokes: msg.strokes,
    }, true);
  }
}

function mpStepOneTick() {
  const hole = currentHoles()[Game.currentHoleIndex];
  mpSimTick += 1;
  setHoleObstaclesAtTick(hole, mpSimTick);

  const active = [...Game.players.values()].filter((p) => !p.holedOut);
  // Same PHYSICS_SUBTICKS schedule as the host so sticky stop/latch thresholds match.
  for (let s = 0; s < MP_PHYSICS_SUBTICKS; s++) {
    for (const p of active) {
      if (p.holedOut) continue;
      const events = stepBallPhysics(p, hole, TICK_DT / MP_PHYSICS_SUBTICKS);
      const mine = p.id === mpPlayerId;
      if (events.bounced && mine) {
        maybePlayBounceSound();
        achvOnBounce();
      }
      if (events.enteredSand && mine) soundSand();
      for (const z of events.boosts) {
        spawnBoostSpark(p.x, p.y, p.angleDir);
        if (mine) soundBoost();
      }
      if (events.water) {
        p.x = events.water.dropPoint.x;
        p.y = events.water.dropPoint.y;
        p.vx = 0;
        p.vy = 0;
        p.z = 0;
        p.vz = 0;
        p.stuckStickyIndex = -1;
        p.strokes += 1;
        p.errX = 0;
        p.errY = 0;
        p.rx = p.x;
        p.ry = p.y;
        spawnSplash(events.water.dropPoint.x, events.water.dropPoint.y);
        if (mine) {
          soundWater();
          mpShowBanner('SPLASH! +1');
          achvOnSplash();
        }
      }
      if (events.holed) {
        p.holedOut = true;
        p.vx = 0;
        p.vy = 0;
        p.errX = 0;
        p.errY = 0;
        p.rx = p.x;
        p.ry = p.y;
        spawnConfetti(hole.cup.x, hole.cup.y);
        const diff = p.strokes - hole.par;
        soundHole(p.strokes === 1 || diff <= -2);
        if (mine) {
          if (p.strokes === 1) unlockAchievement('ace');
          mpShowBanner(ratingText(diff, p.strokes));
        } else {
          mpShowBanner(`${p.name} is in! (${p.strokes})`);
        }
      }
    }
  }
}

function mpUpdateLocalSim(dt) {
  if (!mpPlaying) {
    setHudText(hudTotal, `Time: ${(mpEstimatedElapsedMs() / 1000).toFixed(1)}s`);
    return;
  }
  const targetTick = mpHostTargetTick();
  let steps = 0;
  while (mpSimTick < targetTick && steps < MP_MAX_CATCH_UP) {
    mpStepOneTick();
    steps++;
  }

  const decay = Math.exp(-dt / MP_ERR_DECAY_TAU);
  for (const p of Game.players.values()) {
    p.errX *= decay;
    p.errY *= decay;
    if (Math.hypot(p.errX, p.errY) < 0.5) {
      p.errX = 0;
      p.errY = 0;
    }
    p.rx = p.x + p.errX;
    p.ry = p.y + p.errY;
    p.rz = p.z || 0;
  }
  // Cosmetics trails from render positions.
  const nowT = performance.now();
  for (const p of Game.players.values()) {
    if (!p.trail) { p.trailPts = null; continue; }
    if (!p.trailPts) p.trailPts = [];
    const lastPt = p.trailPts[p.trailPts.length - 1];
    if (!lastPt || Math.hypot(p.rx - lastPt.x, p.ry - lastPt.y) > 4) {
      p.trailPts.push({ x: p.rx, y: p.ry, t: nowT });
    }
    while (p.trailPts.length && nowT - p.trailPts[0].t > 600) p.trailPts.shift();
  }
  const me = Game.players.get(mpPlayerId);
  if (me) mpSyncSelfFromPlayer(me);
  setHudText(hudTotal, `Time: ${(mpEstimatedElapsedMs() / 1000).toFixed(1)}s`);
  const hole = currentHoles()[Game.currentHoleIndex];
  setHudText(hudHole, `Hole ${Game.currentHoleIndex + 1}/${currentHoles().length} — ${hole.name}`);
  setHudText(hudPar, `Par ${hole.par}`);
}

function mpApplyCorrection(msg) {
  const hole = currentHoles()[msg.holeIndex];
  const tick = typeof msg.tick === 'number' ? msg.tick : elapsedMsToTick(msg.elapsedMs || 0);
  const reason = msg.reason || 'heartbeat';
  const hard = !!msg.hard || reason === 'event' || reason === 'resync';
  mpPlaying = true;
  mpNoteHostTick(tick);

  if (msg.obstacles) {
    msg.obstacles.windmillAngles.forEach((a, i) => { if (hole.windmills[i]) hole.windmills[i].angle = a; });
    msg.obstacles.pendulumPhases.forEach((ph, i) => { if (hole.pendulums[i]) hole.pendulums[i].phase = ph; });
    msg.obstacles.gatePhases.forEach((ph, i) => { if (hole.gates[i]) hole.gates[i].phase = ph; });
  } else {
    setHoleObstaclesAtTick(hole, tick);
  }

  if (hard || mpSimTick > tick + 2) {
    mpSimTick = tick;
    if (!msg.obstacles) setHoleObstaclesAtTick(hole, tick);
  }

  const seen = new Set();
  for (const b of msg.balls || []) {
    seen.add(b.id);
    const existed = Game.players.has(b.id);
    const p = mpUpsertPlayer(b);
    mpApplyAuthorityPose(p, b, hard || !existed);
  }
  for (const id of Game.players.keys()) {
    if (!seen.has(id)) Game.players.delete(id);
  }

  for (const ev of msg.events || []) mpHandleEvent(ev, hole);

  const me = Game.players.get(mpPlayerId);
  if (me) {
    mpSyncSelfFromPlayer(me);
    mpUpdateHUD(msg);
  }
}

function mpRenderHoleResults(msg) {
  const hole = currentHoles()[msg.holeIndex];
  document.getElementById('hole-results-title').textContent = `${hole.name} — Results`;
  const body = document.getElementById('hole-results-body');
  body.innerHTML = '';
  for (const r of msg.results) {
    const tr = document.createElement('tr');
    const timeLabel = r.timedOut ? `${r.finishSeconds.toFixed(1)}s (timed out)` : `${r.finishSeconds.toFixed(1)}s`;
    tr.innerHTML = `<td>${r.name}</td><td>${r.strokes}</td><td>${timeLabel}</td><td>${r.holeScore.toFixed(1)}</td>`;
    body.appendChild(tr);
  }
  const standings = document.getElementById('hole-results-standings');
  standings.innerHTML = '';
  msg.standings.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="standing-rank">${i + 1}</span><span>${s.name}</span><span class="standing-score">${s.totalScore.toFixed(1)}</span>`;
    standings.appendChild(li);
  });
  const myResult = msg.results.find((r) => r.id === mpPlayerId);
  if (myResult && !myResult.timedOut && myResult.finishSeconds < 5) unlockAchievement('speed5');
  const isLastHole = msg.holeIndex === currentHoles().length - 1;
  document.getElementById('hole-results-next').textContent = isLastHole ? 'Final results coming up…' : 'Next hole starting soon…';
  showScreen('screen-hole-results');
}

function mpRenderFinalResults(msg) {
  const standings = document.getElementById('final-standings');
  standings.innerHTML = '';
  msg.standings.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="standing-rank">${i + 1}</span><span>${s.name}</span><span class="standing-score">${s.totalScore.toFixed(1)}</span>`;
    standings.appendChild(li);
  });
  if (msg.standings.length > 1 && msg.standings[0].id === mpPlayerId) unlockAchievement('champ');
  document.getElementById('btn-play-again').classList.toggle('hidden', !mpIsHost);
  document.getElementById('final-waiting-text').classList.toggle('hidden', mpIsHost);
  gameMenuEl.classList.add('hidden');
  hud.classList.add('hidden');
  showScreen('screen-final-results');
}

let mpBannerTimer = null;
function mpShowBanner(text) {
  const el = document.getElementById('mp-banner');
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(mpBannerTimer);
  mpBannerTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function mpHandleEvent(ev, hole) {
  const mine = ev.id === mpPlayerId;
  switch (ev.kind) {
    case 'bounce':
      break;
    case 'sand':
      break;
    case 'boost':
      if (!mine) spawnBoostSpark(ev.x, ev.y, ev.angle);
      break;
    case 'water':
      if (typeof ev.x === 'number') spawnSplash(ev.x, ev.y);
      if (mine) {
        soundWater();
        mpShowBanner('SPLASH! +1');
        achvOnSplash();
      }
      break;
    case 'clash':
      if (Array.isArray(ev.balls)) {
        for (const b of ev.balls) {
          const p = Game.players.get(b.id) || mpUpsertPlayer({
            id: b.id, name: '?', hue: 0, x: b.x, y: b.y, vx: b.vx, vy: b.vy, strokes: 0, holedOut: false,
          });
          mpApplyAuthorityPose(p, {
            x: b.x, y: b.y, vx: b.vx, vy: b.vy,
            strokes: p.strokes, holedOut: p.holedOut,
          }, true);
        }
      }
      playSfx('bounce', 0.7);
      if (typeof ev.x === 'number') spawnBoostSpark(ev.x, ev.y, Math.random() * Math.PI * 2);
      if (ev.a === mpPlayerId || ev.b === mpPlayerId) {
        achvHole.clashes++;
        if (achvHole.clashes >= 5) unlockAchievement('menace');
      }
      break;
    case 'holed': {
      spawnConfetti(hole.cup.x, hole.cup.y);
      const diff = ev.strokes - hole.par;
      soundHole(ev.strokes === 1 || diff <= -2);
      if (mine && ev.strokes === 1) unlockAchievement('ace');
      if (mine) {
        mpShowBanner(ratingText(diff, ev.strokes));
      } else {
        const who = Game.players.get(ev.id);
        if (who) mpShowBanner(`${who.name} is in! (${ev.strokes})`);
      }
      break;
    }
  }
}

function mpDoCreateRoom() {
  const name = mpLobbyName();
  localStorage.setItem('pocketPuttName', name);
  mpClearRoomCreds();
  mpSetRelayStatus('Creating room…');
  mpSocket.send(JSON.stringify({ type: 'relay_create', player_name: name }));
}

function mpDoJoinRoom(code) {
  const name = mpLobbyName();
  localStorage.setItem('pocketPuttName', name);
  mpSetRelayStatus(`Joining ${code}…`);
  mpSocket.send(JSON.stringify({ type: 'relay_join', room_code: code, player_name: name }));
}

function mpSendCreateRoom() {
  // Fresh create must not reuse a half-handshaken socket that already tried reconnect.
  if (!mpSocketOpen()) {
    mpPendingAction = { type: 'create' };
    mpConnect({ skipAutoRejoin: true });
    return;
  }
  // If we auto-rejoined or failed a reconnect on this socket, open a clean one for create.
  if (mpRoomCode || localStorage.getItem('pocketPuttRoomCode')) {
    mpPendingAction = { type: 'create' };
    mpConnect({ skipAutoRejoin: true });
    return;
  }
  mpDoCreateRoom();
}

function mpSendJoinRoom() {
  const code = (document.getElementById('lobby-room-input').value || '').trim().toUpperCase();
  if (!code) {
    mpSetRelayStatus('Enter a room code.');
    return;
  }
  if (!mpSocketOpen()) {
    mpPendingAction = { type: 'join', code };
    mpConnect({ skipAutoRejoin: true });
    return;
  }
  // Prefer a clean handshake if this socket already joined something else.
  if (mpPlayerId) {
    mpPendingAction = { type: 'join', code };
    mpConnect({ skipAutoRejoin: true });
    return;
  }
  mpDoJoinRoom(code);
}
const btnCreate = document.getElementById('btn-create-room');
if (btnCreate) {
  btnCreate.addEventListener('click', () => {
    unlockAudio();
    soundClick();
    mpSendCreateRoom();
  });
}
const btnJoinRoom = document.getElementById('btn-join-room');
if (btnJoinRoom) {
  btnJoinRoom.addEventListener('click', () => {
    unlockAudio();
    soundClick();
    mpSendJoinRoom();
  });
}
const gameMenuEl = document.getElementById('game-menu');
let mpInRound = false;
document.getElementById('btn-menu-restart').addEventListener('click', () => {
  soundClick();
  if (MULTIPLAYER) {
    mpSocket.send(JSON.stringify({ type: 'restartGame' }));
  } else {
    startGame();
  }
});
document.getElementById('btn-menu-end').addEventListener('click', () => {
  soundClick();
  if (MULTIPLAYER) {
    mpSocket.send(JSON.stringify({ type: 'endGame' }));
  } else {
    gameMenuEl.classList.add('hidden');
    hud.classList.add('hidden');
    Game.state = 'START';
    showScreen('screen-start');
  }
});
document.getElementById('btn-rename').addEventListener('click', () => {
  const name = document.getElementById('lobby-rename-input').value.trim();
  if (!name) return;
  localStorage.setItem('pocketPuttName', name);
  mpSocket.send(JSON.stringify({ type: 'setName', name }));
  soundClick();
});
const courseSelectEl = document.getElementById('course-select');
if (courseSelectEl) {
  courseSelectEl.addEventListener('change', (e) => {
    const courseIndex = Number(e.target.value);
    mpCourseIndex = courseIndex;
    if (mpSocket && mpSocket.readyState === WebSocket.OPEN) {
      mpSocket.send(JSON.stringify({ type: 'selectCourse', courseIndex }));
    }
  });
}
document.getElementById('btn-start-round').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  mpSocket.send(JSON.stringify({ type: 'startRound', courseIndex: mpCourseIndex }));
});
document.getElementById('btn-play-again').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  mpSocket.send(JSON.stringify({ type: 'startRound', courseIndex: mpCourseIndex }));
});

// ---- Init ----
setupCanvasDPR();
fitStage();
window.addEventListener('resize', fitStage);
populateCourseSelect(document.getElementById('solo-course-select'));
populateCourseSelect(document.getElementById('course-select'));
const soloCourse = document.getElementById('solo-course-select');
if (soloCourse) {
  soloCourse.addEventListener('change', () => {
    Game.courseIndex = Number(soloCourse.value) || 0;
  });
}
Game.ball.x = currentHoles()[0].tee.x;
Game.ball.y = currentHoles()[0].tee.y;
if (MULTIPLAYER) {
  showScreen('screen-lobby');
  mpConnect();
} else {
  showScreen('screen-start');
}
requestAnimationFrame(loop);
