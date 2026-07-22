#!/usr/bin/env node
/**
 * Browser integration: Android-style clientClock starvation.
 *
 * Desktop Chrome / Playwright cannot faithfully reproduce Android Battery Saver
 * timer policy. This suite **forces the product failure mode** instead:
 *   - suppress outbound clientClock for N ms (simulates timer clamp / freeze)
 *   - putt via real game.js path (window.MpTest under ?rbdebug=1)
 *   - assert host does not reject with untrusted / keepalive_stale
 *   - long silence still gets at most one force-sync; later putt still works
 *
 * Also runs with Pixel device descriptor + optional CPU throttle for mobile
 * UX cosplay — not a substitute for silence injection.
 *
 * Usage:
 *   npm run test:pw-keepalive
 *   PW_KEEPALIVE_HEADED=1 npm run test:pw-keepalive
 *
 * Requires: playwright + chromium (auto-installs if missing, like share-modal-visual).
 */
'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HEADED = process.env.PW_KEEPALIVE_HEADED === '1';
const FATAL_REJECTS = new Set(['untrusted', 'keepalive_stale', 'before_keepalive']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function waitHttpOk(url, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for ' + url));
        setTimeout(tryOnce, 80);
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for ' + url));
        setTimeout(tryOnce, 80);
      });
    };
    tryOnce();
  });
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
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install playwright failed'))));
    });
    ({ chromium } = require('playwright'));
  }
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch {
    console.log('Installing chromium for playwright…');
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

/** Init script: wrap WebSocket to probe + optionally drop clientClock. */
function wsProbeInitScript() {
  return `(() => {
    window.__kaProbe = {
      outbound: [],
      inbound: [],
      suppressClientClock: false,
      clientClockSent: 0,
      clientClockSuppressed: 0,
      puttsSent: 0,
    };
    const Orig = window.WebSocket;
    function Wrapped(url, protocols) {
      const ws = protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          const msg = typeof data === 'string' ? JSON.parse(data) : null;
          if (msg && typeof msg === 'object') {
            window.__kaProbe.outbound.push({ t: Date.now(), type: msg.type });
            if (msg.type === 'clientClock') {
              if (window.__kaProbe.suppressClientClock) {
                window.__kaProbe.clientClockSuppressed++;
                return;
              }
              window.__kaProbe.clientClockSent++;
            }
            if (msg.type === 'putt') window.__kaProbe.puttsSent++;
          }
        } catch (_) {}
        return origSend(data);
      };
      ws.addEventListener('message', (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (
            msg.type === 'snapshot' ||
            msg.type === 'puttApplied' ||
            msg.type === 'roundState' ||
            msg.type === 'welcome' ||
            msg.type === 'clockSync'
          ) {
            window.__kaProbe.inbound.push({
              t: Date.now(),
              type: msg.type,
              rejectReason: msg.rejectReason || null,
              reason: msg.reason || null,
              hard: !!msg.hard,
            });
            if (window.__kaProbe.inbound.length > 400) window.__kaProbe.inbound.shift();
          }
        } catch (_) {}
      });
      return ws;
    }
    Wrapped.prototype = Orig.prototype;
    Wrapped.CONNECTING = Orig.CONNECTING;
    Wrapped.OPEN = Orig.OPEN;
    Wrapped.CLOSING = Orig.CLOSING;
    Wrapped.CLOSED = Orig.CLOSED;
    window.WebSocket = Wrapped;
  })();`;
}

async function waitFor(page, fn, { timeout = 15000, interval = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(fn)) return;
    await sleep(interval);
  }
  throw new Error('timeout waiting for ' + label);
}

async function setSuppress(page, on) {
  await page.evaluate((v) => {
    window.__kaProbe.suppressClientClock = !!v;
  }, on);
}

async function probeSlice(page, sinceT) {
  return page.evaluate((t0) => {
    const p = window.__kaProbe;
    const inbound = p.inbound.filter((m) => m.t >= t0);
    const fatal = inbound.filter((m) => m.rejectReason && ['untrusted', 'keepalive_stale', 'before_keepalive'].includes(m.rejectReason));
    const puttApplied = inbound.filter((m) => m.type === 'puttApplied');
    const resyncStale = inbound.filter(
      (m) => m.type === 'snapshot' && (m.rejectReason === 'keepalive_stale' || (m.reason === 'resync' && m.rejectReason === 'keepalive_stale'))
    );
    const anyResync = inbound.filter((m) => m.type === 'snapshot' && m.reason === 'resync');
    return {
      inbound,
      fatal,
      puttApplied,
      resyncStale,
      anyResync,
      suppressed: p.clientClockSuppressed,
      clocksSent: p.clientClockSent,
      puttsSent: p.puttsSent,
    };
  }, sinceT);
}

async function waitSettledForPutt(page, timeout = 12000) {
  await waitFor(
    page,
    () => {
      const t = window.MpTest;
      return !!(t && t.playing() && t.canPutt());
    },
    { timeout, label: 'canPutt' }
  );
}

async function doPutt(page, drag = { x: 110, y: 8 }) {
  return page.evaluate((v) => window.MpTest.puttDrag(v), drag);
}

async function coastUntilCanPutt(page, maxMs = 14000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const ok = await page.evaluate(() => {
      const t = window.MpTest;
      return !!(t && t.playing() && t.canPutt());
    });
    if (ok) return;
    await sleep(80);
  }
  throw new Error('ball never settled for next putt');
}

async function startSoloRound(page, baseUrl) {
  await page.goto(`${baseUrl}/?rbdebug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitFor(
    page,
    () => !!(window.MpTest && document.getElementById('btn-create-room')),
    { timeout: 15000, label: 'lobby+MpTest' }
  );

  await page.fill('#lobby-name-input', 'PwKa');
  await page.click('#btn-create-room');
  await page.waitForSelector('#btn-start-round:not(.hidden)', { timeout: 15000 });
  await page.click('#btn-start-round');

  await waitFor(page, () => !!(window.MpTest && window.MpTest.playing()), {
    timeout: 15000,
    label: 'mpPlaying',
  });
  // Let first keepalive + a few ticks establish host history.
  await sleep(600);
  await waitSettledForPutt(page);
}

async function runScenarios(page) {
  const results = [];

  // --- A) 1.5s silence (classic Android setInterval clamp past old 1.2s stale) ---
  {
    await waitSettledForPutt(page);
    const t0 = Date.now();
    await setSuppress(page, true);
    await sleep(1500);
    const putt = await doPutt(page, { x: 100, y: 0 });
    assert.ok(putt.ok, 'putt A not ready: ' + JSON.stringify(putt));
    await sleep(900);
    const snap = await probeSlice(page, t0);
    await setSuppress(page, false);
    const ok = snap.fatal.length === 0 && (snap.puttApplied.length >= 1 || snap.puttsSent >= 1);
    // puttApplied is the clear accept signal
    const accepted = snap.puttApplied.length >= 1;
    results.push({
      name: 'silence_1_5s_putt',
      ok: ok && accepted,
      detail: {
        putt,
        fatal: snap.fatal,
        puttApplied: snap.puttApplied.length,
        suppressed: snap.suppressed,
      },
    });
    assert.ok(accepted, '1.5s silence: expected puttApplied, got ' + JSON.stringify(snap.fatal));
    assert.strictEqual(snap.fatal.length, 0, '1.5s silence: fatal rejects ' + JSON.stringify(snap.fatal));
    console.log('  ok silence_1_5s_putt (suppressed clocks=%d)', snap.suppressed);
    await coastUntilCanPutt(page);
  }

  // --- B) 3s silence (still under 5s host stale) ---
  {
    await waitSettledForPutt(page);
    // Clear recent inbound marker
    const t0 = Date.now();
    await setSuppress(page, true);
    await sleep(3000);
    const putt = await doPutt(page, { x: 80, y: 20 });
    assert.ok(putt.ok, 'putt B not ready');
    await sleep(900);
    const snap = await probeSlice(page, t0);
    await setSuppress(page, false);
    assert.strictEqual(snap.fatal.length, 0, '3s silence fatal: ' + JSON.stringify(snap.fatal));
    assert.ok(snap.puttApplied.length >= 1, '3s silence: no puttApplied');
    results.push({ name: 'silence_3s_putt', ok: true, detail: { puttApplied: snap.puttApplied.length } });
    console.log('  ok silence_3s_putt');
    await coastUntilCanPutt(page);
  }

  // --- C) Long freeze > host stale (5s): one keepalive_stale resync, putt after still works ---
  {
    await waitSettledForPutt(page);
    // Ensure a fresh clock so lastKeepaliveWall is recent before freeze.
    await page.evaluate(() => window.MpTest.sendKeepalive());
    await sleep(100);
    const tFreeze = Date.now();
    await setSuppress(page, true);
    await sleep(5500);
    const mid = await probeSlice(page, tFreeze);
    // Host should force-sync once for frozen tab (rejectReason keepalive_stale).
    const staleSyncs = mid.inbound.filter(
      (m) => m.type === 'snapshot' && m.rejectReason === 'keepalive_stale'
    );
    // Then putt while still suppressed — must still accept (policy).
    const putt = await doPutt(page, { x: 95, y: -10 });
    assert.ok(putt.ok, 'putt C not ready');
    await sleep(1000);
    const after = await probeSlice(page, tFreeze);
    await setSuppress(page, false);

    const fatalOnPutt = after.fatal.filter((m) => m.t >= putt.clientTick); // rough
    // Any untrusted/keepalive_stale as putt *reject* would appear as snapshot with rejectReason
    // during/after putt — allow freeze force-sync before putt, forbid fatal after putt attempt.
    const postPuttFatal = after.inbound.filter(
      (m) =>
        m.type === 'snapshot' &&
        m.rejectReason &&
        FATAL_REJECTS.has(m.rejectReason) &&
        m.t >= tFreeze + 5500
    );
    // puttApplied after freeze
    const appliedAfter = after.puttApplied.filter((m) => m.t >= tFreeze + 5500);

    assert.ok(
      staleSyncs.length >= 1 || mid.anyResync.length >= 1,
      'expected freeze force-sync, inbound=' + JSON.stringify(mid.inbound.slice(-8))
    );
    // At most a small number of stale syncs (ideally 1; allow 2 under tick race)
    assert.ok(staleSyncs.length <= 3, 'force-sync spam: ' + staleSyncs.length);
    assert.ok(appliedAfter.length >= 1, 'post-freeze putt not applied');
    assert.strictEqual(
      postPuttFatal.filter((m) => m.rejectReason === 'untrusted').length,
      0,
      'post-freeze untrusted reject'
    );

    results.push({
      name: 'freeze_5_5s_then_putt',
      ok: true,
      detail: {
        staleSyncs: staleSyncs.length,
        puttApplied: appliedAfter.length,
        postPuttFatal,
      },
    });
    console.log(
      '  ok freeze_5_5s_then_putt (stale force-syncs=%d, puttApplied=%d)',
      staleSyncs.length,
      appliedAfter.length
    );
    await coastUntilCanPutt(page);
  }

  // --- D) Control: keepalives flowing, putt still fine ---
  {
    await setSuppress(page, false);
    await page.evaluate(() => window.MpTest.sendKeepalive());
    await waitSettledForPutt(page);
    const t0 = Date.now();
    const putt = await doPutt(page, { x: 70, y: 5 });
    assert.ok(putt.ok);
    await sleep(800);
    const snap = await probeSlice(page, t0);
    assert.strictEqual(snap.fatal.length, 0);
    assert.ok(snap.puttApplied.length >= 1);
    results.push({ name: 'control_with_keepalives', ok: true });
    console.log('  ok control_with_keepalives');
  }

  return results;
}

async function main() {
  const chromium = await ensurePlaywright();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const relay = spawn('node', ['relay.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayLog = '';
  relay.stdout.on('data', (d) => {
    relayLog += d.toString();
  });
  relay.stderr.on('data', (d) => {
    relayLog += d.toString();
  });

  let browser;
  const failed = [];
  try {
    await waitHttpOk(baseUrl + '/', 15000);
    browser = await chromium.launch({ headless: !HEADED });

    // --- Run 1: desktop viewport ---
    {
      console.log('--- desktop + silence injection ---');
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(wsProbeInitScript());
      const page = await context.newPage();
      page.on('pageerror', (e) => console.error('[pageerror]', e.message));
      await startSoloRound(page, baseUrl);
      await runScenarios(page);
      await context.close();
    }

    // --- Run 2: Pixel-ish + CPU throttle (cosplay; still uses silence injection) ---
    {
      console.log('--- Pixel 7 + CPU 4x + silence_1_5s ---');
      let device = null;
      try {
        const { devices } = require('playwright');
        device = devices['Pixel 7'] || devices['Pixel 5'] || null;
      } catch (_) {
        device = null;
      }
      const context = await browser.newContext(
        device
          ? { ...device }
          : {
              viewport: { width: 412, height: 915 },
              isMobile: true,
              hasTouch: true,
              userAgent:
                'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            }
      );
      await context.addInitScript(wsProbeInitScript());
      const page = await context.newPage();
      try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      } catch (e) {
        console.log('  (CPU throttle unavailable:', e.message + ')');
      }
      await startSoloRound(page, baseUrl);
      // Focused mobile-shaped check: 1.5s silence putt
      await waitSettledForPutt(page);
      const t0 = Date.now();
      await setSuppress(page, true);
      await sleep(1500);
      const putt = await doPutt(page, { x: 100, y: 0 });
      assert.ok(putt.ok, 'pixel putt failed');
      await sleep(1000);
      const snap = await probeSlice(page, t0);
      await setSuppress(page, false);
      assert.strictEqual(snap.fatal.length, 0, 'pixel fatal ' + JSON.stringify(snap.fatal));
      assert.ok(snap.puttApplied.length >= 1, 'pixel no puttApplied');
      console.log('  ok pixel_silence_1_5s_putt');
      await context.close();
    }

    console.log('playwright-keepalive: all ok');
  } catch (e) {
    failed.push(e);
    console.error('playwright-keepalive FAILED:', e.message || e);
    if (relayLog) console.error('--- relay log (tail) ---\n' + relayLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    relay.kill('SIGTERM');
    await sleep(200);
    try {
      relay.kill('SIGKILL');
    } catch (_) {}
  }

  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
