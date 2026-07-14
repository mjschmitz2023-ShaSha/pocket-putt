'use strict';
/**
 * Structural + pure checks for the 15s emergency tee respawn.
 * (DOM click is manual/Playwright; here we lock host message handling + shared helpers.)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Shared = require('../shared.js');
const { GameSession } = require('../gameSession.js');

const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL  ' + name);
    console.error('    ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

console.log('respawn-offer');

test('client uses 15s unsettled threshold', () => {
  assert.ok(/RESPAWN_OFFER_SEC\s*=\s*15/.test(gameSrc));
});

test('client has soft-correction grace after local respawn', () => {
  assert.ok(/RESPAWN_SOFT_GRACE_MS/.test(gameSrc));
  assert.ok(/respawnSoftGraceUntil/.test(gameSrc));
  assert.ok(/selfRespawnGrace/.test(gameSrc));
});

test('respawn offer stacks above canvas', () => {
  assert.ok(/#respawn-offer[\s\S]{0,200}z-index:\s*30/.test(styleSrc));
  assert.ok(/canvas#game[\s\S]{0,120}z-index:\s*0/.test(styleSrc) || /z-index:\s*0/.test(styleSrc));
});

test('host respawn moves ball to tee slot with zero velocity', () => {
  const session = new GameSession({ code: 'TEST' });
  // Minimal fake player
  const hole = Shared.blankHole({
    tee: { x: 100, y: 200 },
    cup: { x: 700, y: 250, radius: 11 },
  });
  session.customHole = hole;
  session.state = 'PLAYING';
  const player = {
    id: 'p1',
    ws: null,
    name: 'T',
    connected: true,
    isLocal: true,
    holedOut: false,
    strokes: 3,
    ball: Shared.createBallState({ x: 400, y: 250 }),
    speedTracker: Shared.createSpeedAvgTracker(),
    perHoleScores: [],
    totalScore: 0,
  };
  player.ball.vx = 300;
  player.ball.vy = -80;
  session.players.set(player.id, player);
  session.hostPlayerId = player.id;

  const msgs = [];
  session.broadcast = (msg) => { msgs.push(msg); };
  session.broadcastReliable = (msg) => { msgs.push(msg); };

  session.handleMessage(player, { type: 'respawn' });

  assert.ok(Math.abs(player.ball.x - 100) < 1e-6, 'x at tee');
  assert.ok(Math.abs(player.ball.y - 200) < 1e-6, 'y at tee');
  assert.strictEqual(player.ball.vx, 0);
  assert.strictEqual(player.ball.vy, 0);
  assert.strictEqual(player.strokes, 3, 'no stroke penalty');
  assert.ok(msgs.some((m) => m && m.type === 'snapshot' && m.hard === true && m.reason === 'resync'),
    'hard resync broadcast');
});

test('host ignores respawn when not playing', () => {
  const session = new GameSession({ code: 'TEST2' });
  session.state = 'WAITING_FOR_PLAYERS';
  const player = {
    id: 'p2',
    ball: Shared.createBallState({ x: 10, y: 10 }),
    holedOut: false,
  };
  player.ball.vx = 50;
  session.players.set(player.id, player);
  session.handleMessage(player, { type: 'respawn' });
  assert.strictEqual(player.ball.vx, 50, 'unchanged');
});

if (!process.exitCode) console.log('respawn-offer: ' + passed + ' passed');
else console.log('respawn-offer: FAILED');
