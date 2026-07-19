/* Path-trace visual harness — load host+client dumps, step three histories. */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('plot');
  const ctx = canvas.getContext('2d');
  const slider = document.getElementById('slider');
  const stepLabel = document.getElementById('step-label');
  const metaEl = document.getElementById('meta');
  const focusSel = document.getElementById('focus-ball');
  const putterSel = document.getElementById('sel-putter');
  const observerSel = document.getElementById('sel-observer');

  /** @type {object|null} */
  let bundle = null;
  /** Aligned step list: { host, putter, observer, wireIdx } */
  let steps = [];
  let stepI = 0;
  let wirePath = [];

  function dist(a, b) {
    if (!a || !b) return null;
    return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
  }
  function dvel(a, b) {
    if (!a || !b) return null;
    return Math.hypot((a.vx || 0) - (b.vx || 0), (a.vy || 0) - (b.vy || 0));
  }
  function fmt(n, d) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toFixed(d != null ? d : 1);
  }

  function hostSamplesFor(ballId) {
    const lane = bundle && bundle.host && bundle.host[ballId];
    return lane && Array.isArray(lane.samples) ? lane.samples : [];
  }

  function clientLane(clientId) {
    if (!bundle || !bundle.clients || !clientId) return null;
    return bundle.clients[clientId] || null;
  }

  /** Client samples for focus ball only (filter ballId). Prefer sim phase for alignment. */
  function clientSamples(clientId, ballId, preferPhase) {
    const lane = clientLane(clientId);
    if (!lane || !Array.isArray(lane.samples)) return [];
    let list = lane.samples.filter((s) => s.ballId === ballId || (!s.ballId && true));
    // If samples lack ballId (shouldn't), keep all.
    if (!list.length && lane.samples.length) list = lane.samples.slice();
    if (preferPhase) {
      const phased = list.filter((s) => s.phase === preferPhase);
      if (phased.length) return phased;
    }
    // Prefer sim over pure render for tick alignment.
    const sim = list.filter((s) => s.phase === 'sim' || s.phase === 'after_hard' || !s.phase);
    return sim.length ? sim : list;
  }

  function clientRenderSamples(clientId, ballId) {
    const lane = clientLane(clientId);
    if (!lane || !Array.isArray(lane.samples)) return [];
    return lane.samples.filter(
      (s) => (s.ballId === ballId || !s.ballId) && (s.phase === 'render' || s.rx != null)
    );
  }

  function wirePathFor(ballId) {
    if (!bundle || !Array.isArray(bundle.events)) return [];
    for (let i = bundle.events.length - 1; i >= 0; i--) {
      const e = bundle.events[i];
      if (e.kind === 'wire_path' && e.playerId === ballId && Array.isArray(e.path)) {
        return e.path;
      }
    }
    // Client may have recorded vis_path_start
    for (const cid of Object.keys(bundle.clients || {})) {
      const evs = bundle.clients[cid].events || [];
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i];
        if (e.kind === 'vis_path_start' && e.ballId === ballId && Array.isArray(e.path)) {
          return e.path;
        }
      }
    }
    return [];
  }

  /**
   * Build the scrubber timeline.
   * Primary axis = host dense samples for the focus ball (one slider step = one host sample).
   * At each host sample, pick the putter/observer sample with the same (or nearest) sim tick.
   * If host has no samples yet, fall back to the longest client series.
   */
  function rebuildSteps() {
    steps = [];
    if (!bundle) return;
    const ballId = focusSel.value;
    const putterId = putterSel.value;
    const observerId = observerSel.value;
    const host = hostSamplesFor(ballId);
    const putter = clientSamples(putterId, ballId, 'sim');
    const observer = clientSamples(observerId, ballId, 'sim');
    wirePath = wirePathFor(ballId);

    // Prefer host as the timeline. Only invent a single dummy step when everything is empty.
    let primary = host;
    let primaryKind = 'host';
    if (primary.length === 0) {
      if (putter.length >= observer.length && putter.length > 0) {
        primary = putter;
        primaryKind = 'putter';
      } else if (observer.length > 0) {
        primary = observer;
        primaryKind = 'observer';
      }
    }

    if (primary.length === 0) {
      steps = [];
      slider.max = '0';
      slider.value = '0';
      stepI = 0;
      stepLabel.textContent = '0 / 0';
      document.getElementById('step-info').textContent =
        'No samples for this focus ball. Start the hole, make a putt, then Fetch again. ' +
        'Client lanes need PathTrace → Push dump on each browser.';
      draw();
      return;
    }

    for (let i = 0; i < primary.length; i++) {
      const prim = primary[i];
      const tick = prim.tick != null ? prim.tick : i;
      const h = primaryKind === 'host' ? prim : nearestByTick(host, tick, i);
      const p = nearestByTick(putter, tick, i);
      const o = nearestByTick(observer, tick, i);
      steps.push({
        i,
        tick,
        host: h,
        putter: p,
        observer: o,
        putterIdx: indexOfSample(putter, p),
        observerIdx: indexOfSample(observer, o),
        primaryKind,
      });
    }
    slider.min = '0';
    slider.max = String(Math.max(0, steps.length - 1));
    slider.step = '1';
    if (stepI >= steps.length) stepI = Math.max(0, steps.length - 1);
    // Jump to last sample so a fresh fetch shows "end of putt" not tee frame 0.
    if (stepI === 0 && steps.length > 1) stepI = steps.length - 1;
    slider.value = String(stepI);
    updateUI();
    draw();
  }

  function indexOfSample(arr, s) {
    if (!s) return -1;
    return arr.indexOf(s);
  }

  /**
   * Nearest sample by tick. If several share the same tick (4 subticks), prefer
   * the one closest in index to fallbackIdx so scrubbing still advances.
   */
  function nearestByTick(arr, tick, fallbackIdx) {
    if (!arr.length) return null;
    const atTick = [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].tick === tick) atTick.push({ s: arr[i], i });
    }
    if (atTick.length) {
      if (fallbackIdx != null && fallbackIdx >= 0) {
        let best = atTick[0];
        let bestD = Math.abs(best.i - fallbackIdx);
        for (const cand of atTick) {
          const d = Math.abs(cand.i - fallbackIdx);
          if (d < bestD) {
            best = cand;
            bestD = d;
          }
        }
        return best.s;
      }
      return atTick[atTick.length - 1].s;
    }
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      const d = Math.abs((s.tick || 0) - tick);
      // Tie-break: closer index when ticks equidistant.
      const tie = d === bestD && best && Math.abs(i - (fallbackIdx || 0)) < Math.abs((best._i || 0) - (fallbackIdx || 0));
      if (d < bestD || tie) {
        bestD = d;
        best = s;
        best._i = i;
      }
    }
    return best;
  }

  function populateSelectors() {
    const ballIds = new Set();
    const clientIds = [];
    if (bundle && bundle.host) {
      for (const id of Object.keys(bundle.host)) ballIds.add(id);
    }
    if (bundle && bundle.clients) {
      for (const id of Object.keys(bundle.clients)) {
        clientIds.push(id);
        const samples = bundle.clients[id].samples || [];
        for (const s of samples) if (s.ballId) ballIds.add(s.ballId);
      }
    }
    focusSel.innerHTML = '';
    for (const id of ballIds) {
      const name =
        (bundle.host[id] && bundle.host[id].name) ||
        (bundle.clients[id] && bundle.clients[id].name) ||
        id.slice(0, 8);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${name} (${id.slice(0, 8)})`;
      focusSel.appendChild(opt);
    }
    function fillClient(sel) {
      sel.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '(none)';
      sel.appendChild(empty);
      for (const id of clientIds) {
        const c = bundle.clients[id];
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${c.name || id.slice(0, 8)} · ${c.sampleCount || (c.samples && c.samples.length) || 0} samp`;
        sel.appendChild(opt);
      }
    }
    fillClient(putterSel);
    fillClient(observerSel);

    // Heuristic: first client = putter, second = observer; focus = putter if known.
    if (clientIds.length >= 1) putterSel.value = clientIds[0];
    if (clientIds.length >= 2) observerSel.value = clientIds[1];
    if (clientIds.length === 1 && ballIds.has(clientIds[0])) focusSel.value = clientIds[0];
    else if (ballIds.size) focusSel.value = [...ballIds][0];

    // Prefer focus ball that has host samples with motion.
    let bestBall = focusSel.value;
    let bestSpan = -1;
    for (const id of ballIds) {
      const hs = hostSamplesFor(id);
      if (hs.length < 2) continue;
      const span = dist(hs[0], hs[hs.length - 1]) || 0;
      if (span > bestSpan) {
        bestSpan = span;
        bestBall = id;
      }
    }
    if (bestBall) focusSel.value = bestBall;
  }

  function setBundle(b) {
    bundle = b;
    if (!bundle) {
      metaEl.textContent = 'No dump loaded';
      steps = [];
      draw();
      return;
    }
    metaEl.textContent = `room ${bundle.room || '?'} · hole ${bundle.holeIndex ?? '?'} · hostTick ${bundle.hostTick ?? '?'} · clients ${Object.keys(bundle.clients || {}).length}`;
    populateSelectors();
    rebuildSteps();
  }

  function updateUI() {
    const n = steps.length;
    stepLabel.textContent = n ? `${stepI + 1} / ${n}` : '0 / 0';
    const st = steps[stepI];
    if (!st) {
      document.getElementById('step-info').textContent = '—';
      return;
    }
    const hArr = hostSamplesFor(focusSel.value);
    document.getElementById('step-info').innerHTML =
      `step <b>${stepI + 1}</b> of <b>${n}</b> · host tick <b>${st.tick}</b>` +
      (st.host && st.host.sub != null ? ` · sub <b>${st.host.sub}</b>` : '') +
      (st.host && st.host.phase ? ` · <code>${st.host.phase}</code>` : '') +
      `<br>timeline=${st.primaryKind || 'host'} · host ${hArr.length} · ` +
      `putter ${clientSamples(putterSel.value, focusSel.value).length} · ` +
      `observer ${clientSamples(observerSel.value, focusSel.value).length} · ` +
      `wire ${wirePath.length}` +
      (n <= 1
        ? `<br><span style="color:#ff4d6d">Only one step — nothing to scrub. Play a putt, wait for motion, Push dumps, Fetch again.</span>`
        : '');

    const h = st.host;
    const p = st.putter;
    const o = st.observer;
    // Prefer render pose (rx,ry) for client display if present.
    const pPose = p ? { x: p.rx != null ? p.rx : p.x, y: p.ry != null ? p.ry : p.y, vx: p.vx, vy: p.vy, tick: p.tick, sub: p.sub, phase: p.phase } : null;
    const oPose = o ? { x: o.rx != null ? o.rx : o.x, y: o.ry != null ? o.ry : o.y, vx: o.vx, vy: o.vy, tick: o.tick, sub: o.sub, phase: o.phase } : null;

    function setD(id, d, badAt) {
      const el = document.getElementById(id);
      el.textContent = fmt(d);
      el.className = 'metric ' + (d != null && d > (badAt || 3) ? 'bad' : 'ok');
    }
    setD('d-ph', dist(pPose, h), 3);
    setD('d-oh', dist(oPose, h), 3);
    setD('d-po', dist(pPose, oPose), 3);
    document.getElementById('dv-ph').textContent = fmt(dvel(p, h));
    document.getElementById('dv-oh').textContent = fmt(dvel(o, h));
    document.getElementById('dv-po').textContent = fmt(dvel(p, o));

    const rows = document.getElementById('pose-rows');
    rows.innerHTML = '';
    function addRow(name, s) {
      const tr = document.createElement('tr');
      if (!s) {
        tr.innerHTML = `<td>${name}</td><td colspan="5">—</td>`;
      } else {
        const x = s.rx != null ? s.rx : s.x;
        const y = s.ry != null ? s.ry : s.y;
        tr.innerHTML = `<td>${name}</td><td>${s.tick ?? '—'}</td><td>${s.sub ?? '—'}</td><td>${fmt(x, 2)}</td><td>${fmt(y, 2)}</td><td>${s.phase || ''}</td>`;
      }
      rows.appendChild(tr);
    }
    addRow('host', h);
    addRow('putter', p);
    addRow('observer', o);

    // Neighbor gaps along each series at this aligned index.
    const gaps = document.getElementById('gap-rows');
    gaps.innerHTML = '';
    function gapRow(name, arr, idx) {
      const tr = document.createElement('tr');
      if (!arr || idx <= 0 || !arr[idx] || !arr[idx - 1]) {
        tr.innerHTML = `<td>${name}</td><td>—</td>`;
      } else {
        const g = dist(arr[idx - 1], arr[idx]);
        const bad = g != null && g > 12;
        tr.innerHTML = `<td>${name}</td><td class="${bad ? 'metric bad' : ''}">${fmt(g, 2)} px</td>`;
      }
      gaps.appendChild(tr);
    }
    const hArr = hostSamplesFor(focusSel.value);
    const pArr = clientSamples(putterSel.value, focusSel.value);
    const oArr = clientSamples(observerSel.value, focusSel.value);
    gapRow('host', hArr, st.i < hArr.length ? st.i : -1);
    gapRow('putter', pArr, st.putterIdx);
    gapRow('observer', oArr, st.observerIdx);
    // Wire neighbor gaps (show for nearest wire index by arc)
    if (wirePath.length && h) {
      let wi = 0;
      let best = Infinity;
      for (let i = 0; i < wirePath.length; i++) {
        const d = dist(wirePath[i], h);
        if (d < best) {
          best = d;
          wi = i;
        }
      }
      gapRow('wire', wirePath, wi);
    }

    // Events near this host tick
    const evLines = [];
    const t = st.tick;
    for (const e of bundle.events || []) {
      if (Math.abs((e.hostTick ?? e.tick ?? 0) - t) <= 2) {
        evLines.push(`[host] ${e.kind} t=${e.hostTick ?? e.tick} ${e.playerId ? e.playerId.slice(0, 8) : ''}`);
      }
    }
    for (const cid of [putterSel.value, observerSel.value]) {
      const lane = clientLane(cid);
      if (!lane) continue;
      for (const e of lane.events || []) {
        if (Math.abs((e.tick || 0) - t) <= 2) {
          evLines.push(`[${(lane.name || cid).slice(0, 10)}] ${e.kind} t=${e.tick}`);
        }
      }
    }
    document.getElementById('events').textContent = evLines.length ? evLines.join('\n') : '(none near tick)';
  }

  function boundsOf(samples) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of samples) {
      if (!s) continue;
      const x = s.rx != null ? s.rx : s.x;
      const y = s.ry != null ? s.ry : s.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 400, maxY: 600 };
    const pad = 30;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 1000;
    const cssH = canvas.clientHeight || 640;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, cssW, cssH);

    if (!bundle || !steps.length) {
      ctx.fillStyle = '#8aa0bc';
      ctx.font = '14px system-ui';
      ctx.fillText('Load a path-trace bundle to plot.', 24, 40);
      return;
    }

    const ballId = focusSel.value;
    const host = hostSamplesFor(ballId);
    const putter = clientSamples(putterSel.value, ballId);
    const observer = clientSamples(observerSel.value, ballId);
    const putterR = clientRenderSamples(putterSel.value, ballId);
    const observerR = clientRenderSamples(observerSel.value, ballId);

    const all = host.concat(putter, observer, wirePath);
    const b = boundsOf(all);
    const w = b.maxX - b.minX || 1;
    const h = b.maxY - b.minY || 1;
    const scale = Math.min((cssW - 40) / w, (cssH - 40) / h);
    const ox = (cssW - w * scale) / 2;
    const oy = (cssH - h * scale) / 2;

    function tx(x) {
      return ox + (x - b.minX) * scale;
    }
    function ty(y) {
      return oy + (y - b.minY) * scale;
    }

    function strokePoly(arr, color, width, useRender, fromI, toI) {
      if (!arr || arr.length < 2) return;
      const a = fromI != null ? Math.max(0, fromI) : 0;
      const z = toI != null ? Math.min(arr.length - 1, toI) : arr.length - 1;
      if (z - a < 1) return;
      ctx.beginPath();
      for (let i = a; i <= z; i++) {
        const s = arr[i];
        const x = useRender && s.rx != null ? s.rx : s.x;
        const y = useRender && s.ry != null ? s.ry : s.y;
        if (i === a) ctx.moveTo(tx(x), ty(y));
        else ctx.lineTo(tx(x), ty(y));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Dim full paths (context) + bright prefix up to playhead so scrubbing is obvious.
    const hi = stepI;
    strokePoly(host, 'rgba(93,222,160,0.22)', 2, false);
    strokePoly(putter, 'rgba(110,182,255,0.18)', 1.5, false);
    strokePoly(observer, 'rgba(255,180,84,0.18)', 1.5, false);
    strokePoly(host, '#5ddea0', 2.5, false, 0, Math.min(hi, host.length - 1));
    // Client series: draw up to the sample aligned at this step (by index in their arrays).
    const st0 = steps[hi];
    if (st0) {
      if (st0.putterIdx >= 0) strokePoly(putter, '#6eb6ff', 2, false, 0, st0.putterIdx);
      if (st0.observerIdx >= 0) strokePoly(observer, '#ffb454', 2, false, 0, st0.observerIdx);
    }
    if (putterR.length) strokePoly(putterR, 'rgba(110,182,255,0.25)', 1, true);
    if (observerR.length) strokePoly(observerR, 'rgba(255,180,84,0.25)', 1, true);

    // Wire keyframes always full (sparse reference), with index nearest playhead filled larger.
    if (wirePath.length) {
      strokePoly(wirePath, 'rgba(232,107,107,0.5)', 1.2, false);
      let wi = 0;
      let best = Infinity;
      const ref = st0 && st0.host ? st0.host : st0 && st0.putter;
      if (ref) {
        for (let i = 0; i < wirePath.length; i++) {
          const d = dist(wirePath[i], ref);
          if (d < best) {
            best = d;
            wi = i;
          }
        }
      }
      for (let i = 0; i < wirePath.length; i++) {
        const s = wirePath[i];
        ctx.beginPath();
        ctx.arc(tx(s.x), ty(s.y), i === wi ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === wi ? '#ff8a8a' : '#e86b6b';
        ctx.fill();
      }
    }

    // Playhead markers (large + crosshair) — this is what the slider moves.
    const st = steps[stepI];
    if (st) {
      function mark(s, color, r, label) {
        if (!s) return;
        const x = s.rx != null ? s.rx : s.x;
        const y = s.ry != null ? s.ry : s.y;
        const px = tx(x);
        const py = ty(y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(px - 14, py);
        ctx.lineTo(px + 14, py);
        ctx.moveTo(px, py - 14);
        ctx.lineTo(px, py + 14);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (label) {
          ctx.fillStyle = color;
          ctx.font = '11px system-ui';
          ctx.fillText(label, px + r + 4, py - 4);
        }
      }
      mark(st.host, '#5ddea0', 8, 'H');
      mark(st.putter, '#6eb6ff', 7, 'P');
      mark(st.observer, '#ffb454', 7, 'O');

      // Segment gap highlight host prev→current
      if (st.host && host[st.i - 1]) {
        const a = host[st.i - 1];
        const c = st.host;
        const g = dist(a, c);
        if (g != null && g > 12) {
          ctx.beginPath();
          ctx.moveTo(tx(a.x), ty(a.y));
          ctx.lineTo(tx(c.x), ty(c.y));
          ctx.strokeStyle = '#ff4d6d';
          ctx.lineWidth = 4;
          ctx.stroke();
          ctx.fillStyle = '#ff4d6d';
          ctx.font = 'bold 12px system-ui';
          ctx.fillText(`gap ${g.toFixed(1)}px`, tx((a.x + c.x) / 2) + 6, ty((a.y + c.y) / 2));
        }
      }

      // Big HUD so slider feedback is obvious even if poses coincide.
      ctx.fillStyle = '#e6eefc';
      ctx.font = 'bold 14px system-ui';
      ctx.fillText(
        `step ${stepI + 1}/${steps.length}  tick ${st.tick}` +
          (st.host && st.host.sub != null ? `  sub ${st.host.sub}` : ''),
        12,
        22
      );
    }

    // Store transform for click
    canvas._xf = { tx, ty, b, scale, ox, oy, cssW, cssH };
  }

  function go(i) {
    if (!steps.length) return;
    stepI = Math.max(0, Math.min(steps.length - 1, i));
    slider.value = String(stepI);
    updateUI();
    draw();
  }

  document.getElementById('btn-prev').onclick = () => go(stepI - 1);
  document.getElementById('btn-next').onclick = () => go(stepI + 1);
  slider.oninput = () => go(Number(slider.value));
  focusSel.onchange = rebuildSteps;
  putterSel.onchange = rebuildSteps;
  observerSel.onchange = rebuildSteps;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(stepI - (e.shiftKey ? 10 : 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(stepI + (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(steps.length - 1);
    }
  });

  canvas.addEventListener('click', (ev) => {
    const xf = canvas._xf;
    if (!xf || !steps.length) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    // Invert
    const wx = xf.b.minX + (mx - xf.ox) / xf.scale;
    const wy = xf.b.minY + (my - xf.oy) / xf.scale;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i].host || steps[i].putter || steps[i].observer;
      if (!s) continue;
      const d = Math.hypot((s.x || 0) - wx, (s.y || 0) - wy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    go(best);
  });

  document.getElementById('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        // Accept full bundle or single client dump wrapped.
        if (data.host || data.clients) setBundle(data);
        else if (data.samples) {
          setBundle({
            version: 1,
            room: data.room,
            host: {},
            clients: {
              [data.playerId || 'client']: {
                playerId: data.playerId,
                name: data.name,
                samples: data.samples,
                events: data.events || [],
              },
            },
            events: [],
          });
        } else {
          alert('Unrecognized JSON shape');
        }
      } catch (err) {
        alert('Bad JSON: ' + err.message);
      }
    };
    reader.readAsText(f);
  });

  document.getElementById('btn-export').onclick = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pathtrace-bundle-${bundle.room || 'room'}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  document.getElementById('btn-fetch').onclick = () => fetchRoom();
  const btnList = document.getElementById('btn-list');
  if (btnList) btnList.onclick = () => listRooms();

  const statusEl = document.getElementById('fetch-status');
  function setFetchStatus(t, isErr) {
    if (!statusEl) return;
    statusEl.textContent = t || '';
    statusEl.style.color = isErr ? '#ff4d6d' : '#8aa0bc';
  }

  async function listRooms() {
    try {
      const res = await fetch('/path-trace', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFetchStatus(`List failed HTTP ${res.status}`, true);
        return;
      }
      const rooms = data.rooms || [];
      if (!rooms.length) {
        setFetchStatus('No active rooms on this relay. Open the game, Create Room, then retry.', true);
        metaEl.textContent = 'no rooms';
        return;
      }
      metaEl.textContent = `active: ${rooms.map((r) => r.code).join(', ')}`;
      setFetchStatus(
        rooms
          .map(
            (r) =>
              `${r.code} · ${r.state} · ${r.players}p · hostSamples=${r.hostSamples} · clientDumps=${r.clientDumps}`
          )
          .join(' | ')
      );
      // If only one room, offer to load it.
      if (rooms.length === 1) {
        await fetchRoom(rooms[0].code);
      }
    } catch (e) {
      setFetchStatus(
        'List error: ' +
          e.message +
          ' — open this page from the relay origin (http://localhost:8977/path-trace.html), not file://',
        true
      );
    }
  }

  async function fetchRoom(forcedCode) {
    let room = (forcedCode || params.get('room') || '').trim().toUpperCase();
    if (!room) {
      // Prefer sole live room if any.
      try {
        const lr = await fetch('/path-trace', { cache: 'no-store' });
        const ld = await lr.json().catch(() => ({}));
        const rooms = (ld && ld.rooms) || [];
        if (rooms.length === 1) room = rooms[0].code;
        else if (rooms.length > 1) {
          room = (prompt(`Room code? Live: ${rooms.map((r) => r.code).join(', ')}`) || '')
            .trim()
            .toUpperCase();
        } else {
          room = (prompt('Room code? (no active rooms listed — create one in the game first)') || '')
            .trim()
            .toUpperCase();
        }
      } catch (_) {
        room = (prompt('Room code?') || '').trim().toUpperCase();
      }
    }
    if (!room) return;
    setFetchStatus(`Fetching ${room}…`);
    try {
      const res = await fetch(`/path-trace/${encodeURIComponent(room)}`, { cache: 'no-store' });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        setFetchStatus(
          `Fetch failed HTTP ${res.status}: body is not JSON (${text.slice(0, 80)}). Is the relay restarted?`,
          true
        );
        return;
      }
      if (!res.ok) {
        const hint = data.hint || data.error || text.slice(0, 120);
        const live = Array.isArray(data.activeRooms) ? data.activeRooms.join(', ') : '';
        setFetchStatus(
          `HTTP ${res.status}: ${hint}${live ? ` · live rooms: ${live}` : ''}`,
          true
        );
        alert(
          `Path-trace fetch failed for room ${room}.\n\n${hint}` +
            (live ? `\n\nLive rooms on this relay:\n${live}` : '\n\nNo rooms — create one after the latest npm start.')
        );
        return;
      }
      if (data.ok === false) {
        setFetchStatus(data.error || 'bad dump', true);
        return;
      }
      setBundle(data);
      setFetchStatus(
        `Loaded ${room}: host lanes ${Object.keys(data.host || {}).length}, clients ${Object.keys(data.clients || {}).length}`
      );
      const u = new URL(location.href);
      u.searchParams.set('room', room);
      history.replaceState(null, '', u);
    } catch (e) {
      setFetchStatus(
        'Fetch error: ' +
          e.message +
          ' — use http://localhost:8977/path-trace.html (same host as the game), not a file:// URL',
        true
      );
      alert('Fetch error: ' + e.message);
    }
  }

  // Boot: sessionStorage from game panel, or ?room=, else list rooms.
  try {
    const raw = sessionStorage.getItem('ppPathTraceBundle');
    if (raw) {
      setBundle(JSON.parse(raw));
      sessionStorage.removeItem('ppPathTraceBundle');
      setFetchStatus('Loaded bundle from game tab (sessionStorage)');
    }
  } catch (_) {}
  if (!bundle && params.get('room')) fetchRoom(params.get('room'));
  else if (!bundle) listRooms();

  window.addEventListener('resize', () => draw());
})();
