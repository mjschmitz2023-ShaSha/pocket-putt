// Pocket Putt — classic (non-module) script, runs fine over file:// with no build step.
// Physics/course-data now live in shared.js (loaded before this file) so the same code
// can run authoritatively on the multiplayer host — see MULTIPLAYER below.
const {
  TICK_HZ, TICK_DT, TICK_MS, tickToElapsedMs, elapsedMsToTick,
  LOGICAL_W, LOGICAL_H, BALL_RADIUS, FRICTION_GRASS, FRICTION_SAND, STOP_THRESHOLD,
  CUP_GRAVITY_RADIUS, cupHasGravity,
  WALL_RESTITUTION, BUMPER_RESTITUTION, PENDULUM_RESTITUTION, GATE_RESTITUTION,
  MAX_DRAG_DIST, MIN_DRAG_DIST, POWER_MULTIPLIER, MAX_LAUNCH_SPEED, BOOST_MAX_SPEED, BOUND,
  COURSES,
  createBallState, stepBallPhysics, advanceHoleObstacles, setHoleObstaclesAtTick, resetHoleObstacles,
  computeLaunchVelocity, clampDragVector, stickyLaunchFactor, stickyIndexAt, latchStickyAfterPutt,
  markWetFromWater, noteWetPutt, ballMayRestForAim, zoneBounds, waterDropPointFor,
  waterDropIndexFor, waterWaveFrontAt, stepWaterFloat, WATER_FLOAT_TICKS, WATER_FLOAT_CARRY,
  createSpeedAvgTracker, resetSpeedAvgTracker, noteSpeedSample, isQuasiRest, mayPuttBall,
  teePositionFor, resolveBallBallCollision,
  decodeHole, encodeHole, normalizeHole, blankHole,
} = window.Shared;
// Must match gameSession PHYSICS_SUBTICKS — same dt schedule keeps sticky latch deterministic.
const MP_PHYSICS_SUBTICKS = 4;
// Every hole lookup goes through custom hole (if any) or the selected course.
function currentHoles() {
  if (Game.customHole) return [Game.customHole];
  return COURSES[Game.courseIndex].holes;
}

// ---- Game state ----
const Game = {
  state: 'START',
  /** True while portal gravity BEM bake is in progress (solo or MP). */
  gravityBaking: false,
  courseIndex: 0,
  customHole: null, // normalized single hole when playing/hosting a shared custom level
  pendingCustomLvl: null, // encoded string to attach on create room
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
  /** Rolling speed average for quasi-rest putt escape (solo). */
  speedTracker: createSpeedAvgTracker(),
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
const respawnOfferEl = document.getElementById('respawn-offer');
const RESPAWN_OFFER_SEC = 15;
/** Ignore soft host poses for this long after local respawn (soft snaps undid the tee). */
const RESPAWN_SOFT_GRACE_MS = 1500;
let unsettledSec = 0;
let settledSec = 0;
let respawnOfferVisible = false;
let respawnDismissedUntilSettle = false;
let respawnSoftGraceUntil = 0;

function hideRespawnOffer() {
  if (respawnOfferEl) respawnOfferEl.classList.add('hidden');
  respawnOfferVisible = false;
}
function showRespawnOffer() {
  if (!respawnOfferEl || respawnOfferVisible || respawnDismissedUntilSettle) return;
  respawnOfferEl.classList.remove('hidden');
  respawnOfferVisible = true;
}
/** True while local ball is in play and not ready for a normal putt. */
function isBallUnsettled() {
  if (MULTIPLAYER) {
    if (!mpPlaying || !mpPlayerId) return false;
    const me = Game.players.get(mpPlayerId);
    if (!me || me.holedOut) return false;
    return !mpCanPutt;
  }
  // Solo: rolling, or gravity-wake thrash that never hands AIMING cleanly.
  if (Game.state === 'BALL_MOVING') return true;
  if (Game.state === 'AIMING') {
    const hole = currentHoles()[Game.currentHoleIndex];
    return !mayPuttBall(Game.ball, hole, Game.speedTracker);
  }
  return false;
}
function resetUnsettledTimer() {
  unsettledSec = 0;
  settledSec = 0;
  respawnDismissedUntilSettle = false;
  hideRespawnOffer();
}
function doLocalRespawnToTee() {
  const hole = currentHoles()[Game.currentHoleIndex];
  Game.drag.active = false;
  if (powerLabelEl) powerLabelEl.classList.add('hidden');
  resetSpeedAvgTracker(Game.speedTracker);
  respawnSoftGraceUntil = performance.now() + RESPAWN_SOFT_GRACE_MS;
  if (MULTIPLAYER) {
    const me = Game.players.get(mpPlayerId);
    if (me) {
      // Match host slot layout so optimistic tee agrees with authority.
      let idx = 0;
      let i = 0;
      for (const p of Game.players.values()) {
        if (p.id === mpPlayerId) { idx = i; break; }
        i++;
      }
      const tee = teePositionFor(idx, Game.players.size, hole);
      me.x = tee.x;
      me.y = tee.y;
      me.vx = 0;
      me.vy = 0;
      me.z = 0;
      me.vz = 0;
      me.errX = 0;
      me.errY = 0;
      me.rx = me.x;
      me.ry = me.y;
      me.wet = false;
      me.wetStroke = false;
      me.firedBoosts = new Set();
      me.stuckStickyIndex = -1;
      mpSyncSelfFromPlayer(me);
      // Force putt unlock at tee (soft host snaps must not re-lock for grace window).
      if (!me.holedOut) mpCanPutt = true;
    }
  } else {
    Game.ball.x = hole.tee.x;
    Game.ball.y = hole.tee.y;
    Game.ball.vx = 0;
    Game.ball.vy = 0;
    Game.ball.z = 0;
    Game.ball.vz = 0;
    Game.ball.wet = false;
    Game.ball.wetStroke = false;
    Game.ball.firedBoosts = new Set();
    Game.ball.stuckStickyIndex = -1;
    Game.trail = [];
    Game.state = 'AIMING';
  }
  resetUnsettledTimer();
  hideAllScreens();
}
function requestRespawn(ev) {
  if (ev && typeof ev.preventDefault === 'function') {
    ev.preventDefault();
    ev.stopPropagation();
  }
  soundClick();
  if (MULTIPLAYER) {
    if (mpSocketOpen()) {
      mpSocket.send(JSON.stringify({ type: 'respawn' }));
    }
    // Optimistic local tee so the UI unlocks immediately; host hard-resync confirms.
    doLocalRespawnToTee();
  } else {
    doLocalRespawnToTee();
  }
}
function updateRespawnOffer(dt) {
  if (isBallUnsettled()) {
    unsettledSec += dt;
    settledSec = 0;
    if (unsettledSec >= RESPAWN_OFFER_SEC) showRespawnOffer();
  } else {
    settledSec += dt;
    // Hysteresis: brief AIMING flicker mid-bounce must not wipe a nearly-ready offer.
    if (settledSec >= 0.45) {
      if (respawnOfferVisible) {
        // Can putt again — drop the offer.
        resetUnsettledTimer();
      } else if (unsettledSec > 0) {
        unsettledSec = 0;
      }
    }
  }
}

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
const SFX_FILES = {
  putt: 'putt.wav',
  bounce: 'echoey_putt.wav',
  holeIn: 'putt_go_in.wav',
  portalEnter: 'sounds/portal/portal_enter.wav',
  portalExit: 'sounds/portal/portal_exit.wav',
};
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
// stepBallPhysics / obstacle helpers come from shared.js so solo and multiplayer host agree.
function maybePlayBounceSound() {
  const now = performance.now();
  if (now - Game.lastBounceSoundAt > 70) {
    soundBounce();
    Game.lastBounceSoundAt = now;
    achvOnBounce();
  }
}
function handleWaterHazard(zone) {
  // Penalty + banner land the instant the ball crosses the waterline; the reset to the
  // drop point waits ~1.5s while the ball bobs afloat and drifts with the pond's waves.
  Game.strokes++;
  Game.totalStrokes++;
  spawnSplash(Game.ball.x, Game.ball.y);
  soundWater();
  achvOnSplash();
  updateHUD();
  Game.waterFloat = {
    zone,
    timer: 1.5,
    vx: Game.ball.vx * 0.22, // a little entry momentum carries into the float
    vy: Game.ball.vy * 0.22,
  };
  Game.ball.vx = 0;
  Game.ball.vy = 0;
  Game.trail = [];
  Game.hazardTimer = 0.9;
  Game.state = 'WATER_FLOAT';
  showScreen('screen-hazard');
  const hazardMsg = document.getElementById('hazard-text');
  if (hazardMsg) hazardMsg.textContent = 'Splash! +1  ·  WET — goo is slick this putt';
}
function updateWaterFloat(dt) {
  const f = Game.waterFloat;
  if (!f) return;
  f.timer -= dt;
  // Drift with the pond's lead wave — shared closed-form front on the same clock the
  // renderer draws with, so the ball visibly rides the wave players see.
  stepWaterFloat(Game.ball, f, f.zone, performance.now() / 1000, dt);

  if (f.timer <= 0) {
    Game.waterFloat = null;
    // Solo variation: land on the original point or any spot in the first drop ring.
    const hole = currentHoles()[Game.currentHoleIndex];
    const drop = waterDropPointFor(f.zone, Math.floor(Math.random() * 6), hole);
    Game.ball.x = drop.x;
    Game.ball.y = drop.y;
    Game.ball.vx = 0;
    Game.ball.vy = 0;
    markWetFromWater(Game.ball);
    Game.trail = [];
    spawnSplash(drop.x, drop.y);
    hideAllScreens();
    Game.state = 'AIMING';
    resetUnsettledTimer();
  }
}
function handleBlackHoleHazard() {
  Game.strokes++;
  Game.totalStrokes++;
  const hole = currentHoles()[Game.currentHoleIndex];
  Game.ball.x = hole.tee.x;
  Game.ball.y = hole.tee.y;
  Game.ball.vx = 0;
  Game.ball.vy = 0;
  Game.ball.z = 0;
  Game.ball.vz = 0;
  Game.ball.wet = false;
  Game.ball.wetStroke = false;
  Game.ball.firedBoosts = new Set();
  Game.trail = [];
  // Visual only — black holes are not water; do not count toward Pond Lover / bubble trail.
  spawnSplash(hole.tee.x, hole.tee.y);
  soundWater();
  updateHUD();
  Game.hazardTimer = 0.9;
  Game.state = 'HAZARD_RESET';
  showScreen('screen-hazard');
  const hazardMsg = document.getElementById('hazard-text');
  if (hazardMsg) hazardMsg.textContent = 'Event horizon! +1  ·  Reset to tee';
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
  if (events.portals && events.portals.length) {
    playSfx('portalEnter', 0.85);
    playSfx('portalExit', 0.85);
  }
  if (events.water) { handleWaterHazard(events.water); return; }
  if (events.blackHole) { handleBlackHoleHazard(); return; }
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
    // Never freeze mid-air in a field, or when a moving well (moon) is pulling hard enough
    // that a "stationary" ball should start rolling again.
    // Clean rest only → AIMING. Crawl/quasi-rest putts interrupt from handlePointerDown
    // while still BALL_MOVING (do not freeze AIMING or gravity wake breaks).
    const nearCup = cupHasGravity(hole) && Math.hypot(Game.ball.x - hole.cup.x, Game.ball.y - hole.cup.y) < CUP_GRAVITY_RADIUS;
    if (!nearCup && ballMayRestForAim(Game.ball, hole)) {
      Game.ball.vx = 0;
      Game.ball.vy = 0;
      Game.state = 'AIMING';
    } else if (!nearCup) {
      // Keep simulating (e.g. moon field just overlapped a resting ball).
      Game.state = 'BALL_MOVING';
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

// ---- Rendering (hole art lives in draw.js as window.Draw) ----
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

  // outer glow, pulsing gently (wet = cool water sheen)
  const glowR = BALL_RADIUS + 5 + Math.sin(t * 4) * 1.5;
  if (b.wet) {
    const wetGlow = ctx.createRadialGradient(0, 0, BALL_RADIUS * 0.4, 0, 0, glowR + 2);
    wetGlow.addColorStop(0, 'rgba(120, 210, 255, 0.65)');
    wetGlow.addColorStop(1, 'rgba(40, 140, 255, 0)');
    ctx.fillStyle = wetGlow;
  } else {
    const glow = ctx.createRadialGradient(0, 0, BALL_RADIUS * 0.5, 0, 0, glowR);
    glow.addColorStop(0, `hsla(${baseHue}, 100%, 65%, 0.55)`);
    glow.addColorStop(1, `hsla(${baseHue}, 100%, 65%, 0)`);
    ctx.fillStyle = glow;
  }
  ctx.beginPath();
  ctx.arc(0, 0, glowR + (b.wet ? 2 : 0), 0, Math.PI * 2);
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
  if (b.wet) {
    ctx.fillStyle = 'rgba(80, 190, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, BALL_RADIUS + 5, 0, Math.PI * 2);
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
  Draw.roundRectPath(ctx, bx - boxW / 2, by - BALL_RADIUS - 22, boxW, 16, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, bx, by - BALL_RADIUS - 14);
}
function drawBallShadow(x, y, z) {
  const shrink = Math.max(0.45, 1 - z / 600);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x, y + 2, BALL_RADIUS * shrink, BALL_RADIUS * 0.55 * shrink, 0, 0, Math.PI * 2);
  ctx.fill();
}
// Grav field visualization lives in Draw (shared with editor test).
// ?gravvis=1 | ?gfield=1 | localStorage.ppGravVis=1
function gravVisEnabled() {
  return !!(Draw && typeof Draw.gravVisEnabled === 'function' && Draw.gravVisEnabled());
}

function drawGravityPotentialOverlay(hole) {
  if (!Draw || typeof Draw.drawGravityPotentialOverlay !== 'function' || !hole) return;
  // Keep _orbitTick in sync for MP phase when present.
  if (typeof mpSimTick === 'number' && hole._orbitTick == null) hole._orbitTick = mpSimTick;
  const extra = portalGravityBakeStore.size
    ? ('store=' + portalGravityBakeStore.size)
    : '';
  Draw.drawGravityPotentialOverlay(ctx, hole, extra ? { statusExtra: extra } : {});
}

function drawWorld() {
  const hole = currentHoles()[Game.currentHoleIndex];
  // Lobby re-decodes strip hole._portalGravityCache; restore from store, or kick a bake.
  if (hole) {
    if (!hole._portalGravityCache) reattachPortalGravityBake(hole, Game.pendingCustomLvl);
    const PG = getPortalGravityAPI();
    if (
      PG &&
      typeof PG.holeNeedsPortalGravityBake === 'function' &&
      PG.holeNeedsPortalGravityBake(hole) &&
      !hole._portalGravityCache &&
      !portalGravityBakeInFlight &&
      !Game.gravityBaking
    ) {
      // Recovery path if mpBeginHole bake was skipped/raced.
      Game.gravityBaking = true;
      ensurePortalGravityBake(hole, Game.pendingCustomLvl).finally(() => {
        Game.gravityBaking = false;
        if (hole) reattachPortalGravityBake(hole, Game.pendingCustomLvl);
        if (Game.customHole) reattachPortalGravityBake(Game.customHole, Game.pendingCustomLvl);
      });
    }
  }
  Draw.drawHoleStatic(ctx, hole, {
    time: performance.now() / 1000,
    flagPhase: Game.flagPhase,
  });
  drawGravityPotentialOverlay(hole);

  // Black-hole tracers: each ball entering a black hole's pull claims its own color.
  // Drawn BEFORE equipped cosmetic trails so it extends off the tail end of them.
  if (MULTIPLAYER) {
    for (const b of Game.players.values()) {
      Draw.updateTracerTrail(b, b.rx, b.ry, hole, 30);
      Draw.drawTracerTrail(ctx, b);
    }
    for (const b of Game.players.values()) {
      if (b.trail && b.trailPts) drawTrailPts(b.trailPts, b.trail);
    }
    for (const [id, b] of Game.players) drawMultiplayerBall(b, id === mpPlayerId);
  } else {
    Draw.updateTracerTrail(Game.ball, Game.ball.x, Game.ball.y, hole, 30);
    Draw.drawTracerTrail(ctx, Game.ball);
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
function showScreen(id) {
  hideAllScreens();
  document.getElementById(id).classList.remove('hidden');
  updateShareLevelButton();
}
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

// ---- Portal gravity bake (material Poisson when hole has portals + masses) ----
const gravityLoadingEl = document.getElementById('gravity-loading');
const gravityLoadingBar = document.getElementById('gravity-loading-bar');
const gravityLoadingDetail = document.getElementById('gravity-loading-detail');
const gravityLoadingText = document.getElementById('gravity-loading-text');
/** In-flight bake token so rapid hole changes discard stale results. */
let gravityBakeToken = 0;
/**
 * Bakes must not live only on the hole object: lobbyState / roundState re-decode
 * customLvl into a fresh hole and would drop hole._portalGravityCache ("free-space only").
 * Index the same cache under several keys so lobby re-decode still finds it.
 */
const portalGravityBakeStore = new Map();
let portalGravityBakeInFlight = null;

function portalGravityIdentityKey(hole) {
  if (!hole) return '';
  return 'id:' + (hole.name || '') +
    '|pp:' + ((hole.portalPairs || []).length) +
    '|gb:' + ((hole.gravityBodies || []).length) +
    '|gt:' + ((hole.gates || []).length) +
    '|pd:' + ((hole.pendulums || []).length);
}

function portalGravityBakeKeys(hole, lvlHint) {
  const keys = [];
  if (lvlHint && typeof lvlHint === 'string' && lvlHint.length) keys.push(lvlHint);
  if (Game.pendingCustomLvl) keys.push(Game.pendingCustomLvl);
  const id = portalGravityIdentityKey(hole);
  if (id) keys.push(id);
  try {
    if (hole) keys.push('enc:' + encodeHole(hole));
  } catch (_) { /* ignore encode failures */ }
  return [...new Set(keys.filter(Boolean))];
}

function storePortalGravityBake(hole, cache, lvlHint) {
  if (!cache) return;
  if (hole) hole._portalGravityCache = cache;
  for (const k of portalGravityBakeKeys(hole, lvlHint)) {
    portalGravityBakeStore.set(k, cache);
  }
}

function reattachPortalGravityBake(hole, lvlHint) {
  if (!hole) return false;
  if (hole._portalGravityCache && hole._portalGravityCache.frames && hole._portalGravityCache.frames.length) {
    return true;
  }
  for (const k of portalGravityBakeKeys(hole, lvlHint)) {
    if (portalGravityBakeStore.has(k)) {
      hole._portalGravityCache = portalGravityBakeStore.get(k);
      return true;
    }
  }
  // Last resort: single-entry store (one custom hole in play)
  if (portalGravityBakeStore.size === 1) {
    hole._portalGravityCache = portalGravityBakeStore.values().next().value;
    return true;
  }
  return false;
}

function showGravityLoading(frac, detail) {
  if (!gravityLoadingEl) return;
  gravityLoadingEl.classList.remove('hidden');
  if (gravityLoadingBar) gravityLoadingBar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  if (gravityLoadingDetail) gravityLoadingDetail.textContent = detail || '';
}
function hideGravityLoading() {
  if (!gravityLoadingEl) return;
  gravityLoadingEl.classList.add('hidden');
  if (gravityLoadingBar) gravityLoadingBar.style.width = '0%';
}

/** Resolve PortalGravity from window/Shared (bare `PortalGravity` is unreliable). */
function getPortalGravityAPI() {
  try {
    if (typeof window !== 'undefined' && window.PortalGravity) return window.PortalGravity;
  } catch (_) { /* ignore */ }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.PortalGravity) return globalThis.PortalGravity;
  } catch (_) { /* ignore */ }
  try {
    if (window.Shared && window.Shared.PortalGravity) return window.Shared.PortalGravity;
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Ensure hole._portalGravityCache is ready when portals + gravity bodies exist.
 * Yields to the UI via PortalGravity.bakePortalGravityAsync.
 */
async function ensurePortalGravityBake(hole, lvlHint) {
  const PG = getPortalGravityAPI();
  if (!PG || !hole) {
    if (!PG) console.warn('[gravity] PortalGravity missing — is portal-gravity.js loaded?');
    return;
  }
  if (typeof PG.holeNeedsPortalGravityBake !== 'function' || !PG.holeNeedsPortalGravityBake(hole)) {
    // Do not delete a good cache if the hole object is mid-replace with empty pairs.
    return;
  }
  // Already on hole or in store.
  if (reattachPortalGravityBake(hole, lvlHint)) return;
  if (hole._portalGravityCache && hole._portalGravityCache.frames && hole._portalGravityCache.frames.length) {
    storePortalGravityBake(hole, hole._portalGravityCache, lvlHint);
    return;
  }
  // Coalesce concurrent bakes (roundState + draw recovery).
  if (portalGravityBakeInFlight) {
    await portalGravityBakeInFlight;
    reattachPortalGravityBake(hole, lvlHint);
    return;
  }
  const token = ++gravityBakeToken;
  const period = PG.gravityPeriodTicks(hole);
  if (gravityLoadingText) {
    gravityLoadingText.textContent = 'Computing portal gravity…';
  }
  const info = PG.gravityPeriodInfo ? PG.gravityPeriodInfo(hole) : { period, rawLcm: period, capped: false };
  let detail = info.period + ' tick period · BEM material gravity';
  if (info.capped) detail += ' (capped from LCM ' + info.rawLcm + ')';
  showGravityLoading(0, detail);
  portalGravityBakeInFlight = (async () => {
    try {
      // Prefer async progressive bake; fall back to sync if async yields nothing.
      let cache = await PG.bakePortalGravityAsync(hole, {
        onProgress(p) {
          if (token !== gravityBakeToken) return;
          showGravityLoading(p, Math.round(p * 100) + '% · ' + info.period + ' ticks');
        },
      });
      if (!cache && typeof PG.bakePortalGravity === 'function') {
        console.warn('[gravity] async bake returned null — trying sync bake');
        cache = PG.bakePortalGravity(hole);
      }
      if (token !== gravityBakeToken) return;
      if (cache && cache.frames && cache.frames.length) {
        storePortalGravityBake(hole, cache, lvlHint);
        if (Game.customHole) storePortalGravityBake(Game.customHole, cache, lvlHint || Game.pendingCustomLvl);
        if (!cache.fingerprint && typeof PG.bakeFingerprint === 'function') {
          cache.fingerprint = PG.bakeFingerprint(cache);
        }
        console.log(
          '[gravity] portal BEM bake ready',
          cache.period, 'ticks', cache.method,
          cache.fingerprint || '',
          'store', portalGravityBakeStore.size,
          cache.capped ? '(capped LCM ' + cache.rawLcm + ')' : ''
        );
      } else {
        console.warn('[gravity] bake produced no cache', {
          pairs: (hole.portalPairs || []).length,
          bodies: (hole.gravityBodies || []).length,
          needs: PG.holeNeedsPortalGravityBake(hole),
        });
      }
    } catch (err) {
      console.warn('portal gravity bake failed', err);
    } finally {
      if (token === gravityBakeToken) hideGravityLoading();
      portalGravityBakeInFlight = null;
    }
  })();
  await portalGravityBakeInFlight;
}

// ---- Game flow ----
async function loadHole(i) {
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
  // Block aim until bake finishes so first putt uses material-space g.
  Game.state = 'LOADING';
  Game.gravityBaking = true;
  updateHUD();
  updateShareLevelButton();
  try {
    await ensurePortalGravityBake(hole);
  } finally {
    Game.gravityBaking = false;
  }
  if (Game.currentHoleIndex !== i) return; // navigated away
  Game.state = 'AIMING';
  resetSpeedAvgTracker(Game.speedTracker);
  resetUnsettledTimer();
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
  if (Game.customHole) {
    document.getElementById('btn-next').textContent = 'Play again ▶';
  } else {
    document.getElementById('btn-next').textContent = Game.currentHoleIndex === currentHoles().length - 1 ? 'See Scorecard →' : 'Next Hole →';
  }
  Game.state = 'HOLE_COMPLETE';
  resetUnsettledTimer();
  showScreen('screen-hole-complete');
  updateShareLevelButton();
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
  updateShareLevelButton();
}

// ---- Input ----
function handlePointerDown(x, y) {
  if (Game.drag.active) return;
  if (MULTIPLAYER) {
    if (!mpCanPutt) return;
  } else {
    const hole = currentHoles()[Game.currentHoleIndex];
    // Crawl / quasi-rest: allow aim while still BALL_MOVING at low speed.
    if (!mayPuttBall(Game.ball, hole, Game.speedTracker)) return;
    Game.ball.vx = 0;
    Game.ball.vy = 0;
    Game.state = 'AIMING';
  }
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
  noteWetPutt(Game.ball);
  Game.ball.vx = v.vx * factor;
  Game.ball.vy = v.vy * factor;
  Game.ball.squash = 0.6;
  Game.ball.angleDir = Math.atan2(v.vy, v.vx);
  Game.strokes++;
  Game.totalStrokes++;
  updateHUD();
  soundPutt(v.speed / MAX_LAUNCH_SPEED);
  Game.state = 'BALL_MOVING';
  resetSpeedAvgTracker(Game.speedTracker);
}
function handlePointerUp(x, y) {
  if (!Game.drag.active) return;
  Game.drag.active = false;
  const v = Game.drag.pointerVec;
  const len = Math.hypot(v.x, v.y);
  if (len < MIN_DRAG_DIST) return;
  if (MULTIPLAYER) {
    // Stamp clientTick at release (mpSimTick before optimistic apply) so host can
    // rewind/replay to the same absolute tick the client launched on.
    const clientTick = mpSimTick;
    mpLastPuttClientTick = clientTick;
    // Optimistic local putt; host validates and broadcasts puttApplied / hard replay snap.
    mpApplyPuttLocal(mpPlayerId, v, null, true);
    mpSocket.send(JSON.stringify({ type: 'putt', dragVector: v, clientTick }));
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
  // Production (http/s): always play via relay — open lobby. file:// keeps offline solo for local dev.
  if (MULTIPLAYER) {
    Game.customHole = null;
    Game.pendingCustomLvl = null;
    showScreen('screen-lobby');
    return;
  }
  Game.customHole = null;
  const soloCourse = document.getElementById('solo-course-select');
  if (soloCourse) Game.courseIndex = Number(soloCourse.value) || 0;
  startGame();
});
document.getElementById('btn-next').addEventListener('click', () => {
  soundClick();
  if (Game.customHole && !MULTIPLAYER) {
    // file:// offline custom: replay the single hole.
    loadHole(0);
    return;
  }
  if (Game.currentHoleIndex === currentHoles().length - 1) showRoundComplete();
  else loadHole(Game.currentHoleIndex + 1);
});
document.getElementById('btn-replay').addEventListener('click', () => { soundClick(); startGame(); });
const btnRespawn = document.getElementById('btn-respawn');
const btnRespawnDismiss = document.getElementById('btn-respawn-dismiss');
if (btnRespawn) {
  btnRespawn.addEventListener('click', requestRespawn);
  // Pointerdown so a canvas-style drag never steals the press on touch devices.
  btnRespawn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}
if (btnRespawnDismiss) {
  btnRespawnDismiss.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    soundClick();
    hideRespawnOffer();
    respawnDismissedUntilSettle = true;
  });
  btnRespawnDismiss.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---- Main loop ----
function update(dt) {
  const hole = currentHoles()[Game.currentHoleIndex];
  // Freeze physics while portal-gravity bake is on the loading overlay.
  if (Game.state === 'LOADING' || Game.gravityBaking) return;
  if (MULTIPLAYER) {
    // Fixed-tick local sim (obstacles + all balls) tick-locked to the host clock.
    // Motion does not depend on a mid-flight snapshot stream.
    mpUpdateLocalSim(dt);
  } else {
    advanceHoleObstacles(hole, dt);
  }
  Game.flagPhase += dt;
  // Track speed for quasi-rest putt escape (solo). MP uses per-player trackers in sim.
  if (!MULTIPLAYER) {
    noteSpeedSample(Game.speedTracker, Math.hypot(Game.ball.vx, Game.ball.vy), dt);
  }
  // Orbit gravity wake vs aim:
  // - AIMING without drag + field yank (!ballMayRestForAim) → BALL_MOVING (roll again)
  // - drag.active = user is lining up a shot → hold still, never clear the drag
  // "Can click the ball" (mayPuttBall) is independent and must NOT suppress wake.
  const hasGravity = (hole.gravityBodies || []).length > 0;
  if (Game.state === 'BALL_MOVING') {
    updateBallPhysics(dt);
  } else if (Game.state === 'AIMING' && Game.drag.active) {
    // Actively lining up: freeze pose for a clean aim (crawl/quasi-rest interrupt).
    Game.ball.vx = 0;
    Game.ball.vy = 0;
  } else if (
    Game.state === 'AIMING' &&
    !Game.drag.active &&
    hasGravity &&
    !ballMayRestForAim(Game.ball, hole)
  ) {
    Game.state = 'BALL_MOVING';
    updateBallPhysics(dt);
  }
  if (Game.state === 'HAZARD_RESET') {
    Game.hazardTimer -= dt;
    if (Game.hazardTimer <= 0) {
      hideAllScreens();
      Game.state = 'AIMING';
      resetUnsettledTimer();
    }
  }
  if (Game.state === 'WATER_FLOAT') {
    // Banner hides on its own clock; the float keeps going until its 1.5s is up.
    Game.hazardTimer -= dt;
    if (Game.hazardTimer <= 0) hideAllScreens();
    updateWaterFloat(dt);
  }
  updateRespawnOffer(dt);
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
  // Drive clientClock from the frame loop (not setInterval) so mobile throttle
  // is tied to actual rendering, not a bare timer the OS freely clamps.
  if (MULTIPLAYER && mpPlaying) mpMaybeSendKeepalive(false);
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
// Coast netcode: puttApplied impulse + local tick-locked sim + sparse hard corrections.
// Soft packets never rewrite in-flight velocity/pose (instant Δv mid-coast = rubber band).
// puttApplied for self is confirm-only after optimistic launch (pose is putt-tick history).
// Multi-room relay protocol (create/join). Cosmetics + menu from main still apply.
const MULTIPLAYER = location.protocol !== 'file:';
const MP_PARAMS = new URLSearchParams(location.search);
// Portal dual-sample gravity prototype: ?portalG=off|always|soi|los (default off).
// Also localStorage.ppPortalGravity. Not a netcode field — host/client must match if used in MP.
(function initPortalGravityMode() {
  const S = typeof Shared !== 'undefined' ? Shared : null;
  if (!S || typeof S.setPortalGravityMode !== 'function') return;
  let mode = null;
  const q = MP_PARAMS.get('portalG') || MP_PARAMS.get('portalg');
  if (q) mode = q;
  else {
    try { mode = localStorage.getItem('ppPortalGravity'); } catch (_) {}
  }
  if (mode) S.setPortalGravityMode(mode);
})();
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
/** True after client BEM bake while host is still in GRAVITY_LOADING. */
let mpAwaitingGravityGo = false;
let mpRoomCode = null;
// Frozen hole clock while results / lobby (hostTargetTick free-runs with wall time).
let mpFrozenTimerMs = 0;
// Local sim tick (integer). Host clock sample drives how far we may advance.
let mpSimTick = 0;
let mpHostTick = 0;
let mpHostTickAt = 0;
/** Hole epoch W0 (host wall time at tick 0) — keepalives / diagnostics. */
let mpHoleEpochMs = 0;
/** lastHostTick reported on keepalives (last adopted host tick). */
let mpLastHostTick = 0;
/** Client tick of the latest optimistic putt (ignore older hard snaps for self). */
let mpLastPuttClientTick = null;
/** Wall time of last clientClock send (performance.now). 0 = not started. */
let mpKeepaliveLastSentMs = 0;
const MP_MAX_CATCH_UP = 8;
/** Predict cap: do not free-run more than lastHostTick + N (matches host HISTORY_TICKS). */
const MP_PREDICT_CAP_TICKS = 30;
/**
 * clientClock cadence. Prefer rAF (see mpMaybeSendKeepalive) over setInterval —
 * Android Chrome throttles timers past 1s even in a foreground tab.
 * ~1/s is enough for frozen-tab detection and cheaper than the old 333ms blast.
 */
const MP_KEEPALIVE_MS = 1000;
const MP_SOFT_ERR_PX = 10;
const MP_HARD_ERR_PX = 80;
const MP_ERR_DECAY_TAU = 0.12;

// Path catch-up + free-run trail: shared module (browser window.MpRecon / Node require).
const MpRecon = window.MpRecon;

function mpStartVisualPath(p, path) {
  MpRecon.startVisualPath(p, path, performance.now());
  if (typeof PathTrace !== 'undefined' && PathTrace.enabled) {
    PathTrace.noteEvent({
      kind: 'vis_path_start',
      ballId: p.id,
      n: path && path.length,
      path: (path || []).map((s) => ({
        tick: s.tick,
        x: s.x,
        y: s.y,
        vx: s.vx || 0,
        vy: s.vy || 0,
      })),
    });
  }
}
function mpAdvanceVisualPaths(now) {
  for (const p of Game.players.values()) {
    MpRecon.advanceVisualPathOne(p, now);
  }
}

// ---- Path-trace recorder (observability; ?pathtrace=1 or localStorage.ppPathTrace=1) ----
// Records this client's complete ball history (sim + render) for the path-trace viewer.
const PATH_TRACE_MAX = 4000;
function mpPathTraceEnabled() {
  const q = MP_PARAMS.get('pathtrace');
  if (q === '0' || q === 'false') return false;
  if (q === '1' || q === 'true') return true;
  try {
    if (localStorage.getItem('ppPathTrace') === '1') return true;
  } catch (_) {}
  return false;
}
const PathTrace = {
  enabled: false,
  samples: [], // all balls, interleaved; filter by ballId in viewer
  events: [],
  panel: null,
  statusEl: null,

  init() {
    this.enabled = mpPathTraceEnabled();
    window.PathTrace = this;
    if (!this.enabled) return;
    try {
      console.info(
        '[PathTrace] ON — records sim+render samples every subtick. ' +
          'Push dump after a putt, then open /path-trace.html?room=CODE'
      );
    } catch (_) {}
    this.ensurePanel();
    this.enableHostRecording();
  },

  /** Tell host to start dense path-trace recording (opt-in observability). */
  enableHostRecording() {
    if (!this.enabled) return;
    if (mpSocket && mpSocket.readyState === 1) {
      mpSocket.send(JSON.stringify({ type: 'pathTraceEnable' }));
    }
  },

  clear() {
    this.samples = [];
    this.events = [];
    this.setStatus('cleared');
  },

  setStatus(t) {
    if (this.statusEl) this.statusEl.textContent = t;
  },

  noteEvent(ev) {
    if (!this.enabled) return;
    this.events.push({
      wallMs: performance.now(),
      tick: mpSimTick,
      ...ev,
    });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  },

  /**
   * Record one sample for every known ball.
   * @param {{ sub?: number|null, phase?: string, note?: string }} meta
   */
  recordAll(meta) {
    if (!this.enabled) return;
    meta = meta || {};
    const wallMs = performance.now();
    const tick = mpSimTick;
    for (const p of Game.players.values()) {
      this.samples.push({
        i: this.samples.length,
        ballId: p.id,
        tick,
        sub: meta.sub != null ? meta.sub : null,
        x: p.x,
        y: p.y,
        vx: p.vx || 0,
        vy: p.vy || 0,
        rx: p.rx != null ? p.rx : p.x,
        ry: p.ry != null ? p.ry : p.y,
        phase: meta.phase || 'sim',
        note: meta.note || null,
        visPathFrames: p.visPathFrames != null ? p.visPathFrames : null,
        wallMs,
      });
    }
    if (this.samples.length > PATH_TRACE_MAX) {
      this.samples.splice(0, this.samples.length - PATH_TRACE_MAX);
      for (let k = 0; k < this.samples.length; k++) this.samples[k].i = k;
    }
    this.setStatus(`${this.samples.length} samples · tick ${tick}`);
  },

  localDump() {
    const names = {};
    for (const p of Game.players.values()) names[p.id] = p.name || p.id;
    return {
      version: 1,
      role: 'client',
      playerId: mpPlayerId,
      name: names[mpPlayerId] || mpPlayerId,
      room: mpRoomCode,
      simTick: mpSimTick,
      hostTick: mpHostTick,
      focusPlayerId: null,
      samples: this.samples.slice(),
      events: this.events.slice(),
      playerNames: names,
      capturedAt: Date.now(),
    };
  },

  pushToServer() {
    if (!mpSocket || mpSocket.readyState !== 1) {
      this.setStatus('no socket');
      return;
    }
    const dump = this.localDump();
    mpSocket.send(
      JSON.stringify({
        type: 'pathTraceClientDump',
        role: dump.role,
        name: dump.name,
        focusPlayerId: dump.focusPlayerId,
        samples: dump.samples,
        events: dump.events,
      })
    );
    this.setStatus(`pushed ${dump.samples.length} → request bundle…`);
    mpSocket.send(JSON.stringify({ type: 'pathTraceRequest' }));
  },

  downloadLocal() {
    const dump = this.localDump();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pathtrace-client-${mpPlayerId || 'me'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.setStatus('downloaded local');
  },

  openViewer(bundle) {
    if (bundle) {
      try {
        sessionStorage.setItem('ppPathTraceBundle', JSON.stringify(bundle));
      } catch (e) {
        try {
          console.warn('[PathTrace] sessionStorage failed', e);
        } catch (_) {}
      }
    }
    const room = mpRoomCode || '';
    const url = `/path-trace.html${room ? `?room=${encodeURIComponent(room)}` : ''}`;
    window.open(url, '_blank');
  },

  onBundle(msg) {
    if (!msg || !msg.bundle) return;
    this.setStatus(
      `bundle host=${Object.keys(msg.bundle.host || {}).length} clients=${Object.keys(msg.bundle.clients || {}).length}`
    );
    this.openViewer(msg.bundle);
  },

  ensurePanel() {
    if (this.panel || !document.body) return;
    const el = document.createElement('div');
    el.id = 'path-trace-panel';
    el.innerHTML =
      '<div style="font:12px/1.3 system-ui,sans-serif;position:fixed;right:8px;bottom:8px;z-index:99999;' +
      'background:rgba(10,14,20,.92);color:#e8f0ff;border:1px solid #3a5a80;border-radius:8px;' +
      'padding:8px 10px;min-width:200px;box-shadow:0 4px 20px rgba(0,0,0,.4)">' +
      '<div style="font-weight:700;margin-bottom:4px">PathTrace</div>' +
      '<div id="path-trace-status" style="opacity:.85;margin-bottom:6px;max-width:220px">recording…</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px">' +
      '<button type="button" data-pt="push" style="cursor:pointer">Push dump</button>' +
      '<button type="button" data-pt="view" style="cursor:pointer">Viewer</button>' +
      '<button type="button" data-pt="dl" style="cursor:pointer">Save local</button>' +
      '<button type="button" data-pt="clr" style="cursor:pointer">Clear</button>' +
      '</div></div>';
    document.body.appendChild(el);
    this.panel = el;
    this.statusEl = el.querySelector('#path-trace-status');
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pt]');
      if (!btn) return;
      const act = btn.getAttribute('data-pt');
      if (act === 'push') this.pushToServer();
      else if (act === 'view') {
        // Prefer live server bundle if in room.
        if (mpSocket && mpSocket.readyState === 1) {
          mpSocket.send(JSON.stringify({ type: 'pathTraceRequest' }));
          this.setStatus('requesting bundle…');
        } else this.openViewer(null);
      } else if (act === 'dl') this.downloadLocal();
      else if (act === 'clr') {
        this.clear();
        if (mpSocket && mpSocket.readyState === 1) {
          mpSocket.send(JSON.stringify({ type: 'pathTraceClear' }));
        }
      }
    });
  },
};
PathTrace.init();
// Panel only when ?pathtrace=1 (or localStorage) — never mount in normal play.
if (PathTrace.enabled) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => PathTrace.ensurePanel());
  } else {
    PathTrace.ensurePanel();
  }
}

// ---- Rubber-band detector (observe only — never changes physics) ----
// Enable: ?rbdebug=1  or  localStorage.ppRbDebug = '1'
// Live RTT lag for realism must come from lag-proxy.js (bidirectional), not here.
function mpRbDebugEnabled() {
  const q = MP_PARAMS.get('rbdebug');
  if (q === '0' || q === 'false') return false;
  if (q === '1' || q === 'true') return true;
  try { if (localStorage.getItem('ppRbDebug') === '1') return true; } catch (_) {}
  return false;
}
const RbDiag = {
  enabled: false,
  hardSnaps: 0,
  hardMoving: 0, // hard pose apply while client or host ball speed >= STOP
  softIgnoredMoving: 0,
  puttResyncs: 0, // self puttApplied re-applied pose after already coasting
  events: [],
  init() {
    this.enabled = mpRbDebugEnabled();
    if (!this.enabled) return;
    try { window.RbDiag = this; } catch (_) {}
    console.info(
      '[RB] rubber-band detector ON — hard snaps while moving are the signal. ' +
      'For realistic lag use lag-proxy (npm run lag-proxy), not one-way client delay. ' +
      'Dump: RbDiag.summary()'
    );
  },
  _push(ev) {
    this.events.push(ev);
    if (this.events.length > 200) this.events.shift();
  },
  /**
   * @param {object} p client player (before or after — pass before snap for dist)
   * @param {object} b host pose
   * @param {boolean} hard
   * @param {{ x:number, y:number, vx:number, vy:number }} before
   * @param {{ reason?: string, applied?: boolean }} meta
   */
  noteAuthority(p, b, hard, before, meta) {
    if (!this.enabled) return;
    meta = meta || {};
    const clientMoving = Math.hypot(before.vx || 0, before.vy || 0) >= STOP_THRESHOLD;
    const hostMoving = Math.hypot(b.vx || 0, b.vy || 0) >= STOP_THRESHOLD;
    const moving = clientMoving || hostMoving;
    // Prefer same-tick residual after sample→present resim when provided.
    const dPos =
      meta.residualAfterResim != null
        ? meta.residualAfterResim
        : Math.hypot((before.x - b.x), (before.y - b.y));
    const isSelf = p && p.id === mpPlayerId;
    const reason = meta.reason || '';
    if (!hard) {
      if (moving && meta.applied === false) {
        this.softIgnoredMoving++;
      }
      return;
    }
    // Path match after apply-at-sample + resim: confirmed no-op, not a rubber band.
    if (meta.matched) return;
    this.hardSnaps++;
    const ev = {
      t: performance.now(),
      tick: typeof mpSimTick === 'number' ? mpSimTick : null,
      hard: true,
      moving,
      isSelf: !!isSelf,
      dPos: Math.round(dPos * 10) / 10,
      dVx: Math.round(((b.vx || 0) - (before.vx || 0)) * 10) / 10,
      dVy: Math.round(((b.vy || 0) - (before.vy || 0)) * 10) / 10,
      reason,
      applied: meta.applied !== false,
      matched: !!meta.matched,
      rejectReason: meta.rejectReason || null,
    };
    if (moving && dPos >= 0.5 && meta.applied !== false) {
      this.hardMoving++;
      this._push(ev);
      console.info('[RB] hard_snap_while_moving', ev);
    } else if (dPos >= 2) {
      this._push(ev);
      console.info('[RB] hard_snap', ev);
    }
  },
  notePuttResync(info) {
    if (!this.enabled) return;
    this.puttResyncs++;
    const ev = { t: performance.now(), kind: 'putt_resync', ...info };
    this._push(ev);
    console.info('[RB] putt_resync (re-applied puttApplied pose)', ev);
  },
  summary() {
    const out = {
      hardSnaps: this.hardSnaps,
      hardMoving: this.hardMoving,
      softIgnoredMoving: this.softIgnoredMoving,
      puttResyncs: this.puttResyncs,
      recent: this.events.slice(-20),
    };
    console.info('[RB] summary', out);
    return out;
  },
  reset() {
    this.hardSnaps = 0;
    this.hardMoving = 0;
    this.softIgnoredMoving = 0;
    this.puttResyncs = 0;
    this.events = [];
    console.info('[RB] counters reset');
  },
};
RbDiag.init();

/**
 * Headless / Playwright harness surface (only when ?rbdebug=1).
 * Forces the failure modes real Android timer policy is hard to emulate.
 */
if (RbDiag.enabled) {
  try {
    window.MpTest = {
      playing: () => !!mpPlaying,
      canPutt: () => !!(mpPlaying && mpCanPutt),
      simTick: () => mpSimTick,
      strokes: () => {
        const me = Game.players.get(mpPlayerId);
        return me ? me.strokes || 0 : 0;
      },
      /** Same path as pointer release — optimistic local + wire putt. */
      puttDrag(v) {
        if (!mpPlaying || !mpSocketOpen()) return { ok: false, reason: 'not_ready' };
        if (!v || typeof v.x !== 'number' || typeof v.y !== 'number') {
          return { ok: false, reason: 'bad_drag' };
        }
        const clientTick = mpSimTick;
        mpLastPuttClientTick = clientTick;
        mpApplyPuttLocal(mpPlayerId, v, null, true);
        mpSocket.send(JSON.stringify({ type: 'putt', dragVector: v, clientTick }));
        mpCanPutt = false;
        return { ok: true, clientTick };
      },
      /** Force an immediate clientClock (bypasses rAF cadence). */
      sendKeepalive() {
        return mpSendClientClock();
      },
    };
  } catch (_) {
    /* ignore */
  }
}

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

function mpApplyCustomFromLobby(msg) {
  if (msg.hasCustomHole && msg.customLvl) {
    const d = decodeHole(msg.customLvl);
    if (d.ok) {
      Game.customHole = d.hole;
      Game.pendingCustomLvl = msg.customLvl;
      // Re-decode drops in-memory bake; restore from store so gravvis / physics stay live.
      reattachPortalGravityBake(Game.customHole, msg.customLvl);
    }
  } else if (msg.hasCustomHole === false) {
    // Room no longer has a custom hole — only clear if we weren't opened on a share link.
    // (Host may still have pendingCustomLvl from URL before attaching it.)
    if (!mpIsHost || !Game.pendingCustomLvl) {
      Game.customHole = null;
    }
  }
  const customLabel = document.getElementById('lobby-custom-label');
  const clearBtn = document.getElementById('btn-clear-custom');
  if (customLabel) {
    if (msg.hasCustomHole && (msg.customHoleName || Game.customHole)) {
      customLabel.textContent = `Custom hole: ${msg.customHoleName || (Game.customHole && Game.customHole.name) || 'Custom'}`;
      customLabel.classList.remove('hidden');
    } else {
      customLabel.classList.add('hidden');
      customLabel.textContent = '';
    }
  }
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !(mpIsHost && msg.hasCustomHole));
  }
  updateShareLevelButton();
}

function mpRenderLobby(msg) {
  const me = msg.players.find((p) => p.id === mpPlayerId);
  if (me) mpIsHost = me.isHost;

  if (msg.roomCode) mpRoomCode = msg.roomCode;
  mpCourseIndex = msg.courseIndex ?? 0;
  mpApplyCustomFromLobby(msg);
  const courseSelect = document.getElementById('course-select');
  const courseDisplay = document.getElementById('course-display');
  if (courseSelect) {
    populateCourseSelect(courseSelect);
    if (document.activeElement !== courseSelect) courseSelect.value = String(mpCourseIndex);
    courseSelect.classList.toggle('hidden', !mpIsHost || !!msg.hasCustomHole);
  }
  if (courseDisplay) {
    courseDisplay.classList.toggle('hidden', mpIsHost && !msg.hasCustomHole);
    if (msg.hasCustomHole) {
      courseDisplay.classList.remove('hidden');
      courseDisplay.textContent = msg.customHoleName || 'Custom hole';
    } else {
      courseDisplay.textContent = COURSES[mpCourseIndex].name;
    }
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
  // Room membership is session-only — never persist codes/tokens across visits.
  // Stale localStorage keys from older builds are scrubbed here too.
  try {
    localStorage.removeItem('pocketPuttRoomCode');
    localStorage.removeItem('pocketPuttReconnectToken');
  } catch { /* private mode */ }
  mpRoomCode = null;
}

function mpSocketOpen() {
  return mpSocket && mpSocket.readyState === WebSocket.OPEN;
}

function mpConnect(opts = {}) {
  // skipAutoRejoin kept for call-site compat; we never auto-rejoin from storage.
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
    const savedName = localStorage.getItem('pocketPuttName') || '';
    const queryRoom = (MP_PARAMS.get('room') || '').trim().toUpperCase();
    // Custom level share links must never be hijacked by a leftover room join.
    // Prefer ?lvl= (and in-memory pending) over any ambient room auto-join.
    const hasCustomLevel =
      !!Game.pendingCustomLvl || !!(MP_PARAMS.get('lvl') || '').trim();
    document.getElementById('lobby-name-input').value = savedName;
    // Prefill the join field ONLY from ?room= in the URL.
    const roomInput = document.getElementById('lobby-room-input');
    if (roomInput && queryRoom && !hasCustomLevel) roomInput.value = queryRoom;
    mpSetRelayStatus('Connected. Create a room or join with a code.');
    if (PathTrace.enabled) PathTrace.enableHostRecording();

    // Pending user action after a reconnect wins over deep-link join.
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
    // Never rejoin from localStorage (removed): it stole focus from custom level links.
    if (queryRoom && !hasCustomLevel) {
      mpSetRelayStatus(`Joining ${queryRoom}…`);
      mpSocket.send(JSON.stringify({
        type: 'relay_join',
        room_code: queryRoom,
        player_name: savedName || 'Player',
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
      // Stale room must not block a fresh create on the same socket.
      if (msg.code === 'room_not_found' || msg.code === 'bad_token') {
        mpClearRoomCreds();
      }
      mpSetRelayStatus(hints[msg.code] || `Error: ${msg.code || 'unknown'}`);
      return;
    }
    if (msg.type === 'relay_created' || msg.type === 'relay_reconnected') {
      mpRoomCode = msg.room_code || null;
      // Intentionally not writing room codes/tokens to localStorage.
      mpSetRelayStatus(msg.room_code ? `In room ${msg.room_code}` : '');
      return;
    }
    if (msg.type === 'welcome') {
      mpPlayerId = msg.playerId;
      mpIsHost = msg.isHost;
      if (msg.roomCode) mpRoomCode = msg.roomCode;
      document.getElementById('lobby-join').classList.add('hidden');
      document.getElementById('lobby-joined').classList.remove('hidden');
      const rename = document.getElementById('lobby-rename-input');
      if (rename) rename.value = localStorage.getItem('pocketPuttName') || '';
      buildCustomizeUI();
      sendMyStyle();
      // Host with a share-link level: attach custom hole to the room (joiners get it via lobbyState).
      if (mpIsHost && Game.pendingCustomLvl && mpSocket && mpSocket.readyState === WebSocket.OPEN) {
        mpSocket.send(JSON.stringify({ type: 'setCustomHole', lvl: Game.pendingCustomLvl }));
      }
      updateShareLevelButton();
    } else if (msg.type === 'notice') {
      mpShowBanner(msg.text);
    } else if (msg.type === 'lobbyState') {
      mpRenderLobby(msg);
      if (msg.state === 'WAITING_FOR_PLAYERS' && mpInRound) {
        mpInRound = false;
        mpPlaying = false;
        mpStopKeepalives();
        mpFrozenTimerMs = 0;
        gameMenuEl.classList.add('hidden');
        hud.classList.add('hidden');
        Game.players.clear();
        mpCanPutt = false;
        showScreen('screen-lobby');
      }
    } else if (msg.type === 'roundState') {
      mpBeginHole(msg);
    } else if (msg.type === 'clockSync') {
      mpOnClockSync(msg);
    } else if (msg.type === 'puttApplied') {
      if (!mpPlaying) return; // ignore late putts while on results/lobby
      mpOnPuttApplied(msg);
    } else if (msg.type === 'snapshot') {
      // Never resurrect "playing" from a stale snapshot during results — that left the
      // timer free-running and blocked feeling like the next hole would never start.
      if (!mpPlaying) return;
      mpApplyCorrection(msg);
    } else if (msg.type === 'pathTraceBundle') {
      if (PathTrace.enabled) PathTrace.onBundle(msg);
    } else if (msg.type === 'pathTraceCleared') {
      if (PathTrace.enabled) {
        PathTrace.clear();
        PathTrace.setStatus('host cleared');
      }
    } else if (msg.type === 'holeResults') {
      mpPlaying = false;
      mpStopKeepalives();
      mpFrozenTimerMs = mpEstimatedElapsedMs();
      mpRenderHoleResults(msg);
    } else if (msg.type === 'finalResults') {
      mpPlaying = false;
      mpStopKeepalives();
      mpFrozenTimerMs = mpEstimatedElapsedMs();
      mpRenderFinalResults(msg);
    }
  });
}

async function mpBeginHole(msg) {
  if (msg.customLvl) {
    const d = decodeHole(msg.customLvl);
    if (d.ok) {
      Game.customHole = d.hole;
      Game.pendingCustomLvl = msg.customLvl;
      reattachPortalGravityBake(Game.customHole, msg.customLvl);
    }
  } else if (msg.hasCustomHole === false) {
    Game.customHole = null;
  }
  if (msg.courseIndex !== undefined && !Game.customHole) Game.courseIndex = msg.courseIndex;
  Game.currentHoleIndex = msg.holeIndex;
  Game.players.clear();
  const hole = currentHoles()[msg.holeIndex];
  if (!hole) {
    console.error('No hole for roundState', msg);
    return;
  }
  // Same loading gate as solo: do not free-run until material gravity bake is ready.
  Game.gravityBaking = true;
  mpPlaying = false;
  mpCanPutt = false;
  gameMenuEl.classList.remove('hidden');
  hud.classList.remove('hidden');
  hideAllScreens();
  setHudText(hudHole, `Hole ${msg.holeIndex + 1}/${currentHoles().length} — ${hole.name}`);
  setHudText(hudPar, `Par ${hole.par}`);
  await ensurePortalGravityBake(hole, msg.customLvl || Game.pendingCustomLvl);
  // Re-bind in case lobby traffic replaced customHole during the await.
  if (Game.customHole && Game.customHole !== hole) {
    reattachPortalGravityBake(Game.customHole, msg.customLvl || Game.pendingCustomLvl);
  } else {
    reattachPortalGravityBake(hole, msg.customLvl || Game.pendingCustomLvl);
  }
  Game.gravityBaking = false;

  resetHoleObstacles(hole);
  const startTick = typeof msg.tick === 'number' ? msg.tick : 0;
  mpSimTick = startTick;
  // New hole: never carry putt-stamp / host-tick floors from the previous hole.
  // Dogfood (rarer/other_extra): lastPutt=4986 made sampleTick 0/1 look "stale" and
  // ignore legitimate resync/idle for the entire next hole → free-run desync + water snaps.
  mpLastPuttClientTick = null;
  mpHostTick = startTick;
  mpHostTickAt = performance.now();
  mpLastHostTick = startTick;
  if (typeof msg.holeEpochMs === 'number' && Number.isFinite(msg.holeEpochMs)) {
    mpHoleEpochMs = msg.holeEpochMs;
  } else if (typeof msg.hostTimeMs === 'number' && Number.isFinite(msg.hostTimeMs)) {
    mpHoleEpochMs = msg.hostTimeMs - startTick * TICK_MS;
  }
  setHoleObstaclesAtTick(hole, startTick);
  // Seed balls from reliable roundState so a dropped resync snapshot can't leave an
  // empty roster (ball "disappears" until the next idle correction).
  for (const b of msg.balls || []) {
    const p = mpUpsertPlayer(b);
    p.x = b.x;
    p.y = b.y;
    p.vx = b.vx || 0;
    p.vy = b.vy || 0;
    p.z = b.z || 0;
    p.vz = b.vz || 0;
    p.strokes = b.strokes || 0;
    p.holedOut = !!b.holedOut;
    p.dunks = typeof b.dunks === 'number' ? b.dunks : 0;
    p.floatTicks = 0;
    p.floatZone = null;
    p.floatCarry = null;
    p.errX = 0;
    p.errY = 0;
    p.rx = p.x;
    p.ry = p.y;
    p.rz = p.z;
    if (typeof b.stuckStickyIndex === 'number') p.stuckStickyIndex = b.stuckStickyIndex;
    p.firedBoosts = new Set();
  }
  const me = Game.players.get(mpPlayerId);
  if (me) mpSyncSelfFromPlayer(me);
  mpCanPutt = false;
  mpFrozenTimerMs = 0;
  resetUnsettledTimer();
  resetAchvHoleCounters();
  mpInRound = true;
  if (PathTrace.enabled) PathTrace.enableHostRecording();
  setHudText(hudTotal, `Time: 0.0s`);
  // MP round does not go through loadHole — surface share control for custom holes.
  // Keep pending payload even if roundState omitted customLvl (already on client).
  if (!Game.pendingCustomLvl && msg.customLvl) Game.pendingCustomLvl = msg.customLvl;
  updateShareLevelButton();

  // Host waits in GRAVITY_LOADING until every client acks bake. Tell host we are ready;
  // free-run only after the follow-up roundState with gravityBakePending=false.
  if (msg.gravityBakePending) {
    mpAwaitingGravityGo = true;
    mpPlaying = false;
    try {
      if (mpSocket && mpSocket.readyState === WebSocket.OPEN) {
        mpSocket.send(JSON.stringify({
          type: 'gravityBakeReady',
          holeIndex: msg.holeIndex,
        }));
      }
    } catch (e) {
      console.warn('[gravity] gravityBakeReady send failed', e);
    }
    return;
  }

  mpAwaitingGravityGo = false;
  mpPlaying = true;
  mpStartKeepalives();
}

function mpNoteHostTick(tick, hostTimeMs, opts) {
  // Monotonic host sample. puttApplied is stamped at putt tick (past) — callers must
  // not pass that as a live sample or we re-anchor W0 as if the putt were "now".
  if (typeof tick !== 'number') return;
  if (tick < mpHostTick) return;
  mpHostTick = tick;
  mpHostTickAt = performance.now();
  mpLastHostTick = tick;
  // Prefer fixed hole epoch from the wire (same W0 host used in tickDriver).
  // Never invent W0 from (hostTimeMs - puttTick): puttApplied/juice use present wall
  // with a past tick and would race the client ahead of the host.
  if (opts && typeof opts.holeEpochMs === 'number' && Number.isFinite(opts.holeEpochMs)) {
    mpHoleEpochMs = opts.holeEpochMs;
  } else if (typeof hostTimeMs === 'number' && Number.isFinite(hostTimeMs) && !(opts && opts.skipEpoch)) {
    mpHoleEpochMs = hostTimeMs - tick * TICK_MS;
  } else if (mpHoleEpochMs > 0) {
    const ideal = Math.floor((Date.now() - mpHoleEpochMs) / TICK_MS);
    if (ideal > tick + 2) {
      mpHoleEpochMs = Date.now() - tick * TICK_MS;
    }
  }
}

/**
 * Shared hole calendar: same formula as host tickDriver
 *   wallTarget = floor((Date.now() - holeEpochMs) / TICK_MS)
 * Not "last snapshot + blind extrapolation" (that races the host under lag).
 */
function mpHostTargetTick() {
  if (mpHoleEpochMs > 0) {
    return Math.max(0, Math.floor((Date.now() - mpHoleEpochMs) / TICK_MS));
  }
  // Fallback before first clockSync
  return Math.floor(mpHostTick + ((performance.now() - mpHostTickAt) / 1000) * TICK_HZ);
}

function mpOnClockSync(msg) {
  if (!msg) return;
  const tick = typeof msg.tick === 'number' ? msg.tick : 0;
  if (typeof msg.holeEpochMs === 'number' && Number.isFinite(msg.holeEpochMs)) {
    mpHoleEpochMs = msg.holeEpochMs;
  } else if (typeof msg.hostTimeMs === 'number' && Number.isFinite(msg.hostTimeMs)) {
    // Derive W0: at hostTimeMs, sim was `tick`
    mpHoleEpochMs = msg.hostTimeMs - tick * TICK_MS;
  }
  mpNoteHostTick(tick, msg.hostTimeMs);
  // Mid-hole join / resync: adopt host tick + obstacle clock when playing.
  if (mpPlaying && typeof msg.tick === 'number') {
    mpSimTick = msg.tick;
    const hole = currentHoles()[Game.currentHoleIndex];
    if (hole) setHoleObstaclesAtTick(hole, mpSimTick);
  }
}

function mpSendClientClock() {
  if (!MULTIPLAYER || !mpPlaying || !mpSocketOpen()) return false;
  mpSocket.send(
    JSON.stringify({
      type: 'clientClock',
      tick: mpSimTick,
      clientTimeMs: Date.now(),
      lastHostTick: mpLastHostTick,
    })
  );
  mpKeepaliveLastSentMs = performance.now();
  return true;
}

/** rAF-driven keepalive — less throttled than setInterval on mobile browsers. */
function mpMaybeSendKeepalive(force) {
  if (!MULTIPLAYER || !mpPlaying || !mpSocketOpen()) return;
  const now = performance.now();
  if (!force && mpKeepaliveLastSentMs > 0 && now - mpKeepaliveLastSentMs < MP_KEEPALIVE_MS) {
    return;
  }
  mpSendClientClock();
}

function mpStartKeepalives() {
  mpStopKeepalives();
  if (!MULTIPLAYER) return;
  // Immediate pulse so host liveness starts before the first rAF gap.
  mpSendClientClock();
}

function mpStopKeepalives() {
  mpKeepaliveLastSentMs = 0;
}

// Resume pulse after tab freeze / browser throttle gap (visibility API).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') mpMaybeSendKeepalive(true);
  });
}

function mpEstimatedElapsedMs() {
  // Between holes the host clock sample is frozen but wall time isn't — freeze the HUD.
  if (!mpPlaying) return mpFrozenTimerMs;
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
      wet: !!b.wet,
      wetStroke: !!b.wetStroke,
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
  const hole = currentHoles()[Game.currentHoleIndex];
  mpCanPutt = !p.holedOut && mayPuttBall(p, hole, Game.speedTracker);
  setHudText(hudStrokes, `Strokes: ${p.strokes}`);
}

function mpApplyAuthorityPose(p, b, hard, applyOpts) {
  applyOpts = applyOpts || {};
  const visX = p.rx, visY = p.ry;
  const before = { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
  const clientMoving = Math.hypot(p.vx, p.vy) >= STOP_THRESHOLD;
  const hostMoving = Math.hypot(b.vx || 0, b.vy || 0) >= STOP_THRESHOLD;
  const moving = clientMoving || hostMoving;
  const distBefore = Math.hypot((p.x - b.x), (p.y - b.y));
  const reason = applyOpts.reason || '';

  // Soft + in-flight: never touch sim pose or velocity.
  // Instant Δv (or mid-coast x/y snap) rewrites the integration path under the ball —
  // visual error decay cannot hide that kink. Soft packets are juice/meta only until
  // a hard discrete event (clash/water/holed/idle/resync) or catastrophic error.
  // Also ignore soft poses for self during post-respawn grace (soft idle undid tee reset).
  const selfRespawnGrace =
    p.id === mpPlayerId && performance.now() < respawnSoftGraceUntil;
  if (!hard && selfRespawnGrace) {
    if (typeof b.strokes === 'number' && b.strokes > p.strokes) p.strokes = b.strokes;
    RbDiag.noteAuthority(p, b, false, before, { reason, applied: false });
    return;
  }
  if (!hard && moving && !b.holedOut) {
    if (typeof b.strokes === 'number' && b.strokes > p.strokes) p.strokes = b.strokes;
    p.rx = p.x + p.errX;
    p.ry = p.y + p.errY;
    p.rz = p.z || 0;
    RbDiag.noteAuthority(p, b, false, before, { reason, applied: false });
    return;
  }

  if (!applyOpts.skipDiag) {
    RbDiag.noteAuthority(p, b, hard, before, { reason, applied: true });
  }

  // Hard authority, settled soft, or hole-out: adopt host sim state.
  p.strokes = b.strokes;
  p.holedOut = !!b.holedOut;
  p.x = b.x;
  p.y = b.y;
  p.vx = b.vx || 0;
  p.vy = b.vy || 0;
  p.z = b.z || 0;
  p.vz = b.vz || 0;
  if (typeof b.stuckStickyIndex === 'number') p.stuckStickyIndex = b.stuckStickyIndex;
  // Absent wet on wire means dry (ballWire only sets the flag when true).
  p.wet = !!b.wet;
  p.wetStroke = !!b.wetStroke;
  // Water float / dunk count — must match host for deterministic drop slots.
  if (typeof b.dunks === 'number') p.dunks = b.dunks;
  if (b.floating && typeof b.floating.ticks === 'number' && b.floating.ticks > 0) {
    p.floatTicks = b.floating.ticks;
    p.floatZone = b.floating.zone || p.floatZone;
    p.floatCarry = {
      vx: b.floating.vx || 0,
      vy: b.floating.vy || 0,
    };
  } else if (hard && b.floating === null) {
    // Explicit clear from host (landed / not floating).
    p.floatTicks = 0;
    p.floatZone = null;
    p.floatCarry = null;
  } else if (hard && b.floating === undefined && Math.hypot(p.vx || 0, p.vy || 0) < STOP_THRESHOLD) {
    // Hard rest snap without float payload: not floating.
    p.floatTicks = 0;
    p.floatZone = null;
    p.floatCarry = null;
  }
  // Boost latch is leave-to-rearm (cleared when ball exits pad). Wire must preserve
  // firedBoosts while still on a pad — clearing on rest snaps re-fires and can loop.
  if (Array.isArray(b.firedBoosts)) {
    p.firedBoosts = new Set(b.firedBoosts.filter((i) => typeof i === 'number'));
  }

  // deferVisual: seed sim at sample tick only; caller will resim to present and fix rx/ry.
  if (applyOpts.deferVisual) {
    p.rx = visX;
    p.ry = visY;
    p.rz = p.z || 0;
    return;
  }

  const visGap = Math.hypot(visX - p.x, visY - p.y);
  // Hard / hole-out / catastrophic / already aligned → clean snap.
  // Soft settled with leftover offset → glide via err decay (no pop).
  const forceHard =
    b.holedOut || hard || distBefore >= MP_HARD_ERR_PX || visGap < MP_SOFT_ERR_PX;
  if (forceHard) {
    p.errX = 0;
    p.errY = 0;
    p.rx = p.x;
    p.ry = p.y;
    p.rz = p.z;
  } else {
    p.errX = visX - p.x;
    p.errY = visY - p.y;
    p.rx = p.x + p.errX;
    p.ry = p.y + p.errY;
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
    if (fromServer.wet !== undefined) p.wet = !!fromServer.wet;
    if (fromServer.wetStroke !== undefined) p.wetStroke = !!fromServer.wetStroke;
  } else {
    const factor = stickyLaunchFactor(p, hole);
    latchStickyAfterPutt(p, hole);
    noteWetPutt(p);
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
    resetSpeedAvgTracker(Game.speedTracker);
    mpSyncSelfFromPlayer(p);
    mpCanPutt = false;
  }
}

function mpOnPuttApplied(msg) {
  if (!mpPlaying) return;
  // puttApplied = confirmed input juice (+ optional remote launch for prediction).
  // State truth remains hard replay (seed@H → resim). No single-ball "aging" hacks —
  // free-run is only the shared mpUpdateLocalSim path for the whole world.
  if (typeof msg.holeEpochMs === 'number' && Number.isFinite(msg.holeEpochMs)) {
    mpHoleEpochMs = msg.holeEpochMs;
  }
  const puttTick = typeof msg.tick === 'number' ? msg.tick : null;
  const isSelf = msg.playerId === mpPlayerId;
  let p = Game.players.get(msg.playerId);
  const hostPose = {
    x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, strokes: msg.strokes,
    stuckStickyIndex: msg.stuckStickyIndex, z: msg.z, vz: msg.vz,
    wet: msg.wet, wetStroke: msg.wetStroke,
  };

  // puttApplied carries pose *at the putt tick* (rest x/y + full launch v) — not live pose.
  if (isSelf && p) {
    const alreadyLaunched =
      Math.hypot(p.vx, p.vy) >= STOP_THRESHOLD || p.strokes >= (msg.strokes || 0);
    const lateWhileCoasting =
      puttTick != null && puttTick < mpSimTick && alreadyLaunched;
    if (alreadyLaunched || lateWhileCoasting) {
      // Confirm only. Optimistic coast until hard replay.
      p.strokes = Math.max(p.strokes, msg.strokes || 0);
      if (typeof msg.stuckStickyIndex === 'number') p.stuckStickyIndex = msg.stuckStickyIndex;
      if (msg.wet !== undefined) p.wet = !!msg.wet;
      if (msg.wetStroke !== undefined) p.wetStroke = !!msg.wetStroke;
      mpSyncSelfFromPlayer(p);
    } else {
      mpApplyPuttLocal(msg.playerId, msg.dragVector, hostPose, false);
    }
    return;
  }

  // Remote puttApplied = juice only (SFX). Do NOT teleport sim/draw to putt-tick pose —
  // that was the large discontinuity (trail jump) before host path catch-up.
  // Pose + path truth arrive on hard replay (balls[].path → mpStartVisualPath).
  if (!p) {
    p = mpUpsertPlayer({
      id: msg.playerId, name: '?', hue: 0,
      x: msg.x, y: msg.y, vx: 0, vy: 0,
      strokes: msg.strokes || 0, holedOut: false,
      stuckStickyIndex: msg.stuckStickyIndex,
    });
    // Keep draw at spawn pose until hard path plays; do not launch visually here.
    p.rx = p.x;
    p.ry = p.y;
  }
  if (msg.dragVector) {
    const launch = computeLaunchVelocity(clampDragVector(msg.dragVector) || msg.dragVector);
    soundPutt(Math.hypot(launch.vx, launch.vy) / MAX_LAUNCH_SPEED);
  }
}

function mpStepOneTick() {
  const hole = currentHoles()[Game.currentHoleIndex];
  mpSimTick += 1;
  setHoleObstaclesAtTick(hole, mpSimTick);

  const active = [...Game.players.values()].filter((p) => !p.holedOut);

  // Hazard floats mirror the server pass: drift with the deterministic waves,
  // then take the same slot-indexed drop spot. Hard corrections reconcile drift.
  for (const p of active) {
    if (!p.floatTicks || p.floatTicks <= 0) continue;
    p.floatTicks -= 1;
    stepWaterFloat(p, p.floatCarry, p.floatZone, mpSimTick * TICK_DT, TICK_DT);
    p.rx = p.x;
    p.ry = p.y;
    if (p.floatTicks <= 0) {
      // Stable slot: sorted id order (must match host waterDropSlot).
      const roster = [...Game.players.keys()].sort();
      const slot = Math.max(0, roster.indexOf(p.id));
      const drop = waterDropPointFor(p.floatZone, waterDropIndexFor(slot, p.dunks || 1), hole);
      p.x = drop.x;
      p.y = drop.y;
      p.vx = 0;
      p.vy = 0;
      p.floatTicks = 0;
      p.floatZone = null;
      p.floatCarry = null;
      markWetFromWater(p);
      p.errX = 0;
      p.errY = 0;
      p.rx = p.x;
      p.ry = p.y;
      spawnSplash(drop.x, drop.y);
    }
  }

  // Same PHYSICS_SUBTICKS schedule as the host so sticky stop/latch thresholds match.
  for (let s = 0; s < MP_PHYSICS_SUBTICKS; s++) {
    for (const p of active) {
      if (p.holedOut || (p.floatTicks && p.floatTicks > 0)) continue;
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
      if (mine && events.portals && events.portals.length) {
        playSfx('portalEnter', 0.85);
        playSfx('portalExit', 0.85);
      }
      if (events.water) {
        // Penalty + splash now; the ball floats 1.5s (float pass above) before the
        // server-matched drop-zone reset.
        p.strokes += 1;
        p.dunks = (p.dunks || 0) + 1;
        p.floatTicks = WATER_FLOAT_TICKS;
        p.floatZone = events.water;
        p.floatCarry = { vx: p.vx * WATER_FLOAT_CARRY, vy: p.vy * WATER_FLOAT_CARRY };
        p.vx = 0;
        p.vy = 0;
        p.z = 0;
        p.vz = 0;
        p.stuckStickyIndex = -1;
        spawnSplash(p.x, p.y);
        if (mine) {
          soundWater();
          mpShowBanner('SPLASH! +1  ·  WET');
          achvOnSplash();
        }
      }
      if (events.blackHole) {
        const tee = hole.tee;
        p.x = tee.x;
        p.y = tee.y;
        p.vx = 0;
        p.vy = 0;
        p.z = 0;
        p.vz = 0;
        p.stuckStickyIndex = -1;
        p.wet = false;
        p.wetStroke = false;
        p.firedBoosts = new Set();
        p.strokes += 1;
        p.errX = 0;
        p.errY = 0;
        p.rx = p.x;
        p.ry = p.y;
        spawnSplash(tee.x, tee.y);
        if (mine) {
          soundWater();
          mpShowBanner('EVENT HORIZON! +1  ·  Tee');
          // Not a water splash — pond3 / bubble trail only from actual water.
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

    // Ball–ball clashes (same order as host): predict collisions locally so host→guest
    // does not phase through until a late hard clash snap. Host remains authority.
    const activeNow = active
      .filter((p) => !p.holedOut && !(p.floatTicks && p.floatTicks > 0))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < activeNow.length; i++) {
      for (let j = i + 1; j < activeNow.length; j++) {
        const pa = activeNow[i];
        const pb = activeNow[j];
        if (resolveBallBallCollision(pa, pb)) {
          pa.errX = 0;
          pa.errY = 0;
          pb.errX = 0;
          pb.errY = 0;
          pa.rx = pa.x;
          pa.ry = pa.y;
          pb.rx = pb.x;
          pb.ry = pb.y;
          // Predictive clack only — achievements count from host clash events.
          if (pa.id === mpPlayerId || pb.id === mpPlayerId) {
            playSfx('bounce', 0.55);
          }
        }
      }
    }
    if (PathTrace.enabled) PathTrace.recordAll({ sub: s, phase: 'sim' });
  }
  // Quasi-rest window for local player (host validates with its own tracker).
  const me = Game.players.get(mpPlayerId);
  if (me && !me.holedOut) {
    noteSpeedSample(Game.speedTracker, Math.hypot(me.vx || 0, me.vy || 0), TICK_DT);
    mpSyncSelfFromPlayer(me);
  }
}

function mpUpdateLocalSim(dt) {
  if (!mpPlaying) {
    // Frozen clock on results / between holes — do not free-run hostTargetTick.
    setHudText(hudTotal, `Time: ${(mpFrozenTimerMs / 1000).toFixed(1)}s`);
    return;
  }
  // Shared epoch calendar (same as host): floor((now - W0) / TICK_MS).
  const targetTick = mpHostTargetTick();
  let steps = 0;
  while (mpSimTick < targetTick && steps < MP_MAX_CATCH_UP) {
    mpStepOneTick();
    steps++;
  }

  const nowT = performance.now();
  // Host-path visual catch-up first (render-only; does not write sim x/y).
  mpAdvanceVisualPaths(nowT);
  if (PathTrace.enabled) PathTrace.recordAll({ sub: null, phase: 'render' });

  const decay = Math.exp(-dt / MP_ERR_DECAY_TAU);
  for (const p of Game.players.values()) {
    if (p.visPath && p.visPath.length >= 2) {
      // Catch-up owns rx/ry until finished.
      continue;
    }
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
  // Cosmetics trails from render positions (MpRecon free-run + 600ms prune).
  for (const p of Game.players.values()) {
    MpRecon.freeRunTrailAndPrune(p, nowT);
  }
  const me = Game.players.get(mpPlayerId);
  if (me) mpSyncSelfFromPlayer(me);
  setHudText(hudTotal, `Time: ${(mpEstimatedElapsedMs() / 1000).toFixed(1)}s`);
  const hole = currentHoles()[Game.currentHoleIndex];
  setHudText(hudHole, `Hole ${Game.currentHoleIndex + 1}/${currentHoles().length} — ${hole.name}`);
  setHudText(hudPar, `Par ${hole.par}`);
}

function mpApplyCorrection(msg) {
  // Law: docs/mp-hard-truth-sync.md
  //   Hard @ H → seed host@H → resim H→present = sim truth.
  //   Residual match = visual no-op only when prediction already agreed.
  //   Soft = juice only (never sim).
  const hole = currentHoles()[msg.holeIndex];
  const tick = typeof msg.tick === 'number' ? msg.tick : elapsedMsToTick(msg.elapsedMs || 0);
  const reason = msg.reason || 'heartbeat';
  const hard = reason === 'resync' || reason === 'replay' ? true : !!msg.hard;
  const clientTickBefore = mpSimTick;
  const sampleInPast = hard && typeof tick === 'number' && tick < clientTickBefore;

  // Soft: juice only — never clock, epoch, or pose.
  if (!hard) {
    for (const ev of msg.events || []) mpHandleEvent(ev, hole, { juiceOnly: true });
    return;
  }

  // Hard is whole-hole authority for every ball — including self.
  // Do not skip self pose: another player's putt/clash can rewrite your ball; residual
  // match is the only visual no-op when free-run already agreed with host-resim present.

  // Snapshot present for residual (match → visual no-op; !match → path if host sent one).
  const presentById = new Map();
  for (const p of Game.players.values()) {
    presentById.set(p.id, {
      x: p.x, y: p.y, vx: p.vx, vy: p.vy, z: p.z || 0, vz: p.vz || 0,
      rx: p.rx, ry: p.ry, errX: p.errX || 0, errY: p.errY || 0,
      strokes: p.strokes, holedOut: !!p.holedOut,
    });
  }

  mpNoteHostTick(tick, msg.hostTimeMs, { holeEpochMs: msg.holeEpochMs });

  if (msg.obstacles) {
    msg.obstacles.windmillAngles.forEach((a, i) => { if (hole.windmills[i]) hole.windmills[i].angle = a; });
    msg.obstacles.pendulumPhases.forEach((ph, i) => { if (hole.pendulums[i]) hole.pendulums[i].phase = ph; });
    msg.obstacles.gatePhases.forEach((ph, i) => { if (hole.gates[i]) hole.gates[i].phase = ph; });
  } else {
    setHoleObstaclesAtTick(hole, tick);
  }

  // Seed sim at host sample tick H (law step 1–2). No free-run catch-up past H without host path.
  if (typeof tick === 'number') {
    mpSimTick = tick;
    if (!msg.obstacles) setHoleObstaclesAtTick(hole, tick);
  }

  const deferVisual = sampleInPast; // resim then residual visual check
  const seen = new Set();
  for (const b of msg.balls || []) {
    seen.add(b.id);
    const existed = Game.players.has(b.id);
    const p = mpUpsertPlayer(b);
    mpApplyAuthorityPose(p, b, true, {
      reason,
      skipDiag: deferVisual,
      deferVisual,
    });
  }
  if ((msg.balls || []).length > 0) {
    for (const id of Game.players.keys()) {
      if (seen.has(id)) continue;
      if (id === mpPlayerId) continue;
      Game.players.delete(id);
    }
  }

  // Law step 3–4: optional resim H→present; residual visual policy for every hard.
  let stepsGoal = 0;
  let stepsRun = 0;
  let hitCap = false;
  if (deferVisual) {
    stepsGoal = clientTickBefore - mpSimTick;
    let guard = 0;
    while (mpSimTick < clientTickBefore && guard++ < 256) {
      mpStepOneTick();
    }
    stepsRun = guard;
    hitCap = mpSimTick < clientTickBefore;
  }
  // Residual for all hard snaps (present-stamped included). Path catch-up only if
  // !matched and host attached a path for that ball (path = lastHard→thisHard window).
  for (const [id, before] of presentById) {
    const p = Game.players.get(id);
    if (!p) continue;
    const hostBall = (msg.balls || []).find((b) => b.id === id);
    const path = hostBall && Array.isArray(hostBall.path) ? hostBall.path : null;
    const vis = MpRecon.applyHardBallVisual(p, before, path, {
      hitCap,
      nowMs: performance.now(),
    });
    if (vis.matched) {
      RbDiag.noteAuthority(p, before, true, before, {
        reason,
        applied: true,
        matched: true,
        residualAfterResim: vis.dPos,
        rejectReason: msg.rejectReason,
      });
    } else {
      RbDiag.noteAuthority(p, { x: p.x, y: p.y, vx: p.vx, vy: p.vy }, true, before, {
        reason,
        applied: true,
        matched: false,
        residualAfterResim: vis.dPos,
        rejectReason: msg.rejectReason,
      });
      if (vis.pathCatchup || vis.dPos > 3) {
        try {
          console.info('[RB] path_mismatch_after_resim', {
            reason,
            sampleTick: tick,
            clientTickBefore,
            stepsGoal,
            stepsRun,
            hitCap,
            dPos: Math.round(vis.dPos * 10) / 10,
            dV: Math.round(vis.dV * 10) / 10,
            pathSamples: path ? path.length : 0,
            pathCatchup: vis.pathCatchup,
          });
        } catch (_) {}
      }
    }
  }
  // Balls that appeared only on this hard (no before snapshot): path if host sent one.
  for (const b of msg.balls || []) {
    if (presentById.has(b.id)) continue;
    const p = Game.players.get(b.id);
    if (!p || !Array.isArray(b.path) || b.path.length === 0) continue;
    mpStartVisualPath(p, b.path);
  }
  if (msg.rejectReason || reason === 'resync') {
    try {
      console.info('[RB] force_sync_or_resync', {
        rejectReason: msg.rejectReason || null,
        tick,
        reason,
        clientTick: clientTickBefore,
      });
    } catch (_) {}
  }

  // Hard already seeded poses (+ resim). Events are juice only — no second authority.
  for (const ev of msg.events || []) mpHandleEvent(ev, hole, { juiceOnly: true });

  if (PathTrace.enabled) {
    PathTrace.noteEvent({
      kind: 'hard_snapshot',
      reason,
      sampleTick: tick,
      clientTickBefore,
      balls: (msg.balls || []).map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        pathN: Array.isArray(b.path) ? b.path.length : 0,
      })),
    });
    PathTrace.recordAll({ sub: null, phase: 'after_hard', note: reason || 'hard' });
  }

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

function mpHandleEvent(ev, hole, opts) {
  opts = opts || {};
  // After hard seed+resim, poses are already authority — events must not re-author.
  const juiceOnly = !!opts.juiceOnly;
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
      // Pose/float come from hard ballWire (floating + dunks), not event coords.
      break;
    case 'blackHole':
      if (typeof ev.x === 'number') spawnSplash(ev.x, ev.y);
      if (mine) {
        soundWater();
        mpShowBanner('EVENT HORIZON! +1');
      }
      break;
    case 'clash':
      // Hard snapshot balls[] already hold post-clash poses when juiceOnly.
      if (!juiceOnly && Array.isArray(ev.balls)) {
        for (const b of ev.balls) {
          const p = Game.players.get(b.id) || mpUpsertPlayer({
            id: b.id, name: '?', hue: 0, x: b.x, y: b.y, vx: b.vx, vy: b.vy, strokes: 0, holedOut: false,
          });
          mpApplyAuthorityPose(p, {
            x: b.x, y: b.y, vx: b.vx, vy: b.vy,
            strokes: p.strokes, holedOut: p.holedOut,
          }, true, { reason: 'clash' });
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
  mpRoomCode = null; // joining a new code; in-memory only
  mpSetRelayStatus(`Joining ${code}…`);
  mpSocket.send(JSON.stringify({ type: 'relay_join', room_code: code, player_name: name }));
}

function mpSendCreateRoom() {
  // Fresh create must not reuse a half-handshaken socket already in a room.
  if (!mpSocketOpen()) {
    mpPendingAction = { type: 'create' };
    mpConnect({ skipAutoRejoin: true });
    return;
  }
  // Already in a room on this socket — open a clean one for create.
  if (mpRoomCode) {
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
    // Keep customHole if we still have pendingCustomLvl so share UI remains.
    if (!Game.pendingCustomLvl) Game.customHole = null;
    else {
      const d = decodeHole(Game.pendingCustomLvl);
      Game.customHole = d.ok ? d.hole : null;
    }
    showScreen('screen-start');
    refreshCustomLevelPanel();
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
    Game.customHole = null;
    Game.pendingCustomLvl = null;
    if (mpSocket && mpSocket.readyState === WebSocket.OPEN) {
      mpSocket.send(JSON.stringify({ type: 'selectCourse', courseIndex }));
    }
  });
}
const btnClearCustom = document.getElementById('btn-clear-custom');
if (btnClearCustom) {
  btnClearCustom.addEventListener('click', () => {
    soundClick();
    Game.customHole = null;
    Game.pendingCustomLvl = null;
    if (mpSocket && mpSocket.readyState === WebSocket.OPEN) {
      mpSocket.send(JSON.stringify({ type: 'clearCustomHole' }));
    }
  });
}
document.getElementById('btn-start-round').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  if (Game.pendingCustomLvl || Game.customHole) {
    try {
      const lvl = Game.pendingCustomLvl || encodeHole(Game.customHole);
      mpSocket.send(JSON.stringify({ type: 'setCustomHole', lvl }));
      mpSocket.send(JSON.stringify({ type: 'startRound' }));
      return;
    } catch (e) {
      mpSetRelayStatus('Custom hole invalid: ' + (e.message || e));
    }
  }
  mpSocket.send(JSON.stringify({ type: 'startRound', courseIndex: mpCourseIndex }));
});
document.getElementById('btn-play-again').addEventListener('click', () => {
  unlockAudio();
  soundClick();
  if (Game.customHole || Game.pendingCustomLvl) {
    try {
      const lvl = Game.pendingCustomLvl || encodeHole(Game.customHole);
      mpSocket.send(JSON.stringify({ type: 'setCustomHole', lvl }));
      mpSocket.send(JSON.stringify({ type: 'startRound' }));
      return;
    } catch (e) { /* fall through */ }
  }
  mpSocket.send(JSON.stringify({ type: 'startRound', courseIndex: mpCourseIndex }));
});

// ---- Custom level URL (?lvl= independent of ?room=) ----
/** Encoded payload for share links (pending URL, live custom hole, or MP host attach). */
function getCustomLevelPayload() {
  if (Game.pendingCustomLvl) return Game.pendingCustomLvl;
  const fromUrl = (MP_PARAMS.get('lvl') || '').trim();
  if (fromUrl) return fromUrl;
  if (Game.customHole) {
    try {
      return encodeHole(Game.customHole);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function openCustomLevelShare() {
  const lvl = getCustomLevelPayload();
  if (!lvl) return;
  if (window.ShareLevel && typeof ShareLevel.openShareMenu === 'function') {
    ShareLevel.openShareMenu(lvl);
  }
}

/**
 * Corner Share while a custom level is active.
 * Visible during MP/solo play (all menu screens hidden) and results overlays —
 * start menu uses its own Share control instead.
 */
function updateShareLevelButton() {
  const btn = document.getElementById('btn-share-level');
  if (!btn) return;
  const startEl = document.getElementById('screen-start');
  const onStart = startEl && !startEl.classList.contains('hidden');
  const lobbyEl = document.getElementById('screen-lobby');
  const onLobby = lobbyEl && !lobbyEl.classList.contains('hidden');
  const hasPayload = !!getCustomLevelPayload();
  // pendingCustomLvl alone is enough (joiners / encode-fragile live holes).
  const show = hasPayload && !onStart && !onLobby;
  btn.classList.toggle('hidden', !show);
}

function refreshCustomLevelPanel() {
  const panel = document.getElementById('custom-level-panel');
  const label = document.getElementById('custom-level-label');
  const errEl = document.getElementById('custom-level-error');
  if (!panel) return;
  const lvl = Game.pendingCustomLvl || MP_PARAMS.get('lvl');
  if (!lvl) {
    panel.classList.add('hidden');
    updateShareLevelButton();
    return;
  }
  const d = decodeHole(lvl);
  panel.classList.remove('hidden');
  if (!d.ok) {
    if (label) label.textContent = 'Custom level link invalid';
    if (errEl) {
      errEl.textContent = 'Could not load level: ' + d.error;
      errEl.classList.remove('hidden');
    }
    updateShareLevelButton();
    return;
  }
  if (errEl) errEl.classList.add('hidden');
  Game.pendingCustomLvl = lvl;
  // Do not force customHole until user chooses Play (keeps menu course select working).
  if (label) label.textContent = `Custom level: ${d.hole.name} (par ${d.hole.par})`;
  // Warm portal-gravity bake store as soon as the share link is recognized.
  ensurePortalGravityBake(d.hole, lvl).catch((e) => console.warn('[gravity] menu bake', e));
  updateShareLevelButton();
}

/**
 * Share-link Play / Create room: on production, create a multiplayer room with the
 * custom hole attached (same path as "create room and start alone" today). Friends
 * join via room code. file:// only falls back to offline solo for local dev.
 */
function playCustomInRoom() {
  const lvl = Game.pendingCustomLvl || MP_PARAMS.get('lvl');
  if (!lvl) return;
  const d = decodeHole(lvl);
  if (!d.ok) return;
  Game.pendingCustomLvl = lvl;
  Game.customHole = d.hole;
  unlockAudio();
  soundClick();
  // Start bake immediately (lobby or solo) so store is warm before the round clock runs.
  ensurePortalGravityBake(d.hole, lvl).catch((e) => console.warn('[gravity] early bake', e));
  if (!MULTIPLAYER) {
    // Local file:// dev only — no relay.
    startGame();
    return;
  }
  showScreen('screen-lobby');
  mpSendCreateRoom(); // host welcome sends setCustomHole(pendingCustomLvl)
}

const btnPlayCustom = document.getElementById('btn-play-custom');
if (btnPlayCustom) btnPlayCustom.addEventListener('click', playCustomInRoom);
const btnEditLevel = document.getElementById('btn-edit-level');
if (btnEditLevel) {
  btnEditLevel.addEventListener('click', () => {
    const lvl = Game.pendingCustomLvl || MP_PARAMS.get('lvl');
    if (!lvl) {
      location.href = 'editor.html';
      return;
    }
    location.href = 'editor.html?lvl=' + encodeURIComponent(lvl);
  });
}
const btnCreateWithLevel = document.getElementById('btn-create-with-level');
if (btnCreateWithLevel) {
  btnCreateWithLevel.addEventListener('click', playCustomInRoom);
}
const btnShareCustom = document.getElementById('btn-share-custom');
if (btnShareCustom) {
  btnShareCustom.addEventListener('click', () => {
    soundClick();
    openCustomLevelShare();
  });
}
const btnShareLevel = document.getElementById('btn-share-level');
if (btnShareLevel) {
  btnShareLevel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    soundClick();
    openCustomLevelShare();
  });
}

// ---- Init ----
// Scrub legacy room auto-rejoin keys so custom level links always win a fresh visit.
mpClearRoomCreds();

// ?lvl_short=alias → TinyURL redirect → comes back with permanent ?lvl=
if (window.ShareLevel && ShareLevel.resolveLvlShortFromLocation(MP_PARAMS)) {
  // Navigation in progress; skip rest of boot.
} else {
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

// Parse level param independently of room (do not require room for lvl).
{
  const lvl = (MP_PARAMS.get('lvl') || '').trim();
  if (lvl) {
    Game.pendingCustomLvl = lvl;
    const d = decodeHole(lvl);
    if (d.ok) {
      // Prefill ball preview only — customHole set on Play.
      Game.ball.x = d.hole.tee.x;
      Game.ball.y = d.hole.tee.y;
    }
  }
}
refreshCustomLevelPanel();

if (!Game.pendingCustomLvl) {
  Game.ball.x = COURSES[0].holes[0].tee.x;
  Game.ball.y = COURSES[0].holes[0].tee.y;
} else {
  try {
    const d = decodeHole(Game.pendingCustomLvl);
    if (d.ok) {
      Game.ball.x = d.hole.tee.x;
      Game.ball.y = d.hole.tee.y;
    }
  } catch (e) { /* ignore */ }
}

if (MULTIPLAYER) {
  // Level-only share: show start with custom actions (not forced lobby auto-play).
  // Room param still opens lobby join flow.
  const hasRoom = !!(MP_PARAMS.get('room') || '').trim();
  if (Game.pendingCustomLvl && !hasRoom) {
    showScreen('screen-start');
    mpConnect(); // connect in background for Create room
  } else {
    showScreen('screen-lobby');
    mpConnect();
  }
} else {
  showScreen('screen-start');
}
updateShareLevelButton();
requestAnimationFrame(loop);
} // end init (skipped when resolving ?lvl_short=)
