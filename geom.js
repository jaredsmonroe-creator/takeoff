/* Takeoff geometry + units. Pure functions, no DOM. Works in browser and Node (for tests). */
(function (root) {
  const G = {};

  G.AREA_TYPES = ['roof', 'gable', 'bsmt_ceiling', 'garage_ceiling', 'other_area'];
  G.LENGTH_TYPES = ['wall', 'bsmt_wall', 'garage_wall', 'other_wall'];
  G.TYPE_LABELS = {
    roof: 'Roof', wall: 'Walls', gable: 'Gable', bsmt_ceiling: 'Basement ceiling',
    bsmt_wall: 'Basement walls', garage_ceiling: 'Garage ceiling', garage_wall: 'Garage walls',
    other_area: 'Other area', other_wall: 'Other walls'
  };
  G.isArea = t => G.AREA_TYPES.indexOf(t) >= 0;
  G.isLength = t => G.LENGTH_TYPES.indexOf(t) >= 0;

  G.dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  G.polylineLength = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += G.dist(pts[i - 1], pts[i]); return L; };
  G.polygonArea = pts => {
    if (!pts || pts.length < 3) return 0;
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
  };
  G.centroid = pts => {
    if (!pts.length) return [0, 0];
    let x = 0, y = 0; pts.forEach(p => { x += p[0]; y += p[1]; }); return [x / pts.length, y / pts.length];
  };
  /* Roof slope factor for rise-per-12 pitch. 6/12 -> 1.118 */
  G.pitchFactor = p => Math.sqrt(1 + Math.pow((+p || 0) / 12, 2));
  /* "inchesPerFoot" = paper inches that equal 1 real foot (1/4"=1' -> 0.25). PDF units are points (1/72"). */
  G.ftPerPtFromScale = inchesPerFoot => 1 / (72 * inchesPerFoot);
  G.ftPerPtFromCalibration = (ptsDistance, feet) => feet / ptsDistance;

  function parseInches(s) {
    s = s.replace(/"/g, '').replace(/^[\s-]+|[\s-]+$/g, '');
    if (!s) return 0;
    const m = /^(\d+(?:\.\d+)?)?(?:[\s-]*(\d+)\/(\d+))?$/.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined)) return NaN;
    let v = m[1] !== undefined ? parseFloat(m[1]) : 0;
    if (m[2] !== undefined) { if (+m[3] === 0) return NaN; v += (+m[2]) / (+m[3]); }
    return v;
  }
  /* Accepts 24'6", 24' 6", 24'-6 1/2", 24-6, 24 6, 24.5, 24', 6", 10'1 */
  G.parseFtIn = function (str) {
    if (str === null || str === undefined) return NaN;
    let s = String(str).toLowerCase()
      .replace(/[\u2019\u2032\u00b4`]/g, "'").replace(/[\u201d\u2033]/g, '"').replace(/''/g, '"')
      .replace(/\b(feet|foot|ft)\b\.?/g, "'").replace(/\b(inches|inch|in)\b\.?/g, '"').trim();
    if (!s) return NaN;
    let neg = false; if (s[0] === '-' && s.indexOf("'") < 0 && /^-\d+(\.\d+)?$/.test(s)) { neg = true; s = s.slice(1); }
    let v;
    if (s.indexOf("'") >= 0) {
      const i = s.indexOf("'");
      const f = s.slice(0, i).trim(); const rest = s.slice(i + 1);
      if (!/^\d+(\.\d+)?$/.test(f)) return NaN;
      const inch = parseInches(rest); if (isNaN(inch)) return NaN;
      v = parseFloat(f) + inch / 12;
    } else if (s.indexOf('"') >= 0) {
      const inch = parseInches(s); if (isNaN(inch)) return NaN; v = inch / 12;
    } else if (/^\d+(\.\d+)?$/.test(s)) {
      v = parseFloat(s);
    } else {
      const m = /^(\d+)[\s-]+(.+)$/.exec(s);
      if (!m) return NaN;
      const inch = parseInches(m[2]); if (isNaN(inch)) return NaN;
      v = (+m[1]) + inch / 12;
    }
    return neg ? -v : v;
  };
  /* Format feet as ft-in. denom = inch fraction (1 = whole inches, 2 = halves, 4 = quarters) */
  G.fmtFtIn = function (ft, denom) {
    if (ft === null || ft === undefined || isNaN(ft)) return '—';
    denom = denom || 1;
    const neg = ft < 0; ft = Math.abs(ft);
    let units = Math.round(ft * 12 * denom);
    const feet = Math.floor(units / (12 * denom)); units -= feet * 12 * denom;
    const whole = Math.floor(units / denom); let num = units - whole * denom, den = denom;
    while (num && num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
    let inch = String(whole); if (num) inch = (whole ? whole + ' ' : '') + num + '/' + den;
    return (neg ? '-' : '') + feet + "' " + inch + '"';
  };

  /* Compute one line item. ftPerPt = scale of the item's page (null if not set). */
  G.itemCalc = function (item, ftPerPt) {
    const out = { lf: null, flat: null, sf: null, factor: 1, noScale: !ftPerPt };
    const qty = (item.qty === undefined || item.qty === '' || isNaN(+item.qty)) ? 1 : +item.qty;
    const adj = +item.adjust || 0;
    const shapes = (item.shapes || []).map(s => s.pts || s);
    if (!ftPerPt) return out;
    if (G.isArea(item.type)) {
      let a = 0; shapes.forEach(p => { a += G.polygonArea(p); });
      out.flat = a * ftPerPt * ftPerPt;
      out.factor = item.type === 'roof' ? G.pitchFactor(item.pitch) : 1;
      out.sf = out.flat * out.factor * qty + adj;
    } else {
      let L = 0; shapes.forEach(p => { L += G.polylineLength(p); });
      out.lf = L * ftPerPt;
      out.sf = out.lf * (+item.height || 0) * qty + adj;
    }
    return out;
  };

  G.csvEscape = v => { v = (v === null || v === undefined) ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

  /* Build CSV text from a project + per-page scales */
  G.buildCSV = function (proj) {
    const rows = [['Job', 'Line', 'Name', 'Type', 'Page', 'Scale', 'LF', 'Height', 'Pitch', 'Flat SF', 'Qty', 'Adjust SF', 'SF']];
    const totals = {}; let grand = 0;
    proj.items.forEach((it, i) => {
      const sc = proj.scales[it.page];
      const c = G.itemCalc(it, sc && sc.ftPerPt);
      const sf = c.sf === null ? '' : Math.round(c.sf);
      if (c.sf !== null) { totals[it.type] = (totals[it.type] || 0) + c.sf; grand += c.sf; }
      rows.push([
        proj.jobName || '', i + 1, it.name, G.TYPE_LABELS[it.type] || it.type, it.page, sc ? sc.label : 'NOT SET',
        c.lf === null ? '' : c.lf.toFixed(1),
        G.isLength(it.type) ? G.fmtFtIn(+it.height || 0) : '',
        it.type === 'roof' ? (it.pitch || 0) + '/12' : '',
        c.flat === null ? '' : Math.round(c.flat),
        it.qty === undefined || it.qty === '' ? 1 : it.qty, +it.adjust || 0, sf
      ]);
    });
    rows.push([]);
    rows.push(['', '', 'TOTALS BY TYPE']);
    Object.keys(G.TYPE_LABELS).forEach(t => { if (totals[t] !== undefined) rows.push(['', '', G.TYPE_LABELS[t], '', '', '', '', '', '', '', '', '', Math.round(totals[t])]); });
    rows.push(['', '', 'GRAND TOTAL', '', '', '', '', '', '', '', '', '', Math.round(grand)]);
    return rows.map(r => r.map(G.csvEscape).join(',')).join('\r\n') + '\r\n';
  };

  root.TakeoffGeom = G;
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})(typeof window !== 'undefined' ? window : globalThis);
