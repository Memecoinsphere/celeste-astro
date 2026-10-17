/* Céleste — carte du ciel interactive. Code original. Calculs : astronomy-engine (MIT). */
(() => {
'use strict';
const A = window.Astronomy;
const D = window.SKYDATA;
const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const norm360 = a => ((a % 360) + 360) % 360;
const angDiff = (a, b) => { let d = norm360(a - b); return d > 180 ? d - 360 : d; };
const fold = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9α-ω ]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------- État ---------------- */
const DEFAULT_LOC = { name: 'La Rochelle', lat: 46.16, lon: -1.15, tz: 'Europe/Paris' };
const S = {
  loc: { ...DEFAULT_LOC },
  opts: { lines: true, conNames: true, starNames: true, grid: false, eqGrid: false, ecliptic: true, milkyway: true, ground: true, atmosphere: true, laser: false },
  magLimit: 6,
  az: 180 * DEG, alt: 28 * DEG, fov: 100 * DEG,
  anchor: Date.now(), slider: 0, live: true, playing: false, speed: 600,
  night: false, selected: null, tween: null, dirty: true
};
try {
  const saved = JSON.parse(localStorage.getItem('celeste.v1') || 'null');
  if (saved) {
    if (saved.loc && isFinite(saved.loc.lat) && isFinite(saved.loc.lon)) S.loc = { ...DEFAULT_LOC, ...saved.loc };
    if (saved.opts) Object.assign(S.opts, saved.opts);
    if (isFinite(saved.magLimit)) S.magLimit = saved.magLimit;
    if (isFinite(saved.az)) { S.az = saved.az; S.alt = saved.alt; S.fov = saved.fov; }
    S.night = !!saved.night;
  }
} catch (e) { /* stockage indisponible */ }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('celeste.v1', JSON.stringify({ loc: S.loc, opts: S.opts, magLimit: S.magLimit, az: S.az, alt: S.alt, fov: S.fov, night: S.night })); } catch (e) {}
  }, 400);
}
const simMs = () => S.anchor + S.slider * 60000;
let observer = new A.Observer(S.loc.lat, S.loc.lon, 0);

/* ---------------- Fuseaux et formats ---------------- */
const fmtCache = {};
function validTz(tz) { try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return tz; } catch (e) { return undefined; } }
function fmt(kind) {
  const tz = validTz(S.loc.tz);
  const key = kind + '|' + tz;
  if (fmtCache[key]) return fmtCache[key];
  const o = { timeZone: tz };
  if (kind === 'hm') Object.assign(o, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (kind === 'hms') Object.assign(o, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  if (kind === 'date') Object.assign(o, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (kind === 'dshort') Object.assign(o, { weekday: 'short', day: 'numeric' });
  if (kind === 'dmed') Object.assign(o, { weekday: 'short', day: 'numeric', month: 'short' });
  if (kind === 'parts') Object.assign(o, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return (fmtCache[key] = new Intl.DateTimeFormat(kind === 'parts' ? 'en-US' : 'fr-FR', o));
}
function tzParts(ms) {
  const p = {};
  for (const x of fmt('parts').formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
}
function tzOffsetMin(ms) { const p = tzParts(ms); return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000; }
function localMidnight(ms) {
  const p = tzParts(ms);
  let g = Date.UTC(p.y, p.mo - 1, p.d) - tzOffsetMin(ms) * 60000;
  g = Date.UTC(p.y, p.mo - 1, p.d) - tzOffsetMin(g) * 60000;
  return g;
}
const dayKey = ms => { const p = tzParts(ms); return p.y * 10000 + p.mo * 100 + p.d; };
const hm = ms => fmt('hm').format(new Date(ms));
function hmRel(ms, refMs) {
  if (ms == null) return '—';
  const dd = Math.round((localMidnight(ms) - localMidnight(refMs)) / 86400000);
  const pre = dd === 0 ? '' : dd === 1 ? 'demain ' : dd === -1 ? 'hier ' : fmt('dshort').format(new Date(ms)) + ' ';
  return pre + hm(ms);
}
const dateOf = t => t && (t.date || (t.time && t.time.date));
const msOf = t => { const d = dateOf(t); return d ? d.getTime() : null; };
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const cardinal = az => CARD[Math.round(norm360(az) / 22.5) % 16];
function fmtRA(h) { h = (h % 24 + 24) % 24; const H = Math.floor(h), m = (h - H) * 60, M = Math.floor(m), s = Math.round((m - M) * 60); return `${H}h ${String(M).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; }
function fmtDec(d) { const sg = d < 0 ? '−' : '+'; d = Math.abs(d); const D0 = Math.floor(d), m = Math.round((d - D0) * 60); return `${sg}${D0 + (m === 60 ? 1 : 0)}° ${String(m % 60).padStart(2, '0')}′`; }
const fmtDeg = (d, n = 1) => (d < 0 ? '−' : '') + Math.abs(d).toFixed(n).replace('.', ',') + '°';
const num = (v, n = 1) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(n).replace('.', ',');

/* ---------------- Données ---------------- */
const NS = D.stars.length / 5;
const SX = new Float32Array(NS), SY = new Float32Array(NS), SZ = new Float32Array(NS);
const SMAG = new Float32Array(NS), SBV = new Float32Array(NS), SHIP = new Int32Array(NS), SCOL = new Uint8Array(NS);
const SN = new Float32Array(NS), SE = new Float32Array(NS), SU = new Float32Array(NS);
const SRA = new Float32Array(NS), SDEC = new Float32Array(NS);
const hipIndex = new Map();
const BV_STOPS = [[-0.4, [155, 178, 255]], [0, [200, 214, 255]], [0.3, [236, 240, 255]], [0.6, [255, 246, 232]], [0.9, [255, 228, 190]], [1.3, [255, 206, 150]], [1.7, [255, 178, 110]], [2.2, [255, 150, 90]]];
function bvRGB(bv) {
  bv = clamp(bv, -0.4, 2.2);
  for (let i = 1; i < BV_STOPS.length; i++) if (bv <= BV_STOPS[i][0]) {
    const [a, ca] = BV_STOPS[i - 1], [b, cb] = BV_STOPS[i]; const t = (bv - a) / (b - a);
    return ca.map((c, k) => Math.round(lerp(c, cb[k], t)));
  }
  return BV_STOPS[BV_STOPS.length - 1][1];
}
const COLBINS = [-0.3, 0, 0.25, 0.5, 0.75, 1.0, 1.3, 1.7];
const COLRGB = COLBINS.map(bvRGB);
const vecFromRaDec = (raDeg, decDeg) => { const r = raDeg * DEG, d = decDeg * DEG; return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]; };
for (let i = 0; i < NS; i++) {
  const ra = D.stars[i * 5], dec = D.stars[i * 5 + 1];
  const v = vecFromRaDec(ra, dec);
  SX[i] = v[0]; SY[i] = v[1]; SZ[i] = v[2]; SRA[i] = ra; SDEC[i] = dec;
  SMAG[i] = D.stars[i * 5 + 2]; SBV[i] = D.stars[i * 5 + 3]; SHIP[i] = D.stars[i * 5 + 4];
  let b = 0; for (let k = 0; k < COLBINS.length; k++) if (Math.abs(SBV[i] - COLBINS[k]) < Math.abs(SBV[i] - COLBINS[b])) b = k;
  SCOL[i] = b; hipIndex.set(SHIP[i], i);
}
const CONS = D.cons.map(c => ({ id: c[0], fr: c[1], la: c[2], gen: c[3], ra: c[4], dec: c[5], rank: c[6], v: vecFromRaDec(c[4], c[5]) }));
const consById = {}; CONS.forEach(c => { if (!consById[c.id]) consById[c.id] = c; });
const consFr = id => (consById[id] ? consById[id].fr : id);
const LINES = [];
for (const id in D.lines) for (const seg of D.lines[id]) LINES.push(seg.map(p => vecFromRaDec(p[0], p[1])));

/* Voie lactée procédurale (galactique -> équatorial J2000) */
const GAL = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
const MW = [];
(function buildMilkyWay() {
  let seed = 1234567; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let i = 0; i < 2600; i++) {
    const l = rnd() * 360; const dl = Math.min(l, 360 - l);
    const sigma = 3.5 + 7 * Math.exp(-((dl / 35) ** 2));
    const b = gauss() * sigma;
    let w = 0.35 + 0.9 * Math.exp(-((dl / 55) ** 2));
    if (l > 15 && l < 80 && Math.abs(b - 1.5) < 2.2) w *= 0.35; // grande faille
    if (Math.abs(b) > 2.5 * sigma) w *= 0.5;
    const L = l * DEG, B = b * DEG; const g = [Math.cos(B) * Math.cos(L), Math.cos(B) * Math.sin(L), Math.sin(B)];
    const e = [0, 1, 2].map(k => GAL[0][k] * g[0] + GAL[1][k] * g[1] + GAL[2][k] * g[2]);
    MW.push({ v: e, w, size: (1.6 + rnd() * 2.6) * (1 + 0.6 * Math.exp(-((dl / 30) ** 2))) });
  }
})();
const ECL = []; { const eps = 23.4393 * DEG; for (let l = 0; l <= 360; l += 2) { const L = l * DEG; ECL.push([Math.cos(L), Math.sin(L) * Math.cos(eps), Math.sin(L) * Math.sin(eps)]); } }
const EQU = []; for (let r = 0; r <= 360; r += 2) EQU.push(vecFromRaDec(r, 0));

const BODIES = [
  { key: 'Sun', fr: 'Soleil', type: 'Étoile', color: '#ffe9a8', radiusKm: 696000 },
  { key: 'Moon', fr: 'Lune', type: 'Satellite naturel', color: '#f2efe4', radiusKm: 1737.4 },
  { key: 'Mercury', fr: 'Mercure', type: 'Planète', color: '#d6c7b4', radiusKm: 2439.7 },
  { key: 'Venus', fr: 'Vénus', type: 'Planète', color: '#fff6d8', radiusKm: 6051.8 },
  { key: 'Mars', fr: 'Mars', type: 'Planète', color: '#ff8f62', radiusKm: 3389.5 },
  { key: 'Jupiter', fr: 'Jupiter', type: 'Planète', color: '#f3dcb6', radiusKm: 69911 },
  { key: 'Saturn', fr: 'Saturne', type: 'Planète', color: '#eed69c', radiusKm: 58232 },
  { key: 'Uranus', fr: 'Uranus', type: 'Planète', color: '#aee9f0', radiusKm: 25362 },
  { key: 'Neptune', fr: 'Neptune', type: 'Planète', color: '#86a9ff', radiusKm: 24622 }
];
const PLANETS = BODIES.slice(2);
const AU_KM = 149597870.7;

/* ---------------- Calculs astronomiques ---------------- */
let rot = null, curT = null, frameKey = '';
const sky = { sunAlt: -90, sunAz: 0, bodies: [] };
function refractNEU(N, E, U, out) {
  const alt = Math.asin(clamp(U, -1, 1)) * RAD;
  if (alt < 89.9) { // même modèle que astronomy-engine Horizon(..., 'normal')
    const a2 = alt + A.Refraction('normal', alt);
    const c0 = Math.sqrt(N * N + E * E) || 1e-9, c1 = Math.cos(a2 * DEG);
    out[0] = N / c0 * c1; out[1] = E / c0 * c1; out[2] = Math.sin(a2 * DEG);
  } else { out[0] = N; out[1] = E; out[2] = U; }
  return out;
}
const tmp3 = [0, 0, 0];
function eqjToNEU(x, y, z, out, refr = true) {
  const m = rot;
  const hx = m[0][0] * x + m[1][0] * y + m[2][0] * z;
  const hy = m[0][1] * x + m[1][1] * y + m[2][1] * z;
  const hz = m[0][2] * x + m[1][2] * y + m[2][2] * z;
  out[0] = hx; out[1] = -hy; out[2] = hz; // HOR : x=nord, y=ouest, z=zénith
  return refr ? refractNEU(out[0], out[1], out[2], out) : out;
}
const neuToAltAz = v => ({ alt: Math.asin(clamp(v[2], -1, 1)) * RAD, az: norm360(Math.atan2(v[1], v[0]) * RAD) });
function bodyState(b, t) {
  const eq = A.Equator(b.key, t, observer, false, true); // J2000 topocentrique
  const v = vecFromRaDec(eq.ra * 15, eq.dec);
  const neu = eqjToNEU(v[0], v[1], v[2], [0, 0, 0]);
  let mag = null, phase = null, phaseAngle = null;
  try { const il = A.Illumination(b.key, t); mag = il.mag; phase = il.phase_fraction; phaseAngle = il.phase_angle; } catch (e) {}
  const distKm = eq.dist * AU_KM;
  const angRad = Math.asin(Math.min(1, b.radiusKm / distKm));
  return { b, eq, v, neu, mag, phase, phaseAngle, distKm, angRad, ...neuToAltAz(neu) };
}
function updateSky(force) {
  const ms = simMs();
  const key = Math.round(ms / 500) + '|' + S.loc.lat + '|' + S.loc.lon;
  if (!force && key === frameKey) return false;
  frameKey = key;
  curT = A.MakeTime(new Date(ms));
  rot = A.Rotation_EQJ_HOR(curT, observer).rot;
  for (let i = 0; i < NS; i++) {
    eqjToNEU(SX[i], SY[i], SZ[i], tmp3);
    SN[i] = tmp3[0]; SE[i] = tmp3[1]; SU[i] = tmp3[2];
  }
  sky.bodies = BODIES.map(b => bodyState(b, curT));
  sky.sunAlt = sky.bodies[0].alt; sky.sunAz = sky.bodies[0].az;
  sky.moonElong = A.MoonPhase(curT);
  return true;
}
function starAltAz(i) { return { alt: Math.asin(clamp(SU[i], -1, 1)) * RAD, az: norm360(Math.atan2(SE[i], SN[i]) * RAD) }; }
function moonPhaseName(e) {
  if (e < 6 || e > 354) return 'Nouvelle Lune'; if (e < 84) return 'Premier croissant'; if (e < 96) return 'Premier quartier';
  if (e < 174) return 'Gibbeuse croissante'; if (e < 186) return 'Pleine Lune'; if (e < 264) return 'Gibbeuse décroissante';
  if (e < 276) return 'Dernier quartier'; return 'Dernier croissant';
}
/* Lever / passage / coucher sur la journée locale affichée */
const riseCache = new Map();
function riseTransitSet(bodyKey, raH, decDeg, ms) {
  const k = bodyKey + '|' + (raH != null ? raH.toFixed(3) + decDeg.toFixed(2) : '') + '|' + dayKey(ms) + '|' + S.loc.lat + S.loc.lon;
  if (riseCache.has(k)) return riseCache.get(k);
  let body = bodyKey;
  if (raH != null) { A.DefineStar(A.Body.Star1, raH, decDeg, 1000); body = A.Body.Star1; }
  const t0 = A.MakeTime(new Date(localMidnight(ms)));
  let rise = null, set = null, transit = null, transitAlt = null;
  try { rise = msOf(A.SearchRiseSet(body, observer, +1, t0, 1)); } catch (e) {}
  try { set = msOf(A.SearchRiseSet(body, observer, -1, t0, 1)); } catch (e) {}
  try { const h = A.SearchHourAngle(body, observer, 0, t0, +1); transit = msOf(h.time); transitAlt = h.hor.altitude; } catch (e) {}
  let lower = null; try { lower = A.SearchHourAngle(body, observer, 12, t0, +1).hor.altitude; } catch (e) {}
  const r = { rise, set, transit, transitAlt, circumpolar: rise == null && set == null && lower != null && lower > 0, never: rise == null && set == null && transitAlt != null && transitAlt < 0 };
  if (riseCache.size > 300) riseCache.clear();
  riseCache.set(k, r); return r;
}

/* ---------------- Canvas et projection ---------------- */
const cv = $('sky'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  S.dirty = true; drawForecastChart();
}
window.addEventListener('resize', resize);
const V = { fN: 1, fE: 0, fU: 0, rN: 0, rE: 1, rU: 0, uN: 0, uE: 0, uU: 1, s: 1, cx: 0, cy: 0, gnomonic: false };
function setBasisFromAzAlt(az, alt) {
  const ca = Math.cos(alt), sa = Math.sin(alt), cz = Math.cos(az), sz = Math.sin(az);
  V.fN = ca * cz; V.fE = ca * sz; V.fU = sa;
  V.rN = -sz; V.rE = cz; V.rU = 0;
  V.uN = -sa * cz; V.uE = -sa * sz; V.uU = ca;
}
const P = { x: 0, y: 0, d: 0 };
function proj(N, E, U) {
  const d = N * V.fN + E * V.fE + U * V.fU;
  let k;
  if (V.gnomonic) { if (d < 0.06) return false; k = 1 / d; }
  else { if (d < -0.97) return false; k = 2 / (1 + d); }
  P.x = V.cx + (N * V.rN + E * V.rE + U * V.rU) * k * V.s;
  P.y = V.cy - (N * V.uN + E * V.uE + U * V.uU) * k * V.s;
  P.d = d; return true;
}
const onScreen = (m = 0) => P.x > -m && P.x < W + m && P.y > -m && P.y < H + m;
function setupView() {
  V.cx = W / 2; V.cy = H / 2;
  if (AR.on && AR.f) {
    V.gnomonic = true;
    Object.assign(V, AR.basis);
    let longPx = Math.max(W, H);
    const vid = $('camera');
    if (AR.camera && vid.videoWidth) { const sc = Math.max(W / vid.videoWidth, H / vid.videoHeight); longPx = Math.max(vid.videoWidth, vid.videoHeight) * sc; }
    V.s = (longPx / 2) / Math.tan(AR.fov * DEG / 2);
    V.fovDeg = 2 * Math.atan((Math.min(W, H) / 2) / V.s) * RAD;
  } else {
    V.gnomonic = false;
    setBasisFromAzAlt(S.az, S.alt);
    V.s = (Math.min(W, H) / 2) / (2 * Math.tan(S.fov / 4));
    V.fovDeg = S.fov * RAD;
  }
}
const sprite = (rgb, size = 64) => {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.18, `rgba(${rgb},.55)`); gr.addColorStop(0.45, `rgba(${rgb},.12)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size); return c;
};
const GLOWS = COLRGB.map(c => sprite(c.join(',')));
const MWSPRITE = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(190,205,255,1)'); gr.addColorStop(1, 'rgba(190,205,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c; })();
const SUNGLOW = sprite('255,226,150', 128);
const spriteCache = {};
function spriteFor(hex) {
  if (!spriteCache[hex]) { const n = parseInt(hex.slice(1), 16); spriteCache[hex] = sprite(`${n >> 16},${(n >> 8) & 255},${n & 255}`); }
  return spriteCache[hex];
}

/* ---------------- Rendu ---------------- */
let picks = [], labelBoxes = [];
function labelFits(x, y, w, h) {
  for (const b of labelBoxes) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
  labelBoxes.push([x, y, w, h]); return true;
}
function skyColors() {
  const s = sky.sunAlt;
  const stops = [[-18, [3, 5, 11]], [-12, [6, 11, 26]], [-6, [13, 24, 56]], [-2, [30, 52, 104]], [3, [52, 98, 170]], [15, [62, 122, 205]]];
  if (!S.opts.atmosphere) return [3, 5, 11];
  if (s <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (s <= stops[i][0]) { const t = (s - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]); return stops[i - 1][1].map((c, k) => Math.round(lerp(c, stops[i][1][k], t))); }
  return stops[stops.length - 1][1];
}
function effMagLimit() {
  let lim = S.magLimit;
  if (V.fovDeg < 90) lim = Math.min(6.5, lim + 0.9 * Math.log2(90 / V.fovDeg));
  if (S.opts.atmosphere) {
    const s = sky.sunAlt;
    if (s > -18) lim = Math.min(lim, lerp(S.magLimit, 3.5, clamp((s + 18) / 6, 0, 1)));
    if (s > -12) lim = Math.min(lim, lerp(3.5, 1.8, clamp((s + 12) / 6, 0, 1)));
    if (s > -6) lim = Math.min(lim, lerp(1.8, -1.5, clamp((s + 6) / 6, 0, 1)));
    if (s > 0) lim = -3.6;
  }
  if (AR.on && AR.camera) lim = Math.max(Math.min(lim, 4.5), 2.5);
  return lim;
}
function drawCurve(vecs, transform) {
  let pen = false; const o = [0, 0, 0];
  ctx.beginPath();
  for (const v of vecs) {
    let N, E, U;
    if (transform) { eqjToNEU(v[0], v[1], v[2], o); N = o[0]; E = o[1]; U = o[2]; } else { N = v[0]; E = v[1]; U = v[2]; }
    if (proj(N, E, U) && Math.abs(P.x - V.cx) < W * 3 && Math.abs(P.y - V.cy) < H * 3) {
      if (pen) ctx.lineTo(P.x, P.y); else ctx.moveTo(P.x, P.y);
      pen = true;
    } else pen = false;
  }
  ctx.stroke();
}
const altAzVec = (alt, az) => [Math.cos(alt * DEG) * Math.cos(az * DEG), Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG)];
function drawAltAzGrid() {
  ctx.strokeStyle = 'rgba(110,170,255,.22)'; ctx.lineWidth = 1;
  const step = V.fovDeg < 40 ? 5 : 10;
  for (let alt = -80; alt <= 80; alt += step) { if (alt === 0) continue; const pts = []; for (let az = 0; az <= 360; az += 2) pts.push(altAzVec(alt, az)); drawCurve(pts); }
  const azStep = V.fovDeg < 40 ? 10 : 15;
  for (let az = 0; az < 360; az += azStep) { const pts = []; for (let alt = -88; alt <= 88; alt += 2) pts.push(altAzVec(alt, az)); drawCurve(pts); }
  ctx.fillStyle = 'rgba(150,190,255,.6)'; ctx.font = '10.5px system-ui,sans-serif'; ctx.textAlign = 'left';
  const cAz = Math.atan2(V.fE, V.fN) * RAD;
  for (let alt = -60; alt <= 80; alt += 20) { const v = altAzVec(alt, cAz); if (alt && proj(v[0], v[1], v[2]) && onScreen()) ctx.fillText(alt + '°', P.x + 4, P.y - 3); }
  for (let az = 0; az < 360; az += 30) { const v = altAzVec(3, az); if (proj(v[0], v[1], v[2]) && onScreen()) ctx.fillText(az + '°', P.x + 3, P.y - 12); }
}
function drawMoonShape(g, x, y, r, phaseAngleDeg, sunAng, alpha = 1) {
  g.save(); g.translate(x, y); g.rotate(sunAng); g.globalAlpha = alpha;
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = 'rgba(48,52,66,.92)'; g.fill();
  const k = Math.cos(phaseAngleDeg * DEG);
  g.beginPath(); g.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  g.ellipse(0, 0, Math.max(0.01, Math.abs(k) * r), r, 0, Math.PI / 2, k >= 0 ? Math.PI * 1.5 : -Math.PI / 2, k < 0);
  g.closePath();
  const gr = g.createRadialGradient(r * 0.3, -r * 0.2, r * 0.1, 0, 0, r);
  gr.addColorStop(0, '#fbf8ee'); gr.addColorStop(1, '#cbc5b2'); g.fillStyle = gr; g.fill();
  g.clip(); g.globalAlpha = alpha * 0.16; g.fillStyle = '#5a5a6a';
  [[-0.25, -0.3, 0.28], [0.2, -0.05, 0.2], [-0.05, 0.3, 0.22], [0.35, 0.35, 0.12]].forEach(([a, b, c]) => { g.beginPath(); g.arc(a * r, b * r, c * r, 0, 7); g.fill(); });
  g.restore();
}
function screenDirToward(fromNEU, toNEU) {
  if (!proj(fromNEU[0], fromNEU[1], fromNEU[2])) return 0;
  const x0 = P.x, y0 = P.y;
  const v = [0, 1, 2].map(k => fromNEU[k] + (toNEU[k] - fromNEU[k]) * 0.02);
  if (!proj(v[0], v[1], v[2])) return 0;
  return Math.atan2(P.y - y0, P.x - x0);
}
function drawGround() {
  const fAz = Math.atan2(V.fE, V.fN) * RAD;
  const refIsZenith = V.fU >= 0;
  const ref = refIsZenith ? [0, 0, 1] : [0, 0, -1];
  let refPt = null; if (proj(ref[0], ref[1], ref[2])) refPt = [P.x, P.y];
  const groundAlpha = AR.on ? (AR.camera ? 0.22 : 0.55) : (S.opts.ground ? 0.97 : 0.25);
  const horizStroke = AR.on ? 'rgba(120,230,170,.85)' : 'rgba(110,200,150,.65)';
  const offs = V.gnomonic ? [0, 40, -40] : [0, 90, -90];
  const pts = [];
  for (const o of offs) { const v = altAzVec(0, fAz + o); if (proj(v[0], v[1], v[2])) pts.push([P.x, P.y]); }
  const [r0, g0, b0] = skyColors();
  const kk = clamp((sky.sunAlt + 12) / 20, 0, 1);
  const fillCol = `rgba(${Math.round(lerp(8, r0 * 0.3 + 14, kk))},${Math.round(lerp(13, g0 * 0.28 + 22, kk))},${Math.round(lerp(11, b0 * 0.12 + 12, kk))},${groundAlpha})`;
  ctx.save(); ctx.fillStyle = fillCol;
  if (pts.length < 2) { if (!refIsZenith && V.fU < -0.9) ctx.fillRect(0, 0, W, H); ctx.restore(); return; }
  let circle = null;
  if (!V.gnomonic && pts.length === 3) {
    const [a, b, c] = pts; const dd = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(dd) > 1e-6) {
      const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / dd;
      const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / dd;
      const R = Math.hypot(a[0] - ux, a[1] - uy);
      if (R < 60000) circle = [ux, uy, R];
    }
  }
  if (circle) {
    const [ux, uy, R] = circle;
    const refInside = refPt ? Math.hypot(refPt[0] - ux, refPt[1] - uy) < R : !refIsZenith;
    const groundInside = refIsZenith ? !refInside : refInside;
    ctx.beginPath();
    if (groundInside) ctx.arc(ux, uy, R, 0, Math.PI * 2);
    else { ctx.rect(-10, -10, W + 20, H + 20); ctx.moveTo(ux + R, uy); ctx.arc(ux, uy, R, 0, Math.PI * 2, true); }
    ctx.fill('evenodd');
    ctx.beginPath(); ctx.arc(ux, uy, R, 0, Math.PI * 2); ctx.strokeStyle = horizStroke; ctx.lineWidth = 1.6; ctx.stroke();
  } else {
    const [a, b] = pts; let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    let nx = -dy, ny = dx;
    if (refPt) { const side = (refPt[0] - a[0]) * nx + (refPt[1] - a[1]) * ny; if ((side > 0) === refIsZenith) { nx = -nx; ny = -ny; } }
    const B = 1e5;
    ctx.beginPath(); ctx.moveTo(a[0] - dx * B, a[1] - dy * B); ctx.lineTo(a[0] + dx * B, a[1] + dy * B);
    ctx.lineTo(a[0] + dx * B + nx * B, a[1] + dy * B + ny * B); ctx.lineTo(a[0] - dx * B + nx * B, a[1] - dy * B + ny * B); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(a[0] - dx * B, a[1] - dy * B); ctx.lineTo(a[0] + dx * B, a[1] + dy * B); ctx.strokeStyle = horizStroke; ctx.lineWidth = 1.6; ctx.stroke();
  }
  ctx.restore();
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  names.forEach((n, i) => {
    const v = altAzVec(1.2, i * 45);
    if (!proj(v[0], v[1], v[2]) || !onScreen(20)) return;
    const big = i % 2 === 0;
    ctx.font = `${big ? 700 : 600} ${big ? 17 : 12}px system-ui,sans-serif`;
    ctx.fillStyle = n === 'N' ? '#ff7a7a' : big ? 'rgba(200,220,255,.95)' : 'rgba(160,185,230,.75)';
    ctx.fillText(n, P.x, P.y - 10);
  });
  ctx.textBaseline = 'alphabetic';
}
function render() {
  setupView();
  const w = W, h = H;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  picks = []; labelBoxes = [];
  const camOn = AR.on && AR.camera;
  if (camOn) { ctx.clearRect(0, 0, w, h); ctx.fillStyle = 'rgba(0,4,16,.25)'; ctx.fillRect(0, 0, w, h); }
  else {
    const [r, g, b] = skyColors();
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(0, 0, w, h);
    const sun = sky.bodies[0];
    if (S.opts.atmosphere && sky.sunAlt > -20 && proj(sun.neu[0], sun.neu[1], sun.neu[2])) {
      const k = clamp(1 - Math.abs(sky.sunAlt + 4) / 16, 0, 1);
      const R = Math.max(w, h) * 0.9;
      const gr = ctx.createRadialGradient(P.x, P.y, 0, P.x, P.y, R);
      gr.addColorStop(0, `rgba(255,150,80,${0.45 * k})`); gr.addColorStop(0.35, `rgba(220,110,90,${0.16 * k})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
    }
  }
  const dark = S.opts.atmosphere ? clamp((-sky.sunAlt - 8) / 10, 0, 1) : 1;
  if (S.opts.milkyway && dark > 0.05 && !camOn) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const o = [0, 0, 0];
    for (const p of MW) {
      eqjToNEU(p.v[0], p.v[1], p.v[2], o, false);
      if (!proj(o[0], o[1], o[2])) continue;
      const sz = Math.min(600, p.size * DEG * V.s * (V.gnomonic ? 1 / P.d : 2 / (1 + P.d)) * 2);
      if (P.x < -sz || P.x > w + sz || P.y < -sz || P.y > h + sz) continue;
      ctx.globalAlpha = 0.03 * p.w * dark;
      ctx.drawImage(MWSPRITE, P.x - sz / 2, P.y - sz / 2, sz, sz);
    }
    ctx.restore();
  }
  if (S.opts.grid) drawAltAzGrid();
  if (S.opts.eqGrid) { ctx.strokeStyle = 'rgba(120,200,255,.35)'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1; drawCurve(EQU, true); ctx.setLineDash([]); }
  if (S.opts.ecliptic) { ctx.strokeStyle = 'rgba(255,200,90,.32)'; ctx.setLineDash([3, 5]); ctx.lineWidth = 1; drawCurve(ECL, true); ctx.setLineDash([]); }
  if (S.opts.lines) { ctx.strokeStyle = camOn ? 'rgba(150,190,255,.6)' : `rgba(110,150,240,${(0.14 + 0.22 * dark).toFixed(3)})`; ctx.lineWidth = camOn ? 1.4 : 1.1; for (const seg of LINES) drawCurve(seg, true); }
  const lim = effMagLimit();
  const zb = clamp(Math.pow(90 / V.fovDeg, 0.22), 0.85, 1.9);
  const groundOn = !AR.on && S.opts.ground;
  for (let i = 0; i < NS; i++) {
    const m = SMAG[i]; if (m > lim) break; // catalogue trié par magnitude
    if (groundOn && SU[i] < 0) continue;
    if (!proj(SN[i], SE[i], SU[i]) || !onScreen(10)) continue;
    const rr = Math.min(8, (0.55 + 0.42 * Math.pow(Math.max(0, lim - m + 0.6), 1.15)) * zb);
    const a = clamp((lim - m) / 1.2 + 0.25, 0.15, 1);
    const c = COLRGB[SCOL[i]];
    if (m < 1.8) { const gs = rr * 7; ctx.globalAlpha = a * 0.7; ctx.drawImage(GLOWS[SCOL[i]], P.x - gs / 2, P.y - gs / 2, gs, gs); }
    ctx.globalAlpha = a; ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.beginPath(); ctx.arc(P.x, P.y, rr, 0, 6.2832); ctx.fill();
    picks.push({ kind: 'star', i, x: P.x, y: P.y, r: rr, pri: m });
  }
  ctx.globalAlpha = 1;
  const bodyLabels = [];
  for (let bi = sky.bodies.length - 1; bi >= 0; bi--) {
    const bs = sky.bodies[bi];
    if (groundOn && bs.alt < -1) continue;
    if (!proj(bs.neu[0], bs.neu[1], bs.neu[2]) || !onScreen(40)) continue;
    const x = P.x, y = P.y;
    const angPx = bs.angRad * V.s * (V.gnomonic ? 1 / P.d : 2 / (1 + P.d));
    let r;
    if (bs.b.key === 'Sun') {
      r = Math.max(9, angPx);
      ctx.globalAlpha = 0.9; ctx.drawImage(SUNGLOW, x - r * 6, y - r * 6, r * 12, r * 12); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = '#fff4cf'; ctx.fill();
    } else if (bs.b.key === 'Moon') {
      r = Math.max(8, angPx);
      ctx.globalAlpha = 0.35; ctx.drawImage(GLOWS[3], x - r * 4, y - r * 4, r * 8, r * 8); ctx.globalAlpha = 1;
      const ang = screenDirToward(bs.neu, sky.bodies[0].neu);
      drawMoonShape(ctx, x, y, r, bs.phaseAngle == null ? 0 : bs.phaseAngle, ang);
    } else {
      const mag = bs.mag == null ? 5 : bs.mag;
      if (mag > lim + 1.5 && !camOn) continue;
      r = Math.max(clamp(2.4 + (1.5 - mag) * 0.75, 2, 6.5) * Math.min(zb, 1.4), angPx);
      ctx.globalAlpha = 0.85; ctx.drawImage(spriteFor(bs.b.color), x - r * 5, y - r * 5, r * 10, r * 10); ctx.globalAlpha = 1;
      if (bs.b.key === 'Saturn' && r > 5) { ctx.strokeStyle = 'rgba(238,214,156,.85)'; ctx.lineWidth = Math.max(1, r * 0.22); ctx.beginPath(); ctx.ellipse(x, y, r * 2.1, r * 0.75, -0.4, 0, 7); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = bs.b.color; ctx.fill();
    }
    picks.push({ kind: 'body', bi, x, y, r: r + 4, pri: -30 });
    bodyLabels.push([bs.b.fr, x, y, r, bs.b.key]);
  }
  drawGround();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = '600 13px system-ui,sans-serif';
  for (const [name, x, y, r, key] of bodyLabels) {
    const tw = ctx.measureText(name).width;
    if (labelFits(x + r + 5, y - 8, tw, 16) || key === 'Moon' || key === 'Sun') { ctx.fillStyle = key === 'Sun' ? '#ffe39a' : key === 'Moon' ? '#f2efe4' : '#ffd9a0'; ctx.fillText(name, x + r + 5, y); }
  }
  if (S.opts.starNames) {
    const lab = clamp(1.5 + 1.6 * Math.log2(100 / V.fovDeg), 1.5, 4.8);
    ctx.font = '12px system-ui,sans-serif';
    for (const p of picks) {
      if (p.kind !== 'star' || SMAG[p.i] > Math.min(lab, lim)) continue;
      const n = D.names[SHIP[p.i]]; if (!n || !n[0]) continue;
      const tw = ctx.measureText(n[0]).width;
      if (labelFits(p.x + p.r + 4, p.y - 7, tw, 14)) { ctx.fillStyle = camOn ? 'rgba(235,240,255,.95)' : 'rgba(200,214,245,.78)'; ctx.fillText(n[0], p.x + p.r + 4, p.y); }
    }
  }
  if (S.opts.conNames) {
    ctx.textAlign = 'center'; const o = [0, 0, 0];
    ctx.font = `500 ${V.fovDeg > 140 ? 10.5 : 12}px system-ui,sans-serif`;
    for (const c of CONS) {
      if (V.fovDeg > 120 && c.rank > 2) continue;
      eqjToNEU(c.v[0], c.v[1], c.v[2], o);
      if (groundOn && o[2] < 0) continue;
      if (!proj(o[0], o[1], o[2]) || !onScreen(-10)) continue;
      const txt = c.fr.toUpperCase();
      const tw = ctx.measureText(txt).width + txt.length * 1.2 + 10;
      if (!labelFits(P.x - tw / 2, P.y - 8, tw, 16)) continue;
      ctx.fillStyle = camOn ? 'rgba(170,200,255,.85)' : 'rgba(130,160,235,.55)';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
      ctx.fillText(txt, P.x, P.y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      picks.push({ kind: 'con', c, x: P.x, y: P.y, r: tw / 2, pri: 50 });
    }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  drawSelection();
  drawLaser();
  updateHud();
}
function selectedNEU() {
  const s = S.selected; if (!s) return null;
  if (s.kind === 'star') return [SN[s.i], SE[s.i], SU[s.i]];
  if (s.kind === 'body') return sky.bodies[s.bi].neu;
  if (s.kind === 'con') return eqjToNEU(s.c.v[0], s.c.v[1], s.c.v[2], [0, 0, 0]);
  return null;
}
function drawSelection() {
  const v = selectedNEU(); if (!v) return;
  const t = performance.now() / 1000;
  if (proj(v[0], v[1], v[2]) && onScreen(-8)) {
    const r = 15 + Math.sin(t * 3) * 1.5;
    ctx.strokeStyle = 'rgba(255,214,120,.95)'; ctx.lineWidth = 1.8;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(P.x, P.y, r, k * Math.PI / 2 + 0.25, k * Math.PI / 2 + Math.PI / 2 - 0.25); ctx.stroke(); }
    return;
  }
  // Flèche vers un objet hors champ
  const x = v[0] * V.rN + v[1] * V.rE + v[2] * V.rU, y = v[0] * V.uN + v[1] * V.uE + v[2] * V.uU;
  const ang = Math.atan2(-y, x);
  const mx = W / 2 - 46, my = H / 2 - 130;
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = Math.min(Math.abs(mx / (c || 1e-9)), Math.abs(my / (s || 1e-9)));
  const ax = V.cx + c * k, ay = V.cy + s * k;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang);
  ctx.fillStyle = 'rgba(255,214,120,.95)'; ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, -10); ctx.lineTo(-3, 0); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = '600 12px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,214,120,.95)'; ctx.textAlign = 'center';
  ctx.fillText(objName(S.selected), ax - c * 32, ay - s * 32 + 4); ctx.textAlign = 'left';
}
function updateHud() {
  let az, alt;
  if (AR.on && AR.f) { az = norm360(Math.atan2(V.fE, V.fN) * RAD); alt = Math.asin(clamp(V.fU, -1, 1)) * RAD; }
  else { az = norm360(S.az * RAD); alt = S.alt * RAD; }
  const txt = `Az ${Math.round(az)}° ${cardinal(az)} · Alt ${Math.round(alt)}° · Champ ${Math.round(V.fovDeg)}°`;
  const el = $('viewInfo'); if (el.textContent !== txt) el.textContent = txt;
}

/* ---------------- Noms et fiches ---------------- */
function starName(i) {
  const n = D.names[SHIP[i]];
  if (n && n[0]) return n[0];
  if (n && n[1]) { const c = consById[n[2]]; return `${n[1]} ${c ? c.gen : n[2]}`; }
  return `HIP ${SHIP[i]}`;
}
function objName(s) { return s.kind === 'star' ? starName(s.i) : s.kind === 'body' ? BODIES[s.bi].fr : s.c.fr; }
function spectralHint(bv) { if (bv < 0) return 'bleu-blanc (type O/B)'; if (bv < 0.3) return 'blanc (type A)'; if (bv < 0.58) return 'blanc-jaune (type F)'; if (bv < 0.81) return 'jaune (type G)'; if (bv < 1.4) return 'orangé (type K)'; return 'rouge-orangé (type M)'; }
function riseRows(r, refMs) {
  if (r.circumpolar) return `<dt>Lever / coucher</dt><dd>Circumpolaire</dd><dt>Passage méridien</dt><dd>${hmRel(r.transit, refMs)} (${fmtDeg(r.transitAlt, 0)})</dd>`;
  if (r.never) return `<dt>Lever / coucher</dt><dd>Ne se lève pas ici</dd>`;
  return `<dt>Lever</dt><dd>${hmRel(r.rise, refMs)}</dd><dt>Passage méridien</dt><dd>${hmRel(r.transit, refMs)}${r.transitAlt != null ? ' (' + fmtDeg(r.transitAlt, 0) + ')' : ''}</dd><dt>Coucher</dt><dd>${hmRel(r.set, refMs)}</dd>`;
}
function renderInfo() {
  const s = S.selected; const card = $('infoCard');
  if (!s) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const ms = simMs(); let html = '';
  const upTag = alt => alt > 0 ? '<span class="tag ok">Au-dessus de l\'horizon</span>' : '<span class="tag no">Sous l\'horizon</span>';
  if (s.kind === 'star') {
    const i = s.i, n = D.names[SHIP[i]] || ['', '', ''], c = consById[n[2]];
    const { alt, az } = starAltAz(i);
    const r = riseTransitSet('star', SRA[i] / 15, SDEC[i], ms);
    const des = n[1] ? `${n[1]} ${c ? c.gen : n[2]}` : '';
    html = `<h3>${starName(i)}</h3><div class="sub">Étoile${c ? ' · ' + c.fr : ''}</div>${upTag(alt)}<span class="tag">${spectralHint(SBV[i])}</span>
    <dl class="kv" style="margin-top:10px"><dt>Magnitude</dt><dd>${num(SMAG[i], 2)}</dd>${des && n[0] ? `<dt>Désignation</dt><dd>${des}</dd>` : ''}<dt>Catalogue</dt><dd>HIP ${SHIP[i]}</dd>
    ${(D.extra && D.extra[SHIP[i]] && D.extra[SHIP[i]][1]) ? `<dt>Type spectral</dt><dd>${D.extra[SHIP[i]][1]}</dd>` : ''}<dt>Distance</dt><dd>${distText({ kind: 'star', i })}</dd>
    <dt>Indice B−V</dt><dd>${num(SBV[i], 2)}</dd><dt>Asc. droite (J2000)</dt><dd>${fmtRA(SRA[i] / 15)}</dd><dt>Déclinaison</dt><dd>${fmtDec(SDEC[i])}</dd>
    <dt>Altitude</dt><dd>${fmtDeg(alt)}</dd><dt>Azimut</dt><dd>${fmtDeg(az)} ${cardinal(az)}</dd>${riseRows(r, ms)}</dl>`;
  } else if (s.kind === 'body') {
    const bs = sky.bodies[s.bi], b = bs.b;
    const r = riseTransitSet(b.key, null, null, ms);
    const ofd = A.Equator(b.key, curT, observer, true, true);
    let con = ''; try { const cc = A.Constellation(bs.eq.ra, bs.eq.dec); con = consFr(cc.symbol); } catch (e) {}
    const dist = b.key === 'Moon' ? `${Math.round(bs.distKm).toLocaleString('fr-FR')} km` : `${num(bs.eq.dist, 3)} UA`;
    const diam = 2 * bs.angRad * RAD;
    const diamTxt = diam > 0.1 ? `${num(diam * 60, 1)}′` : `${num(diam * 3600, 1)}″`;
    let extra = '';
    if (b.key === 'Moon') extra = `<dt>Phase</dt><dd>${moonPhaseName(sky.moonElong)}</dd><dt>Illumination</dt><dd>${Math.round(bs.phase * 100)} %</dd>`;
    else if (b.key !== 'Sun' && bs.phase != null) extra = `<dt>Illumination</dt><dd>${Math.round(bs.phase * 100)} %</dd>`;
    if (b.key !== 'Sun' && b.key !== 'Moon') { try { const el = A.Elongation(b.key, curT); extra += `<dt>Élongation</dt><dd>${fmtDeg(el.elongation, 0)} ${el.visibility === 'morning' ? '(matin)' : '(soir)'}</dd>`; } catch (e) {} }
    html = `<h3>${b.fr}</h3><div class="sub">${b.type}${con ? ' · dans ' + con : ''}</div>${upTag(bs.alt)}${b.key === 'Sun' ? '<span class="tag no">Ne jamais observer sans filtre</span>' : ''}
    <dl class="kv" style="margin-top:10px">${bs.mag != null ? `<dt>Magnitude</dt><dd>${num(bs.mag, 2)}</dd>` : ''}${extra}<dt>Distance</dt><dd>${dist}</dd><dt>Diamètre apparent</dt><dd>${diamTxt}</dd>
    <dt>Asc. droite (date)</dt><dd>${fmtRA(ofd.ra)}</dd><dt>Déclinaison</dt><dd>${fmtDec(ofd.dec)}</dd>
    <dt>Altitude</dt><dd>${fmtDeg(bs.alt)}</dd><dt>Azimut</dt><dd>${fmtDeg(bs.az)} ${cardinal(bs.az)}</dd>${riseRows(r, ms)}</dl>`;
  } else {
    const c = s.c; const v = eqjToNEU(c.v[0], c.v[1], c.v[2], [0, 0, 0]); const { alt, az } = neuToAltAz(v);
    const r = riseTransitSet('con', c.ra / 15, c.dec, ms);
    let nStars = 0; for (const h in D.names) if (D.names[h][2] === c.id && SMAG[hipIndex.get(+h)] < 4.5) nStars++;
    html = `<h3>${c.fr}</h3><div class="sub">Constellation · ${c.la} (${c.id})</div>${upTag(alt)}
    <dl class="kv" style="margin-top:10px"><dt>Génitif</dt><dd>${c.gen}</dd><dt>Étoiles &lt; mag 4,5</dt><dd>${nStars}</dd><dt>Centre (J2000)</dt><dd>${fmtRA(c.ra / 15)} · ${fmtDec(c.dec)}</dd>
    <dt>Altitude du centre</dt><dd>${fmtDeg(alt)}</dd><dt>Azimut</dt><dd>${fmtDeg(az)} ${cardinal(az)}</dd>${riseRows(r, ms)}</dl>`;
  }
  html += `<div class="row-btns"><button class="btn" id="centerSel">Centrer</button></div>`;
  $('infoContent').innerHTML = html;
  $('centerSel').onclick = () => centerOn(S.selected);
}

/* ---------------- Interaction ---------------- */
const pointers = new Map(); let gesture = null;
cv.addEventListener('pointerdown', e => {
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) gesture = { kind: 'drag', t0: performance.now(), moved: 0 };
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), fov0: S.fov, moved: 99 }; }
  S.tween = null; closeSearch(); si.blur();
});
cv.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId); if (!p || !gesture) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  if (gesture.kind === 'drag' && pointers.size === 1) {
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (AR.on) return;
    if (gesture.moved > 4) cv.classList.add('dragging');
    S.az -= dx / V.s / Math.max(0.35, Math.cos(S.alt));
    S.alt = clamp(S.alt + dy / V.s, -89.9 * DEG, 89.9 * DEG);
    S.dirty = true; save();
  } else if (gesture.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (!AR.on) { S.fov = clamp(gesture.fov0 * gesture.d0 / Math.max(d, 1), 1 * DEG, 185 * DEG); S.dirty = true; save(); }
  }
});
function endPointer(e) {
  const g = gesture;
  pointers.delete(e.pointerId);
  cv.classList.remove('dragging');
  if (g && g.kind === 'drag' && pointers.size === 0 && g.moved < 8 && performance.now() - g.t0 < 600 && e.type === 'pointerup') handleTap(e.clientX, e.clientY, e.pointerType === 'touch');
  if (pointers.size === 0) gesture = null;
  else if (pointers.size === 1) gesture = { kind: 'drag', t0: 0, moved: 99 };
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('wheel', e => { e.preventDefault(); if (AR.on) return; S.fov = clamp(S.fov * Math.exp(e.deltaY * 0.0012), 1 * DEG, 185 * DEG); S.dirty = true; save(); }, { passive: false });
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || AR.on) return;
  const st = 5 * DEG * Math.min(1, S.fov / (60 * DEG));
  const k = { ArrowLeft: () => S.az -= st, ArrowRight: () => S.az += st, ArrowUp: () => S.alt = clamp(S.alt + st, -1.56, 1.56), ArrowDown: () => S.alt = clamp(S.alt - st, -1.56, 1.56), '+': () => S.fov = clamp(S.fov / 1.2, DEG, 185 * DEG), '-': () => S.fov = clamp(S.fov * 1.2, DEG, 185 * DEG) }[e.key];
  if (k) { k(); S.dirty = true; save(); }
});
function handleTap(x, y, touch) {
  const th = touch ? 26 : 16; let best = null, bd = 1e9;
  for (const p of picks) {
    if (p.kind === 'con') continue;
    const d = Math.hypot(p.x - x, p.y - y) - p.r * 0.6;
    const score = d + (p.kind === 'star' ? p.pri * 1.6 : -6);
    if (d < th && score < bd) { bd = score; best = p; }
  }
  if (!best) for (const p of picks) if (p.kind === 'con' && Math.abs(p.x - x) < p.r + 8 && Math.abs(p.y - y) < 12) { best = p; break; }
  if (best) select(best.kind === 'star' ? { kind: 'star', i: best.i } : best.kind === 'body' ? { kind: 'body', bi: best.bi } : { kind: 'con', c: best.c });
  else select(null);
}
function select(s) { S.selected = s; renderInfo(); S.dirty = true; }
function objAltAz(s) {
  const v = s.kind === 'star' ? [SN[s.i], SE[s.i], SU[s.i]] : s.kind === 'body' ? sky.bodies[s.bi].neu : eqjToNEU(s.c.v[0], s.c.v[1], s.c.v[2], [0, 0, 0]);
  return neuToAltAz(v);
}
function centerOn(s, fovDeg) {
  if (!s) return;
  const { alt, az } = objAltAz(s);
  if (AR.on) { toast(`${objName(s)} : azimut ${Math.round(az)}° ${cardinal(az)}, altitude ${Math.round(alt)}° — suivez la flèche`); return; }
  const toFov = fovDeg ? Math.min(S.fov, fovDeg * DEG) : S.fov;
  S.tween = { t0: performance.now(), dur: 700, az0: S.az, alt0: S.alt, fov0: S.fov, az1: S.az + angDiff(az, S.az * RAD) * DEG, alt1: clamp(alt < 0 ? Math.max(alt, 12) : alt, -89, 89) * DEG, fov1: toFov };
  if (alt < 0) toast(`${objName(s)} est actuellement sous l'horizon (${fmtDeg(alt, 0)})`);
}

/* ---------------- Recherche ---------------- */
const INDEX = [];
BODIES.forEach((b, bi) => INDEX.push({ label: b.fr, sub: b.type, keys: [fold(b.fr), fold(b.key)], sel: { kind: 'body', bi }, rank: 0 }));
CONS.forEach(c => INDEX.push({ label: c.fr, sub: `Constellation · ${c.la}`, keys: [fold(c.fr), fold(c.la), fold(c.id)], sel: { kind: 'con', c }, rank: 1 }));
const GREEK = { 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega' };
for (let i = 0; i < NS; i++) {
  const n = D.names[SHIP[i]]; if (!n) continue;
  if (!n[0] && SMAG[i] > 4.5) continue;
  const c = consById[n[2]]; const keys = [];
  if (n[0]) keys.push(fold(n[0]));
  if (n[1] && c) { keys.push(fold(`${n[1]} ${c.gen}`)); keys.push(fold(`${n[1]} ${c.id}`)); if (GREEK[n[1]]) { keys.push(fold(`${GREEK[n[1]]} ${c.gen}`)); keys.push(fold(`${GREEK[n[1]]} ${c.id}`)); } }
  keys.push('hip ' + SHIP[i]);
  INDEX.push({ label: starName(i), sub: `Étoile · mag ${num(SMAG[i], 1)}${c ? ' · ' + c.fr : ''}`, keys, sel: { kind: 'star', i }, rank: 2 + SMAG[i] / 10 });
}
const si = $('searchInput'), sr = $('searchResults'); let results = [], selIdx = 0;
function doSearch() {
  const q = fold(si.value);
  if (!q) { closeSearch(); return; }
  const hits = [];
  for (const it of INDEX) {
    let sc = 1e9;
    for (const k of it.keys) { if (k === q) sc = Math.min(sc, 0); else if (k.startsWith(q)) sc = Math.min(sc, 1); else if (k.includes(' ' + q)) sc = Math.min(sc, 2); else if (q.length > 2 && k.includes(q)) sc = Math.min(sc, 3); }
    if (sc < 1e9) hits.push([sc * 10 + it.rank, it]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  results = hits.slice(0, 8).map(h => h[1]); selIdx = 0;
  sr.innerHTML = results.length ? results.map((r, k) => `<li data-k="${k}" class="${k === 0 ? 'sel' : ''}"><span>${r.label}</span><small>${r.sub}</small></li>`).join('') : '<li><span class="muted">Aucun résultat</span></li>';
  sr.classList.remove('hidden');
}
function closeSearch() { sr.classList.add('hidden'); }
function pickResult(k) {
  const r = results[k]; if (!r) return;
  si.value = r.label; closeSearch(); si.blur();
  updateSky(true);
  select(r.sel); centerOn(r.sel, r.sel.kind === 'con' ? 80 : 60);
}
si.addEventListener('input', doSearch);
si.addEventListener('focus', () => { if (si.value) doSearch(); });
si.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selIdx = clamp(selIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1); [...sr.children].forEach((li, k) => li.classList.toggle('sel', k === selIdx)); }
  else if (e.key === 'Enter') { e.preventDefault(); if (!results.length) doSearch(); pickResult(selIdx); }
  else if (e.key === 'Escape') { closeSearch(); si.blur(); }
});
sr.addEventListener('pointerdown', e => { const li = e.target.closest('li[data-k]'); if (li) { e.preventDefault(); pickResult(+li.dataset.k); } });

/* ---------------- Temps ---------------- */
const slider = $('timeSlider');
function setLive() { S.anchor = Date.now(); S.slider = 0; slider.value = 0; S.live = true; S.playing = false; syncTimeUI(); S.dirty = true; }
function shift(sec) { S.live = false; S.anchor += sec * 1000; S.dirty = true; syncTimeUI(); }
$('nowBtn').onclick = setLive;
document.querySelectorAll('.sbtn[data-step]').forEach(b => b.onclick = () => shift(+b.dataset.step));
$('playBtn').onclick = () => { S.playing = !S.playing; if (S.playing) S.live = false; syncTimeUI(); };
$('speedSel').onchange = e => { S.speed = +e.target.value; if (!S.playing) { S.playing = true; S.live = false; } syncTimeUI(); };
slider.addEventListener('input', () => { S.slider = +slider.value; if (S.slider !== 0) S.live = false; S.dirty = true; syncTimeUI(); });
function syncTimeUI() {
  $('playBtn').classList.toggle('on', S.playing); $('playBtn').textContent = S.playing ? '❚❚' : '▶';
  const off = S.slider; const a = Math.abs(off);
  $('offsetLabel').textContent = off === 0 ? '±0' : (off > 0 ? '+' : '−') + (a >= 1440 ? `${Math.floor(a / 1440)} j ${Math.round((a % 1440) / 60)} h` : `${Math.floor(a / 60)} h ${String(a % 60).padStart(2, '0')}`);
  $('nowBtn').classList.toggle('accent', !S.live);
}
let lastClockTxt = '';
function updateClock() {
  const d = new Date(simMs());
  const t = fmt('hm').format(d) + '|' + S.live + '|' + S.loc.tz;
  if (t !== lastClockTxt) { lastClockTxt = t; $('clockTime').textContent = fmt('hm').format(d); $('clockDate').textContent = fmt(window.innerWidth <= 720 ? 'dmed' : 'date').format(d) + (S.live ? ' · en direct' : ''); }
}
let toastTimer = 0;
function toast(msg, ms = 4200) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms); }

/* ---------------- Panneaux ---------------- */
const PANELS = ['tonight', 'forecast', 'layers', 'location'];
function openPanel(name, forceOpen) {
  const el = $('panel-' + name); const willOpen = forceOpen || el.classList.contains('hidden');
  PANELS.forEach(n => $('panel-' + n).classList.toggle('hidden', !(n === name && willOpen)));
  document.querySelectorAll('.fab[data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === name && willOpen));
  if (!willOpen) return;
  if (window.innerWidth <= 720) select(null);
  if (name === 'tonight') renderTonight();
  if (name === 'forecast') loadForecast();
}
document.querySelectorAll('.fab[data-panel]').forEach(b => b.onclick = () => openPanel(b.dataset.panel));
$('locBtn').onclick = () => openPanel('location');
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => {
  const id = b.dataset.close;
  if (id === 'infoCard') select(null); else { $(id).classList.add('hidden'); document.querySelectorAll('.fab[data-panel]').forEach(f => f.classList.remove('on')); }
});
document.querySelectorAll('[data-opt]').forEach(cb => {
  cb.checked = !!S.opts[cb.dataset.opt];
  cb.onchange = () => { S.opts[cb.dataset.opt] = cb.checked; S.dirty = true; save(); if (cb.dataset.opt === 'laser') { LASER.target = null; LASER.key = ''; renderLaserPanel(performance.now()); } };
});
$('magLimit').value = S.magLimit; $('magLimitVal').textContent = num(S.magLimit, 1);
$('magLimit').oninput = e => { S.magLimit = +e.target.value; $('magLimitVal').textContent = num(S.magLimit, 1); S.dirty = true; save(); };
function applyNight() { document.body.classList.toggle('night', S.night); $('nightBtn').classList.toggle('on', S.night); document.querySelector('meta[name=theme-color]').content = S.night ? '#000000' : '#05070d'; }
$('nightBtn').onclick = () => { S.night = !S.night; applyNight(); save(); };

/* ---------------- Lieu ---------------- */
const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; } })();
const TZS = [...new Set(['Europe/Paris', deviceTz, 'UTC', 'Europe/London', 'Europe/Brussels', 'Europe/Zurich', 'America/Montreal', 'America/New_York', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne', 'Indian/Reunion', 'Indian/Mayotte', 'Pacific/Noumea', 'Pacific/Tahiti', 'Africa/Casablanca', 'Africa/Dakar', 'Asia/Tokyo', 'Australia/Sydney'].filter(validTz))];
$('tzSel').innerHTML = TZS.map(t => `<option value="${t}">${t}${t === deviceTz ? ' (appareil)' : ''}</option>`).join('');
function syncLocUI() {
  $('locLabel').textContent = S.loc.name || `${num(S.loc.lat, 2)}°, ${num(S.loc.lon, 2)}°`;
  $('locName').value = S.loc.name; $('latInput').value = S.loc.lat; $('lonInput').value = S.loc.lon;
  if (!TZS.includes(S.loc.tz) && validTz(S.loc.tz)) { TZS.push(S.loc.tz); $('tzSel').insertAdjacentHTML('beforeend', `<option value="${S.loc.tz}">${S.loc.tz}</option>`); }
  $('tzSel').value = S.loc.tz;
}
function setLocation(loc) {
  S.loc = { ...S.loc, ...loc };
  observer = new A.Observer(S.loc.lat, S.loc.lon, 0);
  riseCache.clear(); frameKey = ''; S.dirty = true; lastClockTxt = ''; syncLocUI(); save();
  forecastState.key = null; updateSky(true);
  if (!$('panel-tonight').classList.contains('hidden')) renderTonight();
  if (!$('panel-forecast').classList.contains('hidden')) loadForecast();
  renderInfo();
}
$('locApply').onclick = () => {
  const lat = parseFloat(String($('latInput').value).replace(',', '.')), lon = parseFloat(String($('lonInput').value).replace(',', '.'));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { $('geoStatus').textContent = 'Coordonnées invalides : latitude entre −90 et 90, longitude entre −180 et 180.'; return; }
  setLocation({ name: $('locName').value.trim() || 'Lieu personnalisé', lat, lon, tz: $('tzSel').value });
  $('geoStatus').textContent = 'Lieu mis à jour.';
};
$('locReset').onclick = () => { setLocation({ ...DEFAULT_LOC }); $('geoStatus').textContent = 'Retour à La Rochelle.'; };
$('geoBtn').onclick = () => {
  const st = $('geoStatus');
  if (!navigator.geolocation) { st.textContent = 'La géolocalisation n\'est pas disponible dans ce navigateur. Saisissez la latitude et la longitude.'; return; }
  st.textContent = 'Recherche de votre position…';
  navigator.geolocation.getCurrentPosition(p => {
    const lat = +p.coords.latitude.toFixed(4), lon = +p.coords.longitude.toFixed(4);
    setLocation({ name: 'Ma position', lat, lon, tz: deviceTz || S.loc.tz });
    st.textContent = `Position trouvée : ${num(lat, 4)}°, ${num(lon, 4)}° (± ${Math.round(p.coords.accuracy)} m).`;
  }, err => {
    const m = { 1: 'Permission refusée. Autorisez la localisation pour cette page, ou saisissez les coordonnées.', 2: 'Position indisponible.', 3: 'Délai dépassé.' };
    st.textContent = (m[err.code] || 'Erreur de géolocalisation.') + (window.isSecureContext ? '' : ' (La géolocalisation exige souvent une page HTTPS.)');
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
};

/* ---------------- Ce soir ---------------- */
function altOf(bodyKey, ms) { const t = A.MakeTime(new Date(ms)); const eq = A.Equator(bodyKey, t, observer, true, true); return A.Horizon(t, observer, eq.ra, eq.dec, 'normal'); }
function nightWindow(ms) {
  const p = tzParts(ms);
  let noon = localMidnight(ms) + 12 * 3600000;
  if (p.h < 12) noon -= 86400000;
  const t0 = A.MakeTime(new Date(noon));
  const f = fn => { try { return msOf(fn()); } catch (e) { return null; } };
  return {
    noon,
    sunset: f(() => A.SearchRiseSet('Sun', observer, -1, t0, 1)),
    civil: f(() => A.SearchAltitude('Sun', observer, -1, t0, 1, -6)),
    naut: f(() => A.SearchAltitude('Sun', observer, -1, t0, 1, -12)),
    astro: f(() => A.SearchAltitude('Sun', observer, -1, t0, 1, -18)),
    astroEnd: f(() => A.SearchAltitude('Sun', observer, +1, t0, 1, -18)),
    civilEnd: f(() => A.SearchAltitude('Sun', observer, +1, t0, 1, -6)),
    sunrise: f(() => A.SearchRiseSet('Sun', observer, +1, t0, 1))
  };
}
function drawMoonIcon(canvas, elong, phaseAngle) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.height = 72 * dpr; const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  drawMoonShape(g, 36, 36, 33, phaseAngle, elong < 180 ? 0 : Math.PI); // hémisphère nord : croissant éclairé à droite
}
function renderTonight() {
  const ms = simMs(); const nw = nightWindow(ms); const ref = nw.noon;
  const t = A.MakeTime(new Date(nw.sunset || ms));
  const elong = A.MoonPhase(t); const il = A.Illumination('Moon', t);
  let nextFull = null, nextNew = null;
  try { let q = A.SearchMoonQuarter(A.MakeTime(new Date(ms))); for (let k = 0; k < 8 && (nextFull == null || nextNew == null); k++) { if (q.quarter === 2 && nextFull == null) nextFull = msOf(q.time); if (q.quarter === 0 && nextNew == null) nextNew = msOf(q.time); q = A.NextMoonQuarter(q); } } catch (e) {}
  const t0 = A.MakeTime(new Date(ref));
  let mr = null, mset = null; try { mr = msOf(A.SearchRiseSet('Moon', observer, +1, t0, 1)); } catch (e) {} try { mset = msOf(A.SearchRiseSet('Moon', observer, -1, t0, 1.2)); } catch (e) {}
  const age = elong / 360 * 29.530588;
  const dark = nw.astro && nw.astroEnd ? (nw.astroEnd - nw.astro) / 3600000 : 0;
  const start = nw.civil || nw.sunset || ref + 6 * 3600000, end = nw.civilEnd || nw.sunrise || start + 12 * 3600000;
  const rows = PLANETS.map(b => {
    let best = null;
    for (let tm = start; tm <= end; tm += 10 * 60000) { const h = altOf(b.key, tm); if (!best || h.altitude > best.alt) best = { alt: h.altitude, az: h.azimuth, tm }; }
    let mag = null; try { mag = A.Illumination(b.key, A.MakeTime(new Date(best.tm))).mag; } catch (e) {}
    const r = { b, best, mag, visible: best.alt > 5 && (mag == null || mag < 6.5) };
    if (r.visible) { try { r.rise = msOf(A.SearchRiseSet(b.key, observer, +1, t0, 1)); } catch (e) {} try { r.set = msOf(A.SearchRiseSet(b.key, observer, -1, t0, 1)); } catch (e) {} }
    return r;
  });
  const vis = rows.filter(r => r.visible).sort((a, b) => a.best.tm - b.best.tm), hid = rows.filter(r => !r.visible);
  const nightLabel = `${fmt('dmed').format(new Date(ref))} → ${fmt('dmed').format(new Date(ref + 86400000))}`;
  const L = (a, b) => `<span>${a}</span><span>${b}</span>`;
  $('tonightContent').innerHTML = `
  <div class="muted" style="margin-bottom:8px">Nuit du ${nightLabel} · ${S.loc.name}</div>
  <div class="moonbox"><canvas id="moonIcon"></canvas><div><div class="big">${moonPhaseName(elong)}</div>
  <div>Illumination <b>${Math.round(il.phase_fraction * 100)} %</b> · âge ${num(age, 1)} j</div>
  <div class="muted">Lever ${hmRel(mr, ref)} · Coucher ${hmRel(mset, ref)}</div>
  <div class="muted">Pleine Lune ${nextFull ? fmt('dmed').format(new Date(nextFull)) : '—'} · Nouvelle Lune ${nextNew ? fmt('dmed').format(new Date(nextNew)) : '—'}</div></div></div>
  <div class="sect">Soleil et crépuscules</div>
  <div class="timeline">${L('☀ Coucher du Soleil', hmRel(nw.sunset, ref))}${L('Fin du crépuscule civil (−6°)', hmRel(nw.civil, ref))}${L('Fin du crépuscule nautique (−12°)', hmRel(nw.naut, ref))}
  ${L('<b>Nuit astronomique (−18°)</b>', nw.astro ? `<b>${hmRel(nw.astro, ref)} → ${hmRel(nw.astroEnd, ref)}</b>` : 'pas de nuit noire')}${L('Durée de nuit noire', dark ? `${Math.floor(dark)} h ${String(Math.round((dark % 1) * 60)).padStart(2, '0')}` : '—')}
  ${L('Début de l\'aube astronomique', hmRel(nw.astroEnd, ref))}${L('Début de l\'aube civile', hmRel(nw.civilEnd, ref))}${L('☀ Lever du Soleil', hmRel(nw.sunrise, ref))}</div>
  <div class="sect">Planètes visibles</div>
  <ul class="plist">${vis.length ? vis.map(r => `<li data-body="${r.b.key}"><span class="pdot" style="background:${r.b.color};color:${r.b.color}"></span><div><div class="pname">${r.b.fr}</div><div class="pmeta">mag ${r.mag != null ? num(r.mag, 1) : '?'} · lever ${hmRel(r.rise, ref)} · coucher ${hmRel(r.set, ref)}</div></div>
     <div class="pright">Meilleur : <b>${hmRel(r.best.tm, ref)}</b><br><span class="muted">${fmtDeg(r.best.alt, 0)} · ${cardinal(r.best.az)}</span></div></li>`).join('') : '<li class="muted">Aucune planète bien placée cette nuit.</li>'}</ul>
  ${hid.length ? `<div class="fine">Non visibles cette nuit : ${hid.map(r => r.b.fr).join(', ')}.</div>` : ''}
  <p class="fine">« Meilleur » = moment de hauteur maximale entre la fin du crépuscule civil et l'aube civile. Heures : ${S.loc.tz}.</p>`;
  drawMoonIcon($('moonIcon'), elong, il.phase_angle);
  document.querySelectorAll('.plist li[data-body]').forEach(li => li.onclick = () => {
    const bi = BODIES.findIndex(b => b.key === li.dataset.body); const s = { kind: 'body', bi };
    if (window.innerWidth <= 720) openPanel('tonight');
    select(s); centerOn(s, 60);
  });
}

/* ---------------- Prévisions Open-Meteo ---------------- */
const forecastState = { key: null, hours: [], loading: false, source: '' };
function skyScore(h) {
  const total = h.cc ?? 100, low = h.lo ?? total, mid = h.mi ?? total, high = h.hi ?? total;
  const ce = clamp(0.55 * total + 0.45 * Math.max(low, 0.9 * mid, 0.55 * high), 0, 100);
  let s = 5 * (1 - ce / 100);
  if (h.rh != null && h.rh > 80) s -= Math.min(1.2, (h.rh - 80) / 20 * 1.2);
  if (h.vis != null && h.vis < 20000) s -= (1 - h.vis / 20000) * 1.6;
  if (h.wind != null && h.wind > 25) s -= Math.min(1, (h.wind - 25) / 25);
  if (h.pp != null && h.pp > 30) s -= (h.pp - 30) / 70 * 2;
  return clamp(Math.round(s * 10) / 10, 0, 5);
}
const scoreText = s => s < 1 ? '#ff6b7a' : s < 2 ? '#ff8a5c' : s < 3 ? '#ffb547' : s < 3.6 ? '#e6d75a' : s < 4.3 ? '#6fdc7c' : '#38e0b8';
const scoreColor = s => s < 1 ? '#5a2330' : s < 2 ? '#8c3b2f' : s < 3 ? '#c07a2c' : s < 3.6 ? '#c8b43a' : s < 4.3 ? '#5fbf6b' : '#38d6b0';
function sunMoonHours(t0, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * 3600000;
    out.push({ ms, sun: altOf('Sun', ms).altitude, moon: altOf('Moon', ms).altitude, moonIll: A.Illumination('Moon', A.MakeTime(new Date(ms))).phase_fraction });
  }
  return out;
}
async function loadForecast(force) {
  const st = $('forecastStatus');
  const key = S.loc.lat.toFixed(2) + ',' + S.loc.lon.toFixed(2);
  if (!force && forecastState.key === key && forecastState.hours.length) { drawForecastChart(); return; }
  if (forecastState.loading) return;
  forecastState.loading = true; forecastState.key = key;
  st.textContent = 'Chargement des prévisions…';
  const cacheKey = 'celeste.fc.' + key;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${S.loc.lat}&longitude=${S.loc.lon}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,wind_speed_10m,precipitation_probability,temperature_2m&forecast_days=7&timezone=GMT&timeformat=unixtime`;
  let data = null, note = '';
  try {
    if (navigator.onLine === false) throw new Error('hors ligne');
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
    if (!data.hourly || !data.hourly.time) throw new Error('réponse inattendue');
    try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data })); } catch (e) {}
    note = `Mis à jour à ${hm(Date.now())} · ${S.loc.name} · survolez/touchez le graphique pour le détail.`;
  } catch (e) {
    let cached = null; try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (e2) {}
    if (cached && cached.data && Date.now() - cached.at < 3 * 86400000) { data = cached.data; note = `⚠ Hors ligne ou service injoignable — données en cache du ${fmt('dmed').format(new Date(cached.at))} à ${hm(cached.at)}.`; }
    else note = '⚠ Prévisions indisponibles (hors ligne ou service Open-Meteo injoignable). La carte, « Ce soir » et les nuits astronomiques ci-dessous restent calculées localement.';
  }
  let i0 = 0;
  if (data) { const nowH = Math.floor(Date.now() / 3600000) * 3600; i0 = Math.max(0, data.hourly.time.findIndex(t => t >= nowH)); }
  const t0 = data ? data.hourly.time[i0] * 1000 : Math.floor(Date.now() / 3600000) * 3600000;
  const n = data ? Math.min(168, data.hourly.time.length - i0) : 168;
  const astro = sunMoonHours(t0, n);
  forecastState.hours = astro.map((a, j) => {
    if (!data) return { ...a, score: null };
    const Hh = data.hourly, i = i0 + j;
    const h = { cc: Hh.cloud_cover[i], lo: Hh.cloud_cover_low[i], mi: Hh.cloud_cover_mid[i], hi: Hh.cloud_cover_high[i], rh: Hh.relative_humidity_2m[i], vis: Hh.visibility[i], wind: Hh.wind_speed_10m[i], pp: Hh.precipitation_probability ? Hh.precipitation_probability[i] : null, temp: Hh.temperature_2m[i] };
    return { ...a, ...h, score: h.cc == null ? null : skyScore(h) };
  });
  forecastState.source = data ? 'ok' : 'none';
  st.textContent = note; forecastState.loading = false;
  drawForecastChart(); renderNights();
}
function renderNights() {
  const hrs = forecastState.hours; const groups = new Map();
  for (const h of hrs) { if (h.sun > -12) continue; const k = localMidnight(h.ms - 12 * 3600000); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h); }
  let html = '';
  for (const [k, list] of groups) {
    const dark = list.filter(h => h.sun < -18); const use = dark.length ? dark : list;
    const sc = use.filter(h => h.score != null);
    const avg = sc.length ? sc.reduce((a, h) => a + h.score, 0) / sc.length : null;
    let bestTxt = '';
    if (sc.length) { let bi = 0, bv = -1; for (let i = 0; i < sc.length; i++) { const w = sc.slice(i, i + 3); const v = w.reduce((a, h) => a + h.score, 0) / w.length; if (v > bv) { bv = v; bi = i; } } const w = sc.slice(bi, bi + 3); bestTxt = `Meilleur créneau ${hm(w[0].ms)}–${hm(w[w.length - 1].ms + 3600000)} (${num(bv, 1)})`; }
    const moon = list[Math.floor(list.length / 2)];
    html += `<div class="night"><b>${fmt('dmed').format(new Date(k + 12 * 3600000))}</b><span class="score" style="color:${avg != null ? scoreText(avg) : 'var(--mut)'}">${avg != null ? num(avg, 1) : '—'}</span><small> /5</small><br>
    <small>${dark.length ? `Nuit noire ${hm(dark[0].ms)}–${hm(dark[dark.length - 1].ms + 3600000)}` : 'Pas de nuit noire'}</small><br><small>${bestTxt || 'Météo indisponible'}</small><br><small>Lune ${Math.round(moon.moonIll * 100)} %${moon.moon > 0 ? ' (levée)' : ' (couchée)'}</small></div>`;
  }
  $('forecastNights').innerHTML = html;
}
const fcv = $('forecastChart');
let chartGeom = null;
function drawForecastChart() {
  if ($('panel-forecast').classList.contains('hidden') || !forecastState.hours.length) return;
  const w = fcv.clientWidth, h = fcv.clientHeight; if (!w) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1); fcv.width = w * dpr; fcv.height = h * dpr;
  const g = fcv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const hrs = forecastState.hours, n = hrs.length;
  const L = 26, R = 6, T = 18, B = 26, pw = w - L - R, ph = h - T - B, bw = pw / n;
  chartGeom = { L, bw };
  hrs.forEach((x, i) => { if (x.sun < -18) { g.fillStyle = 'rgba(122,162,255,.17)'; g.fillRect(L + i * bw, T, bw + 0.5, ph); } else if (x.sun < -6) { g.fillStyle = 'rgba(122,162,255,.07)'; g.fillRect(L + i * bw, T, bw + 0.5, ph); } });
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.fillStyle = '#8d98b8'; g.font = '10px system-ui,sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let s = 0; s <= 5; s++) { const y = T + ph - s / 5 * ph; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); g.fillText(s, L - 6, y); }
  hrs.forEach((x, i) => { if (x.score == null) return; const bh = Math.max(1.5, x.score / 5 * ph); g.fillStyle = scoreColor(x.score); g.globalAlpha = x.sun < -6 ? 1 : 0.4; g.fillRect(L + i * bw + 0.3, T + ph - bh, Math.max(0.8, bw - 0.6), bh); });
  g.globalAlpha = 1;
  if (hrs[0].cc != null) { g.strokeStyle = 'rgba(230,236,255,.6)'; g.lineWidth = 1; g.setLineDash([2, 3]); g.beginPath(); hrs.forEach((x, i) => { const y = T + ph - x.cc / 100 * ph; const X = L + i * bw + bw / 2; i ? g.lineTo(X, y) : g.moveTo(X, y); }); g.stroke(); g.setLineDash([]); }
  g.textBaseline = 'top'; g.fillStyle = '#c9d3f0'; g.textAlign = 'center';
  hrs.forEach((x, i) => { const p = tzParts(x.ms); if (p.h === 0) { g.strokeStyle = 'rgba(255,255,255,.2)'; g.beginPath(); g.moveTo(L + i * bw, T); g.lineTo(L + i * bw, T + ph + 4); g.stroke(); } if (p.h === 12) g.fillText(fmt('dshort').format(new Date(x.ms)), L + i * bw, T + ph + 8); });
  if (forecastState.source !== 'ok') { g.textBaseline = 'middle'; g.fillStyle = '#ffb547'; g.font = '13px system-ui,sans-serif'; g.fillText('Météo indisponible — seules les nuits astronomiques sont affichées', L + pw / 2, T + ph / 2); }
  g.textAlign = 'left'; g.fillStyle = '#8d98b8'; g.font = '10px system-ui,sans-serif'; g.textBaseline = 'top';
  g.fillText(hrs[0].cc != null ? 'Indice 0–5 (barres) · ┄ couverture nuageuse %' : 'Bandes bleues = nuit astronomique', L, 2);
}
(function chartTip() {
  const wrap = fcv.parentElement; const tip = document.createElement('div'); tip.id = 'chartTip'; tip.className = 'hidden'; wrap.appendChild(tip);
  const show = cx => {
    if (!chartGeom) return; const rect = fcv.getBoundingClientRect(); const i = Math.floor((cx - rect.left - chartGeom.L) / chartGeom.bw);
    const x = forecastState.hours[i]; if (!x) { tip.classList.add('hidden'); return; }
    tip.innerHTML = `<b>${fmt('dshort').format(new Date(x.ms))} ${hm(x.ms)}</b>${x.score != null ? ` · indice <b style="color:${scoreText(x.score)}">${num(x.score, 1)}</b><br>Nuages ${x.cc} % (bas ${x.lo} · moy. ${x.mi} · hauts ${x.hi})<br>Humidité ${x.rh} % · Visibilité ${x.vis != null ? num(x.vis / 1000, 0) : '?'} km<br>Vent ${num(x.wind, 0)} km/h · ${num(x.temp, 0)} °C${x.pp != null ? ' · pluie ' + x.pp + ' %' : ''}` : ''}<br>Soleil ${fmtDeg(x.sun, 0)} · Lune ${x.moon > 0 ? 'levée' : 'couchée'} (${Math.round(x.moonIll * 100)} %)`;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(Math.max(0, cx - rect.left - 90), rect.width - 210) + 'px'; tip.style.top = '18px';
  };
  fcv.addEventListener('pointermove', e => show(e.clientX));
  fcv.addEventListener('pointerdown', e => show(e.clientX));
  fcv.addEventListener('pointerleave', () => tip.classList.add('hidden'));
})();

/* ---------------- Pointeur laser ---------------- */
const LASER = { target: null, score: 0, lostAt: 0, last: 0, lastHtml: 0, key: '', con: '' };
const laserActive = () => AR.on || S.opts.laser;
const laserRadiusDeg = () => AR.on ? clamp(AR.fov * 0.06, 3, 5) : clamp(V.fovDeg * 0.045, 1.5, 5); // ~4° en mode caméra
const sameSel = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === 'star' ? a.i === b.i : a.kind === 'body' ? a.bi === b.bi : a.c === b.c);
function sepDeg(v) { return Math.acos(clamp(v[0] * V.fN + v[1] * V.fE + v[2] * V.fU, -1, 1)) * RAD; }
function laserScore(sel, R) {
  if (sel.kind === 'body') {
    const bs = sky.bodies[sel.bi]; const sep = sepDeg(bs.neu) - bs.angRad * RAD;
    return { sep, score: Math.max(0, sep) / R - 0.6 };
  }
  const i = sel.i; const sep = sepDeg([SN[i], SE[i], SU[i]]);
  return { sep, score: sep / R + (SMAG[i] - 1) * 0.08 };
}
function centreConstellation() {
  // direction visée -> J2000 (transposée de la rotation EQJ->HOR, sans réfraction)
  const m = rot, hx = V.fN, hy = -V.fE, hz = V.fU;
  const x = m[0][0] * hx + m[0][1] * hy + m[0][2] * hz, y = m[1][0] * hx + m[1][1] * hy + m[1][2] * hz, z = m[2][0] * hx + m[2][1] * hy + m[2][2] * hz;
  const ra = norm360(Math.atan2(y, x) * RAD) / 15, dec = Math.asin(clamp(z, -1, 1)) * RAD;
  try { return consFr(A.Constellation(ra, dec).symbol); } catch (e) { return ''; }
}
function updateLaser(now) {
  if (now - LASER.last < 125) return; // ~8 Hz
  LASER.last = now;
  const R = laserRadiusDeg(); const lim = AR.on ? clamp(effMagLimit(), 3.5, 5) : Math.min(effMagLimit(), 5.5);
  const groundOn = !AR.on && S.opts.ground;
  let best = null, bestScore = 1e9;
  sky.bodies.forEach((bs, bi) => {
    if (groundOn && bs.alt < -1) return;
    if (bs.b.key !== 'Sun' && bs.b.key !== 'Moon' && bs.mag != null && bs.mag > lim + 1.5) return;
    const r = laserScore({ kind: 'body', bi }, R);
    if (r.sep < R * 1.2 && r.score < bestScore) { bestScore = r.score; best = { kind: 'body', bi }; }
  });
  const cosR = Math.cos(R * DEG);
  for (let i = 0; i < NS; i++) {
    if (SMAG[i] > lim) break;
    const d = SN[i] * V.fN + SE[i] * V.fE + SU[i] * V.fU; if (d < cosR) continue;
    if (groundOn && SU[i] < 0) continue;
    const sc = Math.acos(clamp(d, -1, 1)) * RAD / R + (SMAG[i] - 1) * 0.08;
    if (sc < bestScore) { bestScore = sc; best = { kind: 'star', i }; }
  }
  // Hystérésis : on garde la cible tant qu'elle reste proche et pas nettement battue
  const cur = LASER.target;
  if (cur) {
    const c = laserScore(cur, R);
    const stillIn = c.sep < R * 1.4;
    if (stillIn) {
      LASER.lostAt = 0;
      if (!best || sameSel(best, cur) || bestScore > c.score - 0.18) { best = cur; bestScore = c.score; }
    } else if (!best) {
      if (!LASER.lostAt) LASER.lostAt = now;
      if (now - LASER.lostAt < 350) { best = cur; bestScore = c.score; }
    }
  }
  if (best && !sameSel(best, cur)) LASER.lostAt = 0;
  LASER.target = best; LASER.score = bestScore;
  if (!best) LASER.con = centreConstellation();
  renderLaserPanel(now);
}
function distText(sel) {
  if (sel.kind === 'star') {
    const ex = D.extra && D.extra[SHIP[sel.i]]; const pc = ex ? ex[0] : 0;
    if (!pc) return 'inconnue';
    const ly = pc * 3.26156;
    return `≈ ${ly < 100 ? num(ly, 1) : Math.round(ly).toLocaleString('fr-FR')} al (${num(pc, pc < 100 ? 1 : 0)} pc)`;
  }
  const bs = sky.bodies[sel.bi];
  if (bs.b.key === 'Moon') return `${Math.round(bs.distKm).toLocaleString('fr-FR')} km`;
  const lm = bs.distKm / 299792.458 / 60;
  return `${num(bs.eq.dist, bs.eq.dist < 10 ? 3 : 2)} UA (${lm < 60 ? num(lm, 1) + ' min' : num(lm / 60, 1) + ' h'}-lumière)`;
}
function renderLaserPanel(now) {
  const el = $('laserPanel');
  if (!laserActive()) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const t = LASER.target;
  const key = t ? (t.kind + (t.i ?? t.bi)) : 'none:' + LASER.con;
  if (key === LASER.key && now - LASER.lastHtml < 1000) return;
  LASER.key = key; LASER.lastHtml = now;
  if (!t) {
    el.classList.add('empty');
    el.innerHTML = `<div class="lz-name"><span class="lz-dot"></span>Visez un astre…</div><div class="lz-row">${LASER.con ? 'Constellation : <b>' + LASER.con + '</b> · ' : ''}rayon de capture ${num(laserRadiusDeg(), 1)}°</div>`;
    return;
  }
  el.classList.remove('empty');
  const ms = simMs(); let name, type, con = '', mag, aa, r;
  if (t.kind === 'star') {
    const n = D.names[SHIP[t.i]] || ['', '', '']; name = starName(t.i); type = 'Étoile';
    const ex = D.extra && D.extra[SHIP[t.i]]; if (ex && ex[1]) type += ' ' + ex[1];
    con = consFr(n[2]) || ''; mag = SMAG[t.i]; aa = starAltAz(t.i); r = riseTransitSet('star', SRA[t.i] / 15, SDEC[t.i], ms);
    if (!con) { try { con = consFr(A.Constellation(SRA[t.i] / 15, SDEC[t.i]).symbol); } catch (e) {} }
  } else {
    const bs = sky.bodies[t.bi]; name = bs.b.fr; type = bs.b.type; mag = bs.mag; aa = { alt: bs.alt, az: bs.az };
    try { con = consFr(A.Constellation(bs.eq.ra, bs.eq.dec).symbol); } catch (e) {}
    r = riseTransitSet(bs.b.key, null, null, ms);
    if (bs.b.key === 'Moon') type += ` · ${moonPhaseName(sky.moonElong)} ${Math.round(bs.phase * 100)} %`;
  }
  const rs = r.circumpolar ? 'circumpolaire' : r.never ? 'ne se lève pas' : `↑ ${hmRel(r.rise, ms)} · ↓ ${hmRel(r.set, ms)}`;
  el.innerHTML = `<div class="lz-name"><span class="lz-dot on"></span>${name}<small>${type}</small></div>
  <div class="lz-row">${con ? '<span>' + con + '</span>' : ''}${mag != null ? `<span>mag ${num(mag, 2)}</span>` : ''}<span>${distText(t)}</span></div>
  <div class="lz-row"><span>Alt ${fmtDeg(aa.alt, 1)} · Az ${fmtDeg(aa.az, 0)} ${cardinal(aa.az)}</span><span>${rs}</span></div>
  <div class="lz-hint">Touchez pour la fiche complète</div>`;
}
$('laserPanel').addEventListener('click', () => { if (LASER.target) { select({ ...LASER.target }); } });
function drawLaser() {
  if (!laserActive()) return;
  const cx = V.cx, cy = V.cy, t = performance.now() / 1000;
  const R = laserRadiusDeg(); const rpx = (V.gnomonic ? Math.tan(R * DEG) : 2 * Math.tan(R * DEG / 2)) * V.s;
  ctx.save();
  // faisceau : de bas d'écran vers le centre
  const g = ctx.createLinearGradient(cx, H, cx, cy);
  g.addColorStop(0, 'rgba(60,255,120,0)'); g.addColorStop(0.7, 'rgba(60,255,120,.22)'); g.addColorStop(1, 'rgba(120,255,160,.55)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx - 7, H); ctx.lineTo(cx + 7, H); ctx.lineTo(cx + 1.2, cy); ctx.lineTo(cx - 1.2, cy); ctx.closePath(); ctx.fill();
  // cercle de capture
  ctx.strokeStyle = 'rgba(90,255,140,.35)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]);
  ctx.beginPath(); ctx.arc(cx, cy, rpx, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  // cible
  const tg = LASER.target; let tx = null, ty = null;
  if (tg) {
    const v = tg.kind === 'star' ? [SN[tg.i], SE[tg.i], SU[tg.i]] : sky.bodies[tg.bi].neu;
    if (proj(v[0], v[1], v[2])) {
      tx = P.x; ty = P.y;
      ctx.strokeStyle = 'rgba(110,255,160,.95)'; ctx.lineWidth = 1.6; ctx.shadowColor = '#3cff78'; ctx.shadowBlur = 8;
      const s = 13, k = 5;
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b]) => { ctx.beginPath(); ctx.moveTo(tx + a * s, ty + b * (s - k)); ctx.lineTo(tx + a * s, ty + b * s); ctx.lineTo(tx + a * (s - k), ty + b * s); ctx.stroke(); });
      if (Math.hypot(tx - cx, ty - cy) > 6) { ctx.strokeStyle = 'rgba(110,255,160,.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke(); }
      ctx.shadowBlur = 0;
    }
  }
  // point laser lumineux
  const pulse = 1 + 0.15 * Math.sin(t * 6);
  const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18 * pulse);
  gr.addColorStop(0, 'rgba(230,255,235,1)'); gr.addColorStop(0.2, 'rgba(80,255,130,.95)'); gr.addColorStop(0.5, 'rgba(40,255,100,.35)'); gr.addColorStop(1, 'rgba(40,255,100,0)');
  ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx, cy, 18 * pulse, 0, 7); ctx.fill();
  ctx.restore();
}

/* ---------------- Mode caméra (réalité augmentée) ---------------- */
const AR = { on: false, camera: false, stream: null, f: null, u: null, basis: null, raw: null, offset: null, absolute: false, fov: 66, userHead: 0, gotEvent: false, evName: null, camMsg: '' };
const arMsg = m => { $('arMsg').textContent = m || ''; };
function deviceAxes(al, be, ga) {
  const a = al * DEG, b = be * DEG, g = ga * DEG;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  // R = Rz(alpha)·Rx(beta)·Ry(gamma) ; repère terrestre (Est, Nord, Haut) selon la spécification W3C
  const m = [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG, sB, cB * cG]];
  return { X: [m[0][0], m[1][0], m[2][0]], Y: [m[0][1], m[1][1], m[2][1]], Z: [m[0][2], m[1][2], m[2][2]] };
}
function onOrient(e) {
  if (e.alpha == null && e.beta == null) return;
  AR.gotEvent = true;
  const raw = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0 };
  AR.raw = raw;
  if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) {
    // iOS : alpha est relatif. Le cap boussole (corrigé de l'inclinaison) correspond au haut de l'appareil
    // posé à plat, ou à l'axe de la caméra arrière tenu verticalement : on en déduit un décalage lissé.
    const { Y, Z } = deviceAxes(raw.alpha, raw.beta, raw.gamma);
    const refv = Math.abs(raw.beta) > 45 ? [-Z[0], -Z[1], -Z[2]] : Y;
    const azRaw = Math.atan2(refv[0], refv[1]) * RAD;
    const off = angDiff(e.webkitCompassHeading, azRaw);
    if (AR.offset == null) AR.offset = off;
    else if (!(e.webkitCompassAccuracy < 0)) AR.offset = norm360(AR.offset + angDiff(off, AR.offset) * 0.05);
    AR.absolute = true;
  } else if (e.absolute === true || e.type === 'deviceorientationabsolute') { AR.offset = 0; AR.absolute = true; }
  else if (AR.offset == null) { AR.offset = 0; AR.absolute = false; }
}
const vnorm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
let arLast = 0;
function updateAR(now) {
  if (!AR.on || !AR.raw) return;
  const { X, Y, Z } = deviceAxes(AR.raw.alpha, AR.raw.beta, AR.raw.gamma);
  let ang = 0;
  if (screen.orientation && typeof screen.orientation.angle === 'number') ang = screen.orientation.angle;
  else if (typeof window.orientation === 'number') ang = window.orientation;
  const th = ang * DEG, ct = Math.cos(th), st = Math.sin(th);
  const upE = [ct * Y[0] + st * X[0], ct * Y[1] + st * X[1], ct * Y[2] + st * X[2]]; // haut de l'écran
  const fE = [-Z[0], -Z[1], -Z[2]]; // axe de la caméra arrière
  const d = ((AR.offset || 0) + AR.userHead) * DEG, cd = Math.cos(d), sd = Math.sin(d);
  const toNEU = v => { const N = v[1], E = v[0]; return [N * cd - E * sd, N * sd + E * cd, v[2]]; };
  const f = toNEU(fE), u = toNEU(upE);
  const dt = Math.min(0.2, (now - (arLast || now)) / 1000); arLast = now;
  const k = AR.f ? 1 - Math.exp(-dt / 0.09) : 1; // lissage exponentiel (~90 ms)
  AR.f = vnorm(AR.f ? AR.f.map((x, i) => lerp(x, f[i], k)) : f);
  AR.u = vnorm(AR.u ? AR.u.map((x, i) => lerp(x, u[i], k)) : u);
  const r = vnorm(vcross(AR.u, AR.f)); const uu = vcross(AR.f, r);
  AR.basis = { fN: AR.f[0], fE: AR.f[1], fU: AR.f[2], rN: r[0], rE: r[1], rU: r[2], uN: uu[0], uE: uu[1], uU: uu[2] };
}
function startAR() {
  if (AR.on) { stopAR(); return; }
  // Les deux demandes partent directement dans le geste utilisateur (exigence iOS)
  let permP = Promise.resolve('granted');
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { permP = DeviceOrientationEvent.requestPermission().catch(() => 'denied'); } catch (e) { permP = Promise.resolve('denied'); }
  }
  let camP = Promise.resolve(null);
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try { camP = navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).catch(err => err); } catch (e) { camP = Promise.resolve(e); }
  }
  AR.on = true; AR.f = null; AR.u = null; AR.raw = null; AR.offset = null; AR.gotEvent = false; AR.absolute = false; arLast = 0; AR.camMsg = '';
  document.body.classList.add('ar'); $('arBar').classList.remove('hidden'); $('arBtn').classList.add('on');
  PANELS.forEach(n => $('panel-' + n).classList.add('hidden'));
  arMsg(window.isSecureContext ? 'Initialisation des capteurs…' : '⚠ Page non sécurisée (file:// ou http) : l\'iPhone bloque caméra et capteurs hors HTTPS. Ouvrez la version HTTPS de l\'application.');
  AR.evName = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  permP.then(perm => {
    if (!AR.on) return;
    if (perm !== 'granted') { arFail(/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Accès aux capteurs de mouvement refusé. Sur iPhone : Réglages › Apps › Safari › « Mouvement et orientation » (et page en HTTPS), puis rechargez.' : 'Capteurs d\'orientation refusés ou indisponibles sur cet appareil : le mode caméra nécessite un téléphone ou une tablette avec gyroscope et boussole.'); return; }
    window.addEventListener(AR.evName, onOrient);
    setTimeout(() => {
      if (!AR.on) return;
      if (!AR.gotEvent) arFail('Capteurs d\'orientation indisponibles : le mode caméra nécessite un téléphone ou une tablette avec gyroscope et boussole' + (window.isSecureContext ? '.' : ', ouvert en HTTPS.'));
      else if (!AR.absolute) arMsg('Boussole indisponible : orientation relative. Visez une étoile connue et ajustez « Cap ».');
      else arMsg(AR.camera ? 'Pointez le téléphone vers le ciel. Ajustez « Champ » et « Cap » si le ciel est décalé.' : (AR.camMsg || 'Mode gyroscope seul.'));
    }, 2500);
  });
  camP.then(res => {
    if (!AR.on) { if (res && res.getTracks) res.getTracks().forEach(t => t.stop()); return; }
    if (res && res.getTracks) {
      AR.stream = res; AR.camera = true; const v = $('camera'); v.srcObject = res; v.classList.add('on');
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    } else {
      AR.camera = false;
      AR.camMsg = res && res.name === 'NotAllowedError' ? 'Caméra refusée — mode gyroscope seul (ciel sur fond sombre).' : 'Caméra indisponible — mode gyroscope seul (ciel sur fond sombre).';
      if (AR.gotEvent) arMsg(AR.camMsg);
    }
    S.dirty = true;
  });
}
function arFail(msg) { stopAR(); toast(msg, 9000); }
function stopAR() {
  if (AR.f) { S.az = Math.atan2(AR.f[1], AR.f[0]); S.alt = clamp(Math.asin(clamp(AR.f[2], -1, 1)), -89 * DEG, 89 * DEG); S.fov = clamp(AR.fov * 1.3 * DEG, 20 * DEG, 120 * DEG); }
  AR.on = false; AR.camera = false; AR.f = null; AR.raw = null;
  if (AR.stream) { AR.stream.getTracks().forEach(t => t.stop()); AR.stream = null; }
  const v = $('camera'); v.srcObject = null; v.classList.remove('on');
  window.removeEventListener('deviceorientationabsolute', onOrient); window.removeEventListener('deviceorientation', onOrient);
  LASER.target = null; LASER.key = '';
  document.body.classList.remove('ar'); $('arBar').classList.add('hidden'); $('arBtn').classList.remove('on'); arMsg('');
  S.dirty = true;
}
$('arBtn').onclick = startAR;
$('arExit').onclick = stopAR;
$('arFov').oninput = e => { AR.fov = +e.target.value; $('arFovVal').textContent = AR.fov + '°'; S.dirty = true; };
$('arHead').oninput = e => { AR.userHead = +e.target.value; $('arHeadVal').textContent = (AR.userHead > 0 ? '+' : '') + AR.userHead + '°'; };

/* ---------------- Boucle ---------------- */
let lastT = performance.now(), lastLive = 0, lastInfo = 0;
function frame(now) {
  const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
  if (S.playing) { S.anchor += dt * 1000 * S.speed; S.dirty = true; }
  else if (S.live && now - lastLive > 1000) { S.anchor = Date.now(); lastLive = now; }
  if (S.tween) {
    const tw = S.tween, k = clamp((now - tw.t0) / tw.dur, 0, 1), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    S.az = lerp(tw.az0, tw.az1, e); S.alt = lerp(tw.alt0, tw.alt1, e); S.fov = lerp(tw.fov0, tw.fov1, e);
    if (k >= 1) { S.tween = null; save(); }
    S.dirty = true;
  }
  if (AR.on) { updateAR(now); S.dirty = true; }
  const changed = updateSky(false);
  if (laserActive()) { setupView(); updateLaser(now); S.dirty = true; } else if (LASER.key) { LASER.key = ''; LASER.target = null; renderLaserPanel(now); }
  if (changed || S.dirty || S.selected) { render(); S.dirty = false; }
  updateClock();
  if (S.selected && changed && now - lastInfo > (S.playing ? 300 : 1000)) { lastInfo = now; renderInfo(); }
  requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.live) S.anchor = Date.now(); });

/* ---------------- Démarrage ---------------- */
applyNight(); syncLocUI(); syncTimeUI(); resize(); updateSky(true);
requestAnimationFrame(frame);
if ((location.protocol === 'https:' || location.hostname === 'localhost') && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__celeste = {
  S, sky, AR, select, centerOn, setLocation, openPanel, loadForecast, forecastState, BODIES,
  setTime(ms) { S.live = false; S.playing = false; S.anchor = ms; S.slider = 0; slider.value = 0; syncTimeUI(); S.dirty = true; updateSky(true); },
  bodyAltAz() { updateSky(true); return sky.bodies.map(b => ({ key: b.b.key, alt: b.alt, az: b.az, mag: b.mag })); },
  starAltAzByName(name) { const it = INDEX.find(x => x.label === name && x.sel.kind === 'star'); return it ? starAltAz(it.sel.i) : null; },
  project(alt, az) { const v = altAzVec(alt, az); return proj(v[0], v[1], v[2]) ? { x: P.x, y: P.y } : null; },
  laser: () => ({ target: LASER.target && objName(LASER.target), kind: LASER.target && LASER.target.kind, radius: laserRadiusDeg(), html: $('laserPanel').innerText }),
  aimAltAz(alt, az) { S.az = az * DEG; S.alt = alt * DEG; S.dirty = true; },
  simMs, search(q) { si.value = q; doSearch(); pickResult(0); }
};
})();
