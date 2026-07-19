#!/usr/bin/env node
/**
 * Client must simulate ball–ball like the host. Without it, remote putts phase
 * through local balls until a late hard clash snap (true_multi_snaps / dogfood).
 */
'use strict';

const assert = require('assert');
const Shared = require('../shared.js');
const { ClientModel } = require('./clientModel.js');

function main() {
  const hole = Shared.normalizeHole(JSON.parse(JSON.stringify(Shared.COURSES[0].holes[0])));
  const client = new ClientModel({ playerId: 'a' });
  client.playing = true;
  client.holeIndex = 0;
  client.simTick = 10;
  client.hostTick = 10;
  client.hostTickAtMs = 0;

  // Two balls side by side, a moving into b.
  client.players.set('a', {
    id: 'a',
    x: 200,
    y: 250,
    vx: 200,
    vy: 0,
    z: 0,
    vz: 0,
    strokes: 1,
    holedOut: false,
    errX: 0,
    errY: 0,
    rx: 200,
    ry: 250,
    dunks: 0,
  });
  client.players.set('b', {
    id: 'b',
    x: 200 + Shared.BALL_RADIUS * 2 - 1,
    y: 250,
    vx: 0,
    vy: 0,
    z: 0,
    vz: 0,
    strokes: 0,
    holedOut: false,
    errX: 0,
    errY: 0,
    rx: 200 + Shared.BALL_RADIUS * 2 - 1,
    ry: 250,
    dunks: 0,
  });

  const bBefore = client.players.get('b').vx;
  client.stepOneTick();
  const a = client.players.get('a');
  const b = client.players.get('b');
  // After clash, resting ball should pick up velocity (equal-mass exchange).
  assert.ok(b.vx > 20, 'resting ball should be hit: vx=' + b.vx + ' (before ' + bBefore + ')');
  assert.ok(a.vx < 200, 'moving ball should slow after clash: vx=' + a.vx);
  console.log(
    'client-ball-clash: ok (a.vx=' + a.vx.toFixed(1) + ' b.vx=' + b.vx.toFixed(1) + ')'
  );
}

main();
