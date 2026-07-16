'use strict';
/**
 * Short-link expand: pure helpers + live TinyURL expand for a known long level.
 * Network tests skip cleanly if offline.
 */
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const Shared = require('../shared.js');

const ROOT = path.join(__dirname, '..');

function mainHelpers() {
  assert.strictEqual(
    Shared.extractLvlFromUrl('https://www.pocketputt.net/index.html?lvl=ABC123&x=1'),
    'ABC123'
  );
  assert.strictEqual(Shared.extractLvlFromUrl('https://example.com/'), null);

  const html =
    '<html><head><meta http-equiv="refresh" content="0;url=\'https://www.pocketputt.net/index.html?lvl=ZZZ\'" /></head></html>';
  const next = Shared.extractRedirectFromHtml(html, 'https://tinyurl.com/preview/x');
  assert.ok(next && next.includes('lvl=ZZZ'), 'meta refresh parse');
  assert.strictEqual(Shared.extractLvlFromUrl(next), 'ZZZ');

  console.log('expand-lvl-short helpers: OK');
}

async function liveExpandViaRelay() {
  // Known TinyURL for a real custom hole (Starry Night) — preview/deprecated path.
  const alias = '23457qff';
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['relay.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: urlPath, timeout: 20000 }, (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        })
        .on('error', reject);
    });
  }

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const h = await get('/health');
        if (h.status === 200) break;
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const res = await get('/api/expand-lvl-short?alias=' + encodeURIComponent(alias));
    assert.strictEqual(res.status, 200, 'expand status ' + res.status + ' body=' + res.body.slice(0, 200));
    const data = JSON.parse(res.body);
    assert.ok(data.ok, 'expand ok: ' + res.body.slice(0, 300));
    assert.ok(typeof data.lvl === 'string' && data.lvl.length > 100, 'lvl payload length');
    const decoded = Shared.decodeHole(data.lvl);
    assert.ok(decoded.ok, 'decoded level: ' + (decoded.error || ''));
    assert.ok(
      /starry/i.test(decoded.hole.name || '') || decoded.hole.name,
      'has a hole name: ' + decoded.hole.name
    );
    console.log(
      'expand-lvl-short live: OK via=' +
        data.via +
        ' name=' +
        decoded.hole.name +
        ' lvlLen=' +
        data.lvl.length
    );
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      child.on('exit', r);
      setTimeout(r, 500);
    });
    if (stderr && /Error/.test(stderr)) console.error(stderr.slice(0, 400));
  }
}

async function main() {
  mainHelpers();
  try {
    await liveExpandViaRelay();
  } catch (e) {
    if (/fetch|ECONN|ENOTFOUND|network|timed out/i.test(String(e))) {
      console.log('expand-lvl-short live: SKIPPED (network):', e.message || e);
      return;
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
