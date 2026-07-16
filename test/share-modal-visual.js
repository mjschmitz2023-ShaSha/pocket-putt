'use strict';
/**
 * Browser verification: share dialog must be a real fixed viewport modal,
 * not document-flow content under the editor.
 *
 * Usage: node test/share-modal-visual.js
 * Requires: npx playwright (browsers installed).
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp-share-modal');
const REPORT = path.join(OUT_DIR, 'report.json');
const SHOT_OPEN = path.join(OUT_DIR, 'share-modal-open.png');
const SHOT_EDITOR = path.join(OUT_DIR, 'editor-before.png');

function mime(file) {
  const ext = path.extname(file);
  return (
    {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.wav': 'audio/wav',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    }[ext] || 'application/octet-stream'
  );
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/') urlPath = '/index.html';
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
        res.writeHead(200, { 'Content-Type': mime(filePath) });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    // Install into project if missing
    console.log('Installing playwright…');
    await new Promise((resolve, reject) => {
      const child = spawn(
        'npm',
        ['install', '--no-save', 'playwright@1.49.1'],
        { cwd: ROOT, stdio: 'inherit' }
      );
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('npm install failed'))));
    });
    ({ chromium } = require('playwright'));
  }

  // Ensure browser binary
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch {
    console.log('Installing chromium for playwright…');
    await new Promise((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'install', 'chromium'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('browser install failed'))));
    });
  }

  const { server, port } = await startStaticServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const report = { ok: false, checks: [], base, shotOpen: SHOT_OPEN, shotEditor: SHOT_EDITOR };

  try {
    await page.goto(`${base}/editor.html`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: SHOT_EDITOR, fullPage: true });

    // Open share via the same API the toolbar uses
    const opened = await page.evaluate(() => {
      if (!window.ShareLevel || !window.Shared) return { error: 'ShareLevel/Shared missing' };
      const hole = window.Shared.blankHole({ name: 'Modal Verify', par: 2 });
      const v = window.Shared.validateHole(hole);
      if (!v.ok) return { error: 'validate failed ' + v.error };
      const lvl = window.Shared.encodeHole(v.hole);
      window.ShareLevel.openShareMenu(lvl);
      return { ok: true, lvlLen: lvl.length };
    });
    assert.ok(opened.ok, 'openShareMenu failed: ' + JSON.stringify(opened));
    report.checks.push({ name: 'openShareMenu', pass: true, detail: opened });

    await page.waitForSelector('#share-modal:not(.hidden)', { timeout: 3000 });
    await page.waitForTimeout(100);

    const metrics = await page.evaluate(() => {
      const el = document.getElementById('share-modal');
      const card =
        el &&
        (el.querySelector('[data-share-card]') ||
          el.querySelector('.share-modal-card') ||
          el.querySelector('.pp-modal-card'));
      const cs = el ? getComputedStyle(el) : null;
      const rect = el ? el.getBoundingClientRect() : null;
      const cardRect = card ? card.getBoundingClientRect() : null;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      return {
        parentIsBody: !!(el && el.parentElement === document.body),
        className: el ? el.className : null,
        position: cs && cs.position,
        display: cs && cs.display,
        zIndex: cs && cs.zIndex,
        background: cs && cs.backgroundColor,
        inset: cs && [cs.top, cs.right, cs.bottom, cs.left],
        rect: rect && {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        },
        cardRect: cardRect && {
          x: cardRect.x,
          y: cardRect.y,
          w: cardRect.width,
          h: cardRect.height,
        },
        vw,
        vh,
        // Overlay should cover essentially the full viewport
        coversViewport:
          !!rect &&
          rect.width >= vw * 0.95 &&
          rect.height >= vh * 0.95 &&
          Math.abs(rect.top) < 4 &&
          Math.abs(rect.left) < 4,
        // Card should be roughly centered, not parked under the left palette
        cardCentered:
          !!cardRect &&
          cardRect.x > vw * 0.15 &&
          cardRect.x + cardRect.width < vw * 0.95 &&
          cardRect.y > vh * 0.05 &&
          cardRect.y + cardRect.height < vh * 0.95 &&
          Math.abs(cardRect.x + cardRect.width / 2 - vw / 2) < vw * 0.2,
        // Option rows: title stacked above description; copy button to the right
        optionLayout: (() => {
          const opt = el && el.querySelector('.share-option[data-kind="short"]');
          if (!opt) return null;
          const title = opt.querySelector('.share-option-title, strong');
          const desc = opt.querySelector('.share-option-desc, span');
          const btn = opt.querySelector('button');
          if (!title || !desc || !btn) return { ok: false, reason: 'missing nodes' };
          const tr = title.getBoundingClientRect();
          const dr = desc.getBoundingClientRect();
          const br = btn.getBoundingClientRect();
          const titleAboveDesc = tr.bottom <= dr.top + 2;
          const btnRightOfText = br.left >= Math.max(tr.right, dr.right) - 4;
          const notLeftRail = tr.x > vw * 0.2;
          return {
            ok: titleAboveDesc && btnRightOfText && notLeftRail,
            titleAboveDesc,
            btnRightOfText,
            notLeftRail,
            tr: { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
            dr: { x: dr.x, y: dr.y, w: dr.width, h: dr.height },
            br: { x: br.x, y: br.y, w: br.width, h: br.height },
          };
        })(),
        titleText: document.getElementById('share-modal-title')
          ? document.getElementById('share-modal-title').textContent
          : null,
        hasShort: !!document.getElementById('btn-share-short'),
        hasLong: !!document.getElementById('btn-share-long'),
      };
    });

    report.metrics = metrics;
    await page.screenshot({ path: SHOT_OPEN, fullPage: false });

    function check(name, pass, detail) {
      report.checks.push({ name, pass: !!pass, detail });
      assert.ok(pass, name + ' failed: ' + JSON.stringify(detail));
    }

    check('parent is document.body', metrics.parentIsBody, metrics.parentIsBody);
    check('position is fixed', metrics.position === 'fixed', metrics.position);
    check('display is flex', metrics.display === 'flex', metrics.display);
    check('z-index is elevated', Number(metrics.zIndex) >= 1000, metrics.zIndex);
    check('covers viewport', metrics.coversViewport, metrics.rect);
    check('card centered (not left-rail flow)', metrics.cardCentered, metrics.cardRect);
    check('title present', metrics.titleText === 'Share level', metrics.titleText);
    check('both copy buttons present', metrics.hasShort && metrics.hasLong, {
      short: metrics.hasShort,
      long: metrics.hasLong,
    });
    check(
      'option row layout (title stack + button right)',
      !!(metrics.optionLayout && metrics.optionLayout.ok),
      metrics.optionLayout
    );

    // Backdrop should not be fully transparent
    const bg = metrics.background || '';
    const alphaMatch = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\s*\)/.exec(bg);
    const alphaOk = alphaMatch ? Number(alphaMatch[1]) >= 0.3 : false;
    check('dimmed backdrop', alphaOk, bg);

    report.ok = true;
    report.summary = 'Share modal is a fixed, viewport-covering, centered overlay.';
    console.log('share-modal-visual: OK');
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    report.ok = false;
    report.error = String(e && e.stack ? e.stack : e);
    console.error('share-modal-visual: FAIL');
    console.error(report.error);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'share-modal-fail.png'), fullPage: true });
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
