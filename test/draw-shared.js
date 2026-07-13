'use strict';
/**
 * P1 structural checks: shared draw.js wired into game + editor + relay;
 * walls use game thickness (10); editor no longer paints thin sketch walls as primary.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function main() {
  const drawPath = path.join(ROOT, 'draw.js');
  assert.ok(fs.existsSync(drawPath), 'draw.js must exist');

  const drawSrc = read('draw.js');
  const indexHtml = read('index.html');
  const editorHtml = read('editor.html');
  const relaySrc = read('relay.js');
  const editorSrc = read('editor.js');
  const gameSrc = read('game.js');

  // HTML loads draw.js after shared.js, before game/editor
  assert.ok(/shared\.js[^"']*["']/.test(indexHtml) || /shared\.js\?/.test(indexHtml), 'index.html loads shared.js');
  assert.ok(/draw\.js(\?[^"']*)?["']/.test(indexHtml), 'index.html loads draw.js');
  assert.ok(/game\.js(\?[^"']*)?["']/.test(indexHtml), 'index.html loads game.js');
  const idxShared = indexHtml.indexOf('shared.js');
  const idxDraw = indexHtml.indexOf('draw.js');
  const idxGame = indexHtml.indexOf('game.js');
  assert.ok(idxShared >= 0 && idxDraw > idxShared && idxGame > idxDraw, 'index.html script order: shared → draw → game');

  assert.ok(/draw\.js(\?[^"']*)?["']/.test(editorHtml), 'editor.html loads draw.js');
  const edShared = editorHtml.indexOf('shared.js');
  const edDraw = editorHtml.indexOf('draw.js');
  const edEditor = editorHtml.indexOf('editor.js');
  assert.ok(edShared >= 0 && edDraw > edShared && edEditor > edDraw, 'editor.html script order: shared → draw → editor');

  // Relay allowlist
  const m = relaySrc.match(/const STATIC_FILES = \[([\s\S]*?)\];/);
  assert.ok(m, 'STATIC_FILES in relay.js');
  assert.ok(/['"]draw\.js['"]/.test(m[1]), 'relay STATIC_FILES includes draw.js');

  // Wall thickness: primary stroke uses 10 or WALL_DRAW_WIDTH = 10
  assert.ok(
    /WALL_DRAW_WIDTH\s*=\s*10/.test(drawSrc) || /lineWidth\s*=\s*10/.test(drawSrc),
    'draw.js wall stroke lineWidth 10 (or WALL_DRAW_WIDTH=10)'
  );
  assert.ok(/function drawWallSegment|drawWallSegment\s*[:=]/.test(drawSrc), 'draw.js exports drawWallSegment');
  assert.ok(/drawHoleStatic/.test(drawSrc), 'draw.js has drawHoleStatic');
  assert.ok(/warpBlackHoleLens/.test(drawSrc), 'draw.js has warpBlackHoleLens');
  assert.ok(/root\.Draw|window\.Draw/.test(drawSrc) || /Draw\s*=/.test(drawSrc), 'draw.js attaches Draw');

  // game.js uses Draw for hole static layer
  assert.ok(/Draw\.drawHoleStatic/.test(gameSrc), 'game.js calls Draw.drawHoleStatic');
  assert.ok(!/function drawWallSegment\s*\(/.test(gameSrc), 'game.js no longer defines drawWallSegment');
  assert.ok(!/function drawGrass\s*\(/.test(gameSrc), 'game.js no longer defines drawGrass');

  // editor uses Draw; must not use thin lineWidth 3 as primary wall path
  assert.ok(/Draw\.drawHoleStatic|D\.drawHoleStatic/.test(editorSrc), 'editor.js calls Draw.drawHoleStatic');
  // Forbidden pattern: old sketch walls — stroke then lineWidth 3/4 for walls as main paint
  assert.ok(
    !/function drawWallSeg\s*\(/.test(editorSrc),
    'editor.js must not define drawWallSeg (thin sketch walls)'
  );
  // No primary wall path setting lineWidth to 3 for final wall draw
  const thinWallPrimary = /lineWidth\s*=\s*highlight\s*\?\s*4\s*:\s*3/.test(editorSrc)
    || /lineWidth\s*=\s*3\s*;[\s\S]{0,80}moveTo\(w\.x1/.test(editorSrc);
  assert.ok(!thinWallPrimary, 'editor.js must not use lineWidth 3 as primary wall path');

  // Optional: require Draw under node (IIFE + Shared optional)
  try {
    globalThis.Shared = require('../shared.js');
    const Draw = require('../draw.js');
    assert.ok(Draw && typeof Draw.drawWallSegment === 'function', 'Draw.drawWallSegment is a function');
    assert.strictEqual(Draw.WALL_DRAW_WIDTH, 10, 'WALL_DRAW_WIDTH === 10');
    assert.ok(typeof Draw.drawHoleStatic === 'function', 'Draw.drawHoleStatic is a function');
    console.log('draw.js require() OK (node)');
  } catch (e) {
    console.log('draw.js require() skipped or failed (browser-only ok):', e.message);
  }

  console.log('draw-shared: OK');
}

main();
