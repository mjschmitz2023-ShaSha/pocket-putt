// Pocket Putt — classic (non-module) script, runs fine over file:// with no build step.
// Physics/course-data now live in shared.js (loaded before this file) so the same code
// can run authoritatively on the multiplayer host — see MULTIPLAYER below.
const {
  LOGICAL_W, LOGICAL_H, BALL_RADIUS, FRICTION_GRASS, FRICTION_SAND, STOP_THRESHOLD,
  CUP_GRAVITY_RADIUS,
  WALL_RESTITUTION, BUMPER_RESTITUTION, PENDULUM_RESTITUTION, GATE_RESTITUTION,
  MAX_DRAG_DIST, MIN_DRAG_DIST, POWER_MULTIPLIER, MAX_LAUNCH_SPEED, BOOST_MAX_SPEED, BOUND,
  BOUNDARY_WALLS, HOLES, pointInZone, zoneBounds, resolveWallCollision, getWindmillBlades,
  getPendulumSegment, getSlidingGateSegment,
  createBallState, stepBallPhysics, advanceHoleObstacles, resetHoleObstacles, computeLaunchVelocity,
} = window.Shared;

const BOOST_COLOR_A = '#8b2fd1';
const BOOST_COLOR_B = '#2fd1c8';

// ---- Game state ----
const Game = {
  state: 'START',
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
  updateHUD();
  Game.hazardTimer = 0.9;
  Game.state = 'HAZARD_RESET';
  showScreen('screen-hazard');
}
// Thin wrapper around shared.js's stepBallPhysics: the physics itself is identical to what
// the multiplayer server runs, this just reacts to the returned events with solo-mode
// sound/particles/scoring so the two never have to agree on anything beyond ball motion.
function updateBallPhysics(dt) {
  const hole = HOLES[Game.currentHoleIndex];
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
    const nearCup = Math.hypot(Game.ball.x - hole.cup.x, Game.ball.y - hole.cup.y) < CUP_GRAVITY_RADIUS;
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
function drawTrail() {
  const hue = (performance.now() / 1000 * 130) % 360;
  for (const pt of Game.trail) {
    const alpha = Math.max(0, 1 - pt.age / 0.6);
    if (alpha <= 0) continue;
    ctx.fillStyle = `hsla(${hue}, 100%, 70%, ${alpha * 0.4})`;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, BALL_RADIUS * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawBall() {
  const b = Game.ball;
  const t = performance.now() / 1000;
  const baseHue = (t * 130) % 360;

  ctx.save();
  ctx.translate(b.x, b.y);
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
  ctx.save();
  ctx.translate(bx, by);
  if (isSelf) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (b.isHost) {
    // The host's exclusive rainbow ball: hue tracks speed — cool violet at rest, blazing
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
function drawWorld() {
  const hole = HOLES[Game.currentHoleIndex];
  drawGrass();
  for (const z of hole.sand) drawSandZone(z);
  for (const z of hole.water) drawWaterZone(z);
  for (const z of hole.boost) drawBoostZone(z);
  for (const w of BOUNDARY_WALLS) drawWallSegment(w);
  for (const w of hole.walls) drawWallSegment(w);
  for (const wm of hole.windmills) drawWindmill(wm);
  for (const p of hole.pendulums) drawPendulum(p);
  for (const g of hole.gates) drawSlidingGate(g);
  drawHoleAndFlag(hole);

  if (MULTIPLAYER) {
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
  const hole = HOLES[Game.currentHoleIndex];
  hudHole.textContent = `Hole ${Game.currentHoleIndex + 1}/${HOLES.length} — ${hole.name}`;
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
  const hole = HOLES[msg.holeIndex];
  const me = Game.players.get(mpPlayerId);
  setHudText(hudHole, `Hole ${msg.holeIndex + 1}/${HOLES.length} — ${hole.name}`);
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
  const hole = HOLES[i];
  Game.strokes = 0;
  Game.ball = createBallState(hole.tee);
  Game.trail = [];
  Game.drag.active = false;
  resetHoleObstacles(hole);
  hud.classList.remove('hidden');
  hideAllScreens();
  Game.state = 'AIMING';
  updateHUD();
}
function startGame() {
  Game.scorecard = [];
  Game.totalStrokes = 0;
  loadHole(0);
}
function onHoleComplete() {
  const hole = HOLES[Game.currentHoleIndex];
  const diff = Game.strokes - hole.par;
  Game.scorecard.push({ hole: Game.currentHoleIndex + 1, name: hole.name, par: hole.par, strokes: Game.strokes });
  spawnConfetti(hole.cup.x, hole.cup.y);
  soundHole(Game.strokes === 1 || diff <= -2);
  document.getElementById('banner-text').textContent = ratingText(diff, Game.strokes);
  document.getElementById('hole-complete-strokes').textContent = `${Game.strokes} stroke${Game.strokes === 1 ? '' : 's'} (Par ${hole.par})`;
  document.getElementById('btn-next').textContent = Game.currentHoleIndex === HOLES.length - 1 ? 'See Scorecard →' : 'Next Hole →';
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
  Game.ball.firedBoosts.clear();
  const v = computeLaunchVelocity(pointerVec);
  Game.ball.vx = v.vx;
  Game.ball.vy = v.vy;
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
    mpSocket.send(JSON.stringify({ type: 'putt', dragVector: v }));
    mpCanPutt = false; // re-armed once the next snapshot shows the ball stopped again
    // Client-side prediction: launch the local copy of our ball immediately so the shot
    // responds with zero perceived latency; server snapshots blend-correct any drift.
    const lv = computeLaunchVelocity(v);
    Game.ball.firedBoosts.clear();
    Game.ball.vx = lv.vx;
    Game.ball.vy = lv.vy;
    Game.ball.squash = 0.6;
    Game.ball.angleDir = Math.atan2(lv.vy, lv.vx);
    soundPutt(lv.speed / MAX_LAUNCH_SPEED);
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

document.getElementById('btn-play').addEventListener('click', () => { unlockAudio(); soundClick(); startGame(); });
document.getElementById('btn-next').addEventListener('click', () => {
  soundClick();
  if (Game.currentHoleIndex === HOLES.length - 1) showRoundComplete();
  else loadHole(Game.currentHoleIndex + 1);
});
document.getElementById('btn-replay').addEventListener('click', () => { soundClick(); startGame(); });

// ---- Main loop ----
function update(dt) {
  const hole = HOLES[Game.currentHoleIndex];
  // Obstacles advance locally every frame in BOTH modes (they're deterministic functions
  // of time); in multiplayer the server's snapshot values overwrite ours on arrival, so
  // everyone stays corrected to the authoritative timeline while animating smoothly
  // between packets — even during 5Hz idle keepalives.
  advanceHoleObstacles(hole, dt);
  if (MULTIPLAYER) {
    // Predict our own ball locally every frame (same shared physics the server runs) so
    // our shots and bounces feel instant; sounds/particles for our ball come from this
    // local sim, while water/holed outcomes stay server-authoritative.
    const meSnap = Game.players.get(mpPlayerId);
    if (meSnap && !meSnap.holedOut) {
      const evs = stepBallPhysics(Game.ball, hole, dt);
      if (evs.bounced) maybePlayBounceSound();
      if (evs.enteredSand) soundSand();
      for (const z of evs.boosts) {
        spawnBoostSpark(Game.ball.x, Game.ball.y, Game.ball.angleDir);
        soundBoost();
      }
      if (evs.water || evs.holed) {
        Game.ball.vx = 0;
        Game.ball.vy = 0; // freeze and let the server's verdict arrive
      }
      Game.ball.squash *= Math.exp(-10 * dt);
    }
    mpInterpolateBalls();
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

// ---- Multiplayer (lobby) ----
// Solo file:// play and the hosted multiplayer game are the same index.html/game.js —
// this just detects which one we are and, in multiplayer mode, connects to the server's
// WebSocket for the lobby. Round/putt/snapshot handling lands in later milestones.
const MULTIPLAYER = location.protocol !== 'file:';
let mpSocket = null;
let mpPlayerId = null;
let mpIsHost = false;
let mpCanPutt = false;
// Snapshot interpolation: render ~100ms in the past, blending between two buffered
// snapshots, so Wi-Fi packet jitter never shows up as ball stutter. (The host on
// localhost never sees jitter — remote players do; this is for them.)
const MP_INTERP_DELAY_MS = 100;
let mpSnapBuffer = [];
let mpClock = null; // { elapsedMs, at } — server hole-clock sample for extrapolation

function mpRenderLobby(msg) {
  // The server may promote a new host after the original host disconnects - re-derive
  // mpIsHost from the current player list every time rather than trusting the one-time
  // value from 'welcome', so the newly-promoted player actually sees the Start button.
  const me = msg.players.find((p) => p.id === mpPlayerId);
  if (me) mpIsHost = me.isHost;

  const joinUrlEl = document.getElementById('lobby-join-url');
  joinUrlEl.textContent = msg.joinUrl;
  joinUrlEl.onclick = () => {
    navigator.clipboard.writeText(msg.joinUrl).then(() => {
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
    const dot = `<span class="hue-dot" style="color:hsl(${p.hue},85%,55%);background:hsl(${p.hue},85%,55%)"></span>`;
    const hostTag = p.isHost ? '<span class="host-tag">Host</span>' : '';
    li.innerHTML = `${dot}<span>${p.name}</span>${hostTag}`;
    list.appendChild(li);
  }
  const startBtn = document.getElementById('btn-start-round');
  const waitingText = document.getElementById('lobby-waiting-text');
  startBtn.classList.toggle('hidden', !mpIsHost);
  waitingText.classList.toggle('hidden', mpIsHost);
}

function mpConnect() {
  mpSocket = new WebSocket(`ws://${location.host}/ws`);
  mpSocket.addEventListener('open', () => {
    const savedToken = localStorage.getItem('pocketPuttReconnectToken');
    const savedName = localStorage.getItem('pocketPuttName') || '';
    document.getElementById('lobby-name-input').value = savedName;
    if (savedToken) {
      mpSocket.send(JSON.stringify({ type: 'join', name: savedName, reconnectToken: savedToken }));
    }
  });
  mpSocket.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'welcome') {
      mpPlayerId = msg.playerId;
      mpIsHost = msg.isHost;
      localStorage.setItem('pocketPuttReconnectToken', msg.reconnectToken);
      document.getElementById('lobby-join').classList.add('hidden');
      document.getElementById('lobby-joined').classList.remove('hidden');
    } else if (msg.type === 'lobbyState') {
      mpRenderLobby(msg);
    } else if (msg.type === 'roundState') {
      Game.currentHoleIndex = msg.holeIndex;
      Game.players.clear();
      mpSnapBuffer = [];
      mpClock = null;
      mpCanPutt = false;
      hud.classList.remove('hidden');
      hideAllScreens();
    } else if (msg.type === 'snapshot') {
      mpApplySnapshot(msg);
    } else if (msg.type === 'holeResults') {
      mpRenderHoleResults(msg);
    } else if (msg.type === 'finalResults') {
      mpRenderFinalResults(msg);
    }
  });
}

function mpRenderHoleResults(msg) {
  const hole = HOLES[msg.holeIndex];
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
  const isLastHole = msg.holeIndex === HOLES.length - 1;
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
  document.getElementById('btn-play-again').classList.toggle('hidden', !mpIsHost);
  document.getElementById('final-waiting-text').classList.toggle('hidden', mpIsHost);
  hud.classList.add('hidden');
  showScreen('screen-final-results');
}

function mpApplySnapshot(msg) {
  const hole = HOLES[msg.holeIndex];
  msg.obstacles.windmillAngles.forEach((a, i) => { hole.windmills[i].angle = a; });
  msg.obstacles.pendulumPhases.forEach((ph, i) => { hole.pendulums[i].phase = ph; });
  msg.obstacles.gatePhases.forEach((ph, i) => { hole.gates[i].phase = ph; });

  // Update entries in place (never clear/recreate): each keeps rx/ry render coordinates
  // driven by the interpolation buffer below, so ball motion stays smooth between (and
  // through jittery arrivals of) network updates.
  const seen = new Set();
  for (const b of msg.balls) {
    seen.add(b.id);
    const existing = Game.players.get(b.id);
    if (existing) {
      Object.assign(existing, b);
    } else {
      Game.players.set(b.id, { ...b, rx: b.x, ry: b.y });
    }
  }
  for (const id of Game.players.keys()) {
    if (!seen.has(id)) Game.players.delete(id);
  }

  // Feed the interpolation buffer and re-sync the extrapolated hole clock.
  mpClock = { elapsedMs: msg.elapsedMs, at: performance.now() };
  mpSnapBuffer.push({ t: msg.elapsedMs, byId: new Map(msg.balls.map((b) => [b.id, b])) });
  if (mpSnapBuffer.length > 30) mpSnapBuffer.shift();

  for (const ev of msg.events || []) mpHandleEvent(ev, hole);

  const me = Game.players.get(mpPlayerId);
  if (me) {
    // Reconcile prediction with the server: snap on big divergence (we got rammed, or a
    // water teleport we predicted differently), otherwise absorb the error gently so the
    // correction is invisible.
    const errX = me.x - Game.ball.x, errY = me.y - Game.ball.y;
    if (Math.hypot(errX, errY) > 60) {
      Game.ball.x = me.x;
      Game.ball.y = me.y;
      Game.ball.vx = me.vx;
      Game.ball.vy = me.vy;
    } else {
      Game.ball.x += errX * 0.15;
      Game.ball.y += errY * 0.15;
      Game.ball.vx += (me.vx - Game.ball.vx) * 0.15;
      Game.ball.vy += (me.vy - Game.ball.vy) * 0.15;
    }
    const speed = Math.hypot(me.vx, me.vy);
    mpCanPutt = !me.holedOut && speed < STOP_THRESHOLD;
    mpUpdateHUD(msg);
  }
}

function mpEstimatedElapsedMs() {
  return mpClock ? mpClock.elapsedMs + (performance.now() - mpClock.at) : 0;
}

function mpInterpolateBalls() {
  if (!mpClock || mpSnapBuffer.length === 0) return;
  const rt = mpEstimatedElapsedMs() - MP_INTERP_DELAY_MS;
  // Find the two snapshots bracketing the render time.
  let s0 = mpSnapBuffer[0], s1 = mpSnapBuffer[mpSnapBuffer.length - 1];
  for (let i = mpSnapBuffer.length - 1; i >= 0; i--) {
    if (mpSnapBuffer[i].t <= rt) {
      s0 = mpSnapBuffer[i];
      s1 = mpSnapBuffer[Math.min(i + 1, mpSnapBuffer.length - 1)];
      break;
    }
  }
  const span = s1.t - s0.t;
  const f = span > 0 ? Math.min(Math.max((rt - s0.t) / span, 0), 1) : 1;
  for (const [id, p] of Game.players) {
    const b0 = s0.byId.get(id), b1 = s1.byId.get(id);
    if (b0 && b1) {
      // Water-hazard teleports shouldn't lerp the ball sweeping across the course.
      if (Math.hypot(b1.x - b0.x, b1.y - b0.y) > 150) {
        p.rx = b1.x;
        p.ry = b1.y;
      } else {
        p.rx = b0.x + (b1.x - b0.x) * f;
        p.ry = b0.y + (b1.y - b0.y) * f;
      }
    } else if (b1) {
      p.rx = b1.x;
      p.ry = b1.y;
    }
  }
  // Our own ball renders from the local prediction, not the delayed interp buffer.
  const meP = Game.players.get(mpPlayerId);
  if (meP && !meP.holedOut) {
    meP.rx = Game.ball.x;
    meP.ry = Game.ball.y;
    meP.vx = Game.ball.vx;
    meP.vy = Game.ball.vy;
  }
  // Smooth timer between packets (also during 5Hz idle keepalives).
  setHudText(hudTotal, `Time: ${(mpEstimatedElapsedMs() / 1000).toFixed(1)}s`);
  // Prune history we can no longer render.
  while (mpSnapBuffer.length > 2 && mpSnapBuffer[1].t < rt - 500) mpSnapBuffer.shift();
}

let mpBannerTimer = null;
function mpShowBanner(text) {
  const el = document.getElementById('mp-banner');
  el.textContent = text;
  el.classList.remove('hidden');
  // retrigger the pop-in animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(mpBannerTimer);
  mpBannerTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function mpHandleEvent(ev, hole) {
  const mine = ev.id === mpPlayerId;
  switch (ev.kind) {
    // Our own bounce/sand/boost feedback comes from the local prediction sim (instant);
    // the server copies of those events are skipped for us to avoid doubles.
    case 'bounce':
      break;
    case 'sand':
      break;
    case 'boost':
      if (!mine) spawnBoostSpark(ev.x, ev.y, ev.angle);
      break;
    case 'water':
      spawnSplash(ev.x, ev.y);
      if (mine) {
        soundWater();
        mpShowBanner('SPLASH! +1');
      }
      break;
    case 'clash':
      // Ball-on-ball contact: everyone hears the clack and sees the sparks.
      playSfx('bounce', 0.7);
      spawnBoostSpark(ev.x, ev.y, Math.random() * Math.PI * 2);
      break;
    case 'holed': {
      spawnConfetti(hole.cup.x, hole.cup.y);
      const diff = ev.strokes - hole.par;
      soundHole(ev.strokes === 1 || diff <= -2);
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

document.getElementById('btn-join').addEventListener('click', () => {
  unlockAudio();
  const name = document.getElementById('lobby-name-input').value.trim() || 'Player';
  localStorage.setItem('pocketPuttName', name);
  mpSocket.send(JSON.stringify({ type: 'join', name }));
});
document.getElementById('btn-start-round').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  mpSocket.send(JSON.stringify({ type: 'startRound' }));
});
document.getElementById('btn-play-again').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  mpSocket.send(JSON.stringify({ type: 'startRound' }));
});

// ---- Init ----
setupCanvasDPR();
fitStage();
window.addEventListener('resize', fitStage);
Game.ball.x = HOLES[0].tee.x;
Game.ball.y = HOLES[0].tee.y;
if (MULTIPLAYER) {
  showScreen('screen-lobby');
  mpConnect();
} else {
  showScreen('screen-start');
}
requestAnimationFrame(loop);
