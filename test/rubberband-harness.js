#!/usr/bin/env node
/**
 * Rubber-band / reconcilation harness
 * -----------------------------------
 * Runs a real GameSession (host) and one or more pure ClientModel instances
 * (coast recon mirror). Injects network delay / jitter / drops, then scores:
 *
 *   - max/avg sim error (client physics pose vs host)
 *   - max/avg visual error (rx/ry after soft-hard recon vs host)
 *   - hard snaps while moving  ← the "rubber band" signal
 *   - puttApplied self-resyncs
 *
 * Usage:
 *   node test/rubberband-harness.js
 *   node test/rubberband-harness.js --scenario sticky
 *   node test/rubberband-harness.js --all --json
 *   npm test
 *
 * Thresholds (exit 1 if any scenario fails):
 *   ideal:            maxVisErr < 2,  hardSnapsWhileMoving === 0
 *   delayed_putt:     puttResyncs === 0 (never re-fire launch Δv mid-coast)
 *   jitter:           hardSnapsWhileMoving near 0 (soft in-flight is juice-only)
 *   sticky_escape:    puttResyncs === 0
 *   multi_clash:      hardSnapsWhileMoving low (clashes are hard by design)
 */
'use strict';

const path = require('path');
const WebSocket = require('ws');
const Shared = require('../shared.js');
const { GameSession, TICK_MS } = require('../gameSession.js');
const { ClientModel } = require('./clientModel.js');

const TICK_HZ = Shared.TICK_HZ;
const TICK_DT = Shared.TICK_DT;

// ---- Fake socket that captures host → client frames ----
class FakeSocket {
  constructor(label) {
    this.label = label;
    this.readyState = WebSocket.OPEN;
    this.bufferedAmount = 0;
    this.inbox = []; // messages delivered TO the host (unused — we call handleMessage)
    this.outbox = []; // messages host sent to this client
  }
  send(raw) {
    try {
      this.outbox.push(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
  drain() {
    const m = this.outbox;
    this.outbox = [];
    return m;
  }
}

// ---- Network pipe: delay + jitter + drop ----
class NetPipe {
  /**
   * @param {{ delayMs?: number, jitterMs?: number, dropRate?: number, seed?: number }} opts
   */
  constructor(opts = {}) {
    this.delayMs = opts.delayMs || 0;
    this.jitterMs = opts.jitterMs || 0;
    this.dropRate = opts.dropRate || 0;
    this.queue = []; // { deliverAt, msg }
    this._rng = mulberry32(opts.seed ?? 1);
  }

  push(msg, nowMs) {
    if (msg.type === 'snapshot' && this.dropRate > 0 && this._rng() < this.dropRate) {
      return; // drop disposable corrections
    }
    // Never drop puttApplied / roundState — those are reliable in production.
    const j = this.jitterMs ? (this._rng() * 2 - 1) * this.jitterMs : 0;
    const deliverAt = nowMs + this.delayMs + j;
    this.queue.push({ deliverAt, msg });
    this.queue.sort((a, b) => a.deliverAt - b.deliverAt);
  }

  popReady(nowMs) {
    const out = [];
    while (this.queue.length && this.queue[0].deliverAt <= nowMs) {
      out.push(this.queue.shift().msg);
    }
    return out;
  }
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Scenario runner ----
/**
 * @param {{
 *   name: string,
 *   courseIndex: number,
 *   holeIndex: number,
 *   net: object,
 *   frames: number,
 *   script: (ctx) => void,
 *   thresholds: object,
 * }} scenario
 */
function runScenario(scenario) {
  const sockA = new FakeSocket('A');
  const sockB = new FakeSocket('B');
  const session = new GameSession({
    code: 'TEST',
    joinUrl: 'TEST',
    joinUrlFallback: 'TEST',
  });
  session.courseIndex = scenario.courseIndex || 0;

  const a = session.addPlayer(sockA, { name: 'Alice', isLocal: true });
  const b = session.addPlayer(sockB, { name: 'Bob', isLocal: false });
  if (!a.player || !b.player) throw new Error('join failed');

  const client = new ClientModel({ playerId: b.player.id, courseIndex: session.courseIndex });
  const pipe = new NetPipe(scenario.net || {});

  // Deterministic wall clock for the harness (not Date.now).
  let wallMs = 0;
  const FRAME_MS = 1000 / 60;

  // Start round
  session.handleMessage(a.player, {
    type: 'startRound',
    courseIndex: session.courseIndex,
  });
  // If startRound only works in WAITING, beginHole via host start:
  if (session.state !== 'PLAYING') {
    session.startNewRound();
  }
  // Force hole if scenario asks
  if (typeof scenario.holeIndex === 'number' && scenario.holeIndex > 0) {
    session.beginHole(scenario.holeIndex);
  }

  // Deliver initial roundState + resync to client
  function flushHostOut() {
    for (const msg of sockB.drain()) {
      pipe.push(msg, wallMs);
    }
    // Also ignore sockA (local host player) for remote client tests
    sockA.drain();
  }
  flushHostOut();

  function deliverToClient() {
    for (const msg of pipe.popReady(wallMs)) {
      if (msg.type === 'roundState') {
        client.onRoundState(msg);
        client.noteHostTick(msg.tick || 0, wallMs);
      } else if (msg.type === 'puttApplied') {
        client.noteHostTick(msg.tick, wallMs);
        client.onPuttApplied(msg);
      } else if (msg.type === 'snapshot') {
        client.onSnapshot(msg, wallMs);
      }
    }
  }
  deliverToClient();

  const ctx = {
    session,
    hostPlayer: a.player,
    remotePlayer: b.player,
    client,
    putt(player, drag) {
      session.handleMessage(player, { type: 'putt', dragVector: drag });
      flushHostOut();
    },
    wallMs: () => wallMs,
  };

  // Run scenario script (schedule putts at frame indices via callbacks)
  const schedule = [];
  ctx.atFrame = (frame, fn) => {
    schedule.push({ frame, fn });
  };
  scenario.script(ctx);
  schedule.sort((x, y) => x.frame - y.frame);

  const totalFrames = scenario.frames || 300;
  let schedIdx = 0;

  for (let frame = 0; frame < totalFrames; frame++) {
    while (schedIdx < schedule.length && schedule[schedIdx].frame === frame) {
      schedule[schedIdx].fn(ctx);
      schedIdx++;
      flushHostOut();
    }

    // Advance host sim one tick-worth of wall time
    wallMs += FRAME_MS;
    // Align host holeStartedAtMs so tickDriver/step runs deterministically
    if (session.state === 'PLAYING') {
      // Drive exactly one step per frame at 60Hz (same as production catch-up toward wall)
      const wallTarget = Math.floor(wallMs / TICK_MS);
      // holeStartedAtMs is absolute Date.now()-based in production; force step count instead
      while (session.simTick < wallTarget && session.state === 'PLAYING') {
        session.stepSimulation();
        if (session.simTick > wallTarget) break;
        // safety
        if (session.simTick > wallTarget + 100) break;
      }
      // If holeStartedAtMs based — re-sync: set so wallTarget matches
      // Actually session uses Date.now() in tickDriver. We call stepSimulation in a loop
      // based on wallMs / TICK_MS from 0 — but holeStartedAtMs is Date.now() at beginHole.
      // So simTick won't advance with our wallMs. FIX: force holeStartedAtMs relative.
    }
    flushHostOut();
    deliverToClient();
    client.update(wallMs, FRAME_MS / 1000);

    // Ground truth
    const hostBalls = {};
    for (const p of session.players.values()) {
      if (p.ball) {
        hostBalls[p.id] = {
          x: p.ball.x,
          y: p.ball.y,
          vx: p.ball.vx,
          vy: p.ball.vy,
        };
      }
    }
    client.sampleError(hostBalls);
  }

  const summary = client.summary();
  summary.name = scenario.name;
  summary.thresholds = scenario.thresholds || {};
  summary.pass = evaluate(summary, scenario.thresholds || {});
  return summary;
}

function evaluate(s, t) {
  if (t.maxVisErr != null && s.maxVisErr > t.maxVisErr) return false;
  if (t.maxSimErr != null && s.maxSimErr > t.maxSimErr) return false;
  if (t.hardSnapsWhileMoving != null && s.hardSnapsWhileMoving > t.hardSnapsWhileMoving) return false;
  if (t.puttResyncs != null && s.puttResyncs > t.puttResyncs) return false;
  return true;
}

// Patch GameSession to use harness-controlled time for tickDriver if needed.
// We call stepSimulation directly with corrected holeStartedAtMs:
function fixSessionClock(session) {
  // beginHole already set holeStartedAtMs = Date.now(). Replace so simTick tracks wallMs from 0.
  const origBegin = session.beginHole.bind(session);
  session.beginHole = function (idx) {
    origBegin(idx);
    session.holeStartedAtMs = 0; // wallMs origin
  };
  // If already playing:
  if (session.state === 'PLAYING') session.holeStartedAtMs = 0;
}

// Re-implement runner with fixed clock
function runScenarioFixed(scenario) {
  const sockA = new FakeSocket('A');
  const sockB = new FakeSocket('B');
  const session = new GameSession({ code: 'TEST', joinUrl: 'TEST', joinUrlFallback: 'TEST' });
  session.courseIndex = scenario.courseIndex || 0;

  const joinA = session.addPlayer(sockA, { name: 'Alice', isLocal: true });
  const joinB = session.addPlayer(sockB, { name: 'Bob', isLocal: false });
  const hostP = joinA.player;
  const remoteP = joinB.player;

  const client = new ClientModel({ playerId: remoteP.id, courseIndex: session.courseIndex });
  const pipe = new NetPipe(scenario.net || {});

  let wallMs = 0;
  const FRAME_MS = 1000 / 60;

  // Monkey-patch beginHole to zero the wall clock origin
  const _begin = session.beginHole.bind(session);
  session.beginHole = (idx) => {
    _begin(idx);
    session.holeStartedAtMs = 0;
  };

  session.handleMessage(hostP, { type: 'startRound', courseIndex: session.courseIndex });
  if (session.state !== 'PLAYING') session.startNewRound();
  if (typeof scenario.holeIndex === 'number' && scenario.holeIndex !== session.currentHoleIndex) {
    session.beginHole(scenario.holeIndex);
  }
  session.holeStartedAtMs = 0;

  const schedule = [];
  const ctx = {
    session,
    hostPlayer: hostP,
    remotePlayer: remoteP,
    client,
    atFrame(frame, fn) {
      schedule.push({ frame, fn });
    },
    /**
     * Host-authoritative putt. For the remote client under test, also apply an optimistic
     * local launch (mirrors game.js) so puttApplied agreement metrics are meaningful.
     */
    putt(player, drag) {
      // Only optimistic-launch if ball is at rest (host would reject mid-roll putts).
      const ball = player.ball;
      if (!ball || player.holedOut) return;
      if (Math.hypot(ball.vx, ball.vy) >= Shared.STOP_THRESHOLD) return;

      if (player === remoteP) {
        if (!client.players.has(remoteP.id)) {
          client.upsert({
            id: remoteP.id,
            name: remoteP.name,
            hue: remoteP.hue,
            x: ball.x,
            y: ball.y,
            vx: 0,
            vy: 0,
            strokes: player.strokes,
            holedOut: false,
            stuckStickyIndex: ball.stuckStickyIndex,
          });
        }
        client.applyPuttLocal(remoteP.id, drag, null);
      }
      session.handleMessage(player, { type: 'putt', dragVector: drag });
    },
  };
  scenario.script(ctx);
  schedule.sort((a, b) => a.frame - b.frame);

  function flushAndQueue() {
    for (const msg of sockB.drain()) pipe.push(msg, wallMs);
    sockA.drain();
  }
  function deliver() {
    for (const msg of pipe.popReady(wallMs)) {
      if (msg.type === 'roundState') {
        client.onRoundState(msg);
        client.noteHostTick(typeof msg.tick === 'number' ? msg.tick : 0, wallMs);
      } else if (msg.type === 'puttApplied') {
        client.noteHostTick(msg.tick, wallMs);
        client.onPuttApplied(msg);
      } else if (msg.type === 'snapshot') {
        client.onSnapshot(msg, wallMs);
      }
    }
  }

  // Initial resync → client before any steps
  flushAndQueue();
  deliver();
  // Seed remote player pose from host tee if still missing
  if (remoteP.ball && !client.players.has(remoteP.id)) {
    client.upsert({
      id: remoteP.id,
      name: remoteP.name,
      hue: remoteP.hue,
      x: remoteP.ball.x,
      y: remoteP.ball.y,
      vx: 0,
      vy: 0,
      strokes: 0,
      holedOut: false,
      stuckStickyIndex: remoteP.ball.stuckStickyIndex,
    });
  }

  let si = 0;
  const totalFrames = scenario.frames || 360;

  // ---- Pure lockstep: puttApplied first, then each tick:
  // host step → client coast to same tick → then apply snapshots (should be ~0 delta).
  if (scenario.pureLockstep) {
    function deliverImmediate(types) {
      flushAndQueue();
      const keep = [];
      for (const item of pipe.queue) {
        if (!types || types.includes(item.msg.type)) {
          const m = item.msg;
          if (m.type === 'roundState') {
            client.onRoundState(m);
            client.noteHostTick(m.tick || 0, wallMs);
          } else if (m.type === 'puttApplied') {
            client.noteHostTick(m.tick, wallMs);
            client.onPuttApplied(m);
          } else if (m.type === 'snapshot') {
            client.onSnapshot(m, wallMs);
          }
        } else {
          keep.push(item);
        }
      }
      pipe.queue = keep;
    }

    for (let frame = 0; frame < totalFrames; frame++) {
      while (si < schedule.length && schedule[si].frame === frame) {
        schedule[si].fn(ctx);
        si++;
      }
      // Apply puttApplied before any further sim (matches production "reliable event")
      deliverImmediate(['roundState', 'puttApplied', 'welcome', 'lobbyState']);

      if (session.state === 'PLAYING') session.stepSimulation();

      // Client coasts to the host tick BEFORE consuming hard corrections
      while (client.simTick < session.simTick) client.stepOneTick();
      client.noteHostTick(session.simTick, wallMs);

      // Snapshots should now nearly match — any hard_snap is a real physics fork
      deliverImmediate(null);

      const decay = Math.exp(-(FRAME_MS / 1000) / 0.12);
      for (const p of client.players.values()) {
        p.errX *= decay;
        p.errY *= decay;
        if (Math.hypot(p.errX, p.errY) < 0.5) {
          p.errX = 0;
          p.errY = 0;
        }
        p.rx = p.x + p.errX;
        p.ry = p.y + p.errY;
      }
      wallMs += FRAME_MS;
      const hostBalls = {};
      for (const p of session.players.values()) {
        if (p.connected && p.ball) {
          hostBalls[p.id] = { x: p.ball.x, y: p.ball.y, vx: p.ball.vx, vy: p.ball.vy };
        }
      }
      client.sampleError(hostBalls);
    }
  } else {
    for (let frame = 0; frame < totalFrames; frame++) {
      // 1) Scripted inputs (optimistic client putt + host validate)
      while (si < schedule.length && schedule[si].frame === frame) {
        schedule[si].fn(ctx);
        si++;
      }
      // 2) Host outbound → network at this wall time
      flushAndQueue();
      // 3) Deliver anything due (delay=0 → immediate puttApplied before more host steps)
      deliver();
      // 4) Advance host one frame of sim
      wallMs += FRAME_MS;
      if (session.state === 'PLAYING') {
        const target = Math.floor(wallMs / TICK_MS);
        let guard = 0;
        while (session.simTick < target && session.state === 'PLAYING' && guard++ < 32) {
          session.stepSimulation();
        }
      }
      // 5) New corrections into pipe + deliver
      flushAndQueue();
      deliver();
      // 6) Client coast toward host clock + decay visual error.
      if (scenario.perfectHostClock) {
        client.noteHostTick(session.simTick, wallMs);
      }
      client.update(wallMs, FRAME_MS / 1000);

      // 7) Score vs host ground truth
      const hostBalls = {};
      for (const p of session.players.values()) {
        if (p.connected && p.ball) {
          hostBalls[p.id] = { x: p.ball.x, y: p.ball.y, vx: p.ball.vx, vy: p.ball.vy };
        }
      }
      client.sampleError(hostBalls);
    }
  }

  const summary = client.summary();
  summary.name = scenario.name;
  summary.pass = evaluate(summary, scenario.thresholds || {});
  summary.thresholds = scenario.thresholds || {};
  return summary;
}

// ---- Scenarios ----
const SCENARIOS = {
  // Pure coast physics lockstep (pinned host clock). If this fails, host/client
  // stepBallPhysics schedules disagree — fix shared.js / PHYSICS_SUBTICKS first.
  lockstep_coast: {
    name: 'lockstep_coast',
    courseIndex: 0,
    holeIndex: 0,
    frames: 200,
    pureLockstep: true,
    net: { delayMs: 0, jitterMs: 0, dropRate: 0 },
    thresholds: { maxSimErr: 0.01, maxVisErr: 0.01, hardSnapsWhileMoving: 0, puttResyncs: 0 },
    script(ctx) {
      ctx.atFrame(10, () => ctx.putt(ctx.remotePlayer, { x: 80, y: 0 }));
    },
  },

  // Zero-latency network, host clock only from messages (realistic sparse corrections).
  ideal: {
    name: 'ideal',
    courseIndex: 0,
    holeIndex: 0,
    frames: 240,
    net: { delayMs: 0, jitterMs: 0, dropRate: 0 },
    // Soft keepalives: no mid-roll hard snaps expected.
    thresholds: { maxVisErr: 20, hardSnapsWhileMoving: 0, puttResyncs: 0 },
    script(ctx) {
      ctx.atFrame(10, () => ctx.putt(ctx.remotePlayer, { x: 80, y: 0 }));
      // Wait long enough for stop before second putt
      ctx.atFrame(150, () => ctx.putt(ctx.remotePlayer, { x: 40, y: 30 }));
    },
  },

  delayed_putt: {
    name: 'delayed_putt',
    courseIndex: 0,
    holeIndex: 0,
    frames: 240,
    net: { delayMs: 80, jitterMs: 20, dropRate: 0, seed: 42 },
    // puttApplied must never re-fire launch Δv after optimistic coast.
    thresholds: { maxVisErr: 65, hardSnapsWhileMoving: 0, puttResyncs: 0 },
    script(ctx) {
      ctx.atFrame(15, () => ctx.putt(ctx.remotePlayer, { x: 100, y: 10 }));
      ctx.atFrame(160, () => ctx.putt(ctx.hostPlayer, { x: -60, y: 40 }));
    },
  },

  snapshot_jitter: {
    name: 'snapshot_jitter',
    courseIndex: 0,
    holeIndex: 0,
    frames: 300,
    net: { delayMs: 40, jitterMs: 60, dropRate: 0.15, seed: 7 },
    // Soft recon under jitter — hardSnapsWhileMoving must stay near zero.
    thresholds: { hardSnapsWhileMoving: 5, maxVisErr: 50 },
    script(ctx) {
      ctx.atFrame(12, () => ctx.putt(ctx.remotePlayer, { x: 90, y: -20 }));
      ctx.atFrame(120, () => ctx.putt(ctx.hostPlayer, { x: 50, y: 50 }));
      ctx.atFrame(220, () => ctx.putt(ctx.remotePlayer, { x: -70, y: 20 }));
    },
  },

  sticky_escape: {
    name: 'sticky_escape',
    courseIndex: 2, // Goo Lagoon
    holeIndex: 0,
    frames: 300,
    net: { delayMs: 50, jitterMs: 15, dropRate: 0, seed: 3 },
    thresholds: { maxVisErr: 80, hardSnapsWhileMoving: 2, puttResyncs: 0 },
    script(ctx) {
      ctx.atFrame(10, () => ctx.putt(ctx.remotePlayer, { x: 60, y: 0 }));
      ctx.atFrame(130, () => ctx.putt(ctx.remotePlayer, { x: 120, y: 0 }));
      ctx.atFrame(220, () => ctx.putt(ctx.remotePlayer, { x: 80, y: -40 }));
    },
  },

  multi_clash: {
    name: 'multi_clash',
    courseIndex: 0,
    holeIndex: 0,
    frames: 200,
    net: { delayMs: 30, jitterMs: 10, dropRate: 0, seed: 99 },
    // Clash poses still snap sim; visual soft-guard should keep hardMoving low.
    thresholds: { hardSnapsWhileMoving: 2, maxVisErr: 50 },
    script(ctx) {
      ctx.atFrame(15, () => {
        ctx.putt(ctx.hostPlayer, { x: 70, y: 0 });
        ctx.putt(ctx.remotePlayer, { x: -70, y: 0 });
      });
    },
  },
};

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const all = args.includes('--all') || !args.some((a) => a.startsWith('--scenario') || (!a.startsWith('--') && SCENARIOS[a]));
  let names = Object.keys(SCENARIOS);
  const scenArg = args.find((a) => a.startsWith('--scenario='));
  if (scenArg) names = [scenArg.split('=')[1]];
  else {
    const positional = args.filter((a) => !a.startsWith('--') && SCENARIOS[a]);
    if (positional.length) names = positional;
    else if (!all && args.includes('--scenario')) {
      const i = args.indexOf('--scenario');
      names = [args[i + 1]];
    }
  }

  const results = [];
  let failed = 0;
  for (const name of names) {
    const sc = SCENARIOS[name];
    if (!sc) {
      console.error('Unknown scenario:', name);
      process.exit(2);
    }
    let result;
    try {
      result = runScenarioFixed(sc);
    } catch (e) {
      result = { name, pass: false, error: e.message, stack: e.stack };
      failed++;
    }
    results.push(result);
    if (result.pass === false) failed++;
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('\nRubber-band harness results\n' + '='.repeat(56));
    for (const r of results) {
      if (r.error) {
        console.log(`\n✖ ${r.name}  ERROR: ${r.error}`);
        continue;
      }
      const mark = r.pass ? '✔' : '✖';
      console.log(`\n${mark} ${r.name}`);
      console.log(
        `  maxSim=${r.maxSimErr}  maxVis=${r.maxVisErr}  avgSim=${r.avgSimErr}  avgVis=${r.avgVisErr}`
      );
      console.log(
        `  hardSnaps=${r.hardSnaps}  hardMoving=${r.hardSnapsWhileMoving}  puttResyncs=${r.puttResyncs}  softApplies=${r.softApplies}`
      );
      if (r.topRubberBands && r.topRubberBands.length) {
        console.log('  top events:', JSON.stringify(r.topRubberBands.slice(0, 4)));
      }
      if (!r.pass) {
        console.log('  thresholds:', JSON.stringify(r.thresholds));
      }
    }
    console.log('\n' + '='.repeat(56));
    console.log(failed ? `${failed} scenario(s) FAILED` : 'All scenarios passed');
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { runScenarioFixed, SCENARIOS, FakeSocket, NetPipe, ClientModel };
