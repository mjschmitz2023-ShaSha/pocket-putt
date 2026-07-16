'use strict';
/**
 * Share-link helpers: long ?lvl= / short ?lvl_short= + TinyURL alias parsing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Shared = require('../shared.js');

const {
  isValidTinyAlias,
  extractTinyAlias,
  gameEntryUrl,
  buildLongLevelUrl,
  buildShortLevelUrl,
  tinyurlExpandUrl,
  LVL_PARAM,
  LVL_SHORT_PARAM,
  blankHole,
  encodeHole,
} = Shared;

function main() {
  assert.strictEqual(isValidTinyAlias('22zr25g5'), true);
  assert.strictEqual(isValidTinyAlias('ab'), true);
  assert.strictEqual(isValidTinyAlias('a'), false);
  assert.strictEqual(isValidTinyAlias('../evil'), false);
  assert.strictEqual(isValidTinyAlias('has space'), false);
  assert.strictEqual(isValidTinyAlias('https://evil.com'), false);
  assert.strictEqual(isValidTinyAlias(''), false);

  assert.strictEqual(extractTinyAlias('https://tinyurl.com/22zr25g5'), '22zr25g5');
  assert.strictEqual(extractTinyAlias('http://tinyurl.com/peakb'), 'peakb');
  assert.strictEqual(extractTinyAlias('https://www.tinyurl.com/abc_12-3'), 'abc_12-3');
  assert.strictEqual(extractTinyAlias('https://tinyurl.com/abc/extra'), null);
  assert.strictEqual(extractTinyAlias('not a url'), null);

  const base = 'https://pocketputt.net/editor.html';
  const entry = gameEntryUrl(base);
  assert.ok(/index\.html$/i.test(entry.pathname) || entry.pathname.endsWith('/'), 'editor → game entry');
  assert.strictEqual(entry.search, '');

  const rootEntry = gameEntryUrl('https://pocketputt.net/');
  assert.strictEqual(rootEntry.origin, 'https://pocketputt.net');

  const hole = blankHole({ name: 'Share Test', par: 2 });
  const lvl = encodeHole(hole);
  const longUrl = buildLongLevelUrl(lvl, 'https://pocketputt.net/');
  const long = new URL(longUrl);
  assert.strictEqual(long.searchParams.get(LVL_PARAM), lvl);
  assert.strictEqual(long.searchParams.get(LVL_SHORT_PARAM), null);

  const shortUrl = buildShortLevelUrl('22zr25g5', 'https://pocketputt.net/');
  const short = new URL(shortUrl);
  assert.strictEqual(short.searchParams.get(LVL_SHORT_PARAM), '22zr25g5');
  assert.strictEqual(short.searchParams.get(LVL_PARAM), null);
  assert.ok(shortUrl.length < longUrl.length, 'short share URL is shorter than long');

  assert.strictEqual(tinyurlExpandUrl('22zr25g5'), 'https://tinyurl.com/22zr25g5');
  assert.throws(() => buildShortLevelUrl('bad alias'), /invalid/i);
  assert.throws(() => tinyurlExpandUrl('x'), /invalid/i);
  assert.throws(() => buildLongLevelUrl(''), /missing/i);

  // Wiring: game + editor load share-level.js; relay serves it
  const root = path.join(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const editorHtml = fs.readFileSync(path.join(root, 'editor.html'), 'utf8');
  const relaySrc = fs.readFileSync(path.join(root, 'relay.js'), 'utf8');
  assert.ok(/share-level\.js/.test(indexHtml), 'index.html loads share-level.js');
  assert.ok(/share-level\.js/.test(editorHtml), 'editor.html loads share-level.js');
  assert.ok(/['"]share-level\.js['"]/.test(relaySrc), 'relay serves share-level.js');
  const iShared = indexHtml.indexOf('shared.js');
  const iShare = indexHtml.indexOf('share-level.js');
  const iGame = indexHtml.indexOf('game.js');
  assert.ok(iShared >= 0 && iShare > iShared && iGame > iShare, 'index: shared → share-level → game');

  // Polished modal markup present in both shells (Import-style centered card).
  for (const [name, html] of [['index', indexHtml], ['editor', editorHtml]]) {
    assert.ok(/id="share-modal"/.test(html), name + ' has #share-modal');
    assert.ok(/class="[^"]*pp-modal/.test(html), name + ' uses pp-modal shell');
    assert.ok(/id="btn-share-short"/.test(html) && /id="btn-share-long"/.test(html), name + ' has short/long copy actions');
    assert.ok(/id="share-modal-url"/.test(html), name + ' has URL preview field');
  }

  console.log('share-level: OK');
}

main();
