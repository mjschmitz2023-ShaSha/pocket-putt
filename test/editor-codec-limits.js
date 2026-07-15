#!/usr/bin/env node
'use strict';
/**
 * Editor share-link limit clamps — values that still use i16 quantizers must be
 * rejected/clamped so the props UI never promises something encode will drop.
 */
const assert = require('assert');
const Shared = require('../shared.js');

const {
  clampEditorProp, clampObjectForCodec, clampCodecQF10, clampCodecQF100, clampCodecQCoord,
  CODEC_QF10_MAX, CODEC_QF100_MAX, CODEC_QCOORD_MAX, CODEC_QCOORD_STEP,
  encodeHole, decodeHole, blankHole, blackHole, boostRect, rampRect,
} = Shared;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e && e.message ? e.message : e);
    process.exitCode = 1;
  }
}

test('boost power clamps to qF10 max', () => {
  assert.strictEqual(clampEditorProp('boost', 'power', 99999), CODEC_QF10_MAX);
  assert.strictEqual(clampEditorProp('boost', 'power', -5), 0);
  assert.strictEqual(clampEditorProp('boost', 'power', 650), 650);
});

test('ramp minSpeed clamps to qF10 max', () => {
  assert.strictEqual(clampEditorProp('ramps', 'minSpeed', 50000), CODEC_QF10_MAX);
  assert.strictEqual(clampEditorProp('ramps', 'minSpeed', 300), 300);
});

test('angles/periods clamp to qF100 range', () => {
  assert.strictEqual(clampEditorProp('boost', 'angle', 999), CODEC_QF100_MAX);
  assert.ok(clampEditorProp('pendulums', 'period', 0) >= 0.01);
  assert.strictEqual(clampEditorProp('windmills', 'rotationSpeed', -9999), Shared.CODEC_QF100_MIN);
});

test('positions clamp to qCoord range', () => {
  assert.strictEqual(clampEditorProp('walls', 'x1', 99999), CODEC_QCOORD_MAX);
  assert.strictEqual(clampEditorProp('tee', 'x', 100.04), 100);
  assert.ok(Math.abs(clampEditorProp('tee', 'x', 100.06) - 100.1) < 1e-9);
});

test('gate amplitude is spatial (qCoord), pendulum amplitude is angular (qF100)', () => {
  assert.strictEqual(clampEditorProp('gates', 'amplitude', 99999), CODEC_QCOORD_MAX);
  assert.strictEqual(clampEditorProp('pendulums', 'amplitude', 99999), CODEC_QF100_MAX);
});

test('gravity mass/radius have no codec max (v3 f32), only positivity', () => {
  assert.strictEqual(clampEditorProp('gravityBodies', 'mass', 55000), 55000);
  assert.strictEqual(clampEditorProp('gravityBodies', 'radius', 0.4), 0.4);
  assert.ok(clampEditorProp('gravityBodies', 'radius', -1) > 0);
});

test('moon orbitRadius still qCoord-limited', () => {
  assert.strictEqual(clampEditorProp('gravityBodies', 'orbitRadius', 99999), CODEC_QCOORD_MAX);
});

test('clampObjectForCodec mutates boost power in place', () => {
  const z = boostRect(10, 10, 50, 50, 0.5, 99999);
  clampObjectForCodec('boost', z);
  assert.strictEqual(z.power, CODEC_QF10_MAX);
});

test('encode still accepts max legal boost power', () => {
  const h = blankHole({
    boost: [boostRect(100, 100, 160, 160, 0.25, CODEC_QF10_MAX)],
    ramps: [rampRect(200, 200, 260, 280, 0.1, CODEC_QF10_MAX)],
  });
  const d = decodeHole(encodeHole(h));
  assert.ok(d.ok, d.error);
  assert.ok(Math.abs(d.hole.boost[0].power - CODEC_QF10_MAX) < 0.15);
});

test('helpers match quantizer steps', () => {
  assert.strictEqual(CODEC_QCOORD_STEP, 0.1);
  assert.strictEqual(clampCodecQCoord(1.04), 1);
  assert.strictEqual(clampCodecQF10(12.04), 12);
  assert.strictEqual(clampCodecQF100(1.234), 1.23);
});

if (process.exitCode) {
  console.error('editor-codec-limits: FAILED');
  process.exit(1);
}
console.log('editor-codec-limits: %d tests passed', passed);
