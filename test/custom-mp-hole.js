'use strict';
/**
 * Multiplayer custom hole: GameSession stores/broadcasts/clears a single validated hole.
 * Uses real GameSession + Shared codec (no fake protocol).
 */
const assert = require('assert');
const Shared = require('../shared.js');
const { GameSession } = require('../gameSession.js');

function mockWs() {
  const sent = [];
  return {
    readyState: 1, // OPEN
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
  };
}

function addHost(session) {
  const ws = mockWs();
  // Minimal join path — GameSession join API
  const player = {
    id: 'host1',
    name: 'Host',
    ws,
    connected: true,
    isLocal: true,
    hue: 0,
    ball: null,
    strokes: 0,
    holedOut: false,
    totalScore: 0,
    holeScores: [],
    styled: false,
  };
  session.players.set(player.id, player);
  session.hostPlayerId = player.id;
  return { player, ws };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e);
    process.exitCode = 1;
  }
}

test('setCustomHole stores hole and lobby includes customLvl', () => {
  const session = new GameSession({ code: 'TEST01' });
  const { player, ws } = addHost(session);
  const hole = Shared.blankHole({ name: 'MP Custom', par: 3, walls: [Shared.wall(100, 100, 100, 200)] });
  const lvl = Shared.encodeHole(hole);
  session.handleMessage(player, { type: 'setCustomHole', lvl });
  assert.ok(session.customHole);
  assert.strictEqual(session.customHole.name, 'MP Custom');
  assert.strictEqual(session.currentHoles().length, 1);
  // broadcastLobbyState was called — find last lobbyState
  const lobbies = ws.sent.filter((m) => m.type === 'lobbyState');
  assert.ok(lobbies.length >= 1);
  const last = lobbies[lobbies.length - 1];
  assert.strictEqual(last.hasCustomHole, true);
  assert.strictEqual(last.customHoleName, 'MP Custom');
  assert.ok(typeof last.customLvl === 'string' && last.customLvl.length > 0);
  const decoded = Shared.decodeHole(last.customLvl);
  assert.ok(decoded.ok);
  assert.strictEqual(decoded.hole.walls.length, 1);
});

test('selectCourse clears custom hole', () => {
  const session = new GameSession({ code: 'TEST02' });
  const { player } = addHost(session);
  const lvl = Shared.encodeHole(Shared.blankHole({ name: 'X' }));
  session.handleMessage(player, { type: 'setCustomHole', lvl });
  assert.ok(session.customHole);
  session.handleMessage(player, { type: 'selectCourse', courseIndex: 0 });
  assert.strictEqual(session.customHole, null);
  assert.ok(session.currentHoles().length > 1);
});

test('clearCustomHole clears', () => {
  const session = new GameSession({ code: 'TEST03' });
  const { player } = addHost(session);
  session.handleMessage(player, { type: 'setCustomHole', lvl: Shared.encodeHole(Shared.blankHole()) });
  session.handleMessage(player, { type: 'clearCustomHole' });
  assert.strictEqual(session.customHole, null);
});

test('rejects garbage custom hole', () => {
  const session = new GameSession({ code: 'TEST04' });
  const { player, ws } = addHost(session);
  session.handleMessage(player, { type: 'setCustomHole', lvl: '!!!bad!!!' });
  assert.strictEqual(session.customHole, null);
  assert.ok(ws.sent.some((m) => m.type === 'notice'));
});

test('startRound without courseIndex keeps custom; with courseIndex clears', () => {
  const session = new GameSession({ code: 'TEST05' });
  const { player } = addHost(session);
  session.handleMessage(player, { type: 'setCustomHole', lvl: Shared.encodeHole(Shared.blankHole({ name: 'Keep' })) });
  session.state = 'WAITING_FOR_PLAYERS';
  assert.ok(session.customHole);
  // startRound without courseIndex should keep custom and begin the round
  session.handleMessage(player, { type: 'startRound' });
  assert.ok(session.customHole);
  assert.strictEqual(session.customHole.name, 'Keep');
  assert.strictEqual(session.currentHoles().length, 1);
  // End to lobby-like state for next assertion
  session.state = 'WAITING_FOR_PLAYERS';
  session.handleMessage(player, { type: 'startRound', courseIndex: 1 });
  assert.strictEqual(session.customHole, null);
});

test('room and lvl remain independent encode fields', () => {
  // Structural: encodeHole never embeds room codes
  const lvl = Shared.encodeHole(Shared.blankHole({ name: 'RoomFree' }));
  assert.ok(!lvl.includes('room'));
  const params = new URLSearchParams();
  params.set('room', 'ABCDEF');
  params.set('lvl', lvl);
  assert.strictEqual(params.get('room'), 'ABCDEF');
  assert.strictEqual(params.get('lvl'), lvl);
  assert.ok(Shared.decodeHole(params.get('lvl')).ok);
});

test('late joiner receives customLvl via lobby broadcast (no lvl URL needed)', () => {
  const session = new GameSession({ code: 'JOIN01', joinUrl: '/?room=JOIN01' });
  const host = addHost(session);
  const lvl = Shared.encodeHole(Shared.blankHole({ name: 'ForJoiners', par: 2 }));
  session.handleMessage(host.player, { type: 'setCustomHole', lvl });

  // Second player joins after custom is set — real addPlayer path.
  const joinerWs = mockWs();
  const added = session.addPlayer(joinerWs, { name: 'Friend', isLocal: false });
  assert.ok(added.player);
  // Welcome + lobbyState should include customLvl for the joiner (and broadcast).
  const lobbyMsgs = joinerWs.sent.filter((m) => m.type === 'lobbyState');
  assert.ok(lobbyMsgs.length >= 1, 'joiner should get lobbyState');
  const last = lobbyMsgs[lobbyMsgs.length - 1];
  assert.strictEqual(last.hasCustomHole, true);
  assert.ok(last.customLvl, 'customLvl present for room-only joiner');
  const d = Shared.decodeHole(last.customLvl);
  assert.ok(d.ok);
  assert.strictEqual(d.hole.name, 'ForJoiners');
});

test('production play path source has no localSolo flag', () => {
  const fs = require('fs');
  const path = require('path');
  const gameSrc = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
  assert.ok(!/\blocalSolo\b/.test(gameSrc), 'game.js must not define localSolo');
  assert.ok(!/\bmpActive\b/.test(gameSrc), 'game.js must not define mpActive');
  assert.ok(/function playCustomInRoom/.test(gameSrc));
  assert.ok(/mpSendCreateRoom/.test(gameSrc));
  // On MULTIPLAYER, playCustomInRoom must create a room (not startGame first).
  const fn = gameSrc.match(/function playCustomInRoom\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'playCustomInRoom body');
  assert.ok(/mpSendCreateRoom/.test(fn[0]));
  assert.ok(/if \(!MULTIPLAYER\)/.test(fn[0]), 'file:// offline only under !MULTIPLAYER');
});

if (process.exitCode) {
  console.error('custom-mp-hole: FAILED');
  process.exit(1);
}
console.log('custom-mp-hole: %d tests passed', passed);
