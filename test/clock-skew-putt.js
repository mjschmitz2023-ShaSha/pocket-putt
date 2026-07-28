#!/usr/bin/env node
/**
 * Clock-skew / low-fps putt acceptance regression
 * ------------------------------------------------
 * Real GameSession + ClientModel.
 *
 * Reproduces the "Android putt rejection" bug: any client whose wall clock is
 * offset from the host's by more than TRUST_WINDOW (±500ms), or whose frame
 * rate is too low for the free-run catch-up cap, stamps putts outside the
 * host's trust window. Signature: first putt after a hard adopt is accepted,
 * every later putt force-syncs with too_old / too_far_future (rubber band,
 * putt never applied).
 *
 * The client tick calendar must NOT compare Date.now() across machines —
 * putt stamps have to survive arbitrary device clock skew. Only real latency
 * (which physically delays messages) may consume trust-window budget.
 *
 * Usage: node test/clock-skew-putt.js
 */
'use strict';

const Shared = require('../shared.js');
const { GameSession } = require('../gameSession.js');
const { ClientModel } = require('./clientModel.js');

const TICK_MS = Shared.TICK_MS;
const STOP = Shared.STOP_THRESHOLD;

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.outbox = [];
  }
  send(raw) {
    try {
      this.outbox.push(JSON.parse(raw));
    } catch (_) {
      /* ignore */
    }
  }
  close() {
    this.readyState = 3;
  }
  drain() {
    const m = this.outbox;
    this.outbox = [];
    return m;
  }
}

class Pipe {
  constructor(delayMs) {
    this.delayMs = delayMs || 0;
    this.q = [];
  }
  push(msg, now) {
    this.q.push({ at: now + this.delayMs, msg });
  }
  pop(now) {
    const out = [];
    while (this.q.length && this.q[0].at <= now) out.push(this.q.shift().msg);
    return out;
  }
}

/**
 * Drive one client profile against a real host session.
 * The harness wall clock `wallMs` is the host's truth. The client sees
 * `wallMs + skewMs` as its own wall clock (device clock offset) and renders
 * a frame every `1000 / clientFps` ms.
 *
 * @returns {{ attempts, accepted, rejects: string[] }}
 */
function runProfile({ skewMs, clientFps, delayMs }) {
  const sockA = new FakeSocket();
  const sockB = new FakeSocket();
  const session = new GameSession({ code: 'T', joinUrl: 'T', joinUrlFallback: 'T' });
  session.courseIndex = 0;
  const alice = session.addPlayer(sockA, { name: 'Alice', isLocal: true }).player;
  const bob = session.addPlayer(sockB, { name: 'Bob', isLocal: false }).player;

  const rejects = [];
  const origForce = session.forceSyncPlayer.bind(session);
  session.forceSyncPlayer = (player, reason) => {
    if (player === bob && reason) rejects.push(reason);
    origForce(player, reason);
  };

  session.handleMessage(alice, { type: 'startRound', courseIndex: 0 });
  if (session.state !== 'PLAYING') session.startNewRound();
  // Synthetic wall origin — host calendar counts from wallMs 0.
  session.holeStartedAtMs = 0;
  session.holeEpochMs = 0;

  const client = new ClientModel({ playerId: bob.id, courseIndex: 0 });
  let wallMs = 0;

  // Join-time seed (no lag on the initial reliable payloads).
  for (const msg of sockB.drain()) {
    if (msg.type === 'roundState') {
      client.onRoundState(msg);
      client.noteHostTick(msg.tick || 0, skewMs);
    } else if (msg.type === 'clockSync') {
      client.onClockSync(msg, skewMs);
    } else if (msg.type === 'snapshot') {
      client.onSnapshot(msg, skewMs);
    }
  }
  sockA.drain();
  if (bob.ball && !client.players.has(bob.id)) {
    client.upsert({
      id: bob.id,
      name: 'Bob',
      hue: 0,
      x: bob.ball.x,
      y: bob.ball.y,
      vx: 0,
      vy: 0,
      strokes: 0,
      holedOut: false,
    });
  }

  const down = new Pipe(delayMs);
  const up = new Pipe(delayMs);
  const clientFrameMs = 1000 / clientFps;
  let nextClientFrame = 0;
  let nextKeepalive = 0;

  const puttPlan = [2000, 8000, 14000];
  let planIdx = 0;
  let attempts = 0;

  const HORIZON = 20000;
  const FRAME = 1000 / 60;
  const drag = { x: 30, y: 4 };

  while (wallMs < HORIZON) {
    while (nextClientFrame <= wallMs) {
      client.update(nextClientFrame + skewMs, clientFrameMs / 1000);
      nextClientFrame += clientFrameMs;
    }
    while (nextKeepalive <= wallMs) {
      up.push(
        {
          type: 'clientClock',
          tick: client.simTick,
          clientTimeMs: wallMs + skewMs,
          lastHostTick: client.lastHostTick,
        },
        wallMs
      );
      nextKeepalive += 333;
    }
    if (planIdx < puttPlan.length && wallMs >= puttPlan[planIdx]) {
      const cp = client.players.get(bob.id);
      if (cp && !cp.holedOut && Math.hypot(cp.vx, cp.vy) < STOP) {
        const clientTick = client.simTick;
        client.applyPuttLocal(bob.id, drag, null);
        client.lastPuttClientTick = clientTick;
        up.push({ type: 'putt', dragVector: drag, clientTick }, wallMs);
        attempts++;
        planIdx++;
      }
    }
    for (const msg of up.pop(wallMs)) session.handleMessage(bob, msg);
    for (const msg of sockB.drain()) down.push(msg, wallMs);
    sockA.drain();
    for (const msg of down.pop(wallMs)) {
      if (msg.type === 'roundState') {
        client.onRoundState(msg);
        client.noteHostTick(msg.tick || 0, wallMs + skewMs);
      } else if (msg.type === 'clockSync') {
        client.onClockSync(msg, wallMs + skewMs);
      } else if (msg.type === 'puttApplied') {
        client.noteHostTick(msg.tick, wallMs + skewMs);
        client.onPuttApplied(msg);
      } else if (msg.type === 'snapshot') {
        client.onSnapshot(msg, wallMs + skewMs);
      }
    }
    wallMs += FRAME;
    if (session.state === 'PLAYING') {
      const target = Math.floor(wallMs / TICK_MS);
      let g = 0;
      while (session.simTick < target && session.state === 'PLAYING' && g++ < 600) {
        session.stepSimulation();
      }
      session.processPendingPutts();
    }
  }

  const puttRejects = rejects.filter((r) =>
    ['too_old', 'too_far_future', 'no_snapshot', 'queued_putt_expired', 'keepalive_stale', 'untrusted', 'missing_tick'].includes(r)
  );
  return { attempts, accepted: bob.strokes, rejects: puttRejects };
}

const CASES = [
  { name: 'control_no_skew', skewMs: 0, clientFps: 60, delayMs: 0 },
  { name: 'clock_behind_700ms', skewMs: -700, clientFps: 60, delayMs: 0 },
  { name: 'clock_behind_2s_lag150', skewMs: -2000, clientFps: 60, delayMs: 150 },
  { name: 'clock_ahead_700ms', skewMs: 700, clientFps: 60, delayMs: 0 },
  { name: 'clock_ahead_2s_lag150', skewMs: 2000, clientFps: 60, delayMs: 150 },
  { name: 'low_fps_5', skewMs: 0, clientFps: 5, delayMs: 0 },
];

let failures = 0;
for (const c of CASES) {
  const r = runProfile(c);
  const ok = r.attempts === 3 && r.accepted === 3 && r.rejects.length === 0;
  const detail = `attempts=${r.attempts} accepted=${r.accepted}${r.rejects.length ? ' rejects=' + r.rejects.join(',') : ''}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} ${detail}`);
  if (!ok) failures++;
}

if (failures) {
  console.error(`\n${failures} clock-skew putt case(s) failed — putt stamps must survive device clock skew.`);
  process.exit(1);
}
console.log('\nAll clock-skew putt cases passed.');
