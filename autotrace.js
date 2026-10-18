/* Take Off Tool – Auto Trace. Finds the drawn exterior walls in a vector PDF page (no AI, runs in the browser).
   Port of the PC tool's "drawn-wall tracing" (read_plan.py update 8): wall lines = a line weight drawn as parallel pairs,
   rasterised on a 0.5 ft grid, gaps closed, outside flood-filled, garage found as the big open bay next to the house.
   The traced loop is the OUTSIDE FACE of the exterior walls (what Tess measures), snapped to the drawn lines. */
(function (root) {
  const AT = {};

  /* ---------- 1. vector segments from pdf.js ---------- */
  AT.extract = async function (page, pdfjsLib) {
    const OPS = pdfjsLib.OPS, ol = await page.getOperatorList();
    const vp = page.getViewport({ scale: 1 }), VT = vp.transform;
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0], lw = 1, sc = [0, 0], fc = [0, 0]; const stack = [];
    const col = a => { const r = +a[0], g = +a[1], b = +a[2]; return [(0.299 * r + 0.587 * g + 0.114 * b) / 255, Math.max(r, g, b) - Math.min(r, g, b) > 40 ? 1 : 0]; };
    const segs = []; let path = [];
    const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
    const PAINT = new Set([...STROKE, OPS.fill, OPS.eoFill, OPS.endPath]);
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i];
      if (fn === OPS.save) stack.push([ctm, lw, sc, fc]);
      else if (fn === OPS.restore) { const s = stack.pop(); if (s) { ctm = s[0]; lw = s[1]; sc = s[2]; fc = s[3]; } }
      else if (fn === OPS.setStrokeRGBColor) sc = col(a);
      else if (fn === OPS.setFillRGBColor) fc = col(a);
      else if (fn === OPS.transform) ctm = mul(ctm, a);
      else if (fn === OPS.setLineWidth) lw = a[0];
      else if (fn === OPS.setGState) { (a[0] || []).forEach(kv => { if (kv[0] === 'LW') lw = kv[1]; }); }
      else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, lw, sc, fc]); if (a[0]) ctm = mul(ctm, a[0]); }
      else if (fn === OPS.paintFormXObjectEnd) { const s = stack.pop(); if (s) { ctm = s[0]; lw = s[1]; sc = s[2]; fc = s[3]; } }
      else if (fn === OPS.constructPath) {
        const ops = a[0], co = a[1]; let k = 0, cx = 0, cy = 0, sx = 0, sy = 0;
        const M = mul(VT, ctm), T = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
        for (const op of ops) {
          if (op === OPS.moveTo) { cx = sx = co[k++]; cy = sy = co[k++]; }
          else if (op === OPS.lineTo) { const x = co[k++], y = co[k++]; path.push([T(cx, cy), T(x, y)]); cx = x; cy = y; }
          else if (op === OPS.curveTo) { k += 4; cx = co[k++]; cy = co[k++]; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { k += 2; cx = co[k++]; cy = co[k++]; }
          else if (op === OPS.closePath) { if (cx !== sx || cy !== sy) path.push([T(cx, cy), T(sx, sy)]); cx = sx; cy = sy; }
          else if (op === OPS.rectangle) {
            const x = co[k++], y = co[k++], w = co[k++], h = co[k++];
            const p = [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)];
            for (let q = 0; q < 4; q++) path.push([p[q], p[(q + 1) % 4]]);
            cx = sx = x; cy = sy = y;
          }
        }
        path._w = lw * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
      }
      if (PAINT.has(fn)) {
        if (STROKE.has(fn) && path.length) { const w = Math.round((path._w || 0) * 100) / 100; for (const s of path) segs.push([s[0][0], s[0][1], s[1][0], s[1][1], w, sc[0], 0, sc[1]]); }
        else if ((fn === OPS.fill || fn === OPS.eoFill) && path.length && fc[0] < 0.6 && !fc[1]) { for (const s of path) segs.push([s[0][0], s[0][1], s[1][0], s[1][1], -1, fc[0], 1, 0]); } // dark wall poché
        path = [];
      }
    }
    return segs;
  };
  AT.pageText = async function (page) { const tc = await page.getTextContent(); return tc.items.map(t => t.str).join(' '); };
  /* text positions (page coords) – used to skip schedules / notes / title blocks */
  AT.textItems = async function (page, pdfjsLib) {
    const tc = await page.getTextContent(), VT = page.getViewport({ scale: 1 }).transform, out = [];
    for (const t of tc.items) {
      if (!t.str || !t.str.trim()) continue; const m = pdfjsLib.Util.transform(VT, t.transform);
      // centre of the text box: origin + half the width along the baseline + ~0.35 font size "up"
      const fs = Math.hypot(m[2], m[3]) || 1, ax = Math.hypot(m[0], m[1]) || 1, dx = m[0] / ax, dy = m[1] / ax, ux = m[2] / fs, uy = m[3] / fs;
      const w = (t.width || 0) * (Math.hypot(VT[0], VT[1]) || 1);
      out.push([m[4], m[5], t.str.trim().length, t.str, m[4] + dx * w / 2 + ux * fs * 0.35, m[5] + dy * w / 2 + uy * fs * 0.35, fs]);
    }
    return out;
  };
  /* points-per-foot from a printed note like 1/4" = 1'-0" (most common one on the page) */
  AT.scaleFromText = function (txt) {
    const re = /(\d+)\s*\/\s*(\d+)\s*(?:"|”|''|IN\.?)\s*(?:=|[-–]{1,3})\s*1\s*(?:'|’|FT)/g; const cnt = {}; let m;
    const t = String(txt || '').toUpperCase(); while ((m = re.exec(t))) { const k = m[1] + '/' + m[2]; cnt[k] = (cnt[k] || 0) + 1; }
    const keys = Object.keys(cnt).filter(k => +k.split('/')[1] > 0); if (!keys.length) return null;
    // details are drawn at bigger scales (3/4", 1 1/2") – the plan itself uses the smallest scale on the sheet
    const best = keys.sort((a, b) => (a.split('/')[0] / a.split('/')[1]) - (b.split('/')[0] / b.split('/')[1]))[0].split('/');
    if (+best[1] === 0) return null;
    return { ppf: 72 * best[0] / best[1], label: best[0] + '/' + best[1] + '" = 1\'' };
  };

  /* ---------- 2. which lines are walls ---------- */
  function linesByWeight(segs, W, H) {
    const thr = 0.006 * Math.max(W, H), g = new Map();
    for (const s of segs) {
      const [x1, y1, x2, y2, w0, lum, fill, colored] = s;
      if (colored || (!fill && lum > 0.45)) continue; // grey grid lines, orange/red dimensions
      const w = fill ? 'F' : w0;
      if ((Math.abs(x1 - x2) < 0.3 || Math.abs(y1 - y2) < 0.3) && Math.hypot(x2 - x1, y2 - y1) > thr) { if (!g.has(w)) g.set(w, []); g.get(w).push(s); }
    }
    return g;
  }
  function bbox(ls) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const s of ls) { a = Math.min(a, s[0], s[2]); b = Math.min(b, s[1], s[3]); c = Math.max(c, s[0], s[2]); d = Math.max(d, s[1], s[3]); } return [a, b, c, d]; }
  function pickWalls(segs, W, H) {
    const out = [];
    for (const [w, ls] of linesByWeight(segs, W, H)) {
      if (ls.length < 12) continue;
      const ls2 = ls.filter(s => Math.hypot(s[2] - s[0], s[3] - s[1]) < 0.6 * Math.min(W, H));
      if (ls2.length < 12) continue;
      const bb = bbox(ls2); if (bb[2] - bb[0] > 0.9 * W && bb[3] - bb[1] > 0.9 * H) continue;
      out.push([w, ls2, bb]);
    }
    return out.sort((a, b) => b[0] - a[0]);
  }
  function pairInfo(ls, long_) {
    const maxsp = 0.006 * long_, Hs = [], Vs = []; let tot = 0;
    for (const s of ls) {
      if (Math.abs(s[1] - s[3]) < 0.3) Hs.push([s[1], Math.min(s[0], s[2]), Math.max(s[0], s[2])]); else Vs.push([s[0], Math.min(s[1], s[3]), Math.max(s[1], s[3])]);
    }
    [...Hs, ...Vs].forEach(l => tot += l[2] - l[1]);
    const hist = new Map(); let paired = 0;
    for (const grp of [Hs, Vs]) {
      grp.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < grp.length; i++) for (let j = i + 1; j < grp.length; j++) {
        const d = grp[j][0] - grp[i][0]; if (d > maxsp) break; if (d < 0.5) continue;
        const ov = Math.min(grp[i][2], grp[j][2]) - Math.max(grp[i][1], grp[j][1]);
        if (ov > 0 && ov > 0.3 * Math.min(grp[i][2] - grp[i][1], grp[j][2] - grp[j][1])) { const k = Math.round(d * 10) / 10; hist.set(k, (hist.get(k) || 0) + ov); paired += ov; }
      }
    }
    let peak = null, pv = -1; for (const [k, v] of hist) if (v > pv) { pv = v; peak = k; }
    return [tot ? paired / tot : 0, peak, tot];
  }
  /* wall lines: the THICKEST dark line weight (or dark filled wall poché) drawn as parallel pairs with enough length.
     Thin lines (tables, schedules, notes, grids, dimensions) only win when nothing thicker qualifies. */
  AT.chooseWalls = function (segs, W, H, ppf, keep) {
    const long_ = Math.max(W, H), good = [], minLen = ppf ? 60 * ppf : 0.3 * long_;
    for (const [w, ls0] of pickWalls(segs, W, H)) {
      const ls = keep ? ls0.filter(keep) : ls0;
      if (ls.length < (w === 'F' ? 12 : 30) || w === 0) continue;
      const [pf, peak, tot] = pairInfo(ls, long_);
      if (pf >= 0.35 && pf <= 1 && peak && tot >= minLen) good.push([tot, w, ls, peak]);
    }
    if (!good.length) return null;
    const thick = g => (g[1] === 'F' ? 1e3 : g[1]);
    good.sort((a, b) => thick(b) - thick(a) || b[0] - a[0]);
    const cands = good.map(g => g[1] + ':' + Math.round(g[0] / (ppf || 1)));
    // one option per weight, thickest first; each also takes the other weights drawn at the same wall spacing
    return good.map((g0, i) => {
      const [tot, w, ls0, peak] = g0; let ls = ls0.slice();
      good.forEach((g, j) => { if (j !== i && Math.abs(g[3] - peak) <= 0.35 * peak && g[0] > 0.3 * tot) ls = ls.concat(g[2]); });
      return { w, ls, bb: bbox(ls), cands };
    });
  };
  /* title block / sheet-border strips: long dark border lines near any edge of the sheet (works for rotated sheets too).
     Returns the box that still holds the drawing [x0, y0, x1, y1]. */
  AT.titleBox = function (segs, W, H) {
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (const s of segs) {
      if (s[6] || s[7] || s[5] > 0.45) continue;
      if (Math.abs(s[0] - s[2]) < 0.5 && Math.abs(s[3] - s[1]) > 0.6 * H) {
        const x = s[0];
        if (x > 0.8 * W && x < 0.985 * W && x < x1) x1 = x;
        if (x < 0.2 * W && x > 0.015 * W && x > x0) x0 = x;
      } else if (Math.abs(s[1] - s[3]) < 0.5 && Math.abs(s[2] - s[0]) > 0.6 * W) {
        const y = s[1];
        if (y > 0.8 * H && y < 0.985 * H && y < y1) y1 = y;
        if (y < 0.2 * H && y > 0.015 * H && y > y0) y0 = y;
      }
    }
    return [x0, y0, x1, y1];
  };
  AT.titleCut = function (segs, W, H) { return AT.titleBox(segs, W, H)[2]; };
  /* separate drawings on one sheet by empty bands */
  AT.split = function (ls, gap) {
    const split1 = (ls, ax) => {
      const iv = ls.map(s => ax ? [Math.min(s[0], s[2]), Math.max(s[0], s[2]), s] : [Math.min(s[1], s[3]), Math.max(s[1], s[3]), s]).sort((a, b) => a[0] - b[0]);
      const gs = []; let cur = [], end = null;
      for (const [s0, e0, s] of iv) { if (end !== null && s0 > end + gap) { gs.push(cur); cur = []; end = null; } cur.push(s); end = end === null ? e0 : Math.max(end, e0); }
      if (cur.length) gs.push(cur); return gs;
    };
    let out = []; for (const g of split1(ls, true)) out = out.concat(split1(g, false));
    return out.filter(g => g.length >= 20);
  };

  /* ---------- 3. grid morphology ---------- */
  function dil(m, W, H, k) {
    const r = new Uint8Array(W * H), o = new Uint8Array(W * H), pre = new Int32Array(Math.max(W, H));
    for (let j = 0; j < H; j++) {
      let d = 1e9, b = j * W;
      for (let i = 0; i < W; i++) { d = m[b + i] ? 0 : d + 1; pre[i] = d; }
      d = 1e9; for (let i = W - 1; i >= 0; i--) { d = m[b + i] ? 0 : d + 1; if (Math.min(d, pre[i]) <= k) r[b + i] = 1; }
    }
    for (let i = 0; i < W; i++) {
      let d = 1e9;
      for (let j = 0; j < H; j++) { d = r[j * W + i] ? 0 : d + 1; pre[j] = d; }
      d = 1e9; for (let j = H - 1; j >= 0; j--) { d = r[j * W + i] ? 0 : d + 1; if (Math.min(d, pre[j]) <= k) o[j * W + i] = 1; }
    }
    return o;
  }
  const inv = m => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o; };
  const closing = (m, W, H, k) => inv(dil(inv(dil(m, W, H, k)), W, H, k));
  const opening = (m, W, H, k) => dil(inv(dil(inv(m), W, H, k)), W, H, k);
  function insideMask(g, W, H, k) {
    const closed = closing(g, W, H, k), out = new Uint8Array(W * H), q = new Int32Array(W * H); let h = 0, t = 0;
    q[t++] = 0; out[0] = 1;
    while (h < t) {
      const p = q[h++], x = p % W, y = (p - x) / W;
      const nb = [x + 1 < W ? p + 1 : -1, x > 0 ? p - 1 : -1, y + 1 < H ? p + W : -1, y > 0 ? p - W : -1];
      for (const n of nb) if (n >= 0 && !out[n] && !closed[n]) { out[n] = 1; q[t++] = n; }
    }
    return inv(out);
  }
  function components(m, W, H) {
    const seen = new Uint8Array(W * H), comps = [], q = new Int32Array(W * H);
    for (let s = 0; s < W * H; s++) {
      if (!m[s] || seen[s]) continue;
      let h = 0, t = 0; q[t++] = s; seen[s] = 1;
      while (h < t) {
        const p = q[h++], x = p % W, y = (p - x) / W;
        if (x + 1 < W && m[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; q[t++] = p + 1; }
        if (x > 0 && m[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; q[t++] = p - 1; }
        if (y + 1 < H && m[p + W] && !seen[p + W]) { seen[p + W] = 1; q[t++] = p + W; }
        if (y > 0 && m[p - W] && !seen[p - W]) { seen[p - W] = 1; q[t++] = p - W; }
      }
      comps.push(q.slice(0, t));
    }
    return comps;
  }
  const largest = cs => cs.reduce((a, b) => (b.length > a.length ? b : a), cs[0] || new Int32Array(0));

  /* ---------- 4. measure + trace ---------- */
  AT.analyze = function (ls, ppf, opt) {
    opt = opt || {};
    if (opt.simple) return simpleOutline(ls, ppf);
    const cell = 0.5, c = cell * ppf, pad = Math.floor(10 / cell) + 3;
    const bb = bbox(ls), x0 = bb[0], y0 = bb[1];
    const W = Math.floor((bb[2] - x0) / c) + 2 * pad + 1, H = Math.floor((bb[3] - y0) / c) + 2 * pad + 1;
    if (W * H > 4e6) return { error: 'too big' };
    const g = new Uint8Array(W * H);
    for (const s of ls) {
      if (Math.abs(s[0] - s[2]) >= 0.3 && Math.abs(s[1] - s[3]) >= 0.3) { // diagonal: step along it
        const L = Math.hypot(s[2] - s[0], s[3] - s[1]), n = Math.ceil(L / (c * 0.5)) + 1;
        for (let q = 0; q <= n; q++) { const x = s[0] + (s[2] - s[0]) * q / n, y = s[1] + (s[3] - s[1]) * q / n; g[(Math.floor((y - y0) / c) + pad) * W + Math.floor((x - x0) / c) + pad] = 1; }
        continue;
      }
      let i0 = Math.floor((s[0] - x0) / c) + pad, i1 = Math.floor((s[2] - x0) / c) + pad, j0 = Math.floor((s[1] - y0) / c) + pad, j1 = Math.floor((s[3] - y0) / c) + pad;
      if (i0 > i1) [i0, i1] = [i1, i0]; if (j0 > j1) [j0, j1] = [j1, j0];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) g[j * W + i] = 1;
    }
    const house = insideMask(g, W, H, Math.round((opt.closeFt || 3) / cell));
    const hc = largest(components(house, W, H));
    const hs = new Uint8Array(W * H); hc.forEach(p => hs[p] = 1);
    const big = insideMask(g, W, H, Math.round(9.5 / cell));
    let cand = new Uint8Array(W * H); for (let p = 0; p < W * H; p++) cand[p] = big[p] && !hs[p] ? 1 : 0;
    const op = opening(cand, W, H, Math.round(4 / cell)); for (let p = 0; p < W * H; p++) cand[p] = cand[p] && op[p];
    const a = cell * cell;
    const gars = components(cand, W, H).filter(cc => cc.length * a >= 200 && cc.length * a <= 1600);
    const gc = gars.length ? largest(gars) : new Int32Array(0);
    const gs = new Uint8Array(W * H); gc.forEach(p => gs[p] = 1);
    let U = new Uint8Array(W * H); for (let p = 0; p < W * H; p++) U[p] = hs[p] || gs[p] ? 1 : 0;
    const uc = largest(components(U, W, H)); U = new Uint8Array(W * H); uc.forEach(p => U[p] = 1);
    const near = gc.length ? dil(gs, W, H, 3) : new Uint8Array(W * H);
    let fpCells = 0; for (let p = 0; p < W * H; p++) if (U[p] && !gs[p]) fpCells++;
    const kk = Math.round(4 / cell), cl = closing(U, W, H, kk); for (let p = 0; p < W * H; p++) if (cl[p]) U[p] = 1;
    let tot = 0, gout = 0;
    for (let p = 0; p < W * H; p++) if (U[p]) {
      const x = p % W, y = (p - x) / W;
      const outs = (x + 1 >= W || !U[p + 1]) + (x <= 0 || !U[p - 1]) + (y + 1 >= H || !U[p + W]) + (y <= 0 || !U[p - W]);
      tot += outs; if (near[p]) gout += outs;
    }
    const toPt = (i, j) => [x0 + (i - pad) * c, y0 + (j - pad) * c];
    const loop = outerLoop(U, W, H, near);
    if (!loop) return { error: 'no loop' };
    const res = {
      footprint: fpCells * a, building_perim: tot * cell, house_ext: (tot - gout) * cell,
      garage_area: gc.length * a, garage_out: gout * cell, hasGarage: gc.length > 0, cellPt: c, ppf
    };
    // corners of the whole building outline (outside face), snapped onto the drawn lines
    const tol = 1.2 * c, simp = l => snapToLines(simplifyClosed(l.map(v => toPt(v[0], v[1])), 0.7 * c), ls, tol);
    res.building = simp(loop.pts);
    // wall runs split into house vs garage portions
    res.houseRuns = []; res.garageRuns = [];
    if (res.hasGarage) {
      const lp = loop.pts.map(v => toPt(v[0], v[1]));
      splitByFlags(res.building, lp, loop.gar, 0.5 * ppf).forEach(r => (r.gar ? res.garageRuns : res.houseRuns).push(r.pts));
      const gl = outerLoop(gs, W, H, null);
      if (gl) res.garage = snapToLines(simplifyClosed(gl.pts.map(v => toPt(v[0], v[1])), 0.7 * c), ls, tol);
    }
    return res;
  };
  /* boundary of a mask as directed unit edges (clockwise on screen), chained into loops; returns the biggest */
  function outerLoop(M, W, H, flag) {
    const out = new Map(); // vertex key -> list of [toKey, gar]
    const key = (i, j) => j * (W + 1) + i;
    const add = (a, b, gar) => { if (!out.has(a)) out.set(a, []); out.get(a).push([b, gar]); };
    for (let p = 0; p < W * H; p++) if (M[p]) {
      const i = p % W, j = (p - i) / W, gar = flag ? !!flag[p] : false;
      if (j === 0 || !M[p - W]) add(key(i, j), key(i + 1, j), gar);
      if (i + 1 >= W || !M[p + 1]) add(key(i + 1, j), key(i + 1, j + 1), gar);
      if (j + 1 >= H || !M[p + W]) add(key(i + 1, j + 1), key(i, j + 1), gar);
      if (i === 0 || !M[p - 1]) add(key(i, j + 1), key(i, j), gar);
    }
    let best = null, bestA = 0;
    for (const [start] of out) {
      if (!out.get(start).length) continue;
      const pts = [], gar = []; let v = start, guard = 0;
      do {
        const lst = out.get(v); if (!lst || !lst.length) break;
        const [to, g] = lst.pop(); pts.push([v % (W + 1), Math.floor(v / (W + 1))]); gar.push(g); v = to;
      } while (v !== start && ++guard < 1e7);
      if (pts.length < 4) continue;
      let A = 0; for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; A += p[0] * q[1] - q[0] * p[1]; }
      if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = { pts, gar }; }
    }
    return best;
  }
  /* split a closed unit-edge loop into runs of house (gar=false) / garage (gar=true) edges */
  function splitRuns(loop) {
    const n = loop.pts.length, g = loop.gar;
    let s = 0; while (s < n && g[s] === g[(s - 1 + n) % n]) s++;
    if (s === n) return [{ gar: g[0], pts: loop.pts.concat([loop.pts[0]]) }];
    const runs = []; let cur = null;
    for (let k = 0; k < n; k++) {
      const idx = (s + k) % n;
      if (!cur || cur.gar !== g[idx]) { if (cur) cur.pts.push(loop.pts[idx]); cur = { gar: g[idx], pts: [loop.pts[idx]] }; runs.push(cur); }
      else cur.pts.push(loop.pts[idx]);
    }
    cur.pts.push(loop.pts[s]);
    // drop tiny runs (< 3 unit edges) by merging them into neighbours
    return runs.filter(r => r.pts.length > 3 || runs.length === 1);
  }
  /* cut the snapped building polygon where the outline changes from house walls to garage walls */
  function splitByFlags(poly, lp, flags, snapDist) {
    const n = lp.length, P = poly.map(p => p.slice()), J = [];
    for (let k = 0; k < n; k++) if (flags[k] !== flags[(k - 1 + n) % n]) J.push(lp[k]);
    if (!J.length) return [{ gar: flags[0], pts: P.concat([P[0].slice()]) }];
    const proj = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)); return [a[0] + t * dx, a[1] + t * dy]; };
    const marks = new Set();
    for (const j of J) {
      let bi = 0, bd = 1e18, bq = null;
      for (let i = 0; i < P.length; i++) { const q = proj(j, P[i], P[(i + 1) % P.length]); const d = Math.hypot(q[0] - j[0], q[1] - j[1]); if (d < bd) { bd = d; bi = i; bq = q; } }
      const a = P[bi], b = P[(bi + 1) % P.length];
      if (Math.hypot(bq[0] - a[0], bq[1] - a[1]) < snapDist) marks.add(a);
      else if (Math.hypot(bq[0] - b[0], bq[1] - b[1]) < snapDist) marks.add(b);
      else { P.splice(bi + 1, 0, bq); marks.add(bq); }
    }
    const idx = P.map((p, i) => (marks.has(p) ? i : -1)).filter(i => i >= 0);
    const flagAt = p => { let bd = 1e18, f = false; for (let k = 0; k < n; k++) { const a = lp[k], b = lp[(k + 1) % n]; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; const d = Math.hypot(m[0] - p[0], m[1] - p[1]); if (d < bd) { bd = d; f = flags[k]; } } return f; };
    const runs = [];
    for (let r = 0; r < idx.length; r++) {
      const s0 = idx[r], s1 = idx[(r + 1) % idx.length], pts = [];
      for (let i = s0; ; i = (i + 1) % P.length) { pts.push(P[i].slice()); if (i === s1 && pts.length > 1) break; if (pts.length > P.length + 1) break; }
      if (pts.length < 2) continue;
      // classify by the point halfway along the run
      let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      let acc = 0, mid = pts[0];
      for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc + d >= L / 2) { const t = (L / 2 - acc) / (d || 1); mid = [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])]; break; } acc += d; }
      runs.push({ gar: flagAt(mid), pts, L });
    }
    // merge neighbouring runs with the same flag
    const out = [];
    for (const r of runs) { const last = out[out.length - 1]; if (last && last.gar === r.gar) last.pts = last.pts.concat(r.pts.slice(1)); else out.push(r); }
    if (out.length > 1 && out[0].gar === out[out.length - 1].gar) { const f = out.pop(); out[0].pts = f.pts.concat(out[0].pts.slice(1)); }
    return out;
  }
  function dpOpen(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1; const A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-9;
      for (let i = a + 1; i < b; i++) { const d = L > 1e-9 ? Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L : Math.hypot(pts[i][0] - A[0], pts[i][1] - A[1]); if (d > md) { md = d; mi = i; } }
      if (md > tol && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((p, i) => keep[i]);
  }
  function simplifyOpen(pts, tol) { return dpOpen(pts, tol); }
  function simplifyClosed(pts, tol) {
    // split at the two farthest-apart points, simplify both halves
    let far = 0, fd = -1; for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
    const h1 = dpOpen(pts.slice(0, far + 1), tol), h2 = dpOpen(pts.slice(far).concat([pts[0]]), tol);
    const out = h1.concat(h2.slice(1, -1));
    // remove collinear vertices (incl. the split points)
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const p = out[(i - 1 + out.length) % out.length], q = out[i], r = out[(i + 1) % out.length];
      const cr = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
      if (Math.abs(cr) > 1e-6 * (1 + Math.hypot(r[0] - p[0], r[1] - p[1]) ** 2)) res.push(q);
    }
    return res;
  }
  /* move each axis-parallel edge onto the nearest drawn wall line (outer face) within tol */
  function snapToLines(poly, ls, tol, open) {
    const P = poly.map(p => p.slice()), n = P.length, m = open ? n - 1 : n;
    for (let k = 0; k < m; k++) {
      const A = P[k], B = P[(k + 1) % n], horiz = Math.abs(A[1] - B[1]) < 1e-6, vert = Math.abs(A[0] - B[0]) < 1e-6;
      if (!horiz && !vert) continue;
      const lo = horiz ? Math.min(A[0], B[0]) : Math.min(A[1], B[1]), hi = horiz ? Math.max(A[0], B[0]) : Math.max(A[1], B[1]), pos = horiz ? A[1] : A[0];
      // total overlap of parallel drawn lines at each nearby position (outer faces are often broken by windows/doors)
      const acc = new Map();
      for (const s of ls) {
        const sh = Math.abs(s[1] - s[3]) < 0.3; if (sh !== horiz) continue;
        const sp = horiz ? s[1] : s[0]; if (Math.abs(sp - pos) > tol) continue;
        const s0 = horiz ? Math.min(s[0], s[2]) : Math.min(s[1], s[3]), s1 = horiz ? Math.max(s[0], s[2]) : Math.max(s[1], s[3]);
        const ov = Math.min(hi, s1) - Math.max(lo, s0); if (ov <= 0) continue;
        const kq = Math.round(sp * 4) / 4; acc.set(kq, (acc.get(kq) || 0) + ov);
      }
      let best = null, bd = tol;
      for (const [sp, ov] of acc) { if (ov < 0.25 * (hi - lo)) continue; const d = Math.abs(sp - pos); if (d < bd) { bd = d; best = sp; } }
      if (best !== null) { if (horiz) { A[1] = best; B[1] = best; } else { A[0] = best; B[0] = best; } }
    }
    return P;
  }

  /* outline of the biggest closed shape drawn with one line weight (roof plans: eaves + hips, single lines) */
  function simpleOutline(ls, ppf) {
    const cell = 0.5, c = cell * ppf, pad = 6, bb = bbox(ls), x0 = bb[0], y0 = bb[1];
    const W = Math.floor((bb[2] - x0) / c) + 2 * pad + 1, H = Math.floor((bb[3] - y0) / c) + 2 * pad + 1;
    if (W * H > 4e6) return { error: 'too big' };
    const g = new Uint8Array(W * H);
    for (const s of ls) {
      const L = Math.hypot(s[2] - s[0], s[3] - s[1]), n = Math.ceil(L / (c * 0.5)) + 1;
      for (let q = 0; q <= n; q++) { const x = s[0] + (s[2] - s[0]) * q / n, y = s[1] + (s[3] - s[1]) * q / n; g[(Math.floor((y - y0) / c) + pad) * W + Math.floor((x - x0) / c) + pad] = 1; }
    }
    const ins = insideMask(g, W, H, 2), comp = largest(components(ins, W, H));
    const M = new Uint8Array(W * H); comp.forEach(p => M[p] = 1);
    const loop = outerLoop(M, W, H, null); if (!loop) return { error: 'no loop' };
    const toPt = (i, j) => [x0 + (i - pad) * c, y0 + (j - pad) * c];
    const poly = snapToLines(simplifyClosed(loop.pts.map(v => toPt(v[0], v[1])), 0.7 * c), ls, 1.2 * c);
    return { building: poly, footprint: comp.length * cell * cell, houseRuns: [], garageRuns: [], hasGarage: false, ppf, simple: true };
  }
  /* fallback for area lines when no wall pairs exist (e.g. a roof plan): try each heavy line weight */
  AT.runSimple = function (segs, W, H, opts) {
    const long_ = Math.max(W, H), thr = 0.006 * long_, ppf = opts.ppf, byW = new Map(), tb = AT.titleBox(segs, W, H);
    const pool = [], tot = new Map();
    for (const s of segs) { const L = Math.hypot(s[2] - s[0], s[3] - s[1]); if (Math.min(s[0], s[2]) > tb[0] + 2 && Math.max(s[0], s[2]) < tb[2] - 2 && Math.min(s[1], s[3]) > tb[1] + 2 && Math.max(s[1], s[3]) < tb[3] - 2 && !s[6] && !s[7] && L > thr && L < 0.9 * Math.max(W, H) && s[4] > 0) { pool.push(s); tot.set(s[4], (tot.get(s[4]) || 0) + L); } }
    // roof edges, hips and ridges are often drawn in two or three heavy weights: try "this weight and everything heavier"
    const ws = [...tot.keys()].filter(w => tot.get(w) > 20 * ppf).sort((a, b) => b - a);
    for (const w of ws) byW.set(w, pool.filter(s => s[4] >= w - 1e-6));
    const all = [], labels = opts.labels || [];
    for (const [w, ls0] of byW) {
      if (ls0.length < 8) continue;
      const parts = AT.split(ls0, 0.02 * long_).filter(p => p.length >= 8);
      if (!parts.length) continue;
      parts.sort((a, b) => b.length - a.length);
      for (const ls of parts.slice(0, 4)) {
        const b = bbox(ls);
        if (b[0] < Math.max(tb[0] + 4, 0.015 * W) || b[2] > Math.min(tb[2] - 4, 0.985 * W) || b[1] < Math.max(tb[1] + 4, 0.015 * H) || b[3] > Math.min(tb[3] - 4, 0.985 * H)) continue; // title block / sheet border
        const r = simpleOutline(ls, ppf); if (r.error || r.footprint < 200) continue;
        const pageSf = W * H / (ppf * ppf); if (r.footprint > 0.5 * pageSf) continue;
        // tier: tapped/visible spot inside first, then (roof plans) the number of pitch labels inside the shape
        const tIn = opts.target && G_inPoly(opts.target, r.building) ? 1 : 0;
        const tDist = opts.target ? Math.hypot(Math.max(b[0] - opts.target[0], 0, opts.target[0] - b[2]), Math.max(b[1] - opts.target[1], 0, opts.target[1] - b[3])) : 0;
        const nLab = labels.filter(l => G_inPoly([l.x, l.y], r.building)).length;
        all.push(Object.assign(r, { tIn, tDist, nLab, score: r.footprint, weight: w, nlines: ls.length, parts: parts.length, ls }));
      }
    }
    if (!all.length) return { error: 'nowalls' };
    const tier = r => r.tIn * 1e6 + Math.min(r.nLab, 999) * 1e3 - Math.min(r.tDist, 999);
    // keep the best drawing (tier), then the thickest line weight whose closed shape is nearly as big as the biggest one
    // (roof edges/hips are drawn heavier than shingle hatching or the floor plan underneath)
    const bt = Math.max(...all.map(tier)), same = all.filter(r => tier(r) >= bt - 50 || (r.tIn && bt >= 1e6));
    const top = Math.max(...same.map(r => r.footprint));
    const ok = same.filter(r => r.footprint >= 0.6 * top).sort((a, b) => b.weight - a.weight || b.footprint - a.footprint);
    const best = ok[0]; best.cands = all.map(r => r.weight + ':' + Math.round(r.footprint) + (r.nLab ? 'L' + r.nLab : '')).join(',');
    return best;
  };
  function G_inPoly(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }

  /* ---------- 5. one call for the app ---------- */
  // opts: {ppf, target:[x,y]|null}
  // opts: {ppf, target:[x,y]|null, text:[[x,y,nChars]]}
  AT.run = function (segs, W, H, opts) {
    const tb = AT.titleBox(segs, W, H), cut = tb[2];
    const keep = s => Math.min(s[0], s[2]) > tb[0] + 2 && Math.max(s[0], s[2]) < tb[2] - 2 && Math.min(s[1], s[3]) > tb[1] + 2 && Math.max(s[1], s[3]) < tb[3] - 2;
    const opts2 = AT.chooseWalls(segs, W, H, opts.ppf, keep);
    if (!opts2) return { error: 'nowalls' };
    for (const sel of opts2.slice(0, 5)) { const r = tryWalls(sel, W, H, opts); if (r) { r.weight = sel.w; r.cands = sel.cands; r.titleCut = cut; return r; } }
    return { error: 'nowalls' };
  };
  function tryWalls(sel, W, H, opts) {
    // separate drawings sit far apart; wide window/door openings inside one building must not split it
    let parts = AT.split(sel.ls, Math.max(0.02 * Math.max(W, H), 8 * opts.ppf)).filter(p => p.length >= 12);
    if (!parts.length) return null;
    // drop schedules / notes: boxes packed with text (characters per square inch of paper); drop sheet-size frames
    const text = opts.text || [];
    const dens = p => { const b = bbox(p), a = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]) / 5184); let n = 0; for (const t of text) if (t[0] >= b[0] && t[0] <= b[2] && t[1] >= b[1] && t[1] <= b[3]) n += t[2]; return n / a; };
    let cands = parts.map(p => ({ p, d: dens(p), b: bbox(p) })).filter(x => x.d < 60 && !((x.b[2] - x.b[0]) > 0.8 * W && (x.b[3] - x.b[1]) > 0.8 * H));
    cands.sort((a, b) => b.p.length - a.p.length); cands = cands.slice(0, 6);
    let best = null;
    for (const c of cands) {
      const r = AT.analyze(c.p, opts.ppf);
      if (r.error || r.footprint < 150) continue;
      r.textDensity = Math.round(c.d); r.parts = parts.length;
      const b = c.b, t = opts.target;
      const dist = t ? Math.hypot(Math.max(b[0] - t[0], 0, t[0] - b[2]), Math.max(b[1] - t[1], 0, t[1] - b[3])) : 0;
      const area = G_area(r.building);
      if (!best || dist < best.dist - 1e-6 || (Math.abs(dist - best.dist) < 1e-6 && area > best.area)) best = { r, dist, area };
    }
    return best ? best.r : null;
  }
  function G_area(P) { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }


  /* ---------- 6. roof planes by pitch label ---------- */
  /* pitch labels from text items: "8:12", "8/12", "8 12", or a pitch triangle drawn as separate "8" and "12" */
  AT.pitchLabels = function (text) {
    const out = [], singles = [], twelves = [], porch = [];
    for (const t of text || []) {
      const str = (t[3] || '').trim(); if (!str) continue;
      const cx = t[4], cy = t[5], fs = t[6] || 8;
      if (/PORCH/i.test(str)) porch.push([cx, cy]);
      const IN = '\\s*(?:"|”|\'\'|IN\\.?)?\\s*';
      let m = str.match(new RegExp('(?:^|[^\\d./])(\\d{1,2}(?:\\.\\d+)?)' + IN + '[:\\/]\\s*12' + IN + '(?![\\d\'’])')) || str.match(/^(\d{1,2}(?:\.\d+)?)\s+12$/);
      if (m && +m[1] > 0 && +m[1] <= 24) { out.push({ x: cx, y: cy, rise: +m[1], str }); continue; }
      if (/^12$/.test(str)) twelves.push({ x: cx, y: cy, fs });
      else if (/^\d{1,2}(\.\d+)?$/.test(str) && +str > 0 && +str <= 24) singles.push({ x: cx, y: cy, fs, v: +str });
    }
    const used = new Set();
    for (const tw of twelves) {
      let best = null, bd = 4 * tw.fs;
      singles.forEach((sg, i) => { if (used.has(i)) return; const d = Math.hypot(sg.x - tw.x, sg.y - tw.y); if (d < bd) { bd = d; best = i; } });
      if (best !== null) { used.add(best); const sg = singles[best]; out.push({ x: (sg.x + tw.x) / 2, y: (sg.y + tw.y) / 2, rise: sg.v, str: sg.v + ' / 12 (triangle)', tri: true }); }
    }
    return { labels: out, porch };
  };
  /* signed loops of a mask (outer loops one orientation, holes the other) */
  function allLoops(M, W, H) {
    const out = new Map(), key = (i, j) => j * (W + 1) + i;
    const add = (a, b) => { if (!out.has(a)) out.set(a, []); out.get(a).push(b); };
    for (let p = 0; p < W * H; p++) if (M[p]) {
      const i = p % W, j = (p - i) / W;
      if (j === 0 || !M[p - W]) add(key(i, j), key(i + 1, j));
      if (i + 1 >= W || !M[p + 1]) add(key(i + 1, j), key(i + 1, j + 1));
      if (j + 1 >= H || !M[p + W]) add(key(i + 1, j + 1), key(i, j + 1));
      if (i === 0 || !M[p - 1]) add(key(i, j + 1), key(i, j));
    }
    const loops = [];
    for (const [start] of out) {
      while (out.get(start).length) {
        const pts = []; let v = start, guard = 0;
        do { const l = out.get(v); if (!l || !l.length) break; const to = l.pop(); pts.push([v % (W + 1), Math.floor(v / (W + 1))]); v = to; } while (v !== start && ++guard < 1e7);
        if (pts.length < 4) continue;
        let A = 0; for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; A += a[0] * b[1] - b[0] * a[1]; }
        loops.push({ pts, A: A / 2 });
      }
    }
    return loops;
  }
  /* join holes to their outer loop through a zero-width slit so one simple point list carries the hole */
  function keyhole(outer, holes) {
    let P = outer.slice();
    for (const h of holes) {
      let bi = 0, bj = 0, bd = 1e18;
      for (let i = 0; i < P.length; i++) for (let j = 0; j < h.length; j++) { const d = (P[i][0] - h[j][0]) ** 2 + (P[i][1] - h[j][1]) ** 2; if (d < bd) { bd = d; bi = i; bj = j; } }
      const hr = h.slice(bj).concat(h.slice(0, bj + 1));
      P = P.slice(0, bi + 1).concat(hr, [P[bi].slice()], P.slice(bi + 1));
    }
    return P;
  }
  /*
   * opts: {ppf, target, text (AT.textItems), pitch (rise per 12, 0 = whole roof), exclude: [[pts]] (taken by other Roof lines)}
   * returns {building, sections:[pts], faces:[...], mode:'pitch'|'whole', reason, pitches, otherPitches, porchNote}
   */
  AT.roofByPitch = function (segs, W, H, opts) {
    const { labels, porch } = AT.pitchLabels(opts.text);
    const base = AT.runSimple(segs, W, H, Object.assign({}, opts, { labels }));
    if (base.error) return base;
    const res = Object.assign({}, base, { mode: 'whole', sections: [base.building], faces: [] });
    const ppf = opts.ppf, outl = base.building, ls = base.ls || [];
    const inOut = labels.filter(l => G_inPoly([l.x, l.y], outl));
    res.pitches = [...new Set(inOut.map(l => l.rise))].sort((a, b) => b - a);
    const lb = bbox(ls);
    res.porchNear = porch.some(p => p[0] > lb[0] - 15 * ppf && p[0] < lb[2] + 15 * ppf && p[1] > lb[1] - 15 * ppf && p[1] < lb[3] + 15 * ppf);
    if (!opts.pitch) { res.reason = 'nopitch'; return res; }
    if (!inOut.length) { res.reason = 'nolabels'; return res; }
    // grid of roof faces: cells inside the outline, cut by the roof lines (eaves, ridges, hips, valleys)
    const cell = 0.25, c = cell * ppf, pad = 3, ob = bbox(outl.map(p => [p[0], p[1], p[0], p[1]]));
    const x0 = ob[0] - pad * c, y0 = ob[1] - pad * c, GW = Math.ceil((ob[2] - ob[0]) / c) + 2 * pad, GH = Math.ceil((ob[3] - ob[1]) / c) + 2 * pad;
    if (GW * GH > 6e6) return Object.assign(res, { reason: 'toobig' });
    const g = new Uint8Array(GW * GH);
    for (const s of ls) {
      const L = Math.hypot(s[2] - s[0], s[3] - s[1]), n = Math.ceil(L / (c * 0.5)) + 1;
      for (let q = 0; q <= n; q++) { const x = s[0] + (s[2] - s[0]) * q / n, y = s[1] + (s[3] - s[1]) * q / n, i = Math.floor((x - x0) / c), j = Math.floor((y - y0) / c); if (i >= 0 && j >= 0 && i < GW && j < GH) g[j * GW + i] = 1; }
    }
    const gl = dil(g, GW, GH, 1), M = new Uint8Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) if (G_inPoly([x0 + (i + 0.5) * c, y0 + (j + 0.5) * c], outl)) M[j * GW + i] = 1;
    const free = new Uint8Array(GW * GH); for (let p = 0; p < GW * GH; p++) free[p] = M[p] && !gl[p] ? 1 : 0;
    const comps = components(free, GW, GH).filter(cc => cc.length * cell * cell >= 3);
    const own = new Int32Array(GW * GH).fill(-1), q = new Int32Array(GW * GH); let h = 0, t = 0;
    comps.forEach((cc, k) => cc.forEach(p => { own[p] = k; q[t++] = p; }));
    while (h < t) { // hand the line cells to the neighbouring faces (half each side)
      const p = q[h++], x = p % GW, y = (p - x) / GW;
      for (const n of [x + 1 < GW ? p + 1 : -1, x > 0 ? p - 1 : -1, y + 1 < GH ? p + GW : -1, y > 0 ? p - GW : -1]) if (n >= 0 && M[n] && own[n] < 0) { own[n] = own[p]; q[t++] = n; }
    }
    const cellOf = (x, y) => { const i = Math.floor((x - x0) / c), j = Math.floor((y - y0) / c); return i >= 0 && j >= 0 && i < GW && j < GH ? j * GW + i : -1; };
    const faces = comps.map(() => ({ cells: 0, labels: [], porch: false, taken: 0, sx: 0, sy: 0 }));
    for (let p = 0; p < GW * GH; p++) if (own[p] >= 0) { const f = faces[own[p]], x = p % GW; f.cells++; f.sx += x; f.sy += (p - x) / GW; }
    for (const l of inOut) { const p = cellOf(l.x, l.y); if (p >= 0 && own[p] >= 0) faces[own[p]].labels.push(l.rise); }
    for (const pp of porch) { const p = cellOf(pp[0], pp[1]); if (p >= 0 && own[p] >= 0) faces[own[p]].porch = true; }
    faces.forEach(f => {
      f.area = f.cells * cell * cell; f.cx = x0 + (f.sx / f.cells + 0.5) * c; f.cy = y0 + (f.sy / f.cells + 0.5) * c;
      if (f.labels.length) { const cnt = {}; f.labels.forEach(r => cnt[r] = (cnt[r] || 0) + 1); f.pitch = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0]; f.labelled = true; }
    });
    // unlabelled faces take the pitch of the nearest label (distance from the label to the face itself)
    const bestD = faces.map(() => 1e18);
    for (let p = 0; p < GW * GH; p++) {
      const k = own[p]; if (k < 0 || faces[k].labelled) continue;
      const x = p % GW, y = (p - x) / GW, px = x0 + (x + 0.5) * c, py = y0 + (y + 0.5) * c;
      for (const l of inOut) { const d = (px - l.x) ** 2 + (py - l.y) ** 2; if (d < bestD[k]) { bestD[k] = d; faces[k].pitch = l.rise; } }
    }
    // faces already covered by other Roof lines on this page
    const ex = opts.exclude || [];
    if (ex.length) for (let p = 0; p < GW * GH; p++) if (own[p] >= 0) { const x = p % GW, y = (p - x) / GW; if ((x + y) % 2) continue; const pt = [x0 + (x + 0.5) * c, y0 + (y + 0.5) * c]; if (ex.some(P => G_inPoly(pt, P))) faces[own[p]].taken += 2; }
    faces.forEach(f => { f.taken = f.taken > 0.5 * f.cells; });
    const sel = faces.map(f => f.pitch === opts.pitch && !f.taken);
    res.faces = faces.map(f => ({ area: +f.area.toFixed(1), pitch: f.pitch, labelled: !!f.labelled, porch: f.porch, taken: f.taken, cx: f.cx, cy: f.cy }));
    if (!sel.some(Boolean)) { res.reason = faces.some(f => f.pitch === opts.pitch) ? 'alltaken' : 'nomatch'; return res; }
    const S = new Uint8Array(GW * GH); for (let p = 0; p < GW * GH; p++) if (own[p] >= 0 && sel[own[p]]) S[p] = 1;
    // corners: snap to roof-line endpoints / outline corners
    const corners = []; for (const s of ls) corners.push([s[0], s[1]], [s[2], s[3]]); outl.forEach(p => corners.push(p));
    const snap = P => P.map(p => { let b = null, bd = (1.25 * ppf) ** 2; for (const k of corners) { const d = (k[0] - p[0]) ** 2 + (k[1] - p[1]) ** 2; if (d < bd) { bd = d; b = k; } } return b ? [b[0], b[1]] : p; });
    const clean = P => { const o = []; for (const p of P) { const l = o[o.length - 1]; if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 0.05) o.push(p); } if (o.length > 1 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) < 0.05) o.pop(); return o; };
    const toPt = v => [x0 + v[0] * c, y0 + v[1] * c];
    const sections = [];
    for (const cc of components(S, GW, GH)) {
      if (cc.length * cell * cell < 3) continue;
      const m1 = new Uint8Array(GW * GH); cc.forEach(p => m1[p] = 1);
      const loops = allLoops(m1, GW, GH); if (!loops.length) continue;
      loops.sort((a, b) => Math.abs(b.A) - Math.abs(a.A));
      const outer = loops[0], sg = Math.sign(outer.A);
      const fix = l => clean(snap(simplifyClosed(l.pts.map(toPt), 1.6 * c)));
      const holes = loops.slice(1).filter(l => Math.sign(l.A) !== sg && Math.abs(l.A) * cell * cell >= 6).map(fix).filter(P => P.length >= 3);
      const O = fix(outer); if (O.length < 3) continue;
      sections.push(holes.length ? keyhole(O, holes) : O);
    }
    if (!sections.length) { res.reason = 'nomatch'; return res; }
    res.mode = 'pitch'; res.sections = sections;
    res.porchNote = faces.some((f, k) => sel[k] && f.porch) || (res.porchNear && opts.pitch === Math.min(...res.pitches) && res.pitches.length > 1);
    res.otherPitches = res.pitches.filter(r => r !== opts.pitch);
    return res;
  };

  root.TakeoffAuto = AT;
  if (typeof module !== 'undefined' && module.exports) module.exports = AT;
})(typeof window !== 'undefined' ? window : globalThis);
