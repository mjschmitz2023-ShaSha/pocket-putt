#!/usr/bin/env node
/**
 * Headless draw-perf harness (Playwright).
 *
 * Opens perf-draw.html, runs the suite (classic grass vs Orbit space vs BH lens),
 * prints a readable report + writes JSON.
 *
 * Usage:
 *   npm run test:perf-draw
 *   PERF_DRAW_DPR=3 PERF_DRAW_FRAMES=120 npm run test:perf-draw
 *   PERF_DRAW_HEADED=1 npm run test:perf-draw
 *
 * Does not fail the build on "too slow" (hardware varies) — only on harness errors.
 * Exit 2 if suite payload missing; print WARN if lens_warp is not top on BH case
 * (unexpected after optimizations, not a hard fail).
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-perf-draw');
const OUT_JSON = path.join(OUT_DIR, 'report.json');
const HEADED = process.env.PERF_DRAW_HEADED === '1';
const FRAMES = Math.max(20, Number(process.env.PERF_DRAW_FRAMES) || 60);
const WARMUP = Math.max(0, Number(process.env.PERF_DRAW_WARMUP) || 12);
const DPR = Number(process.env.PERF_DRAW_DPR) || 2;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function startStaticServer(port) {
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
  };
  return http.createServer((req, res) => {
    let urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/') urlPath = '/perf-draw.html';
    const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  }).listen(port, '127.0.0.1');
}

async function ensurePlaywright() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.log('Installing playwright…');
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '--no-save', 'playwright@1.49.1'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
    });
    ({ chromium } = require('playwright'));
  }
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch {
    console.log('Installing chromium…');
    await new Promise((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'install', 'chromium'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('playwright install chromium failed'))
      );
    });
  }
  return chromium;
}

function printReport(payload) {
  console.log('');
  console.log('=== Draw perf suite ===');
  console.log('UA:', (payload.ua || '').slice(0, 100));
  console.log('DPR:', payload.dpr, ' frames/case: sample from page');
  console.log('');
  if (payload.suiteDeltas) {
    console.log('Mean total ms (Δ vs grass):');
    for (const row of payload.suiteDeltas) {
      const top = row.topStage
        ? row.topStage.stage + ' ' + row.topStage.pct.toFixed(0) + '%'
        : '—';
      console.log(
        '  ' +
          row.name.padEnd(22) +
          row.meanTotalMs.toFixed(2).padStart(7) +
          ' ms   Δ ' +
          (row.deltaVsGrassMs >= 0 ? '+' : '') +
          row.deltaVsGrassMs.toFixed(2) +
          '   top=' +
          top
      );
    }
  } else if (payload.suite) {
    for (const s of payload.suite) {
      console.log(
        '  ' + s.name.padEnd(22) + (s.meanMs.total || 0).toFixed(2) + ' ms'
      );
    }
  }
  console.log('');
  console.log('BH case stage breakdown (mean ms):');
  const ranked = payload.ranked || [];
  for (const r of ranked) {
    console.log(
      '  ' +
        r.stage.padEnd(14) +
        r.ms.toFixed(3).padStart(8) +
        ' ms  ' +
        r.pct.toFixed(1).padStart(5) +
        '%'
    );
  }
  const total = (payload.meanMs && payload.meanMs.total) || 0;
  console.log('');
  console.log(
    'BH total ' +
      total.toFixed(2) +
      ' ms  →  ' +
      ((payload.fracOfFrame60 || 0) * 100).toFixed(0) +
      '% of 16.67 ms @ 60fps'
  );
  if (ranked[0] && ranked[0].stage === 'lens_warp') {
    console.log('Hotspot: lens_warp (expected for BH holes).');
  } else if (ranked[0]) {
    console.log('WARN: top stage is', ranked[0].stage, '(expected lens_warp on BH hole)');
  }
  console.log('JSON →', OUT_JSON);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const chromium = await ensurePlaywright();
  const port = await freePort();
  const server = startStaticServer(port);
  const base = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage();

  try {
    const qs =
      'autorun=0' +
      // page reads controls; we drive via evaluate
      '';
    await page.goto(base + '/perf-draw.html?' + qs, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForFunction(() => window.Draw && window.Shared && window.__drawPerfRunSuite, {
      timeout: 15000,
    });

    // Configure controls then run suite.
    await page.evaluate(
      ({ frames, warmup, dpr }) => {
        document.getElementById('framesInput').value = String(frames);
        document.getElementById('warmupInput').value = String(warmup);
        document.getElementById('dprSelect').value = String(dpr);
        document.getElementById('chkLive').checked = false;
      },
      { frames: FRAMES, warmup: WARMUP, dpr: DPR }
    );

    await page.evaluate(() => window.__drawPerfRunSuite());
    // Wait for suite payload
    await page.waitForFunction(
      () => window.__drawPerfLast && window.__drawPerfLast.suite && window.__drawPerfLast.suite.length >= 2,
      { timeout: 120000 }
    );

    const payload = await page.evaluate(() => window.__drawPerfLast);
    fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
    printReport(payload);

    if (!payload.suite || payload.suite.length < 2) {
      console.error('FAIL: incomplete suite');
      process.exitCode = 2;
    } else {
      console.log('perf-draw: ok');
    }
  } catch (e) {
    console.error('perf-draw FAILED:', e.message || e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main();
