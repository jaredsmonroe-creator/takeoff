/* Take Off Tool – tap-to-measure square footage from PDF plans. No AI, no pricing. */
(function () {
  'use strict';
  const G = window.TakeoffGeom;
  const $ = id => document.getElementById(id);
  const APP_VERSION = '1.6.0';
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f', '#393b79', '#e7298a'];
  const TYPE_COLOR = { roof: '#d62728', wall: '#1f77b4', gable: '#9467bd', bsmt_ceiling: '#8c564b', bsmt_wall: '#a0522d', garage_ceiling: '#2ca02c', garage_wall: '#17a050', other_area: '#7f7f7f', other_wall: '#555' };
  const FLOORS = ['Main', 'Second', 'Third', 'Bonus', 'Knee wall', 'Basement', 'Garage', 'Other'];
  const DEFAULT_FLOOR = { wall: 'Main', bsmt_wall: 'Basement', garage_wall: 'Garage', other_wall: 'Other' };
  const DEFAULT_HEIGHT = { Main: 9, Second: 9, Third: 8, Bonus: 8, 'Knee wall': 4, Basement: 8, Garage: 10, Other: 8 };
  const SCALES = [
    ['1/16" = 1\'', 1 / 16], ['3/32" = 1\'', 3 / 32], ['1/8" = 1\'', 1 / 8], ['3/16" = 1\'', 3 / 16], ['1/4" = 1\'', 1 / 4],
    ['3/8" = 1\'', 3 / 8], ['1/2" = 1\'', 1 / 2], ['3/4" = 1\'', 3 / 4], ['1" = 1\'', 1], ['1-1/2" = 1\'', 1.5], ['3" = 1\'', 3],
    ['1" = 10\'', 1 / 10], ['1" = 20\'', 1 / 20], ['1" = 30\'', 1 / 30], ['1" = 40\'', 1 / 40], ['1" = 50\'', 1 / 50]
  ];

  const S = {
    pdf: null, page: null, pageNum: 1, pageCount: 0, pageW: 0, pageH: 0, renderScale: 1,
    view: { s: 1, tx: 0, ty: 0 },
    proj: newProject(),
    activeId: null, tool: null, toolPts: [], ortho: false,
    renderTask: null, detailTask: null, detailTimer: 0, panelOpen: true, selPt: null, hist: []
  };
  window.__S = S; // for testing / debugging

  function newProject() { return { app: 'epic-takeoff', version: 1, jobName: '', pdfName: '', scales: {}, items: [], nextId: 1, lastHeights: {}, updated: '' }; }

  /* ---------------- persistence ---------------- */
  const LS_KEY = 'epicTakeoff.project.v1';
  let saveTimer = 0;
  const LP_KEY = 'takeoff_lastPrices';
  function lastPrices() { try { return JSON.parse(localStorage.getItem(LP_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function setLastPrice(type, v) { try { const m = lastPrices(); if (v === null) delete m[type]; else m[type] = v; localStorage.setItem(LP_KEY, JSON.stringify(m)); } catch (e) { } }
  function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { S.proj.updated = new Date().toISOString(); localStorage.setItem(LS_KEY, JSON.stringify(S.proj)); } catch (e) { console.warn(e); } }, 300); }
  function idb() {
    return new Promise((res, rej) => { const r = indexedDB.open('epicTakeoff', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }
  async function idbPut(key, val) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  async function idbGet(key) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('files'); const q = tx.objectStore('files').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }

  /* ---------------- helpers ---------------- */
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms || 2200); }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSF(v) { return v === null || v === undefined || isNaN(v) ? '—' : Math.round(v).toLocaleString() + ' sf'; }
  function scaleOf(page) { return S.proj.scales[page] || null; }
  function activeItem() { return S.proj.items.find(i => i.id === S.activeId) || null; }
  function calc(it) { const sc = scaleOf(it.page); return G.itemCalc(it, sc && sc.ftPerPt); }

  /* ---------------- PDF loading ---------------- */
  async function openPdfBytes(buf, name, keepProject) {
    const bytes = new Uint8Array(buf);
    try { await idbPut('pdf', { name, bytes: bytes.slice() }); } catch (e) { console.warn('could not store pdf', e); }
    clearDetail(); if (S.renderTask) { try { S.renderTask.cancel(); } catch (e) { } }
    if (S.pdf) { const old = S.pdf; S.page = null; S.pdf = null; try { await old.destroy(); } catch (e) { } }
    S.pdf = await pdfjsLib.getDocument({ data: bytes, cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/', isEvalSupported: false }).promise;
    S.pageCount = S.pdf.numPages;
    if (!keepProject) {
      if (S.proj.items.length && S.proj.pdfName && S.proj.pdfName !== name) {
        if (confirm('Start a NEW job for "' + name + '"?\n\nOK = new job (current list is cleared — save it first if needed)\nCancel = keep the current list')) S.proj = newProject();
      }
      S.proj.pdfName = name;
      if (!S.proj.jobName) S.proj.jobName = name.replace(/\.pdf$/i, '');
    }
    $('jobName').value = S.proj.jobName || '';
    $('empty').style.display = 'none';
    autosave();
    await showPage(Math.min(S.pageNum || 1, S.pageCount));
  }

  async function showPage(n) {
    if (!S.pdf) return;
    n = Math.max(1, Math.min(S.pageCount, n));
    S.pageNum = n;
    if (S.renderTask) { try { S.renderTask.cancel(); } catch (e) { } }
    clearDetail();
    const page = await S.pdf.getPage(n);
    S.page = page;
    const vp1 = page.getViewport({ scale: 1 });
    S.pageW = vp1.width; S.pageH = vp1.height;
    // base render: longest side up to 4096px and <= 16M pixels (iPad Safari canvas limit)
    const r = Math.min(4096 / Math.max(S.pageW, S.pageH), Math.sqrt(16e6 / (S.pageW * S.pageH)), 5);
    S.renderScale = r;
    const cv = $('pageCanvas');
    const vp = page.getViewport({ scale: r });
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    cv.style.width = S.pageW + 'px'; cv.style.height = S.pageH + 'px';
    const svg = $('overlay');
    svg.setAttribute('width', S.pageW); svg.setAttribute('height', S.pageH);
    svg.setAttribute('viewBox', '0 0 ' + S.pageW + ' ' + S.pageH);
    updatePageUI();
    fitView();
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    S.renderTask = page.render({ canvasContext: ctx, viewport: vp });
    try { await S.renderTask.promise; } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn(e); }
    S.renderTask = null;
    document.body.dataset.rendered = String(n);
    scheduleDetail();
  }

  /* hi-res render of the visible area when zoomed in past the base render */
  function clearDetail() { clearTimeout(S.detailTimer); if (S.detailTask) { try { S.detailTask.cancel(); } catch (e) { } S.detailTask = null; } $('detailHolder').innerHTML = ''; }
  function scheduleDetail() { clearTimeout(S.detailTimer); S.detailTimer = setTimeout(renderDetail, 280); }
  async function renderDetail() {
    try { await renderDetail2(); } catch (e) { /* page was closed while rendering */ }
  }
  async function renderDetail2() {
    if (!S.page || S.renderTask) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const R = Math.min(S.view.s * dpr, 12);
    if (R <= S.renderScale * 1.15) { $('detailHolder').innerHTML = ''; return; }
    const vpEl = $('viewport'); const W = vpEl.clientWidth, H = vpEl.clientHeight;
    let x0 = Math.max(0, -S.view.tx / S.view.s), y0 = Math.max(0, -S.view.ty / S.view.s);
    let x1 = Math.min(S.pageW, (W - S.view.tx) / S.view.s), y1 = Math.min(S.pageH, (H - S.view.ty) / S.view.s);
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    if (w * R * h * R > 12e6) return;
    if (S.detailTask) { try { S.detailTask.cancel(); } catch (e) { } }
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * R); cv.height = Math.ceil(h * R);
    Object.assign(cv.style, { left: x0 + 'px', top: y0 + 'px', width: (cv.width / R) + 'px', height: (cv.height / R) + 'px' });
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    const vp = S.page.getViewport({ scale: R });
    const task = S.page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0 * R, -y0 * R] });
    S.detailTask = task;
    try { await task.promise; } catch (e) { return; }
    if (S.detailTask !== task) return;
    S.detailTask = null;
    const holder = $('detailHolder'); holder.innerHTML = ''; holder.appendChild(cv);
  }

  /* ---------------- view transform ---------------- */
  function applyView() {
    const v = S.view;
    $('stage').style.transform = 'translate(' + v.tx + 'px,' + v.ty + 'px) scale(' + v.s + ')';
    drawOverlay();
  }
  function fitView() {
    const el = $('viewport'); const W = el.clientWidth, H = el.clientHeight;
    if (!S.pageW || !W) return;
    const s = Math.min(W / S.pageW, H / S.pageH) * 0.97;
    S.view = { s, tx: (W - S.pageW * s) / 2, ty: (H - S.pageH * s) / 2 };
    applyView(); scheduleDetail();
  }
  function zoomAt(cx, cy, factor) {
    const v = S.view; const ns = Math.max(0.05, Math.min(40, v.s * factor)); const f = ns / v.s;
    v.tx = cx - (cx - v.tx) * f; v.ty = cy - (cy - v.ty) * f; v.s = ns;
  }
  function toStage(clientX, clientY) {
    const r = $('viewport').getBoundingClientRect();
    return [(clientX - r.left - S.view.tx) / S.view.s, (clientY - r.top - S.view.ty) / S.view.s];
  }

  /* ---------------- gestures ---------------- */
  const ptrs = new Map();
  let gest = null; // {mode:'pending'|'pan'|'pinch'|'drag', ...}
  function initGestures() {
    const el = $('viewport');
    el.addEventListener('pointerdown', e => {
      if (!S.pdf || (e.target.closest && e.target.closest('#hud button'))) return; // HUD buttons are not plan taps
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (ptrs.size === 1) {
        const hit = hitVertex(e.clientX, e.clientY);
        if (hit && hit.kind === 'm') gest = { mode: 'mid', hit, id: e.pointerId, sx: e.clientX, sy: e.clientY };
        else if (hit) {
          gest = { mode: 'drag', hit, id: e.pointerId, sx: e.clientX, sy: e.clientY, orig: hit.arr[hit.idx].slice(), moved: false };
          if (hit.item) { const g0 = gest; g0.lpTimer = setTimeout(() => { if (gest === g0 && !g0.moved) { g0.long = true; setSel({ id: hit.item.id, si: hit.si, idx: hit.idx }); toast('Point selected – tap 🗑 Delete point to remove it'); } }, 450); }
        } else {
          gest = { mode: 'pending', id: e.pointerId, sx: e.clientX, sy: e.clientY, tx: S.view.tx, ty: S.view.ty, t: Date.now() };
          const seg = hitSegment(e.clientX, e.clientY);
          if (seg) { const g0 = gest; g0.lpTimer = setTimeout(() => {
            if (gest !== g0 || g0.mode !== 'pending' || ptrs.size !== 1) return;
            const arr = insertMid(seg);
            gest = { mode: 'drag', id: g0.id, hit: { kind: 'v', arr, idx: seg.insertAt, item: seg.item, si: seg.si }, moved: true, held: true, sx: g0.sx, sy: g0.sy };
            if (navigator.vibrate) { try { navigator.vibrate(30); } catch (er) { } }
            pulse(g0.sx, g0.sy); drawOverlay(); refreshPanelLive(); updateHud();
          }, 500); }
        }
      } else if (ptrs.size === 2) {
        if (gest && gest.lpTimer) clearTimeout(gest.lpTimer);
        const [a, b] = [...ptrs.values()];
        gest = { mode: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, s0: S.view.s };
      }
      e.preventDefault();
    });
    el.addEventListener('pointermove', e => {
      if (!ptrs.has(e.pointerId) || !gest) return;
      const p = ptrs.get(e.pointerId); p.x = e.clientX; p.y = e.clientY;
      const r = el.getBoundingClientRect();
      if (gest.mode === 'pinch' && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        // pan by centre movement then zoom about centre
        S.view.tx += cx - gest.cx; S.view.ty += cy - gest.cy; gest.cx = cx; gest.cy = cy;
        if (gest.d0 > 10) { const target = gest.s0 * d / gest.d0; zoomAt(cx - r.left, cy - r.top, target / S.view.s); }
        applyView(); scheduleDetail();
      } else if (gest.mode === 'pending' || gest.mode === 'pan') {
        const dx = e.clientX - gest.sx, dy = e.clientY - gest.sy;
        if (gest.mode === 'pending' && gest.lpTimer && Math.hypot(dx, dy) > 6) { clearTimeout(gest.lpTimer); gest.lpTimer = 0; }
        if (gest.mode === 'pending' && Math.hypot(dx, dy) > (e.pointerType === 'pen' ? 6 : 10)) gest.mode = 'pan';
        if (gest.mode === 'pan') { S.view.tx = gest.tx + dx; S.view.ty = gest.ty + dy; applyView(); scheduleDetail(); }
      } else if (gest.mode === 'mid') {
        if (Math.hypot(e.clientX - gest.sx, e.clientY - gest.sy) < (e.pointerType === 'pen' ? 4 : 8)) return;
        const h = gest.hit, arr = insertMid(h);
        gest = { mode: 'drag', id: gest.id, hit: { kind: 'v', arr, idx: h.insertAt, item: h.item, si: h.si }, moved: true, sx: gest.sx, sy: gest.sy };
        gest.hit.arr[gest.hit.idx] = clampPt(toStage(e.clientX, e.clientY));
        drawOverlay(); refreshPanelLive();
      } else if (gest.mode === 'drag') {
        if (gest.long) return;
        if (gest.held) { gest.hit.arr[gest.hit.idx] = clampPt(toStage(e.clientX, e.clientY)); drawOverlay(); refreshPanelLive(); e.preventDefault(); return; }
        if (!gest.moved && Math.hypot(e.clientX - gest.sx, e.clientY - gest.sy) < (e.pointerType === 'pen' ? 4 : 8)) return;
        if (!gest.moved) { clearTimeout(gest.lpTimer); if (gest.hit.item) snapshot(gest.hit.item); }
        gest.moved = true;
        const pt = toStage(e.clientX, e.clientY);
        gest.hit.arr[gest.hit.idx] = clampPt(pt);
        drawOverlay(); updateHud(); if (gest.hit.item) refreshPanelLive();
      }
      e.preventDefault();
    });
    const end = e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (!gest) return;
      if (gest.mode === 'pending' && e.type === 'pointerup' && e.pointerId === gest.id) { onTap(toStage(e.clientX, e.clientY), e.clientX, e.clientY); }
      if (gest.lpTimer) clearTimeout(gest.lpTimer);
      if (gest.mode === 'mid' && e.type === 'pointerup') { const h = gest.hit; insertMid(h); autosave(); renderPanel(); drawOverlay(); toast('Point added – drag it in or out'); }
      if (gest.mode === 'drag') {
        if (gest.long) { /* long-press already selected the point */ }
        else if (gest.held) { S.selPt = { id: gest.hit.item.id, si: gest.hit.si, idx: gest.hit.idx }; autosave(); renderPanel(); drawOverlay(); updateHud(); }
        else if (!gest.moved) { gest.hit.arr[gest.hit.idx] = gest.orig; if (e.type === 'pointerup') onTap(toStage(e.clientX, e.clientY), e.clientX, e.clientY); }
        else { if (gest.hit.item) S.selPt = { id: gest.hit.item.id, si: gest.hit.si, idx: gest.hit.idx }; autosave(); renderPanel(); drawOverlay(); updateHud(); }
      }
      if (ptrs.size === 0) gest = null;
      else if (gest.mode === 'pinch') gest = { mode: 'none' };
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('wheel', e => { e.preventDefault(); const r = el.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); applyView(); scheduleDetail(); }, { passive: false });
    // stop Safari's own pinch-zoom of the whole page
    document.addEventListener('gesturestart', e => e.preventDefault());
    window.addEventListener('resize', () => { if (S.pdf) fitView(); });
  }
  function clampPt(p) { return [Math.max(0, Math.min(S.pageW, p[0])), Math.max(0, Math.min(S.pageH, p[1]))]; }
  function screenDist(p, cx, cy) { const r = $('viewport').getBoundingClientRect(); return Math.hypot(p[0] * S.view.s + S.view.tx + r.left - cx, p[1] * S.view.s + S.view.ty + r.top - cy); }
  /* segments of a shape that get a '+' midpoint handle: [a, b, insertAt]; areas include the closing edge */
  function segments(sh, area) {
    const pts = sh.pts, out = [];
    for (let i = 0; i + 1 < pts.length; i++) out.push([i, i + 1, i + 1]);
    if (area && pts.length >= 3) out.push([pts.length - 1, 0, pts.length]);
    return out.filter(sg => screenLen(pts[sg[0]], pts[sg[1]]) >= 50);
  }
  function screenLen(a, b) { return G.dist(a, b) * S.view.s; }
  function hitVertex(cx, cy) {
    const R = 20; let best = null, bd = R;
    const test = (arr, item, si) => arr.forEach((p, idx) => { const d = screenDist(p, cx, cy); if (d < bd) { bd = d; best = { kind: 'v', arr, idx, item, si }; } });
    if (S.tool) { test(S.toolPts, null); return best; }
    const it = activeItem(); if (!it || it.page !== S.pageNum) return null;
    it.shapes.forEach((sh, si) => test(sh.pts, it, si));
    if (best) return best;
    let bm = 22;
    it.shapes.forEach((sh, si) => segments(sh, G.isArea(it.type)).forEach(sg => {
      const m = G.centroid([sh.pts[sg[0]], sh.pts[sg[1]]]); const d = screenDist(m, cx, cy);
      if (d < bm) { bm = d; best = { kind: 'm', item: it, si, insertAt: sg[2], pt: m }; }
    }));
    return best;
  }
  /* nearest spot on any segment of the selected line (not near a point) within a finger-sized tolerance */
  function hitSegment(cx, cy) {
    if (S.tool) return null;
    const it = activeItem(); if (!it || it.page !== S.pageNum) return null;
    const p = toStage(cx, cy), tol = 22 / S.view.s; let best = null, bd = tol;
    it.shapes.forEach((sh, si) => {
      const pts = sh.pts, segs = [];
      for (let i = 0; i + 1 < pts.length; i++) segs.push([i, i + 1, i + 1]);
      if (G.isArea(it.type) && pts.length >= 3) segs.push([pts.length - 1, 0, pts.length]);
      segs.forEach(sg => {
        const a = pts[sg[0]], b = pts[sg[1]], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        if (!L2) return;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
        const q = [a[0] + t * dx, a[1] + t * dy], d = G.dist(p, q);
        if (d < bd) { bd = d; best = { kind: 's', item: it, si, insertAt: sg[2], pt: q }; }
      });
    });
    return best;
  }
  function pulse(cx, cy) {
    const r = $('viewport').getBoundingClientRect(), d = document.createElement('div');
    d.className = 'pulse'; d.style.left = (cx - r.left) + 'px'; d.style.top = (cy - r.top) + 'px';
    $('viewport').appendChild(d); setTimeout(() => d.remove(), 700);
  }
  function insertMid(h) {
    snapshot(h.item);
    const arr = h.item.shapes[h.si].pts;
    arr.splice(h.insertAt, 0, h.pt.slice());
    S.selPt = { id: h.item.id, si: h.si, idx: h.insertAt };
    return arr;
  }
  function snapshot(it) { S.hist.push({ id: it.id, shapes: JSON.stringify(it.shapes) }); if (S.hist.length > 200) S.hist.shift(); }
  function validSel() {
    const sp = S.selPt, it = activeItem();
    if (!sp || !it || sp.id !== it.id || it.page !== S.pageNum || !it.shapes[sp.si] || !it.shapes[sp.si].pts[sp.idx]) return null;
    return sp;
  }
  function setSel(sp) { S.selPt = sp; drawOverlay(); updateHud(); renderEditor(); }
  function deletePoint() {
    const sp = validSel(); if (!sp) { toast('Press and hold a point to select it first'); return; }
    const it = activeItem(); const sh = it.shapes[sp.si];
    snapshot(it);
    if (sh.autoPt && (sp.idx === 0 || sp.idx === sh.pts.length - 1)) { sh.pts.pop(); sh.autoPt = false; sh.closed = false; if (sp.idx === 0) sh.pts.shift(); }
    else sh.pts.splice(sp.idx, 1);
    if (!sh.pts.length) it.shapes.splice(sp.si, 1);
    else if (G.isArea(it.type) && sh.pts.length < 3) sh.closed = false;
    S.selPt = null;
    autosave(); drawOverlay(); renderPanel(); updateHud();
  }

  /* ---------------- tapping / drawing ---------------- */
  function snapOrtho(prev, p) { if (!S.ortho || !prev) return p; return Math.abs(p[0] - prev[0]) >= Math.abs(p[1] - prev[1]) ? [p[0], prev[1]] : [prev[0], p[1]]; }
  function onTap(pt, cx, cy) {
    if (pt[0] < 0 || pt[1] < 0 || pt[0] > S.pageW || pt[1] > S.pageH) return;
    if (S.tool) {
      if (S.toolPts.length >= 2) S.toolPts = [];
      S.toolPts.push(snapOrtho(S.toolPts[S.toolPts.length - 1], pt));
      drawOverlay(); updateHud();
      if (S.tool === 'calibrate' && S.toolPts.length === 2) setTimeout(askCalibrationLength, 150);
      return;
    }
    const it = activeItem();
    if (!it) { toast('Tap a + button first (Roof, Walls, Garage…)'); return; }
    if (it.page !== S.pageNum) {
      if (it.shapes.some(s => s.pts.length)) { toast('This item is on page ' + it.page + '. Tap Done, then add a new item here.', 3000); return; }
      it.page = S.pageNum;
    }
    if (!scaleOf(S.pageNum)) toast('Scale not set on this page yet – tap 📏 Set Scale', 2500);
    snapshot(it); S.selPt = null; updateHud();
    let sh = it.shapes[it.shapes.length - 1];
    if (!sh || sh.closed) { sh = { pts: [], closed: false }; it.shapes.push(sh); }
    // tap on the first point: closes an area shape / snaps a wall run closed
    if (sh.pts.length >= (G.isArea(it.type) ? 3 : 2) && screenDist(sh.pts[0], cx, cy) < 20) {
      if (!G.isArea(it.type)) { sh.pts.push(sh.pts[0].slice()); sh.autoPt = true; }
      sh.closed = true; toast((G.isArea(it.type) ? 'Section closed.' : 'Wall run closed.') + ' Tap to start another, or tap Done.');
    } else {
      sh.pts.push(snapOrtho(sh.pts[sh.pts.length - 1], pt));
    }
    autosave(); drawOverlay(); renderPanel();
  }

  /* ---------------- auto trace (vector PDFs only, runs on the iPad) ---------------- */
  const segCache = {};
  function spinner(on, msg) {
    let el = $('spin');
    if (!el) { el = document.createElement('div'); el.id = 'spin'; el.innerHTML = '<div class="spinbox"><div class="wheel"></div><div id="spinMsg"></div></div>'; document.body.appendChild(el); }
    el.style.display = on ? 'flex' : 'none'; if (msg) $('spinMsg').textContent = msg;
  }
  const NOT_FOUND = "Couldn't find drawn walls on this page; trace by hand.";
  async function autoTrace(it) {
    if (!S.pdf || !S.page) return;
    if (it.page !== S.pageNum) { if (it.shapes.some(s => s.pts.length)) { toast('This line is on page ' + it.page + '. Go to that page or add a new line here.', 3500); return; } it.page = S.pageNum; }
    const AT = window.TakeoffAuto;
    const pts = [].concat(...it.shapes.map(s => s.pts));
    if (pts.length > 1 && !confirm('Replace the points on "' + it.name + '" with the Auto Trace?')) return;
    spinner(true, 'Finding the walls…');
    await new Promise(r => setTimeout(r, 40));
    const t0 = Date.now();
    try {
      const page = S.page, pn = S.pageNum;
      const ck = (S.pdf.fingerprints ? S.pdf.fingerprints[0] : S.proj.pdfName) + '#' + pn;
      if (!segCache[ck]) { for (const k in segCache) delete segCache[k]; segCache[ck] = { segs: await AT.extract(page, pdfjsLib), text: await AT.textItems(page, pdfjsLib) }; }
      const segs = segCache[ck].segs, text = segCache[ck].text;
      let sc = scaleOf(pn), readScale = false;
      if (!sc) {
        const ts = AT.scaleFromText(await AT.pageText(page));
        if (!ts) { spinner(false); alert('Set the scale first (📏 Set Scale), then tap Auto Trace again.'); return; }
        setScale(pn, 1 / ts.ppf, ts.label + ' (read from page)', ts.label + ' read'); sc = scaleOf(pn); readScale = true;
      }
      const ppf = 1 / sc.ftPerPt;
      // where to look: a single tapped point, else the middle of the screen when zoomed in
      let target = pts.length === 1 ? pts[0] : null;
      if (!target) {
        const el = $('viewport'), vw = el.clientWidth / S.view.s, vh = el.clientHeight / S.view.s;
        if (vw * vh < 0.6 * S.pageW * S.pageH) target = [(el.clientWidth / 2 - S.view.tx) / S.view.s, (el.clientHeight / 2 - S.view.ty) / S.view.s];
      }
      const area = G.isArea(it.type);
      let roofNote = '';
      if (it.type === 'roof' && AT.roofByPitch) { const rt = await roofTrace(it, AT, segs, text, ppf, target, sc, readScale); if (rt === true) return; roofNote = rt || ''; }
      let r = AT.run(segs, S.pageW, S.pageH, { ppf, target, text });
      if (r.error && area && it.type !== 'garage_ceiling') r = AT.runSimple(segs, S.pageW, S.pageH, { ppf, target });
      spinner(false);
      if (r.error) { alert(r.error === 'toobig' ? 'That drawing is too big to trace at this scale – check the scale, or zoom in on one plan and try again.' : NOT_FOUND); return; }
      let shapes = [], note = '';
      const loop = poly => ({ pts: poly.concat([poly[0].slice()]), closed: true, autoPt: true });
      // every wall type: ONE closed loop around the outside face of the exterior walls (garage included)
      if (it.type === 'garage_ceiling' && r.garage) shapes = [{ pts: r.garage, closed: true }];
      else if (area) { shapes = [{ pts: r.building, closed: true }]; if (it.type === 'garage_ceiling') note = ' No separate garage found – this is the whole building outline; move points to the garage.'; }
      else shapes = [loop(r.building)];
      snapshot(it);
      it.shapes = shapes; S.selPt = null;
      autosave(); drawOverlay(); renderPanel(); updateHud();
      const c = calc(it);
      const what = area ? Math.round(c.flat).toLocaleString() + ' sf' : c.lf.toFixed(1) + ' LF';
      zoomToPts(shapes[0].pts);
      const small = Math.max(S.pageW, S.pageH) < 0.9 * 72 * 36 && readScale;
      traceBanner('✨ Auto Trace: <b>' + what + '</b>' + (area ? ' (flat)' : ' outside of walls') + ' — check the outline on the plan.' + esc(note) + roofNote +
        (readScale ? '<br>Scale ' + esc(String(sc.short).replace(/\s*read$/, '')) + ' was read from the page' + (small ? ' – this sheet looks REDUCED, calibrate!' : ' – verify with 📐 Check.') : ''));
      window.__lastTrace = r;
    } catch (e) { console.error(e); spinner(false); alert(NOT_FOUND + '\n(' + e.message + ')'); }
  }

  /* Roof with a pitch picked: trace only the roof faces labelled with that pitch (e.g. 8:12).
     Returns true when it handled the trace (or told him why not); false = fall through to the whole outline. */
  async function roofTrace(it, AT, segs, text, ppf, target, sc, readScale) {
    const others = S.proj.items.filter(o => o.type === 'roof' && o.id !== it.id && o.page === S.pageNum);
    const exclude = [].concat(...others.map(o => o.shapes.filter(sh => sh.pts.length >= 3).map(sh => sh.pts)));
    const r = AT.roofByPitch(segs, S.pageW, S.pageH, { ppf, target, text, pitch: +it.pitch, exclude });
    if (r.error) return false;
    spinner(false);
    const P = +it.pitch + '/12', list = a => (a || []).map(x => x + '/12').join(', ');
    if (r.reason === 'alltaken') { alert('The ' + P + ' roof faces on this page are already in another Roof line (' + others.map(o => o.name).join(', ') + '). Nothing changed.'); return true; }
    const roofPlan = r.pitches && r.pitches.length > 0;
    if (r.mode !== 'pitch' && !roofPlan) { // no pitch labels on this page: the normal whole-outline trace runs, with a note
      return +it.pitch ? '<br>⚠ No pitch labels found on this page – this is the <b>whole outline</b>. Move points or change the pitch.' : '';
    }
    const shapes = r.mode === 'pitch' ? r.sections.map(pts => ({ pts, closed: true })) : [{ pts: r.building, closed: true }];
    snapshot(it); it.shapes = shapes; S.selPt = null;
    autosave(); drawOverlay(); renderPanel(); updateHud();
    const c = calc(it), n = shapes.length;
    zoomToPts([].concat(...shapes.map(sh => sh.pts)));
    let msg;
    if (r.mode !== 'pitch') {
      msg = '✨ Whole roof outline: <b>' + Math.round(c.flat).toLocaleString() + ' sf flat</b>' + (+it.pitch ? ' × ' + G.pitchFactor(it.pitch).toFixed(3) + ' = <b>' + Math.round(c.flat * G.pitchFactor(it.pitch)).toLocaleString() + ' sf</b>' : '') + '.';
      if (+it.pitch) msg += '<br>⚠ No ' + P + ' label found on this roof plan (found ' + list(r.pitches) + ') – so this is the whole roof. Move points or change the pitch.';
      else msg += '<br>Pitches on this plan: ' + list(r.pitches) + ' – pick one on the Roof line to trace just those faces.';
      if (r.porchNear) msg += '<br>A porch roof may be inside this outline – check it.';
    } else {
      msg = '✨ Roof ' + P + ': <b>' + Math.round(c.flat).toLocaleString() + ' sf flat</b> × ' + G.pitchFactor(it.pitch).toFixed(3) + ' = <b>' + Math.round(c.flat * G.pitchFactor(it.pitch)).toLocaleString() + ' sf</b> · ' + n + ' section' + (n === 1 ? '' : 's') + ' (faces labelled ' + P + ').';
      if (r.otherPitches && r.otherPitches.length) msg += '<br>Other pitches on this plan: ' + list(r.otherPitches) + ' – add a Roof line for each.';
      if (r.porchNote) msg += '<br>⚠ This looks like a porch roof – check whether to count it.';
    }
    if (readScale) msg += '<br>Scale ' + esc(String(sc.short).replace(/\s*read$/, '')) + ' was read from the page – verify with 📐 Check.';
    traceBanner(msg + ' Check the outline on the plan.', 20000);
    window.__lastTrace = r;
    return true;
  }
  function zoomToPts(pts) {
    if (!pts || !pts.length) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
    const el = $('viewport'), W = el.clientWidth, H = el.clientHeight, w = Math.max(20, x1 - x0), h = Math.max(20, y1 - y0);
    const s = Math.min(W / w, (H - 90) / h) * 0.85; S.view = { s, tx: W / 2 - (x0 + w / 2) * s, ty: 90 + (H - 90) / 2 - (y0 + h / 2) * s };
    applyView(); scheduleDetail();
  }
  function traceBanner(html, ms) {
    const h = $('hud'); h.innerHTML = '<div id="traceBanner">' + html + ' <button id="tbOk" class="okc">OK</button></div>';
    $('tbOk').onclick = () => { h.innerHTML = ''; updateHud(); };
    clearTimeout(traceBanner._t); traceBanner._t = setTimeout(() => { if ($('traceBanner')) { h.innerHTML = ''; updateHud(); } }, ms || 12000);
  }

  /* ---------------- items ---------------- */
  function addItem(type) {
    if (!S.pdf) { toast('Open a plan first'); return; }
    finishTool();
    const count = S.proj.items.filter(i => i.type === type).length + 1;
    const it = { id: S.proj.nextId++, type, name: G.TYPE_LABELS[type] + (count > 1 ? ' ' + count : ''), page: S.pageNum, shapes: [], qty: 1, adjust: 0, price: (lastPrices()[type] !== undefined ? lastPrices()[type] : null), color: TYPE_COLOR[type] };
    // vary color within same type
    if (count > 1) it.color = COLORS[(S.proj.nextId + 3) % COLORS.length];
    if (type === 'roof') it.pitch = S.proj.lastPitch !== undefined ? S.proj.lastPitch : 6;
    if (G.isLength(type)) {
      it.floor = DEFAULT_FLOOR[type];
      it.height = S.proj.lastHeights[it.floor] !== undefined ? S.proj.lastHeights[it.floor] : DEFAULT_HEIGHT[it.floor];
      if (type === 'wall') it.name = 'Main walls' + (count > 1 ? ' ' + count : '');
    }
    S.proj.items.push(it); S.activeId = it.id; S.selPt = null;
    autosave(); renderPanel(); drawOverlay();
    if (!S.panelOpen) togglePanel(true);
    toast(G.isArea(type) ? 'Tap each corner. Tap the first point to close.' : 'Tap along the wall. Use "New run" for a separate wall.', 2800);
  }
  function deleteItem(id) {
    const it = S.proj.items.find(i => i.id === id); if (!it) return;
    if (!confirm('Delete "' + it.name + '"?')) return;
    S.proj.items = S.proj.items.filter(i => i.id !== id);
    if (S.activeId === id) S.activeId = null;
    autosave(); renderPanel(); drawOverlay();
  }
  function undoPoint() {
    if (S.tool) { S.toolPts.pop(); drawOverlay(); updateHud(); return; }
    const it = activeItem(); if (!it) return;
    S.selPt = null;
    for (let i = S.hist.length - 1; i >= 0; i--) {
      if (S.hist[i].id === it.id) { it.shapes = JSON.parse(S.hist[i].shapes); S.hist.splice(i, 1); autosave(); drawOverlay(); renderPanel(); updateHud(); return; }
    }
    let sh = it.shapes[it.shapes.length - 1];
    if (!sh) return;
    if (sh.closed) { sh.closed = false; if (sh.autoPt) { sh.pts.pop(); sh.autoPt = false; } } else sh.pts.pop();
    if (!sh.pts.length) it.shapes.pop();
    autosave(); drawOverlay(); renderPanel();
  }
  function newSection() {
    const it = activeItem(); if (!it) return;
    const sh = it.shapes[it.shapes.length - 1];
    if (sh && sh.pts.length && !sh.closed) { snapshot(it); sh.closed = true; }
    toast(G.isArea(it.type) ? 'Tap corners of the next section' : 'Tap the start of the next wall run');
    drawOverlay(); renderPanel();
  }
  function selectItem(id) {
    finishTool();
    S.activeId = S.activeId === id ? null : id; S.selPt = null;
    const it = activeItem();
    if (it && it.page !== S.pageNum && it.shapes.length) showPage(it.page);
    renderPanel(); drawOverlay();
  }

  /* ---------------- overlay ---------------- */
  function svgEl(tag, attrs, text) { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; }
  function drawOverlay() {
    const svg = $('overlay'); if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!S.pdf) return;
    const k = 1 / S.view.s; // screen px -> stage units
    S.proj.items.forEach(it => {
      if (it.page !== S.pageNum) return;
      const active = it.id === S.activeId;
      const g = svgEl('g', {});
      it.shapes.forEach((sh, si) => {
        const pts = sh.pts; if (!pts.length) return;
        const ps = pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
        if (G.isArea(it.type)) {
          if (pts.length >= 3) g.appendChild(svgEl('polygon', { points: ps, fill: it.color, 'fill-opacity': active ? 0.28 : 0.18, stroke: it.color, 'stroke-width': active ? 3 : 2, 'vector-effect': 'non-scaling-stroke', 'stroke-dasharray': sh.closed ? '' : '8 4' }));
          else g.appendChild(svgEl('polyline', { points: ps, fill: 'none', stroke: it.color, 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke' }));
        } else {
          g.appendChild(svgEl('polyline', { points: ps, fill: 'none', stroke: it.color, 'stroke-width': active ? 5 : 4, 'stroke-opacity': 0.85, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
        }
        if (active && !S.tool) segments(sh, G.isArea(it.type)).forEach(sg => {
          const m = G.centroid([pts[sg[0]], pts[sg[1]]]);
          g.appendChild(svgEl('circle', { cx: m[0], cy: m[1], r: 11 * k, fill: '#fff', 'fill-opacity': 0.92, stroke: it.color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', class: 'midh' }));
          g.appendChild(svgEl('path', { d: 'M' + (m[0] - 6 * k) + ' ' + m[1] + 'H' + (m[0] + 6 * k) + 'M' + m[0] + ' ' + (m[1] - 6 * k) + 'V' + (m[1] + 6 * k), stroke: it.color, 'stroke-width': 3, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
        });
        const sp = active ? validSel() : null;
        if (active) pts.forEach((p, i) => {
          const sel = sp && sp.si === si && sp.idx === i;
          g.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: (sel ? 12 : i === 0 ? 9 : 7) * k, fill: sel ? '#ff3b30' : i === pts.length - 1 ? '#ffd84d' : '#fff', stroke: sel ? '#fff' : it.color, 'stroke-width': sel ? 3 : 2, 'vector-effect': 'non-scaling-stroke', class: sel ? 'selpt' : 'vtx' }));
        });
      });
      // label
      const all = [].concat(...it.shapes.map(s => s.pts));
      if (all.length) {
        const big = it.shapes.reduce((a, b) => (b.pts.length > a.pts.length ? b : a), it.shapes[0]);
        const c = G.isArea(it.type) && big.pts.length >= 3 ? G.centroid(big.pts) : big.pts[Math.floor((big.pts.length - 1) / 2)];
        const v = calc(it);
        g.appendChild(svgEl('text', { x: c[0], y: c[1], 'font-size': 15 * k, fill: it.color, 'text-anchor': 'middle', 'stroke-width': 3 * k }, it.name + ': ' + fmtSF(v.sf)));
      }
      svg.appendChild(g);
    });
    // tool line (check / calibrate)
    if (S.tool && S.toolPts.length) {
      const col = S.tool === 'calibrate' ? '#ff00aa' : '#ff6a00';
      const ps = S.toolPts.map(p => p.join(',')).join(' ');
      svg.appendChild(svgEl('polyline', { points: ps, fill: 'none', stroke: col, 'stroke-width': 3, 'stroke-dasharray': '10 5', 'vector-effect': 'non-scaling-stroke' }));
      S.toolPts.forEach(p => {
        svg.appendChild(svgEl('line', { x1: p[0] - 14 * k, y1: p[1], x2: p[0] + 14 * k, y2: p[1], stroke: col, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
        svg.appendChild(svgEl('line', { x1: p[0], y1: p[1] - 14 * k, x2: p[0], y2: p[1] + 14 * k, stroke: col, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
        svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: 8 * k, fill: 'none', stroke: col, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
      });
      if (S.toolPts.length === 2 && S.tool === 'measure') {
        const sc = scaleOf(S.pageNum); const c = G.centroid(S.toolPts);
        const txt = sc ? G.fmtFtIn(G.dist(S.toolPts[0], S.toolPts[1]) * sc.ftPerPt, 2) : 'set scale';
        svg.appendChild(svgEl('text', { x: c[0], y: c[1] - 10 * k, 'font-size': 20 * k, fill: col, 'text-anchor': 'middle', 'stroke-width': 4 * k }, txt));
      }
    }
  }

  /* ---------------- HUD (tools) ---------------- */
  function updateHud() {
    const h = $('hud');
    if (!S.tool) {
      if (validSel()) {
        h.innerHTML = '<div>Point selected <button id="hudDelPt" class="danger">🗑 Delete point</button> <button id="hudDesel">✕</button></div>';
        $('hudDelPt').onclick = deletePoint; $('hudDesel').onclick = () => setSel(null);
      } else h.innerHTML = '';
      return;
    }
    const sc = scaleOf(S.pageNum);
    let msg;
    if (S.tool === 'measure') {
      if (S.toolPts.length < 2) msg = '📐 Check scale: tap both ends of a printed dimension' + (S.toolPts.length ? ' (1 of 2)' : '');
      else msg = 'Measured: <b>' + (sc ? G.fmtFtIn(G.dist(S.toolPts[0], S.toolPts[1]) * sc.ftPerPt, 2) : '— set scale first') + '</b> &nbsp;Does it match the plan? Tap again to re-measure.';
    } else {
      msg = '📏 Calibrate: zoom in and tap both ends of a long known dimension' + (S.toolPts.length ? ' (1 of 2)' : '');
      if (S.toolPts.length === 2) msg += ' <button id="hudEnter" class="primary">Enter length</button>';
    }
    h.innerHTML = '<div>' + msg + ' <button id="hudUndo">↶</button> <button id="hudDone" class="okc">Done</button></div>';
    $('hudDone').onclick = finishTool; $('hudUndo').onclick = undoPoint;
    const he = $('hudEnter'); if (he) he.onclick = askCalibrationLength;
  }
  function startTool(t) {
    if (!S.pdf) { toast('Open a plan first'); return; }
    if (S.tool === t) { finishTool(); return; }
    S.tool = t; S.toolPts = []; S.activeId = null;
    $('btnRuler').classList.toggle('on', t === 'measure');
    updateHud(); drawOverlay(); renderPanel();
  }
  function finishTool() { S.tool = null; S.toolPts = []; $('btnRuler').classList.remove('on'); updateHud(); drawOverlay(); }

  /* ---------------- modals ---------------- */
  function modal(html) { $('modalbox').innerHTML = html; $('modal').classList.remove('hidden'); }
  function closeModal() { $('modal').classList.add('hidden'); $('modalbox').innerHTML = ''; }
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  function scaleDialog() {
    if (!S.pdf) { toast('Open a plan first'); return; }
    const cur = scaleOf(S.pageNum);
    const wIn = (S.pageW / 72).toFixed(1), hIn = (S.pageH / 72).toFixed(1);
    let html = '<h3>Scale for page ' + S.pageNum + '</h3>';
    html += '<p>Current: <b>' + (cur ? esc(cur.label) : 'NOT SET') + '</b></p>';
    html += '<p>PDF page size: <b>' + wIn + '" × ' + hIn + '"</b>. Picking a printed scale only works if this is the full-size sheet (24×36, 30×42…). If the plan was shrunk (11×17 etc.) or you\'re not sure, use <b>Calibrate</b>.</p>';
    html += '<button id="scCal" class="primary" style="width:100%">📏 Calibrate – tap 2 points on a known dimension</button>';
    html += '<div class="grid">' + SCALES.map((s, i) => '<button data-sc="' + i + '" class="' + (cur && cur.label === s[0] ? 'sel' : '') + '">' + esc(s[0]) + '</button>').join('') + '</div>';
    const others = Object.keys(S.proj.scales).filter(p => +p !== S.pageNum);
    if (others.length) html += '<p>Copy from: ' + others.map(p => '<button data-copy="' + p + '">Page ' + p + ' (' + esc(S.proj.scales[p].label) + ')</button>').join(' ') + '</p>';
    html += '<div class="actions">' + (cur ? '<button id="scClear" class="danger">Clear scale</button>' : '') + '<button id="scClose">Close</button></div>';
    modal(html);
    $('scClose').onclick = closeModal;
    $('scCal').onclick = () => { closeModal(); startTool('calibrate'); };
    if ($('scClear')) $('scClear').onclick = () => { delete S.proj.scales[S.pageNum]; afterScaleChange(); closeModal(); };
    $('modalbox').querySelectorAll('[data-sc]').forEach(b => b.onclick = () => {
      const s = SCALES[+b.dataset.sc];
      setScale(S.pageNum, G.ftPerPtFromScale(s[1]), s[0]); closeModal();
      toast('Scale set to ' + s[0] + '. Now tap 📐 Check to verify a dimension.', 3500);
    });
    $('modalbox').querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { const o = S.proj.scales[b.dataset.copy]; setScale(S.pageNum, o.ftPerPt, o.label, o.short); closeModal(); toast('Scale copied'); });
  }
  function setScale(page, ftPerPt, label, short) { S.proj.scales[page] = { ftPerPt, label, short: short || label }; afterScaleChange(); }
  function afterScaleChange() { autosave(); updatePageUI(); renderPanel(); drawOverlay(); updateHud(); }

  function askCalibrationLength() {
    if (S.toolPts.length !== 2) return;
    const d = G.dist(S.toolPts[0], S.toolPts[1]);
    if (d < 1) { toast('Points are too close'); return; }
    modal('<h3>How long is that line?</h3><p>Type the dimension printed on the plan, like <b>24\'6"</b>, <b>24 6</b> or <b>24.5</b>.</p>' +
      '<input id="calLen" inputmode="text" autocomplete="off" placeholder="e.g. 32\'4&quot;"><p id="calPrev"></p>' +
      '<div class="actions"><button id="calCancel">Cancel</button><button id="calOk" class="primary">Set scale</button></div>');
    const inp = $('calLen'); setTimeout(() => inp.focus(), 50);
    inp.oninput = () => { const v = G.parseFtIn(inp.value); $('calPrev').textContent = isNaN(v) || v <= 0 ? '' : '= ' + G.fmtFtIn(v, 4) + '  (' + v.toFixed(3) + ' ft)'; };
    $('calCancel').onclick = closeModal;
    $('calOk').onclick = () => {
      const v = G.parseFtIn(inp.value);
      if (isNaN(v) || v <= 0) { toast('Could not read that length'); return; }
      const f = G.ftPerPtFromCalibration(d, v);
      const eq = 1 / (72 * f); // paper inches per foot
      const approx = eq >= 0.0625 ? fracLabel(eq) + '"=1\'' : '1"=' + (1 / eq).toFixed(1) + '\'';
      setScale(S.pageNum, f, 'Calibrated ≈' + approx + ' (from ' + G.fmtFtIn(v) + ' line)', '≈' + approx + ' cal');
      closeModal(); finishTool(); toast('Scale set. Tap 📐 Check on another dimension to verify.', 3500);
    };
  }
  function fracLabel(x) { const d = 64; const n = Math.round(x * d); let a = n, b = d; while (a % 2 === 0 && b % 2 === 0 && b > 1) { a /= 2; b /= 2; } const w = Math.floor(a / b); a -= w * b; return (w ? w + (a ? '-' : '') : '') + (a ? a + '/' + b : (w ? '' : '0')); }

  function pageDialog() {
    if (!S.pdf) return;
    let html = '<h3>Pick a page</h3><div class="grid">';
    for (let i = 1; i <= S.pageCount; i++) { const n = S.proj.items.filter(it => it.page === i && it.shapes.length).length; html += '<button data-pg="' + i + '" class="' + (i === S.pageNum ? 'sel' : '') + '">Page ' + i + (S.proj.scales[i] ? ' ✓' : '') + (n ? '<br><small>' + n + ' items</small>' : '') + '</button>'; }
    html += '</div><p>✓ = scale set</p><div class="actions"><button id="pgClose">Close</button></div>';
    modal(html); $('pgClose').onclick = closeModal;
    $('modalbox').querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { closeModal(); finishTool(); showPage(+b.dataset.pg); });
  }

  function menuDialog() {
    modal('<h3>Save / Share</h3><div class="menu">' +
      '<button id="mCsv" class="primary">⬇︎ Save CSV for Tess (to Files)</button>' +
      '<button id="mShare">📤 Share CSV… (Drive, Mail, Messages)</button>' +
      '<button id="mJson">💾 Save project file (to reopen later)</button>' +
      '<button id="mOpenJson">📂 Open a saved project file</button>' +
      '<button id="mNew" class="danger">🗑 New job (clear list)</button>' +
      '<button id="mHelp">❓ How to use</button>' +
      '</div><p style="font-size:13px">Your work also saves automatically on this iPad. v' + APP_VERSION + '</p><div class="actions"><button id="mClose">Close</button></div>');
    $('mClose').onclick = closeModal;
    $('mCsv').onclick = () => { closeModal(); downloadFile(baseName() + ' takeoff.csv', G.buildCSV(S.proj), 'text/csv'); };
    $('mShare').onclick = () => { closeModal(); shareFile(baseName() + ' takeoff.csv', G.buildCSV(S.proj), 'text/csv'); };
    $('mJson').onclick = () => { closeModal(); downloadFile(baseName() + ' takeoff project.json', JSON.stringify(S.proj, null, 1), 'application/json'); };
    $('mOpenJson').onclick = () => { closeModal(); $('fileJson').click(); };
    $('mNew').onclick = () => { if (!confirm('Clear the list and start a new job? (Save first if you need it.)')) return; S.proj = newProject(); S.activeId = null; if (S.pdf) { S.proj.pdfName = ''; } $('jobName').value = ''; autosave(); closeModal(); renderPanel(); drawOverlay(); updatePageUI(); };
    $('mHelp').onclick = helpDialog;
  }
  function helpDialog() {
    modal('<h3>Take Off Tool – how to use</h3><ol style="line-height:1.55">' +
      '<li><b>📄 Open Plan</b> → pick the PDF from Files or Google Drive.</li>' +
      '<li>Go to the page (◀ ▶ or tap the page button).</li>' +
      '<li><b>📏 Set Scale</b> → pick the scale printed on the sheet, or <b>Calibrate</b>: zoom in, tap both ends of a long dimension, type its length.</li>' +
      '<li><b>📐 Check</b> → tap both ends of another printed dimension. If it matches, you\'re good.</li>' +
      '<li>Tap <b>+ Roof</b> (pick the pitch), <b>+ Walls</b> (pick the floor and wall height), <b>+ Garage Ceiling</b>, etc.</li>' +
      '<li>Tap the corners on the plan. For areas, tap the first point to close it. <b>New section</b> adds another piece to the same line. <b>↶ Undo</b> removes the last point. Drag a white dot to fix it.</li>' +
      '<li><b>Jogs / bump-outs:</b> press and hold anywhere on a line (about half a second) until it pulses, then drag without lifting – a new corner follows your finger. Or tap/drag the <b>+</b> in the middle of a line. To remove a point, press and hold it, then tap <b>🗑 Delete point</b>. Undo works for all of these.</li>' +
      '<li><b>✨ Auto Trace</b> (CAD/vector PDFs, not scans): add a line (Walls, Roof, Garage…) and tap <b>Auto Trace this page</b>. It draws ONE loop around the outside of the exterior walls – garage included – and zooms to it with the LF shown at the top. Move points to take out the garage or porches. Sheet with several plans? Zoom in on the one you want, or tap one spot inside it first. It skips schedules, notes and the title block. Shrunk printouts (11×17): calibrate the scale first. Undo puts it back.</li>' +
      '<li><b>✨ Roof by pitch</b>: on the roof plan page add a Roof line, pick its pitch (e.g. 8/12), then Auto Trace. It traces only the roof faces labelled with that pitch (8:12, 8/12, 7"/12" or a pitch triangle) – one section per area – and skips faces you already put in another Roof line on that page, so do one Roof line per pitch. If it finds no matching label it traces the whole roof outline and says so. Pitch 0/12 (flat / none) = whole outline. Porch roofs get a ⚠ note; always check the faces against the plan.</li>' +
      '<li><b>⊾ Square</b> keeps lines straight up/down or left/right.</li>' +
      '<li>Tap <b>Done</b> when that line is finished.</li>' +
      '<li><b>💾 Save</b> → Save CSV → Files → Google Drive, so Tess can build the quote.</li>' +
      '</ol><p>Move the plan: drag with one finger. Zoom: pinch with two fingers. Place a point: quick tap (finger or Pencil).</p><div class="actions"><button id="hClose" class="primary">Got it</button></div>');
    $('hClose').onclick = closeModal;
  }
  function baseName() { return (S.proj.jobName || 'job').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'job'; }
  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type: type + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    window.__lastDownload = { name, text };
    toast('Saved "' + name + '" – find it in Files → Downloads', 3500);
  }
  async function shareFile(name, text, type) {
    try {
      const file = new File([text], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    downloadFile(name, text, type);
  }

  /* ---------------- panel ---------------- */
  function togglePanel(force) { S.panelOpen = force !== undefined ? force : !S.panelOpen; $('panel').classList.toggle('hidden', !S.panelOpen); setTimeout(() => { if (S.pdf) { applyView(); scheduleDetail(); } }, 50); }
  function pitchOptions(sel) { let o = ''; for (let p = 0; p <= 16; p++) o += '<option value="' + p + '"' + (+sel === p ? ' selected' : '') + '>' + p + '/12' + (p === 0 ? ' (flat / none)' : '') + '</option>'; return o; }
  function floorOptions(sel) { return FLOORS.map(f => '<option' + (f === sel ? ' selected' : '') + '>' + f + '</option>').join(''); }

  function renderEditor() {
    const ed = $('editor'); const it = activeItem();
    if (!it) { ed.innerHTML = ''; return; }
    const c = calc(it);
    const area = G.isArea(it.type);
    let h = '<div class="card" style="border-color:' + it.color + '">';
    h += '<div class="row"><input class="name" id="edName" value="' + esc(it.name) + '"></div>';
    h += '<div class="row sub">' + esc(G.TYPE_LABELS[it.type]) + ' · page ' + it.page + (scaleOf(it.page) ? '' : ' · <b style="color:#c0392b">SCALE NOT SET</b>') + '</div>';
    if (it.type === 'roof') h += '<div class="row"><label>Pitch</label><select id="edPitch">' + pitchOptions(it.pitch) + '</select><span class="sub">× ' + G.pitchFactor(it.pitch).toFixed(3) + '</span></div>';
    if (G.isLength(it.type)) {
      h += '<div class="row"><label>Floor</label><select id="edFloor">' + floorOptions(it.floor) + '</select>';
      h += '<label>Height</label><input id="edHeight" class="short" value="' + esc(G.fmtFtIn(+it.height, 4).replace(/ 0"$/, '')) + '" inputmode="text"></div>';
    }
    h += '<div class="row"><label>Qty ×</label><input id="edQty" class="short" inputmode="decimal" value="' + esc(it.qty) + '">';
    h += '<label>' + (G.isLength(it.type) ? 'Deduct/add sf' : 'Add/deduct sf') + '</label><input id="edAdj" class="short" inputmode="numbers-and-punctuation" value="' + esc(it.adjust || 0) + '"></div>';
    h += '<div class="row"><label>Price $/SF</label><input id="edPrice" class="short" type="text" inputmode="decimal" placeholder="none" value="' + (G.itemPrice(it) === null ? '' : esc(it.price)) + '"><span class="sub" id="edMoney">' + (G.lineTotal(it, c.sf) === null ? '' : '= ' + G.fmtMoney(G.lineTotal(it, c.sf))) + '</span></div>';
    h += '<div class="row"><span class="big" id="edSF">' + fmtSF(c.sf) + '</span><span class="sub" id="edSub">' + subText(it, c) + '</span></div>';
    h += '<button id="edAuto" class="primary" style="width:100%;margin-top:8px">✨ Auto Trace this page</button>';
    h += '<div class="btns"><button id="edUndo">↶ Undo</button><button id="edSec">' + (area ? '＋ New section' : '＋ New run') + '</button><button id="edDone" class="okc">✓ Done</button></div>';
    h += '<div class="btns"><button id="edDelPt"' + (validSel() ? '' : ' disabled style="opacity:.45"') + '>🗑 Delete point</button><span></span><button id="edDel" class="danger">Delete line</button></div>';
    h += '</div>';
    ed.innerHTML = h;
    $('edName').onchange = e => { it.name = e.target.value.trim() || it.name; autosave(); renderList(); drawOverlay(); };
    if ($('edPitch')) $('edPitch').onchange = e => { it.pitch = +e.target.value; S.proj.lastPitch = it.pitch; changed(); };
    if ($('edFloor')) $('edFloor').onchange = e => {
      const oldAuto = it.name.match(/^(Main|Second|Third|Bonus|Knee wall|Basement|Garage|Other) walls/);
      it.floor = e.target.value;
      it.height = S.proj.lastHeights[it.floor] !== undefined ? S.proj.lastHeights[it.floor] : DEFAULT_HEIGHT[it.floor];
      if (oldAuto) it.name = it.name.replace(oldAuto[1], it.floor);
      changed();
    };
    if ($('edHeight')) $('edHeight').onchange = e => { const v = G.parseFtIn(e.target.value); if (isNaN(v) || v < 0) { toast('Type a height like 9\'1"'); renderEditor(); return; } it.height = v; S.proj.lastHeights[it.floor] = v; changed(); };
    $('edQty').onchange = e => { const v = parseFloat(e.target.value); it.qty = isNaN(v) ? 1 : v; changed(); };
    $('edAdj').onchange = e => { const v = parseFloat(e.target.value); it.adjust = isNaN(v) ? 0 : v; changed(); };
    $('edPrice').onchange = e => { const s = e.target.value.replace(/[$,\s]/g, ''); const v = s === '' ? null : parseFloat(s); if (s !== '' && (isNaN(v) || v < 0)) { toast('Type a price like 1.84'); setTimeout(renderEditor, 0); return; } it.price = v; setLastPrice(it.type, v); setTimeout(changed, 0); };
    $('edUndo').onclick = undoPoint; $('edSec').onclick = newSection;
    $('edAuto').onclick = () => autoTrace(it);
    $('edDone').onclick = () => { const sh = it.shapes[it.shapes.length - 1]; if (sh) sh.closed = true; S.activeId = null; S.selPt = null; updateHud(); autosave(); renderPanel(); drawOverlay(); };
    $('edDel').onclick = () => deleteItem(it.id);
    $('edDelPt').onclick = deletePoint;
  }
  function subText(it, c) {
    if (c.noScale) return 'set the scale to see sf';
    const n = it.shapes.filter(s => s.pts.length).length;
    if (G.isArea(it.type)) return 'flat ' + Math.round(c.flat).toLocaleString() + ' sf' + (it.type === 'roof' ? ' · ' + (it.pitch || 0) + '/12' : '') + ' · ' + n + ' section' + (n === 1 ? '' : 's');
    return c.lf.toFixed(1) + ' LF × ' + G.fmtFtIn(+it.height, 4).replace(/ 0"$/, '') + ' · ' + n + ' run' + (n === 1 ? '' : 's');
  }
  function changed() { autosave(); renderPanel(); drawOverlay(); }
  function refreshPanelLive() { const it = activeItem(); if (!it || !$('edSF')) return; const c = calc(it); $('edSF').textContent = fmtSF(c.sf); $('edSub').textContent = subText(it, c); const lt = G.lineTotal(it, c.sf); if ($('edMoney')) $('edMoney').textContent = lt === null ? '' : '= ' + G.fmtMoney(lt); }

  function renderList() {
    const L = $('list');
    if (!S.proj.items.length) { L.innerHTML = '<p class="sub" style="color:#5a6875">No measurements yet. Tap a + button above.</p>'; $('totals').innerHTML = ''; return; }
    const tot = {}; let grand = 0, missing = 0, money = 0, priced = 0;
    L.innerHTML = S.proj.items.map(it => {
      const c = calc(it);
      if (c.sf !== null) { tot[it.type] = (tot[it.type] || 0) + c.sf; grand += c.sf; } else if (it.shapes.length) missing++;
      let det = G.TYPE_LABELS[it.type] + ' · p' + it.page;
      if (it.type === 'roof') det += ' · ' + (it.pitch || 0) + '/12';
      if (G.isLength(it.type)) det += ' · ' + (c.lf === null ? '—' : c.lf.toFixed(1)) + ' LF × ' + G.fmtFtIn(+it.height).replace(/ 0"$/, '');
      else if (c.flat !== null) det += ' · flat ' + Math.round(c.flat);
      const lt = G.lineTotal(it, c.sf); if (lt !== null) { money += lt; priced++; det += ' · $' + G.itemPrice(it) + '/sf = ' + G.fmtMoney(lt); }
      return '<div class="item' + (it.id === S.activeId ? ' active' : '') + '" data-id="' + it.id + '"><span class="sw" style="background:' + it.color + '"></span><span class="nm"><b>' + esc(it.name) + '</b><small>' + esc(det) + '</small></span><span class="val">' + fmtSF(c.sf) + '</span></div>';
    }).join('');
    L.querySelectorAll('.item').forEach(el => el.onclick = () => selectItem(+el.dataset.id));
    let th = Object.keys(G.TYPE_LABELS).filter(t => tot[t] !== undefined).map(t => '<div class="t"><span>' + G.TYPE_LABELS[t] + '</span><b>' + fmtSF(tot[t]) + '</b></div>').join('');
    th += '<div class="t g"><span>Total</span><span>' + fmtSF(grand) + '</span></div>';
    if (priced) th += '<div class="t g"><span>Total $ (' + priced + ' priced line' + (priced === 1 ? '' : 's') + ')</span><span>' + G.fmtMoney(money) + '</span></div>';
    if (missing) th += '<p style="color:#c0392b">' + missing + ' item(s) need a scale on their page.</p>';
    $('totals').innerHTML = th;
  }
  function renderPanel() { renderEditor(); renderList(); }
  function updatePageUI() {
    $('btnPage').textContent = S.pdf ? 'Page ' + S.pageNum + '/' + S.pageCount : 'Page –';
    const sc = scaleOf(S.pageNum);
    const b = $('btnScale');
    const lab = sc ? (sc.short || sc.label) : ''; b.textContent = sc ? '📏 ' + (lab.length > 18 ? lab.slice(0, 16) + '…' : lab) : '📏 Set Scale';
    b.classList.toggle('warn', !sc);
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    $('btnOpen').onclick = () => $('filePdf').click();
    $('filePdf').onchange = async e => {
      const f = e.target.files[0]; if (!f) return; e.target.value = '';
      toast('Loading ' + f.name + '…', 5000);
      try { S.pageNum = 1; await openPdfBytes(await f.arrayBuffer(), f.name); pageDialogIfMany(); }
      catch (err) { console.error(err); alert('Could not open that PDF: ' + err.message); }
    };
    $('fileJson').onchange = async e => {
      const f = e.target.files[0]; if (!f) return; e.target.value = '';
      try {
        const p = JSON.parse(await f.text());
        if (!p || !Array.isArray(p.items)) throw new Error('not a takeoff project file');
        S.proj = Object.assign(newProject(), p); S.activeId = null; autosave();
        $('jobName').value = S.proj.jobName || '';
        renderPanel(); drawOverlay(); updatePageUI();
        toast('Project loaded' + (S.proj.pdfName ? ' – open the plan "' + S.proj.pdfName + '" if it isn\'t showing' : ''), 4000);
      } catch (err) { alert('Could not open project: ' + err.message); }
    };
    $('btnPrev').onclick = () => { finishTool(); showPage(S.pageNum - 1); };
    $('btnNext').onclick = () => { finishTool(); showPage(S.pageNum + 1); };
    $('btnPage').onclick = pageDialog;
    $('btnScale').onclick = scaleDialog;
    $('btnRuler').onclick = () => startTool('measure');
    $('btnOrtho').onclick = () => { S.ortho = !S.ortho; $('btnOrtho').classList.toggle('on', S.ortho); toast(S.ortho ? 'Square ON: lines snap level/plumb' : 'Square OFF'); };
    $('btnFit').onclick = fitView;
    $('btnPanel').onclick = () => togglePanel();
    $('btnMenu').onclick = menuDialog;
    $('jobName').onchange = e => { S.proj.jobName = e.target.value.trim(); autosave(); };
    document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addItem(b.dataset.add));
  }
  function pageDialogIfMany() { if (S.pageCount > 1) pageDialog(); }

  async function restore() {
    try { const p = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (p && Array.isArray(p.items)) S.proj = Object.assign(newProject(), p); } catch (e) { }
    $('jobName').value = S.proj.jobName || '';
    renderPanel(); updatePageUI();
    try {
      const f = await idbGet('pdf');
      if (f && f.bytes && (!S.proj.pdfName || f.name === S.proj.pdfName)) { await openPdfBytes(f.bytes.buffer ? f.bytes : new Uint8Array(f.bytes), f.name, true); toast('Reopened ' + f.name); }
    } catch (e) { console.warn('restore pdf failed', e); }
  }

  // test hook: lets an automated test load a PDF from a URL
  window.__openPdfUrl = async (url, name) => { const r = await fetch(url); await openPdfBytes(await r.arrayBuffer(), name || url.split('/').pop()); };
  window.__api = { zoomToPts, autoTrace, addItem, onTap, setScale, showPage, startTool, finishTool, askCalibrationLength, fitView, G };

  wire(); initGestures(); restore();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
