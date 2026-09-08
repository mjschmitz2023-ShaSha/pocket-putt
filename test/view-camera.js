'use strict';
const assert = require('assert');
const Shared = require('../shared.js');

const {
  LOGICAL_W, LOGICAL_H,
  BALL_RADIUS,
  viewCoverScale, viewContainScale, viewFitScale, viewBallScale, viewClampCenter,
  viewScreenToWorld, viewWorldToScreen, viewClampToRectEdge,
} = Shared;

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

console.log('view-camera');

test('landscape phone cover crops height and fills width', () => {
  const s = viewCoverScale(800, 360, LOGICAL_W, LOGICAL_H);
  assert.ok(Math.abs(s - 1) < 1e-9, 's=' + s);
  const c = viewContainScale(800, 360, LOGICAL_W, LOGICAL_H);
  assert.ok(c < s, 'contain is letterboxed');
});

test('follow scale is ball diameter in CSS px / logical diameter', () => {
  assert.strictEqual(BALL_RADIUS * 2, 14);
  assert.ok(Math.abs(viewBallScale(28, BALL_RADIUS) - 2) < 1e-9);
  assert.ok(Math.abs(viewBallScale(14, BALL_RADIUS) - 1) < 1e-9);
});

test('fit scale never crops the hole and never exceeds 1', () => {
  const landscape = viewFitScale(800, 360, LOGICAL_W, LOGICAL_H, 32);
  assert.ok(landscape <= 360 / LOGICAL_H);
  assert.ok(landscape < 1);
  const desktop = viewFitScale(1600, 1000, LOGICAL_W, LOGICAL_H, 32);
  assert.ok(Math.abs(desktop - 1) < 1e-9);
  const portrait = viewFitScale(390, 700, LOGICAL_W, LOGICAL_H, 28);
  assert.ok(portrait <= (390 - 56) / LOGICAL_W + 1e-9);
});

test('portrait phone cover crops width and fills height', () => {
  const s = viewCoverScale(390, 700, LOGICAL_W, LOGICAL_H);
  assert.ok(Math.abs(s - 700 / LOGICAL_H) < 1e-9);
});

test('clamp keeps the view inside the world when cropped', () => {
  const scale = 1;
  const atEdge = viewClampCenter(0, 0, scale, 800, 360, LOGICAL_W, LOGICAL_H);
  assert.ok(atEdge.x >= 400 - 1e-6);
  assert.ok(atEdge.y >= 180 - 1e-6);
  const center = viewClampCenter(400, 250, scale, 800, 360, LOGICAL_W, LOGICAL_H);
  assert.ok(Math.abs(center.x - 400) < 1e-6);
});

test('overview (contain) centers the world', () => {
  const scale = viewContainScale(800, 360, LOGICAL_W, LOGICAL_H);
  const c = viewClampCenter(10, 10, scale, 800, 360, LOGICAL_W, LOGICAL_H);
  assert.ok(Math.abs(c.x - LOGICAL_W / 2) < 1e-6);
  assert.ok(Math.abs(c.y - LOGICAL_H / 2) < 1e-6);
});

test('off-screen point projects onto the view edge toward the target', () => {
  const e = viewClampToRectEdge(200, 40, 20, 20, 180, 100, 100, 60);
  assert.ok(e);
  assert.ok(Math.abs(e.x - 180) < 1e-6);
  assert.ok(e.y > 20 && e.y < 100);
  assert.strictEqual(viewClampToRectEdge(50, 50, 20, 20, 180, 100, 100, 60), null);
});

test('corner-ward target lands on the first edge, not past a corner', () => {
  const e = viewClampToRectEdge(200, 200, 20, 20, 180, 100, 100, 60);
  assert.ok(e);
  assert.ok(Math.abs(e.y - 100) < 1e-6, 'hits bottom first');
  assert.ok(e.x > 20 && e.x < 180);
});

test('screen ↔ world round-trips through the camera', () => {
  const cam = { x: 400, y: 250, scale: 1.4, viewW: 390, viewH: 700 };
  const w = viewScreenToWorld(195, 350, cam);
  const s = viewWorldToScreen(w.x, w.y, cam);
  assert.ok(Math.abs(s.x - 195) < 1e-6);
  assert.ok(Math.abs(s.y - 350) < 1e-6);
  const mid = viewScreenToWorld(cam.viewW / 2, cam.viewH / 2, cam);
  assert.ok(Math.abs(mid.x - cam.x) < 1e-6);
  assert.ok(Math.abs(mid.y - cam.y) < 1e-6);
});

if (!process.exitCode) console.log('view-camera: ' + passed + ' passed');
else console.log('view-camera: FAILED');
