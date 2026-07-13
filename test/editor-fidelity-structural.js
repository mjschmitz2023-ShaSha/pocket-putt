'use strict';
/**
 * P6 structural contracts for editor fidelity packs P1–P5.
 * Source-file assertions only (no pixel flakiness). Complements unit tests
 * (snap/phase/gizmos/test-physics) and draw-shared / relay-static suites.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function extractStaticFiles(src) {
  const m = src.match(/const STATIC_FILES = \[([\s\S]*?)\];/);
  assert.ok(m, 'STATIC_FILES array not found in relay.js');
  const names = [];
  const re = /'([^']+)'/g;
  let hit;
  while ((hit = re.exec(m[1]))) names.push(hit[1]);
  return names;
}

/** First occurrence index of a script path (allows ?query). */
function scriptIndex(html, file) {
  const re = new RegExp(file.replace('.', '\\.') + '(\\?[^"\']*)?["\']');
  const m = html.match(re);
  return m ? html.indexOf(m[0]) : -1;
}

function main() {
  console.log('editor-fidelity-structural (P6)');

  const indexHtml = read('index.html');
  const editorHtml = read('editor.html');
  const relaySrc = read('relay.js');
  const gameSrc = read('game.js');
  const editorSrc = read('editor.js');
  const gizmosSrc = read('editor-gizmos.js');
  const snapSrc = read('editor-snap.js');

  // --- HTML load order ---
  // index: shared → draw → game
  const iShared = scriptIndex(indexHtml, 'shared.js');
  const iDraw = scriptIndex(indexHtml, 'draw.js');
  const iGame = scriptIndex(indexHtml, 'game.js');
  assert.ok(iShared >= 0, 'index.html loads shared.js');
  assert.ok(iDraw > iShared, 'index.html: draw.js after shared.js');
  assert.ok(iGame > iDraw, 'index.html: game.js after draw.js');

  // editor: shared → draw → snap → gizmos → editor
  const eShared = scriptIndex(editorHtml, 'shared.js');
  const eDraw = scriptIndex(editorHtml, 'draw.js');
  const eSnap = scriptIndex(editorHtml, 'editor-snap.js');
  const eGiz = scriptIndex(editorHtml, 'editor-gizmos.js');
  const eEd = scriptIndex(editorHtml, 'editor.js');
  assert.ok(eShared >= 0, 'editor.html loads shared.js');
  assert.ok(eDraw > eShared, 'editor.html: draw.js after shared.js');
  assert.ok(eSnap > eDraw, 'editor.html: editor-snap.js after draw.js');
  assert.ok(eGiz > eSnap, 'editor.html: editor-gizmos.js after editor-snap.js');
  assert.ok(eEd > eGiz, 'editor.html: editor.js after snap/gizmos');

  // --- Relay STATIC_FILES ---
  const staticFiles = extractStaticFiles(relaySrc);
  for (const need of [
    'draw.js',
    'editor.html',
    'editor.js',
    'editor.css',
    'editor-snap.js',
    'editor-gizmos.js',
  ]) {
    assert.ok(staticFiles.includes(need), `relay STATIC_FILES includes ${need}`);
    assert.ok(fs.existsSync(path.join(ROOT, need)), `file on disk: ${need}`);
  }

  // --- game.js + editor.js use Draw ---
  assert.ok(
    /Draw\.drawHoleStatic/.test(gameSrc) || /\bDraw\./.test(gameSrc),
    'game.js calls Draw.drawHoleStatic (or Draw.*)'
  );
  assert.ok(
    /Draw\.drawHoleStatic|D\.drawHoleStatic/.test(editorSrc) || /\bDraw\./.test(editorSrc),
    'editor.js calls Draw.drawHoleStatic (or Draw.*)'
  );

  // --- editor.js: edit-mode movers advance ---
  // loop: else branch (not test mode) calls advanceHoleObstacles
  assert.ok(
    /advanceHoleObstacles\s*\(\s*hole\s*,\s*dt\s*\)/.test(editorSrc),
    'editor.js calls advanceHoleObstacles(hole, dt)'
  );
  // Explicit edit-mode path: mode !== test → advance (comment and/or structure)
  const editAdvance =
    /else\s*\{[\s\S]{0,200}advanceHoleObstacles\s*\(\s*hole/.test(editorSrc)
    || /mode\s*===\s*['"]edit['"][\s\S]{0,120}advanceHoleObstacles/.test(editorSrc)
    || /P2:[\s\S]{0,80}advanceHoleObstacles/.test(editorSrc)
    || /in edit mode[\s\S]{0,80}advanceHoleObstacles|advanceHoleObstacles[\s\S]{0,80}edit mode/i.test(editorSrc);
  assert.ok(editAdvance, 'editor.js advances movers in edit mode (not only test)');

  // --- Freeze only while drag-aiming (testDrag.active), not whole AIMING rest ---
  assert.ok(/testState\s*===\s*['"]AIMING['"]/.test(editorSrc), 'editor.js has AIMING testState checks');
  assert.ok(/testDrag\.active/.test(editorSrc), 'editor.js tracks active aim drag');
  assert.ok(
    /freezeMovers/.test(editorSrc)
      || /testDrag\.active[\s\S]{0,200}advanceHoleObstacles/.test(editorSrc)
      || /hold obstacle clock for ghost/i.test(editorSrc),
    'editor.js freezes movers only while drag-aiming for ghost path'
  );
  assert.ok(
    /BALL_MOVING[\s\S]{0,200}advanceHoleObstacles/.test(editorSrc),
    'editor.js advances movers while ball rolling'
  );

  // --- Ghost trajectory freezes movers ---
  assert.ok(
    /simulateTrajectory\s*\(/.test(editorSrc),
    'editor.js calls simulateTrajectory'
  );
  assert.ok(
    /advanceMovers\s*:\s*false/.test(editorSrc),
    'editor.js simulateTrajectory uses advanceMovers: false'
  );

  // --- editor-gizmos exports ---
  assert.ok(/function\s+getHandles\s*\(/.test(gizmosSrc) || /getHandles\s*[:=]\s*function/.test(gizmosSrc),
    'editor-gizmos.js defines getHandles');
  assert.ok(/function\s+applyHandleDrag\s*\(/.test(gizmosSrc) || /applyHandleDrag\s*[:=]\s*function/.test(gizmosSrc),
    'editor-gizmos.js defines applyHandleDrag');
  assert.ok(/function\s+hitTestHandles\s*\(/.test(gizmosSrc) || /hitTestHandles\s*[:=]\s*function/.test(gizmosSrc),
    'editor-gizmos.js defines hitTestHandles');
  // Public surface (export object)
  assert.ok(/\bgetHandles\b/.test(gizmosSrc) && /\bapplyHandleDrag\b/.test(gizmosSrc) && /\bhitTestHandles\b/.test(gizmosSrc),
    'editor-gizmos.js exports getHandles/applyHandleDrag/hitTestHandles');

  // --- editor-snap exports ---
  assert.ok(/function\s+snapPoint\s*\(/.test(snapSrc) || /snapPoint\s*[:=]\s*function/.test(snapSrc),
    'editor-snap.js defines snapPoint');
  assert.ok(/function\s+collectSnapPoints\s*\(/.test(snapSrc) || /collectSnapPoints\s*[:=]\s*function/.test(snapSrc),
    'editor-snap.js defines collectSnapPoints');
  assert.ok(/\bsnapPoint\b/.test(snapSrc) && /\bcollectSnapPoints\b/.test(snapSrc),
    'editor-snap.js exports snapPoint/collectSnapPoints');

  // --- no localSolo in game.js ---
  assert.ok(!/\blocalSolo\b/.test(gameSrc), 'game.js must not contain localSolo');

  console.log('editor-fidelity-structural: OK');
}

main();
