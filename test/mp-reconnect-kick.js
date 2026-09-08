'use strict';
/**
 * Guest refresh should reclaim the same player slot (reconnect token).
 * Host can kick a guest; that slot and token are gone.
 */
const assert = require('assert');
const { GameSession } = require('../gameSession.js');

function mockWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
    close() { this.readyState = 3; this.closed = true; },
  };
}

function test(name, fn) {
  try {
    fn();
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e && e.message ? e.message : e);
    process.exitCode = 1;
  }
}

test('addPlayer with reconnect token resumes the same id', () => {
  const session = new GameSession({ code: 'ROOM01' });
  const ws1 = mockWs();
  const first = session.addPlayer(ws1, { name: 'Guest', isLocal: false });
  assert.ok(first.player);
  assert.strictEqual(first.reconnected, false);
  const id = first.player.id;
  const token = first.player.reconnectToken;
  first.player.connected = false;

  const ws2 = mockWs();
  const again = session.addPlayer(ws2, {
    name: 'Guest',
    reconnectToken: token,
    isLocal: false,
  });
  assert.strictEqual(again.reconnected, true);
  assert.strictEqual(again.player.id, id);
  assert.strictEqual(session.players.size, 1);
  assert.strictEqual(again.player.ws, ws2);
  assert.strictEqual(again.player.connected, true);
});

test('requireReconnect with unknown token does not create a new player', () => {
  const session = new GameSession({ code: 'ROOM02' });
  const ws = mockWs();
  const r = session.addPlayer(
    ws,
    { name: 'Guest', reconnectToken: 'nope', isLocal: false },
    { requireReconnect: true }
  );
  assert.strictEqual(r.player, null);
  assert.strictEqual(r.error, 'bad_token');
  assert.strictEqual(session.players.size, 0);
});

test('host kick removes guest; old token cannot reclaim the slot', () => {
  const session = new GameSession({ code: 'ROOM03' });
  const hostWs = mockWs();
  const host = session.addPlayer(hostWs, { name: 'Host', isLocal: true }).player;
  const guestWs = mockWs();
  const guest = session.addPlayer(guestWs, { name: 'Guest', isLocal: false }).player;
  const token = guest.reconnectToken;
  const guestId = guest.id;
  assert.strictEqual(session.players.size, 2);

  const kicked = session.kickPlayer(host, guestId);
  assert.ok(kicked.ok);
  assert.strictEqual(session.players.size, 1);
  assert.ok(!session.players.has(guestId));
  assert.ok(guestWs.sent.some((m) => m.type === 'kicked'));
  assert.ok(hostWs.sent.some((m) => m.type === 'playerRemoved' && m.playerId === guestId));

  const ws3 = mockWs();
  const reclaim = session.addPlayer(
    ws3,
    { name: 'Guest', reconnectToken: token, isLocal: false },
    { requireReconnect: true }
  );
  assert.strictEqual(reclaim.player, null);
  assert.strictEqual(reclaim.error, 'bad_token');
  assert.strictEqual(session.players.size, 1);
});

test('non-host cannot kick', () => {
  const session = new GameSession({ code: 'ROOM04' });
  const host = session.addPlayer(mockWs(), { name: 'Host', isLocal: true }).player;
  const guest = session.addPlayer(mockWs(), { name: 'Guest', isLocal: false }).player;
  const r = session.kickPlayer(guest, host.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'not_host');
  assert.strictEqual(session.players.size, 2);
});

test('host cannot kick self', () => {
  const session = new GameSession({ code: 'ROOM05' });
  const host = session.addPlayer(mockWs(), { name: 'Host', isLocal: true }).player;
  const r = session.kickPlayer(host, host.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(session.players.size, 1);
});

test('kick message is ignored from a guest', () => {
  const session = new GameSession({ code: 'ROOM06' });
  const host = session.addPlayer(mockWs(), { name: 'Host', isLocal: true }).player;
  const guest = session.addPlayer(mockWs(), { name: 'Guest', isLocal: false }).player;
  session.handleMessage(guest, { type: 'kick', playerId: host.id });
  assert.strictEqual(session.players.size, 2);
});

if (!process.exitCode) console.log('mp-reconnect-kick: OK');
else console.log('mp-reconnect-kick: FAILED');
