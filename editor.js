// Pocket Putt level editor — plain script, uses Shared from shared.js
(function () {
  'use strict';
  const S = window.Shared;
  const {
    LOGICAL_W, LOGICAL_H, BALL_RADIUS,
    MAX_DRAG_DIST, MIN_DRAG_DIST, STOP_THRESHOLD,
    CUP_GRAVITY_RADIUS,
    blankHole, normalizeHole, validateHole, encodeHole, decodeHole,
    deepCloneHole, simulateTrajectory,
    wall, sandRect, waterRect, boostRect, rampRect, stickyRect,
    pendulum, slidingGate, planet, blackHole, moon,
    createBallState, stepBallPhysics, advanceHoleObstacles, resetHoleObstacles,
    computeLaunchVelocity, clampDragVector, stickyLaunchFactor, latchStickyAfterPutt, noteWetPutt,
    markWetFromWater, ballMayRestForAim, cupHasGravity,
    getWindmillBlades, getPendulumSegment, getSlidingGateSegment,
    COURSES, zoneBounds, TICK_DT,
  } = S;

  const SNAP = 5;
  const ES = window.EditorSnap || {};
  const EG = window.EditorGizmos || {};
  const canvas = document.getElementById('editor-canvas');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('editor-status');
  const propFields = document.getElementById('prop-fields');
  const propName = document.getElementById('prop-name');
  const propPar = document.getElementById('prop-par');
  const snapToggle = document.getElementById('snap-toggle');
  const testHud = document.getElementById('editor-test-hud');
  const testStrokesEl = document.getElementById('test-strokes');
  const powerEl = document.getElementById('editor-power');

  let hole = blankHole();
  let tool = 'select';
  let selection = null; // { kind, index } or { kind:'tee'|'cup' }
  let drag = null;
  let mode = 'edit'; // 'edit' | 'test'
  let testBall = null;
  let testState = 'AIMING';
  let testStrokes = 0;
  let testDrag = { active: false, pointerVec: { x: 0, y: 0 } };
  let trajectoryPts = [];
  let lastTime = 0;
  /** Fixed-step residual for Test physics (matches Shared.TICK_DT / game TICK_HZ). */
  let testPhysAcc = 0;
  let placeStart = null;
  /** Magnet crosshair target while dragging/placing ({x,y} or null). */
  let snapIndicator = null;

  function setStatus(msg, isErr) {
    statusEl.textContent = msg || '';
    statusEl.style.color = isErr ? '#f88' : '';
  }

  /** Build snap opts for the current pointer event (grid toggle + optional Shift-ortho). */
  function snapOpts(e, orthoFrom, skip) {
    const o = {
      grid: !!(snapToggle && snapToggle.checked),
      gridSize: SNAP,
      radius: ES.DEFAULT_RADIUS || 12,
      shift: !!(e && e.shiftKey),
      orthoFrom: orthoFrom || null,
    };
    if (skip) o.skip = skip;
    return o;
  }

  /** Snap a free (x,y) against hole geometry (+ optional grid/ortho). skip = selection while moving. */
  function snapXY(x, y, e, orthoFrom, skip) {
    if (typeof ES.snapPoint === 'function') {
      return ES.snapPoint(x, y, hole, snapOpts(e, orthoFrom, skip));
    }
    // Fallback: grid only if toggle on
    if (snapToggle && snapToggle.checked) {
      const g = SNAP;
      const sx = Math.round(x / g) * g, sy = Math.round(y / g) * g;
      return { x: sx, y: sy, snapped: true, target: { x: sx, y: sy } };
    }
    return { x, y, snapped: false };
  }

  function applySnapIndicator(result) {
    if (result && result.snapped && result.target) {
      snapIndicator = { x: result.target.x, y: result.target.y };
    } else {
      snapIndicator = null;
    }
  }

  function loadHoleDoc(h) {
    const n = normalizeHole(h);
    if (!n) return;
    hole = n;
    selection = null;
    propName.value = hole.name;
    propPar.value = String(hole.par);
    renderProps();
    setStatus('Loaded: ' + hole.name);
  }

  // ---- URL load ----
  const params = new URLSearchParams(location.search);
  const lvlParam = params.get('lvl');
  if (lvlParam) {
    const d = decodeHole(lvlParam);
    if (d.ok) loadHoleDoc(d.hole);
    else setStatus('Invalid lvl param: ' + d.error, true);
  } else {
    loadHoleDoc(blankHole());
  }

  // ---- Tools ----
  document.querySelectorAll('.tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      tool = btn.dataset.tool;
      placeStart = null;
    });
  });

  propName.addEventListener('change', () => {
    hole.name = propName.value.slice(0, 40) || 'Custom Hole';
  });
  propPar.addEventListener('change', () => {
    let p = Math.round(Number(propPar.value));
    if (!Number.isFinite(p) || p < 1) p = 1;
    if (p > 10) p = 10;
    hole.par = p;
    propPar.value = String(p);
  });

  document.getElementById('btn-delete').addEventListener('click', () => {
    if (!selection || selection.kind === 'tee' || selection.kind === 'cup') return;
    const arr = hole[selection.kind];
    if (!arr || selection.index < 0) return;
    arr.splice(selection.index, 1);
    selection = null;
    renderProps();
  });

  document.addEventListener('keydown', (e) => {
    if (mode !== 'edit') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) return;
      document.getElementById('btn-delete').click();
    }
  });

  // ---- Import ----
  const importModal = document.getElementById('import-modal');
  const importCourse = document.getElementById('import-course');
  const importHole = document.getElementById('import-hole');
  const importWarn = document.getElementById('import-warn');

  function fillImportHoles() {
    const ci = Number(importCourse.value) || 0;
    const holes = COURSES[ci].holes;
    importHole.innerHTML = '';
    holes.forEach((h, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${i + 1}. ${h.name}`;
      importHole.appendChild(opt);
    });
    updateImportWarn();
  }
  function updateImportWarn() {
    const ci = Number(importCourse.value) || 0;
    const hi = Number(importHole.value) || 0;
    const h = normalizeHole(COURSES[ci].holes[hi]);
    const v = validateHole(h);
    if (v.ok) importWarn.textContent = 'OK to import (fits share budget).';
    else importWarn.textContent = 'Cannot share as-is: ' + v.error + (v.field ? ' (' + v.field + ')' : '') + '. Import still allowed for editing.';
  }
  COURSES.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = c.name;
    importCourse.appendChild(opt);
  });
  importCourse.addEventListener('change', fillImportHoles);
  importHole.addEventListener('change', updateImportWarn);
  fillImportHoles();

  document.getElementById('btn-import').addEventListener('click', () => {
    importModal.classList.remove('hidden');
  });
  document.getElementById('import-cancel').addEventListener('click', () => {
    importModal.classList.add('hidden');
  });
  document.getElementById('import-ok').addEventListener('click', () => {
    const ci = Number(importCourse.value) || 0;
    const hi = Number(importHole.value) || 0;
    loadHoleDoc(deepCloneHole(COURSES[ci].holes[hi]));
    importModal.classList.add('hidden');
  });

  // ---- Share ----
  function shareUrl() {
    const v = validateHole(hole);
    if (!v.ok) throw Object.assign(new Error(v.error), { detail: v });
    const lvl = encodeHole(v.hole);
    const u = new URL(location.href);
    // Share points at main game, not editor
    u.pathname = u.pathname.replace(/editor\.html$/i, 'index.html');
    if (!/index\.html$/i.test(u.pathname) && u.pathname.endsWith('/')) {
      // ok
    } else if (!u.pathname.includes('index.html') && !u.pathname.endsWith('editor.html')) {
      // keep path
    }
    // Prefer index.html next to editor
    if (/editor\.html/i.test(location.pathname)) {
      u.pathname = location.pathname.replace(/editor\.html/i, 'index.html');
    }
    u.search = '';
    u.searchParams.set('lvl', lvl);
    // never fuse room into level blob
    return u.toString();
  }

  document.getElementById('btn-share').addEventListener('click', async () => {
    try {
      const url = shareUrl();
      await navigator.clipboard.writeText(url);
      setStatus('Share link copied (' + url.length + ' chars)');
    } catch (e) {
      setStatus('Share failed: ' + (e.message || e), true);
    }
  });

  document.getElementById('btn-open-game').addEventListener('click', () => {
    try {
      location.href = shareUrl();
    } catch (e) {
      setStatus('Open failed: ' + (e.message || e), true);
    }
  });

  // ---- Selection helpers ----
  function hitTest(x, y) {
    const r = 12;
    if (Math.hypot(x - hole.tee.x, y - hole.tee.y) < r) return { kind: 'tee' };
    if (Math.hypot(x - hole.cup.x, y - hole.cup.y) < r) return { kind: 'cup' };

    function hitRect(arr, kind) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const z = arr[i];
        // Ramps use oriented pads (rotated with launch angle); other zones stay AABB.
        if (kind === 'ramps' && typeof S.circleTouchesRamp === 'function') {
          if (S.circleTouchesRamp(x, y, 6, z)) return { kind, index: i };
          continue;
        }
        const b = zoneBounds(z);
        if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) return { kind, index: i };
      }
      return null;
    }
    function hitWall(arr, kind) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const w = arr[i];
        const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
        const len = Math.hypot(dx, dy) || 1;
        const t = Math.max(0, Math.min(1, ((x - w.x1) * dx + (y - w.y1) * dy) / (len * len)));
        const cx = w.x1 + t * dx, cy = w.y1 + t * dy;
        if (Math.hypot(x - cx, y - cy) < 8) return { kind, index: i };
      }
      return null;
    }
    let h;
    h = hitWall(hole.walls, 'walls'); if (h) return h;
    h = hitRect(hole.sand, 'sand'); if (h) return h;
    h = hitRect(hole.water, 'water'); if (h) return h;
    h = hitRect(hole.boost, 'boost'); if (h) return h;
    h = hitRect(hole.ramps, 'ramps'); if (h) return h;
    h = hitRect(hole.sticky, 'sticky'); if (h) return h;
    for (let i = hole.pendulums.length - 1; i >= 0; i--) {
      const p = hole.pendulums[i];
      if (Math.hypot(x - p.cx, y - p.cy) < 14) return { kind: 'pendulums', index: i };
    }
    for (let i = hole.gates.length - 1; i >= 0; i--) {
      if (hitWall([hole.gates[i]], 'gates')) return { kind: 'gates', index: i };
    }
    for (let i = hole.windmills.length - 1; i >= 0; i--) {
      const m = hole.windmills[i];
      if (Math.hypot(x - m.cx, y - m.cy) < 16) return { kind: 'windmills', index: i };
    }
    for (let i = hole.gravityBodies.length - 1; i >= 0; i--) {
      const b = hole.gravityBodies[i];
      const px = b.kind === 'moon' ? b.orbitCenter.x : b.x;
      const py = b.kind === 'moon' ? b.orbitCenter.y : b.y;
      if (Math.hypot(x - px, y - py) < Math.max(16, b.radius)) return { kind: 'gravityBodies', index: i };
    }
    return null;
  }

  function selectedObject() {
    if (!selection) return null;
    if (selection.kind === 'tee') return hole.tee;
    if (selection.kind === 'cup') return hole.cup;
    const arr = hole[selection.kind];
    if (!arr) return null;
    return arr[selection.index];
  }

  function renderProps() {
    const obj = selectedObject();
    if (!selection || !obj) {
      propFields.innerHTML = '<p class="muted">Select an object</p>';
      return;
    }
    const fields = [];
    function num(key, label, step) {
      fields.push(`<label>${label}<input data-k="${key}" type="number" step="${step || 1}" value="${obj[key] != null ? obj[key] : ''}"></label>`);
    }
    if (selection.kind === 'tee' || selection.kind === 'cup') {
      num('x', 'X', 1); num('y', 'Y', 1);
      if (selection.kind === 'cup') num('radius', 'Radius', 0.5);
    } else if (selection.kind === 'walls') {
      num('x1', 'X1'); num('y1', 'Y1'); num('x2', 'X2'); num('y2', 'Y2');
      fields.push(`<label><input data-k="bumper" type="checkbox" ${obj.bumper ? 'checked' : ''}> Bumper</label>`);
    } else if (selection.kind === 'sand' || selection.kind === 'sticky') {
      num('x1', 'X1'); num('y1', 'Y1'); num('x2', 'X2'); num('y2', 'Y2');
    } else if (selection.kind === 'water') {
      num('x1', 'X1'); num('y1', 'Y1'); num('x2', 'X2'); num('y2', 'Y2');
      fields.push(`<label>Drop X<input data-k="dropX" type="number" step="1" value="${obj.dropPoint ? obj.dropPoint.x : ''}"></label>`);
      fields.push(`<label>Drop Y<input data-k="dropY" type="number" step="1" value="${obj.dropPoint ? obj.dropPoint.y : ''}"></label>`);
    } else if (selection.kind === 'boost') {
      num('x1', 'X1'); num('y1', 'Y1'); num('x2', 'X2'); num('y2', 'Y2');
      num('angle', 'Angle (rad)', 0.05); num('power', 'Power', 10);
    } else if (selection.kind === 'ramps') {
      num('x1', 'X1'); num('y1', 'Y1'); num('x2', 'X2'); num('y2', 'Y2');
      num('angle', 'Angle (rad)', 0.05); num('minSpeed', 'Min speed', 10);
    } else if (selection.kind === 'pendulums') {
      num('cx', 'CX'); num('cy', 'CY'); num('length', 'Length');
      num('angleCenter', 'Angle center', 0.05); num('amplitude', 'Amplitude', 0.05);
      num('period', 'Period', 0.05);
      // Design-time offset in seconds; live phase = phase0 + elapsed (shared clock).
      num('phase0', 'Phase offset (s)', 0.05);
    } else if (selection.kind === 'gates') {
      num('x1', 'X1'); num('y1', 'Y1'); num('x2', 'X2'); num('y2', 'Y2');
      fields.push(`<label>Axis<select data-k="axis"><option value="x" ${obj.axis === 'x' ? 'selected' : ''}>x</option><option value="y" ${obj.axis === 'y' ? 'selected' : ''}>y</option></select></label>`);
      num('amplitude', 'Amplitude'); num('period', 'Period', 0.05);
      num('phase0', 'Phase offset (s)', 0.05);
    } else if (selection.kind === 'windmills') {
      num('cx', 'CX'); num('cy', 'CY'); num('armLength', 'Arm'); num('blades', 'Blades');
      num('rotationSpeed', 'Rot speed', 0.05);
      // Design-time angular offset (radians); angle = phase0 + rotationSpeed * t.
      num('phase0', 'Phase offset (rad)', 0.05);
    } else if (selection.kind === 'gravityBodies') {
      fields.push(`<p class="muted">${obj.kind}</p>`);
      if (obj.kind === 'moon') {
        fields.push(`<label>Orbit CX<input data-k="ocx" type="number" value="${obj.orbitCenter.x}"></label>`);
        fields.push(`<label>Orbit CY<input data-k="ocy" type="number" value="${obj.orbitCenter.y}"></label>`);
        num('orbitRadius', 'Orbit R'); num('orbitPeriodTicks', 'Period ticks');
        num('orbitPhase0', 'Phase offset (rad)', 0.05);
      } else {
        num('x', 'X'); num('y', 'Y');
      }
      num('radius', 'Radius'); num('mass', 'Mass', 0.5);
      num('fieldRadius', 'Field R'); num('drawRadius', 'Draw R');
    }
    propFields.innerHTML = fields.join('');
    propFields.querySelectorAll('input,select').forEach((el) => {
      el.addEventListener('change', () => applyProp(el));
      el.addEventListener('input', () => {
        if (el.type === 'number' || el.tagName === 'SELECT') applyProp(el);
      });
    });
  }

  /** Elapsed level clock in seconds (shared by all movers in edit/test). */
  function editorElapsedSec() {
    return (hole._orbitTick || 0) * TICK_DT;
  }

  /** Recompute live pose from phase0 + current clock so UI edits apply immediately. */
  function applyLivePoseFromPhase0(obj, kind) {
    const t = editorElapsedSec();
    if (kind === 'pendulums' || kind === 'gates') {
      obj.phase = (obj.phase0 || 0) + t;
    } else if (kind === 'windmills') {
      obj.angle = (obj.phase0 || 0) + (obj.rotationSpeed || 0) * t;
    } else if (kind === 'gravityBodies' && obj.kind === 'moon') {
      S.setMoonPoseAtTick(obj, Math.floor(hole._orbitTick || 0));
    }
  }

  function applyProp(el) {
    const obj = selectedObject();
    if (!obj) return;
    const k = el.dataset.k;
    if (el.type === 'checkbox') {
      obj.bumper = el.checked;
      // rebuild restitution
      if (selection.kind === 'walls') {
        hole.walls[selection.index] = wall(obj.x1, obj.y1, obj.x2, obj.y2, { bumper: obj.bumper });
      }
      return;
    }
    if (k === 'axis') {
      obj.axis = el.value === 'y' ? 'y' : 'x';
      return;
    }
    if (k === 'dropX' || k === 'dropY') {
      if (!obj.dropPoint) obj.dropPoint = { x: 0, y: 0 };
      obj.dropPoint[k === 'dropX' ? 'x' : 'y'] = Number(el.value);
      return;
    }
    if (k === 'ocx' || k === 'ocy') {
      obj.orbitCenter[k === 'ocx' ? 'x' : 'y'] = Number(el.value);
      applyLivePoseFromPhase0(obj, 'gravityBodies');
      return;
    }
    const n = Number(el.value);
    if (!Number.isFinite(n) && el.tagName !== 'SELECT') return;
    obj[k] = n;
    if (selection.kind === 'walls') {
      hole.walls[selection.index] = wall(obj.x1, obj.y1, obj.x2, obj.y2, { bumper: !!obj.bumper });
    }
    if (k === 'phase0' || k === 'rotationSpeed') {
      applyLivePoseFromPhase0(obj, selection.kind);
    }
    if (selection.kind === 'gravityBodies' && obj.kind === 'moon') {
      if (k === 'orbitPhase0' || k === 'orbitRadius' || k === 'orbitPeriodTicks') {
        applyLivePoseFromPhase0(obj, 'gravityBodies');
      }
    }
  }

  // ---- Canvas coords ----
  function canvasPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * LOGICAL_W;
    const y = ((clientY - rect.top) / rect.height) * LOGICAL_H;
    return { x, y };
  }

  /** Handles for current selection (empty if none / no EG). */
  function selectionHandles() {
    if (!selection || typeof EG.getHandles !== 'function') return [];
    return EG.getHandles(selection, hole, {
      getPendulumSegment: getPendulumSegment,
      getSlidingGateSegment: getSlidingGateSegment,
    });
  }

  // ---- Place / select ----
  // Capture pointer so move/up keep firing when the cursor leaves the canvas
  // (matches game.js window mousemove — full pull-back for MAX launch in Test).
  function capturePointer(e) {
    try {
      if (canvas.setPointerCapture && e.pointerId != null) {
        canvas.setPointerCapture(e.pointerId);
      }
    } catch {
      /* ignore — older browsers / already captured */
    }
  }
  function releasePointer(e) {
    try {
      if (canvas.releasePointerCapture && e.pointerId != null && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = canvasPos(e.clientX, e.clientY);
    if (mode === 'test') {
      const started = handleTestPointerDown(p);
      if (started) {
        capturePointer(e);
        e.preventDefault();
      }
      return;
    }
    const sp = snapXY(p.x, p.y, e, null);
    const sx = sp.x, sy = sp.y;
    applySnapIndicator(sp);
    if (tool === 'select') {
      // Prefer gizmo handles on the current selection over whole-object move / reselect.
      if (selection && typeof EG.hitTestHandles === 'function') {
        const handles = selectionHandles();
        const hitH = EG.hitTestHandles(handles, p.x, p.y);
        if (hitH) {
          const obj = selectedObject();
          drag = {
            mode: 'handle',
            handle: hitH,
            ox: p.x,
            oy: p.y,
            start: JSON.parse(JSON.stringify(obj)),
          };
          capturePointer(e);
          renderProps();
          return;
        }
      }
      selection = hitTest(p.x, p.y);
      if (selection) {
        const obj = selectedObject();
        drag = { mode: 'move', ox: p.x, oy: p.y, start: JSON.parse(JSON.stringify(obj)) };
        capturePointer(e);
      }
      renderProps();
      return;
    }
    if (tool === 'tee') {
      hole.tee.x = sx; hole.tee.y = sy;
      selection = { kind: 'tee' };
      renderProps();
      return;
    }
    if (tool === 'cup') {
      hole.cup.x = sx; hole.cup.y = sy;
      selection = { kind: 'cup' };
      renderProps();
      return;
    }
    if (tool === 'wall' || tool === 'bumper') {
      placeStart = { x: sx, y: sy };
      drag = { mode: 'place-wall', bumper: tool === 'bumper' };
      capturePointer(e);
      return;
    }
    if (tool === 'sand' || tool === 'water' || tool === 'boost' || tool === 'ramp' || tool === 'sticky') {
      placeStart = { x: sx, y: sy };
      drag = { mode: 'place-rect', kind: tool };
      capturePointer(e);
      return;
    }
    if (tool === 'pendulum') {
      const pend = pendulum(sx, sy, 200, Math.PI / 2, 0.8, 2.2, 0);
      // Seed live phase from shared editor clock so it matches other movers.
      applyLivePoseFromPhase0(pend, 'pendulums');
      hole.pendulums.push(pend);
      selection = { kind: 'pendulums', index: hole.pendulums.length - 1 };
      renderProps();
      return;
    }
    if (tool === 'gate') {
      const g = slidingGate(sx, sy - 30, sx, sy + 30, 'y', 50, 2.0, 0);
      applyLivePoseFromPhase0(g, 'gates');
      hole.gates.push(g);
      selection = { kind: 'gates', index: hole.gates.length - 1 };
      renderProps();
      return;
    }
    if (tool === 'windmill') {
      const m = { cx: sx, cy: sy, armLength: 80, blades: 4, rotationSpeed: 1.5, phase0: 0, angle: 0 };
      applyLivePoseFromPhase0(m, 'windmills');
      hole.windmills.push(m);
      selection = { kind: 'windmills', index: hole.windmills.length - 1 };
      renderProps();
      return;
    }
    if (tool === 'planet') {
      hole.gravityBodies.push(planet(sx, sy, 30, 45));
      selection = { kind: 'gravityBodies', index: hole.gravityBodies.length - 1 };
      renderProps();
      return;
    }
    if (tool === 'blackHole') {
      hole.gravityBodies.push(blackHole(sx, sy, 8, 90));
      selection = { kind: 'gravityBodies', index: hole.gravityBodies.length - 1 };
      renderProps();
      return;
    }
    if (tool === 'moon') {
      hole.gravityBodies.push(moon(sx, sy, 90, 14, 22, 240, { orbitPhase0: 0 }));
      selection = { kind: 'gravityBodies', index: hole.gravityBodies.length - 1 };
      renderProps();
    }
  });

  /**
   * Snap a moved object's reference point and return translation from start.
   * Uses geometry (+ grid); Shift does not force ortho on free moves.
   * Excludes the current selection so self-snap cannot pin the object.
   */
  function snappedMoveDelta(refX, refY, dx, dy, e) {
    const skip = selection ? { kind: selection.kind, index: selection.index } : null;
    const r = snapXY(refX + dx, refY + dy, e, null, skip);
    applySnapIndicator(r);
    return { dx: r.x - refX, dy: r.y - refY };
  }

  /**
   * Snap pointer for a gizmo handle drag.
   * Endpoints / drop use geometry+grid (+Shift ortho from fixed end when applicable).
   * Angle/amplitude/length use raw pointer (no snap) so rotation feels continuous.
   */
  function snapForHandle(handle, px, py, e, start) {
    const freeKinds = {
      angle: 1, amplitude: 1, length: 1, arm: 1,
      radius: 1, fieldRadius: 1, orbitRadius: 1, orbitPhase: 1,
    };
    if (freeKinds[handle.id] || freeKinds[handle.kind]) {
      snapIndicator = null;
      return { x: px, y: py };
    }
    let orthoFrom = null;
    if (handle.id === 'p1' && start) orthoFrom = { x: start.x2, y: start.y2 };
    if (handle.id === 'p2' && start) orthoFrom = { x: start.x1, y: start.y1 };
    const skip = selection ? { kind: selection.kind, index: selection.index } : null;
    const r = snapXY(px, py, e, orthoFrom, skip);
    applySnapIndicator(r);
    return { x: r.x, y: r.y };
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = canvasPos(e.clientX, e.clientY);
    if (mode === 'test') {
      handleTestPointerMove(p);
      return;
    }
    if (!drag) {
      snapIndicator = null;
      return;
    }
    if (drag.mode === 'handle' && selection && typeof EG.applyHandleDrag === 'function') {
      const obj = selectedObject();
      const st = drag.start;
      const sn = snapForHandle(drag.handle, p.x, p.y, e, st);
      // Restore geometry from snapshot each move so corners/ends stay anchored.
      Object.keys(st).forEach((k) => {
        if (st[k] && typeof st[k] === 'object' && !Array.isArray(st[k])) {
          obj[k] = JSON.parse(JSON.stringify(st[k]));
        } else {
          obj[k] = st[k];
        }
      });
      const tag = EG.applyHandleDrag(selection.kind, obj, st, drag.handle, sn.x, sn.y, {
        setMoonPoseAtTick: S.setMoonPoseAtTick,
        tick: Math.floor(hole._orbitTick || 0),
      });
      if (tag && tag.rebuildWall && selection.kind === 'walls') {
        hole.walls[selection.index] = wall(obj.x1, obj.y1, obj.x2, obj.y2, { bumper: !!st.bumper });
      }
      // Keep props in sync while dragging handles (angles, radii, etc.)
      // Avoid full re-render every frame of prop DOM — only when pointer settles on up;
      // values still live on hole data for canvas re-draw.
    } else if (drag.mode === 'move' && selection) {
      const dx = p.x - drag.ox, dy = p.y - drag.oy;
      const obj = selectedObject();
      const st = drag.start;
      if (selection.kind === 'tee' || selection.kind === 'cup') {
        const d = snappedMoveDelta(st.x, st.y, dx, dy, e);
        obj.x = st.x + d.dx; obj.y = st.y + d.dy;
      } else if (selection.kind === 'walls' || selection.kind === 'gates') {
        const d = snappedMoveDelta(st.x1, st.y1, dx, dy, e);
        obj.x1 = st.x1 + d.dx; obj.y1 = st.y1 + d.dy;
        obj.x2 = st.x2 + d.dx; obj.y2 = st.y2 + d.dy;
        if (selection.kind === 'walls') {
          hole.walls[selection.index] = wall(obj.x1, obj.y1, obj.x2, obj.y2, { bumper: !!st.bumper });
        }
      } else if (selection.kind === 'sand' || selection.kind === 'water' || selection.kind === 'boost' || selection.kind === 'ramps' || selection.kind === 'sticky') {
        const d = snappedMoveDelta(st.x1, st.y1, dx, dy, e);
        obj.x1 = st.x1 + d.dx; obj.y1 = st.y1 + d.dy;
        obj.x2 = st.x2 + d.dx; obj.y2 = st.y2 + d.dy;
        if (selection.kind === 'water' && st.dropPoint) {
          obj.dropPoint.x = st.dropPoint.x + d.dx;
          obj.dropPoint.y = st.dropPoint.y + d.dy;
        }
      } else if (selection.kind === 'pendulums' || selection.kind === 'windmills') {
        const d = snappedMoveDelta(st.cx, st.cy, dx, dy, e);
        obj.cx = st.cx + d.dx; obj.cy = st.cy + d.dy;
      } else if (selection.kind === 'gravityBodies') {
        if (obj.kind === 'moon') {
          const d = snappedMoveDelta(st.orbitCenter.x, st.orbitCenter.y, dx, dy, e);
          obj.orbitCenter.x = st.orbitCenter.x + d.dx;
          obj.orbitCenter.y = st.orbitCenter.y + d.dy;
          S.setMoonPoseAtTick(obj, Math.floor(hole._orbitTick || 0));
        } else {
          const d = snappedMoveDelta(st.x, st.y, dx, dy, e);
          obj.x = st.x + d.dx; obj.y = st.y + d.dy;
        }
      }
    } else if (drag.mode === 'place-wall' && placeStart) {
      // Shift locks second wall point to H/V relative to placeStart.
      const r = snapXY(p.x, p.y, e, placeStart);
      drag.cur = { x: r.x, y: r.y };
      applySnapIndicator(r);
    } else if (drag.mode === 'place-rect' && placeStart) {
      // Rect placement: geometry + grid; ortho not required.
      const r = snapXY(p.x, p.y, e, null);
      drag.cur = { x: r.x, y: r.y };
      applySnapIndicator(r);
    }
  });

  function onPointerUp(e) {
    const p = canvasPos(e.clientX, e.clientY);
    if (mode === 'test') {
      if (testDrag.active) releasePointer(e);
      handleTestPointerUp(p);
      return;
    }
    if (drag) releasePointer(e);
    if (drag && drag.mode === 'place-wall' && placeStart) {
      const r = snapXY(p.x, p.y, e, placeStart);
      const x2 = r.x, y2 = r.y;
      if (Math.hypot(x2 - placeStart.x, y2 - placeStart.y) > 4) {
        hole.walls.push(wall(placeStart.x, placeStart.y, x2, y2, { bumper: !!drag.bumper }));
        selection = { kind: 'walls', index: hole.walls.length - 1 };
        renderProps();
      }
    }
    if (drag && drag.mode === 'place-rect' && placeStart) {
      const r = snapXY(p.x, p.y, e, null);
      const x2 = r.x, y2 = r.y;
      const x1 = Math.min(placeStart.x, x2), y1 = Math.min(placeStart.y, y2);
      const x2b = Math.max(placeStart.x, x2), y2b = Math.max(placeStart.y, y2);
      if (x2b - x1 > 4 && y2b - y1 > 4) {
        const k = drag.kind;
        if (k === 'sand') { hole.sand.push(sandRect(x1, y1, x2b, y2b)); selection = { kind: 'sand', index: hole.sand.length - 1 }; }
        if (k === 'water') {
          hole.water.push(waterRect(x1, y1, x2b, y2b, { x: x1 - 10, y: y1 - 20 }));
          selection = { kind: 'water', index: hole.water.length - 1 };
        }
        if (k === 'boost') { hole.boost.push(boostRect(x1, y1, x2b, y2b, 0, 600)); selection = { kind: 'boost', index: hole.boost.length - 1 }; }
        if (k === 'ramp') { hole.ramps.push(rampRect(x1, y1, x2b, y2b, 0, 300)); selection = { kind: 'ramps', index: hole.ramps.length - 1 }; }
        if (k === 'sticky') { hole.sticky.push(stickyRect(x1, y1, x2b, y2b)); selection = { kind: 'sticky', index: hole.sticky.length - 1 }; }
        renderProps();
      }
    }
    if (drag && (drag.mode === 'move' || drag.mode === 'handle')) renderProps();
    drag = null;
    placeStart = null;
    snapIndicator = null;
  }
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  // Match game.js: track aim drag on window so leaving the green still builds full pull power.
  // (setPointerCapture also helps; window is the reliable fallback for all browsers.)
  window.addEventListener('pointermove', (e) => {
    if (!(mode === 'test' && testDrag.active)) return;
    handleTestPointerMove(canvasPos(e.clientX, e.clientY));
  });
  window.addEventListener('pointerup', (e) => {
    if (mode === 'test' && testDrag.active) onPointerUp(e);
  });
  window.addEventListener('pointercancel', (e) => {
    if (mode === 'test' && testDrag.active) onPointerUp(e);
  });

  // ---- Draw (hole art from Draw; selection / placement overlays on top) ----
  const D = window.Draw;

  function isSel(kind, index) {
    return selection && selection.kind === kind && (index == null || selection.index === index);
  }

  function strokeSelectionSeg(w) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(w.x1, w.y1);
    ctx.lineTo(w.x2, w.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function strokeSelectionRect(z) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(z.x1, z.y1, z.x2 - z.x1, z.y2 - z.y1);
    ctx.setLineDash([]);
  }

  /** Selection outline for oriented ramp pad. */
  function strokeSelectionRamp(z) {
    const corners = (typeof S.orientedRectCorners === 'function')
      ? S.orientedRectCorners(z)
      : null;
    if (!corners || corners.length < 4) {
      strokeSelectionRect(z);
      return;
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawHandleSquare(x, y, fill, stroke, size) {
    size = size == null ? 8 : size;
    const h = size / 2;
    ctx.fillStyle = fill || 'rgba(80, 220, 255, 0.95)';
    ctx.strokeStyle = stroke || '#0a1a22';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.fillRect(x - h, y - h, size, size);
    ctx.strokeRect(x - h, y - h, size, size);
  }

  function drawHandleCircle(x, y, r, fill, stroke) {
    r = r == null ? 5 : r;
    ctx.fillStyle = fill || 'rgba(80, 220, 255, 0.95)';
    ctx.strokeStyle = stroke || '#0a1a22';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  /** Distinct drop-point marker (diamond + crosshair). */
  function drawDropMarker(x, y, selected) {
    const s = selected ? 9 : 6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = selected ? '#ffe066' : '#fff';
    ctx.strokeStyle = selected ? '#c48a00' : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeRect(-s / 2, -s / 2, s, s);
    ctx.restore();
    if (selected) {
      ctx.strokeStyle = 'rgba(255, 224, 102, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y);
      ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12);
      ctx.stroke();
    }
  }

  /** Large clear direction arrow for boost/ramp (selected gizmo). */
  function drawAngleArrow(cx, cy, angle, len) {
    len = len == null ? (EG.ARROW_LEN || 48) : len;
    const tipX = cx + Math.cos(angle) * len;
    const tipY = cy + Math.sin(angle) * len;
    const head = 12;
    const a1 = angle + Math.PI * 0.82;
    const a2 = angle - Math.PI * 0.82;
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.98)';
    ctx.fillStyle = 'rgba(255, 220, 80, 0.98)';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX + Math.cos(a1) * head, tipY + Math.sin(a1) * head);
    ctx.lineTo(tipX + Math.cos(a2) * head, tipY + Math.sin(a2) * head);
    ctx.closePath();
    ctx.fill();
    // Tip handle
    drawHandleCircle(tipX, tipY, 6, '#fff', '#c48a00');
  }

  function drawRadiusRing(cx, cy, r, color, dashed) {
    if (!(r > 0)) return;
    ctx.strokeStyle = color || 'rgba(80, 220, 255, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Draw per-type gizmos for the current selection.
   * Handles are hit-tested before whole-object move.
   */
  function drawSelectionGizmos() {
    if (!selection || mode !== 'edit') return;
    const obj = selectedObject();
    if (!obj) return;
    const handles = selectionHandles();

    // Extra type-specific visuals (rings, arrows, guides) under the point handles
    if (selection.kind === 'boost' || selection.kind === 'ramps') {
      const c = typeof EG.rectCenter === 'function'
        ? EG.rectCenter(obj)
        : { x: (obj.x1 + obj.x2) / 2, y: (obj.y1 + obj.y2) / 2 };
      drawAngleArrow(c.x, c.y, obj.angle || 0);
    }

    if (selection.kind === 'water' && obj.dropPoint) {
      // Line from rect center to drop
      const c = { x: (obj.x1 + obj.x2) / 2, y: (obj.y1 + obj.y2) / 2 };
      ctx.strokeStyle = 'rgba(255, 224, 102, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(obj.dropPoint.x, obj.dropPoint.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawDropMarker(obj.dropPoint.x, obj.dropPoint.y, true);
    }

    if (selection.kind === 'pendulums') {
      // Amplitude arc guide
      const a0 = (obj.angleCenter || 0) - (obj.amplitude || 0);
      const a1 = (obj.angleCenter || 0) + (obj.amplitude || 0);
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(obj.cx, obj.cy, obj.length || 20, a0, a1);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (selection.kind === 'gates') {
      // Amplitude travel guide along axis from rest midpoint
      const mx = (obj.x1 + obj.x2) / 2;
      const my = (obj.y1 + obj.y2) / 2;
      const amp = obj.amplitude || 0;
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      if (obj.axis === 'y') {
        ctx.moveTo(mx, my - amp);
        ctx.lineTo(mx, my + amp);
      } else {
        ctx.moveTo(mx - amp, my);
        ctx.lineTo(mx + amp, my);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (selection.kind === 'windmills') {
      const ang = obj.angle || 0;
      const L = obj.armLength || 40;
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(obj.cx, obj.cy);
      ctx.lineTo(obj.cx + Math.cos(ang) * L, obj.cy + Math.sin(ang) * L);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (selection.kind === 'gravityBodies') {
      if (obj.kind === 'moon' && obj.orbitCenter) {
        drawRadiusRing(obj.orbitCenter.x, obj.orbitCenter.y, obj.orbitRadius || 0, 'rgba(80, 220, 255, 0.85)', true);
        // Phase handle already at body; body radius subtle
        drawRadiusRing(obj.x, obj.y, obj.radius || 8, 'rgba(255,255,255,0.35)', false);
      } else {
        drawRadiusRing(obj.x, obj.y, obj.radius || 10, 'rgba(80, 220, 255, 0.9)', false);
        const fr = obj.fieldRadius != null ? obj.fieldRadius : (obj.radius || 10) * 6;
        drawRadiusRing(obj.x, obj.y, fr, 'rgba(180, 120, 255, 0.75)', true);
      }
    }

    // Point / corner / tip handles (skip drop/angle — drawn specially above)
    for (const h of handles) {
      if (h.id === 'drop') continue;
      if (h.id === 'angle') continue; // tip drawn with arrow
      if (h.ring) {
        // Grab nub on the ring
        drawHandleCircle(h.x, h.y, 5, 'rgba(80, 220, 255, 0.95)', '#0a1a22');
        continue;
      }
      if (h.id === 'orbitPhase') {
        drawHandleCircle(h.x, h.y, 6, '#ffe066', '#c48a00');
        continue;
      }
      if (h.kind === 'amplitude' || h.id === 'amplitude') {
        drawHandleCircle(h.x, h.y, 5, '#c8f0a0', '#2a4a10');
        continue;
      }
      if (h.kind === 'endpoint' || h.kind === 'length' || h.kind === 'arm' || h.kind === 'corner') {
        drawHandleSquare(h.x, h.y);
        continue;
      }
      drawHandleCircle(h.x, h.y, 5);
    }
  }

  function drawEditor() {
    D.drawHoleStatic(ctx, hole, {
      time: performance.now() / 1000,
      flagPhase: 0,
    });

    // Selection outlines (do not replace primary wall path — still WALL_DRAW_WIDTH via Draw)
    if (selection) {
      if (selection.kind === 'walls' && hole.walls[selection.index]) {
        strokeSelectionSeg(hole.walls[selection.index]);
      } else if (selection.kind === 'sand' && hole.sand[selection.index]) {
        strokeSelectionRect(hole.sand[selection.index]);
      } else if (selection.kind === 'water' && hole.water[selection.index]) {
        strokeSelectionRect(hole.water[selection.index]);
      } else if (selection.kind === 'boost' && hole.boost[selection.index]) {
        strokeSelectionRect(hole.boost[selection.index]);
      } else if (selection.kind === 'ramps' && hole.ramps[selection.index]) {
        strokeSelectionRamp(hole.ramps[selection.index]);
      } else if (selection.kind === 'sticky' && hole.sticky[selection.index]) {
        strokeSelectionRect(hole.sticky[selection.index]);
      } else if (selection.kind === 'pendulums' && hole.pendulums[selection.index]) {
        const p = hole.pendulums[selection.index];
        strokeSelectionSeg(getPendulumSegment(p));
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, 10, 0, Math.PI * 2);
        ctx.stroke();
      } else if (selection.kind === 'gates' && hole.gates[selection.index]) {
        // Outline rest segment (gizmo amplitude is relative to rest)
        strokeSelectionSeg(hole.gates[selection.index]);
        const live = getSlidingGateSegment(hole.gates[selection.index]);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(live.x1, live.y1);
        ctx.lineTo(live.x2, live.y2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (selection.kind === 'windmills' && hole.windmills[selection.index]) {
        const m = hole.windmills[selection.index];
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(m.cx, m.cy, 14, 0, Math.PI * 2);
        ctx.stroke();
      } else if (selection.kind === 'gravityBodies' && hole.gravityBodies[selection.index]) {
        const b = hole.gravityBodies[selection.index];
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, (b.radius || 10) + 6, 0, Math.PI * 2);
        ctx.stroke();
      }

      drawSelectionGizmos();
    }

    // Editor-only: water drop points (unselected) + moon orbit path
    for (let i = 0; i < hole.water.length; i++) {
      const z = hole.water[i];
      if (!z.dropPoint) continue;
      if (isSel('water', i)) continue; // selected uses gizmo marker
      drawDropMarker(z.dropPoint.x, z.dropPoint.y, false);
    }
    for (const b of hole.gravityBodies) {
      if (b.kind === 'moon' && b.orbitCenter) {
        // Always show faint orbit; selected gizmo draws a stronger ring
        if (!(selection && selection.kind === 'gravityBodies' &&
              hole.gravityBodies[selection.index] === b)) {
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(b.orbitCenter.x, b.orbitCenter.y, b.orbitRadius, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Tee marker (cup/flag already drawn by Draw)
    ctx.fillStyle = isSel('tee') ? '#fff' : 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(hole.tee.x, hole.tee.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.font = '10px sans-serif';
    ctx.fillText('T', hole.tee.x - 3, hole.tee.y + 3);
    if (isSel('cup')) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(hole.cup.x, hole.cup.y, hole.cup.radius + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Placement previews (dashed, not final wall art)
    if (drag && drag.mode === 'place-wall' && placeStart && drag.cur) {
      ctx.strokeStyle = drag.bumper ? '#e6483f' : '#fff';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(placeStart.x, placeStart.y);
      ctx.lineTo(drag.cur.x, drag.cur.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (drag && drag.mode === 'place-rect' && placeStart && drag.cur) {
      const x1 = Math.min(placeStart.x, drag.cur.x), y1 = Math.min(placeStart.y, drag.cur.y);
      const x2 = Math.max(placeStart.x, drag.cur.x), y2 = Math.max(placeStart.y, drag.cur.y);
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
    }

    // Magnet crosshair at active snap target
    if (snapIndicator && mode === 'edit') {
      const sx = snapIndicator.x, sy = snapIndicator.y;
      const arm = 8;
      ctx.strokeStyle = 'rgba(80, 220, 255, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sx - arm, sy);
      ctx.lineTo(sx + arm, sy);
      ctx.moveTo(sx, sy - arm);
      ctx.lineTo(sx, sy + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- Test mode ----
  let draftSnapshot = null;

  function enterTest() {
    const v = validateHole(hole);
    if (!v.ok && v.error === 'over_cap') {
      setStatus('Over cap — fix counts before test: ' + (v.field || ''), true);
      // still allow test of local draft for design
    }
    draftSnapshot = deepCloneHole(hole);
    hole = deepCloneHole(hole);
    resetHoleObstacles(hole);
    testBall = createBallState(hole.tee);
    testState = 'AIMING';
    testStrokes = 0;
    testDrag = { active: false, pointerVec: { x: 0, y: 0 } };
    trajectoryPts = [];
    testPhysAcc = 0;
    mode = 'test';
    testHud.classList.remove('hidden');
    document.getElementById('btn-test').classList.add('hidden');
    document.getElementById('btn-stop-test').classList.remove('hidden');
    setStatus('Test mode — movers freeze only while dragging aim (ghost path)');
  }

  function exitTest() {
    if (draftSnapshot) hole = draftSnapshot;
    draftSnapshot = null;
    mode = 'edit';
    testBall = null;
    trajectoryPts = [];
    testPhysAcc = 0;
    testHud.classList.add('hidden');
    powerEl.classList.add('hidden');
    document.getElementById('btn-test').classList.remove('hidden');
    document.getElementById('btn-stop-test').classList.add('hidden');
    setStatus('Back to edit');
  }

  document.getElementById('btn-test').addEventListener('click', enterTest);
  document.getElementById('btn-stop-test').addEventListener('click', exitTest);

  /** @returns {boolean} true if aim drag started (caller should capture pointer) */
  function handleTestPointerDown(p) {
    if (testState !== 'AIMING') return false;
    if (Math.hypot(p.x - testBall.x, p.y - testBall.y) > 40) return false;
    testDrag.active = true;
    testDrag.pointerVec = { x: 0, y: 0 };
    return true;
  }
  function handleTestPointerMove(p) {
    if (!testDrag.active) return;
    let vx = p.x - testBall.x, vy = p.y - testBall.y;
    const len = Math.hypot(vx, vy);
    if (len > MAX_DRAG_DIST) {
      vx = (vx / len) * MAX_DRAG_DIST;
      vy = (vy / len) * MAX_DRAG_DIST;
    }
    testDrag.pointerVec = { x: vx, y: vy };
    updateTrajectory();
  }
  function handleTestPointerUp() {
    if (!testDrag.active) return;
    testDrag.active = false;
    const clamped = clampDragVector(testDrag.pointerVec);
    trajectoryPts = [];
    powerEl.classList.add('hidden');
    if (!clamped) return;
    const launch = computeLaunchVelocity(clamped);
    const factor = stickyLaunchFactor(testBall, hole);
    latchStickyAfterPutt(testBall, hole);
    noteWetPutt(testBall);
    testBall.vx = launch.vx * factor;
    testBall.vy = launch.vy * factor;
    testBall.z = 0;
    testBall.vz = 0;
    testBall.firedBoosts = new Set();
    testStrokes++;
    testState = 'BALL_MOVING';
    trajectoryPts = [];
    lastGhostKey = '';
    if (testStrokesEl) testStrokesEl.textContent = 'Strokes: ' + testStrokes;
  }

  let lastGhostKey = '';
  let lastGhostAt = 0;

  function updateTrajectory() {
    const clamped = clampDragVector(testDrag.pointerVec);
    if (!clamped) {
      trajectoryPts = [];
      lastGhostKey = '';
      return;
    }
    // Throttle ghost re-sim (full hole clone + hundreds of ticks) to keep Test interactive.
    const key = clamped.x.toFixed(0) + ',' + clamped.y.toFixed(0);
    const now = performance.now();
    if (key === lastGhostKey && now - lastGhostAt < 40 && trajectoryPts.length > 1) {
      // still refresh power label
    } else {
      lastGhostKey = key;
      lastGhostAt = now;
      const launch = computeLaunchVelocity(clamped);
      const factor = stickyLaunchFactor(testBall, hole);
      // Ghost freezes movers (advanceMovers:false) but still runs full stepBallPhysics.
      trajectoryPts = simulateTrajectory(hole, testBall, launch.vx * factor, launch.vy * factor, {
        advanceMovers: false,
        maxTicks: 60 * 5,
        sampleEvery: 3,
      });
    }
    const power = Math.min(clamped.len / MAX_DRAG_DIST, 1);
    powerEl.classList.remove('hidden');
    powerEl.style.left = (testBall.x / LOGICAL_W) * 100 + '%';
    powerEl.style.top = (testBall.y / LOGICAL_H) * 100 + '%';
    powerEl.textContent = power < 0.33 ? 'Gentle' : power < 0.66 ? 'Firm' : power < 0.9 ? 'Strong' : 'MAX';
  }

  /**
   * One fixed physics step while the ball is rolling (or gravity-waking).
   * Mirrors game.js updateBallPhysics events for hazards + rest, without FX/audio.
   */
  function applyTestBallPhysics(dt) {
    const ev = stepBallPhysics(testBall, hole, dt);
    if (ev.water && ev.water.dropPoint) {
      testBall.x = ev.water.dropPoint.x;
      testBall.y = ev.water.dropPoint.y;
      testBall.vx = 0;
      testBall.vy = 0;
      testBall.z = 0;
      testBall.vz = 0;
      testBall.firedBoosts = new Set();
      markWetFromWater(testBall);
      testStrokes++;
      testDrag.active = false;
      trajectoryPts = [];
      testState = 'AIMING';
      return;
    }
    if (ev.blackHole) {
      testBall = createBallState(hole.tee);
      testStrokes++;
      testDrag.active = false;
      trajectoryPts = [];
      testState = 'AIMING';
      return;
    }
    if (ev.holed) {
      setStatus('Holed in ' + testStrokes + ' — Stop test or keep practicing');
      testBall = createBallState(hole.tee);
      resetHoleObstacles(hole);
      testDrag.active = false;
      trajectoryPts = [];
      testState = 'AIMING';
      return;
    }
    const speed = Math.hypot(testBall.vx, testBall.vy);
    if (speed < STOP_THRESHOLD) {
      // Match game.js: keep simulating inside cup magnet or when a well is yanking.
      const nearCup =
        cupHasGravity(hole) &&
        Math.hypot(testBall.x - hole.cup.x, testBall.y - hole.cup.y) < CUP_GRAVITY_RADIUS;
      if (!nearCup && ballMayRestForAim(testBall, hole)) {
        testBall.vx = 0;
        testBall.vy = 0;
        testBall.firedBoosts = new Set();
        testState = 'AIMING';
      }
      // else stay BALL_MOVING (cup divot / gravity settle)
    }
  }

  /**
   * Test frame (same shape as game.js solo update):
   * - one variable-dt step per animation frame (no fixed-accumulator lag/discard)
   * - freeze movers only while drag-aiming (ghost path)
   * - gravity wake: AIMING + field + !ballMayRestForAim → BALL_MOVING
   */
  function updateTest(dt) {
    const hasGravity = (hole.gravityBodies || []).length > 0;

    // Match game.js solo: wake when a field is yanking the ball (cannot rest/aim).
    if (testState === 'AIMING' && hasGravity && !ballMayRestForAim(testBall, hole)) {
      testState = 'BALL_MOVING';
      testDrag.active = false;
      trajectoryPts = [];
      powerEl.classList.add('hidden');
    }

    // Freeze only while human is dragging aim (trajectory ghost), not all of AIMING.
    const freezeMovers = testState === 'AIMING' && testDrag.active;

    if (testState === 'BALL_MOVING') {
      // Same order as game.js solo: obstacles then ball, using frame dt.
      advanceHoleObstacles(hole, dt);
      applyTestBallPhysics(dt);
    } else if (testState === 'AIMING' && !freezeMovers) {
      // Ball at rest, not dragging — world keeps moving so timing is visible.
      advanceHoleObstacles(hole, dt);
    }
    // AIMING + testDrag.active: hold obstacle clock for ghost accuracy.
  }

  function drawTest() {
    // World art only — skip editor selection/gizmos while testing (cheaper + less clutter).
    D.drawHoleStatic(ctx, hole, {
      time: performance.now() / 1000,
      flagPhase: performance.now() / 1000,
    });
    // trajectory
    if (trajectoryPts.length > 1 && testDrag.active) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(trajectoryPts[0].x, trajectoryPts[0].y);
      for (let i = 1; i < trajectoryPts.length; i++) {
        ctx.lineTo(trajectoryPts[i].x, trajectoryPts[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // aim arrow
    if (testDrag.active) {
      const v = testDrag.pointerVec;
      const len = Math.hypot(v.x, v.y) || 1;
      const dirX = -v.x / len, dirY = -v.y / len;
      const power = Math.min(len / MAX_DRAG_DIST, 1);
      const tipX = testBall.x + dirX * (30 + power * 90);
      const tipY = testBall.y + dirY * (30 + power * 90);
      ctx.strokeStyle = power < 0.33 ? '#8be07c' : power < 0.66 ? '#f4d548' : '#f4543f';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(testBall.x, testBall.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }
    // ball
    ctx.fillStyle = '#f4f4f4';
    ctx.beginPath();
    ctx.arc(testBall.x, testBall.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();
  }

  function loop(ts) {
    // Cap frame dt like a typical game loop so a long stall does not detonate physics.
    const dt = Math.min(0.05, lastTime ? (ts - lastTime) / 1000 : 0.016);
    lastTime = ts;
    if (mode === 'test') {
      // Match game.js solo: one variable-dt step per rAF (avoids fixed-step
      // accumulator discard that made Test "grind to a halt" under load).
      updateTest(dt);
      drawTest();
      if (testStrokesEl) testStrokesEl.textContent = 'Strokes: ' + testStrokes;
    } else {
      // P2: shared global clock — advance all movers every frame in edit mode.
      advanceHoleObstacles(hole, dt);
      drawEditor();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
