'use strict';
/**
 * Production contract: the multi-room relay must serve the level editor UI
 * (not only index/game). Asserts the shipped allowlist and live HTTP 200s.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELAY_SRC = path.join(ROOT, 'relay.js');

function extractStaticFiles(src) {
  const m = src.match(/const STATIC_FILES = \[([\s\S]*?)\];/);
  assert.ok(m, 'STATIC_FILES array not found in relay.js');
  const names = [];
  const re = /'([^']+)'/g;
  let hit;
  while ((hit = re.exec(m[1]))) names.push(hit[1]);
  return names;
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout ' + urlPath));
    });
  });
}

function waitForHealth(port, attempts) {
  attempts = attempts || 40;
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < attempts; i++) {
      try {
        const code = await httpGet(port, '/health');
        if (code === 200) return resolve();
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    reject(new Error('relay health never became ready'));
  });
}

async function main() {
  const src = fs.readFileSync(RELAY_SRC, 'utf8');
  const files = extractStaticFiles(src);
  console.log('STATIC_FILES:', files.join(', '));

  for (const need of ['index.html', 'game.js', 'shared.js', 'portal-gravity.js', 'share-level.js', 'draw.js', 'style.css', 'editor.html', 'editor.js', 'editor-snap.js', 'editor-gizmos.js', 'editor.css', 'path-trace.html', 'path-trace-viewer.js', 'mp-recon.js']) {
    assert.ok(files.includes(need), `relay STATIC_FILES missing ${need}`);
    assert.ok(fs.existsSync(path.join(ROOT, need)), `file missing on disk: ${need}`);
  }

  // Live boot: random high port
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['relay.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', () => {});

  try {
    await waitForHealth(port);
    const checks = [
      '/',
      '/index.html',
      '/editor.html',
      '/editor.js',
      '/editor-snap.js',
      '/editor.css',
      '/game.js',
      '/shared.js',
      '/share-level.js',
      '/draw.js',
      '/style.css',
    ];
    for (const p of checks) {
      const code = await httpGet(port, p);
      console.log('GET', p, code);
      assert.strictEqual(code, 200, `${p} expected 200 got ${code}`);
    }
    console.log('relay-static-files: OK (allowlist + live HTTP 200)');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      child.on('exit', r);
      setTimeout(r, 500);
    });
  }
  if (stderr && /Error|EADDRINUSE/.test(stderr)) {
    console.error(stderr);
  }
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
