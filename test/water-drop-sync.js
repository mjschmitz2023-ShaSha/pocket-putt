#!/usr/bin/env node
/**
 * Water drop pad must be deterministic across host/client.
 * Dogfood water_snaps.txt: dPos 37–68 at V=0 after water float (different drop slots).
 */
'use strict';

const assert = require('assert');
const Shared = require('../shared.js');
const { GameSession } = require('../gameSession.js');

function findWaterHole() {
  for (const c of Shared.COURSES) {
    for (let i = 0; i < c.holes.length; i++) {
      const h = Shared.normalizeHole(JSON.parse(JSON.stringify(c.holes[i])));
      if (h.water && h.water.length) return { courseIndex: Shared.COURSES.indexOf(c), holeIndex: i, hole: h };
    }
  }
  throw new Error('no water hole in COURSES');
}

function main() {
  const { hole } = findWaterHole();
  const zone = hole.water[0];

  // Sorted-id roster slots agree for any id set.
  const ids = ['b-id', 'a-id', 'c-id'];
  const sorted = ids.slice().sort();
  for (let dunks = 1; dunks <= 3; dunks++) {
    for (let s = 0; s < sorted.length; s++) {
      const idx = Shared.waterDropIndexFor(s, dunks);
      const drop = Shared.waterDropPointFor(zone, idx, hole);
      assert.ok(Number.isFinite(drop.x) && Number.isFinite(drop.y), 'drop finite');
    }
  }

  // Host waterDropSlot uses sorted connected ids.
  const session = new GameSession({ code: 'WATR' });
  // Minimal fake players
  const order = ['p-z', 'p-a', 'p-m'];
  for (const id of order) {
    session.players.set(id, {
      id,
      connected: true,
      ball: Shared.createBallState({ x: 100, y: 100 }),
      dunks: 1,
      floating: null,
      holedOut: false,
      strokes: 0,
    });
  }
  const slots = order.map((id) => session.waterDropSlot(session.players.get(id)));
  const expected = order.map((id) => order.slice().sort().indexOf(id));
  assert.deepStrictEqual(slots, expected, 'host slots sorted by id');

  // Same dunks+slot → identical drop (host formula).
  const dropA = Shared.waterDropPointFor(zone, Shared.waterDropIndexFor(0, 1), hole);
  const dropB = Shared.waterDropPointFor(zone, Shared.waterDropIndexFor(0, 1), hole);
  assert.strictEqual(dropA.x, dropB.x);
  assert.strictEqual(dropA.y, dropB.y);

  // dunks bump changes pad (why wire dunks matters).
  const d1 = Shared.waterDropPointFor(zone, Shared.waterDropIndexFor(0, 1), hole);
  const d2 = Shared.waterDropPointFor(zone, Shared.waterDropIndexFor(0, 2), hole);
  assert.ok(Math.hypot(d1.x - d2.x, d1.y - d2.y) > 1, 'dunk count moves drop pad');

  console.log('water-drop-sync: ok');
}

main();
