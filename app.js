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
  opts: { lines: true, conNames: true, starNames: true, grid: false, eqGrid: false, ecliptic: true, milkyway: true, ground: true, atmosphere: true, laser: true },
  quality: 'auto',
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
    if (['auto', 'high', 'medium', 'low'].includes(saved.quality)) S.quality = saved.quality;
  }
} catch (e) { /* stockage indisponible */ }
try { const l = localStorage.getItem('celeste.laser'); S.opts.laser = l == null ? true : l === '1'; } catch (e) { S.opts.laser = true; }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('celeste.v1', JSON.stringify({ loc: S.loc, opts: S.opts, magLimit: S.magLimit, az: S.az, alt: S.alt, fov: S.fov, night: S.night, quality: S.quality })); } catch (e) {}
  }, 400);
}
const simMs = () => S.anchor + S.slider * 60000;
let observer = new A.Observer(S.loc.lat, S.loc.lon, 0);

/* ---------------- Fuseaux et formats ---------------- */
const fmtCache = {};
const tzOk = new Map();
function validTz(tz) { if (tzOk.has(tz)) return tzOk.get(tz); let r; try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); r = tz; } catch (e) { r = undefined; } tzOk.set(tz, r); return r; }
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
/* Tampons précalculés (horizontaux) mis à jour dans updateSky : rien n'est recalculé à chaque image */
const flat = list => { const a = new Float32Array(list.length * 3); list.forEach((v, i) => { a[i * 3] = v[0]; a[i * 3 + 1] = v[1]; a[i * 3 + 2] = v[2]; }); return a; };
const CURVES = { lines: LINES.map(seg => ({ q: flat(seg), n: new Float32Array(seg.length * 3) })), ecl: { q: flat(ECL), n: new Float32Array(ECL.length * 3) }, equ: { q: flat(EQU), n: new Float32Array(EQU.length * 3) } };
const CONSN = new Float32Array(CONS.length * 3);
let mwKey = '';

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
const REFR_MIN = -1, REFR_STEP = 0.01, REFR = (() => { const n = Math.ceil((89.9 - REFR_MIN) / REFR_STEP) + 2, t = new Float32Array(n); for (let i = 0; i < n; i++) t[i] = A.Refraction('normal', REFR_MIN + i * REFR_STEP); return t; })();
function refrFast(alt) {
  if (alt < REFR_MIN || alt >= 89.9) return A.Refraction('normal', alt);
  const x = (alt - REFR_MIN) / REFR_STEP, i = x | 0, f = x - i; return REFR[i] + (REFR[i + 1] - REFR[i]) * f;
}
let refrExact = false;
function refractNEU(N, E, U, out) {
  const alt = Math.asin(clamp(U, -1, 1)) * RAD;
  if (alt < 89.9) { // même modèle que astronomy-engine Horizon(..., 'normal') ; table interpolée (< 0,5″) hors astres du Système solaire
    const a2 = alt + (refrExact ? A.Refraction('normal', alt) : refrFast(alt));
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
  refrExact = true; const neu = eqjToNEU(v[0], v[1], v[2], [0, 0, 0]); refrExact = false;
  let mag = null, phase = null, phaseAngle = null;
  try { const il = A.Illumination(b.key, t); mag = il.mag; phase = il.phase_fraction; phaseAngle = il.phase_angle; } catch (e) {}
  const distKm = eq.dist * AU_KM;
  const angRad = Math.asin(Math.min(1, b.radiusKm / distKm));
  return { b, eq, v, neu, mag, phase, phaseAngle, distKm, angRad, ...neuToAltAz(neu) };
}
function updateSky(force) {
  const ms = simMs();
  // en direct : recalcul toutes les 2 s (le ciel tourne de 0,008° : invisible) ; sinon à chaque changement d'heure
  const key = (S.live && !S.playing ? 'L' + Math.floor(ms / 2000) : ms) + '|' + S.loc.lat + '|' + S.loc.lon;
  if (!force && key === frameKey) return false;
  frameKey = key;
  curT = A.MakeTime(new Date(ms));
  rot = A.Rotation_EQJ_HOR(curT, observer).rot;
  for (let i = 0; i < NS; i++) {
    eqjToNEU(SX[i], SY[i], SZ[i], tmp3);
    SN[i] = tmp3[0]; SE[i] = tmp3[1]; SU[i] = tmp3[2];
  }
  const xf = (c, refr) => { const q = c.q, n = c.n; for (let k = 0; k < q.length; k += 3) { eqjToNEU(q[k], q[k + 1], q[k + 2], tmp3, refr); n[k] = tmp3[0]; n[k + 1] = tmp3[1]; n[k + 2] = tmp3[2]; } };
  for (const c of CURVES.lines) xf(c, true);
  xf(CURVES.ecl, true); xf(CURVES.equ, true);
  for (let k = 0; k < CONS.length; k++) { const v = CONS[k].v; eqjToNEU(v[0], v[1], v[2], tmp3); CONSN[k * 3] = tmp3[0]; CONSN[k * 3 + 1] = tmp3[1]; CONSN[k * 3 + 2] = tmp3[2]; }
  mwKey = '';
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
/* Qualité adaptative : niveau initial selon l'appareil, puis abaissé si les images mettent trop de temps */
const LEVELS = [
  { name: 'Haute', dpr: 2, mag: 6.5, lab: 1, glow: 1.8 },
  { name: 'Moyenne', dpr: 1.5, mag: 6.2, lab: 1, glow: 1.3 },
  { name: 'Économie', dpr: 1, mag: 5.6, lab: 0.8, glow: 0.7 }];
const HWC = navigator.hardwareConcurrency || 8, DMEM = navigator.deviceMemory || 8;
const lowEnd = HWC <= 4 || DMEM <= 4;
const Q = { level: 0, auto: true, base: lowEnd ? 1 : 0, ema: 16.7, n: 0, slowSince: 0, fastSince: 0, ups: 0, downs: 0, lastRT: 0, renders: 0, frames: 0, cost: 0, lastRender: 0, ovl: false };
function initQuality() { Q.auto = S.quality === 'auto'; Q.level = Q.auto ? Q.base : { high: 0, medium: 1, low: 2 }[S.quality]; }
function setLevel(l) { l = clamp(l, 0, 2); if (l === Q.level) return; Q.level = l; Q.n = 0; Q.ema = 16.7; Q.slowSince = Q.fastSince = 0; resize(); }
function qualityTick(now, rendered) {
  if (!rendered) return;
  const dt = now - Q.lastRT; Q.lastRT = now;
  if (dt > 250) return; // pas un rendu continu (vue immobile)
  Q.ema += (dt - Q.ema) * 0.08; Q.n++;
  if (!Q.auto || Q.n < 24) return;
  if (Q.ema > 42 && Q.level < 2) { Q.fastSince = 0; if (!Q.slowSince) Q.slowSince = now; else if (now - Q.slowSince > 1200) { Q.downs++; setLevel(Q.level + 1); } }
  else if (Q.ema < (AR.on ? 36 : 19) && Q.level > 0 && Q.ups < 2 && Q.downs < 3) { Q.slowSince = 0; if (!Q.fastSince) Q.fastSince = now; else if (now - Q.fastSince > 8000) { Q.ups++; setLevel(Q.level - 1); } }
  else { Q.slowSince = 0; Q.fastSince = 0; }
}
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, LEVELS[Q.level].dpr);
  W = cv.clientWidth; H = cv.clientHeight;
  const cw = Math.round(W * DPR), ch = Math.round(H * DPR);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  mwKey = '';
  document.body.classList.toggle('lite', Q.level >= 1);
  S.dirty = true; drawForecastChart();
}
window.addEventListener('resize', resize);
if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', () => setTimeout(resize, 50));
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
const SUNGLOW = sprite('255,226,150', 128);
const spriteCache = {};
function spriteFor(hex) {
  if (!spriteCache[hex]) { const n = parseInt(hex.slice(1), 16); spriteCache[hex] = sprite(`${n >> 16},${(n >> 8) & 255},${n & 255}`); }
  return spriteCache[hex];
}

/* ---------------- Rendu ---------------- */
let picks = [];
const LB = new Float32Array(4 * 600); let nLB = 0;
function labelFits(x, y, w, h) {
  for (let k = 0; k < nLB * 4; k += 4) if (x < LB[k] + LB[k + 2] && x + w > LB[k] && y < LB[k + 1] + LB[k + 3] && y + h > LB[k + 1]) return false;
  if (nLB < 600) { const k = nLB * 4; LB[k] = x; LB[k + 1] = y; LB[k + 2] = w; LB[k + 3] = h; nLB++; }
  return true;
}
const twCache = new Map();
function textW(txt, font) { const k = font + txt; let w = twCache.get(k); if (w === undefined) { w = ctx.measureText(txt).width; if (twCache.size > 3000) twCache.clear(); twCache.set(k, w); } return w; }
/* étoiles visibles : tableaux typés réutilisés (pas d'objet par étoile et par image) */
const VS_I = new Int32Array(NS), VS_X = new Float32Array(NS), VS_Y = new Float32Array(NS), VS_R = new Float32Array(NS), VS_B = new Uint8Array(NS), VS_ORD = new Int32Array(NS);
let nVS = 0; const BUCKET_N = new Int32Array(COLBINS.length * 4 + 1), BUCKET_A = [0.3, 0.55, 0.8, 1];
const FILLPOS = new Int32Array(COLBINS.length * 4);
const COLSTR = COLRGB.map(c => `rgb(${c[0]},${c[1]},${c[2]})`);
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
function pathFlat(n) { // n : Float32Array de vecteurs horizontaux (N,E,U) ; ajoute au chemin courant
  let pen = false; const mx = W * 3, my = H * 3;
  for (let k = 0; k < n.length; k += 3) {
    if (proj(n[k], n[k + 1], n[k + 2]) && Math.abs(P.x - V.cx) < mx && Math.abs(P.y - V.cy) < my) {
      if (pen) ctx.lineTo(P.x, P.y); else ctx.moveTo(P.x, P.y);
      pen = true;
    } else pen = false;
  }
}
function drawCurve(n) { ctx.beginPath(); pathFlat(n); ctx.stroke(); }
const GRIDC = {};
function gridCurves(step, azStep) {
  const k = step + '|' + azStep; if (GRIDC[k]) return GRIDC[k];
  const out = [];
  for (let alt = -80; alt <= 80; alt += step) { if (alt === 0) continue; const pts = []; for (let az = 0; az <= 360; az += 2) pts.push(altAzVec(alt, az)); out.push(flat(pts)); }
  for (let az = 0; az < 360; az += azStep) { const pts = []; for (let alt = -88; alt <= 88; alt += 2) pts.push(altAzVec(alt, az)); out.push(flat(pts)); }
  return (GRIDC[k] = out);
}
const altAzVec = (alt, az) => [Math.cos(alt * DEG) * Math.cos(az * DEG), Math.cos(alt * DEG) * Math.sin(az * DEG), Math.sin(alt * DEG)];
function drawAltAzGrid() {
  ctx.strokeStyle = 'rgba(110,170,255,.22)'; ctx.lineWidth = 1;
  const step = V.fovDeg < 40 ? 5 : 10, azStep = V.fovDeg < 40 ? 10 : 15;
  ctx.beginPath(); for (const c of gridCurves(step, azStep)) pathFlat(c); ctx.stroke();
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
/* Voie lactée : texture galactique précalculée (1°) échantillonnée sur une grille d'écran grossière, puis agrandie
   avec lissage bilinéaire. Quelques milliers de calculs par image au lieu de milliers d'appels drawImage. */
const MWT_W = 360, MWT_H = 181, MWT = (() => {
  const t = new Float32Array(MWT_W * MWT_H);
  for (let i = 0; i < MW.length; i++) {
    const p = MW[i], v = p.v;
    const g0 = GAL[0][0] * v[0] + GAL[0][1] * v[1] + GAL[0][2] * v[2], g1 = GAL[1][0] * v[0] + GAL[1][1] * v[1] + GAL[1][2] * v[2], g2 = GAL[2][0] * v[0] + GAL[2][1] * v[1] + GAL[2][2] * v[2];
    const l0 = Math.atan2(g1, g0) * RAD, b0 = Math.asin(clamp(g2, -1, 1)) * RAD, rad = p.size, amp = 0.03 * p.w;
    const cb = Math.max(0.05, Math.cos(b0 * DEG));
    for (let b = Math.floor(b0 - rad); b <= Math.ceil(b0 + rad); b++) {
      if (b < -90 || b > 90) continue;
      const dl = Math.ceil(rad / cb);
      for (let l = Math.floor(l0 - dl); l <= Math.ceil(l0 + dl); l++) {
        const d = Math.hypot((l - l0) * cb, b - b0); if (d >= rad) continue;
        t[(b + 90) * MWT_W + ((l % 360) + 360) % 360] += amp * (1 - d / rad);
      }
    }
  }
  return t;
})();
const mwImgCv = document.createElement('canvas'), mwImgCtx = mwImgCv.getContext('2d');
let mwImg = null;
function drawMilkyWay(dark) {
  const c = [5, 7, 10][Q.level]; // pas de la grille (px CSS)
  const cols = Math.ceil(W / c) + 2, rows = Math.ceil(H / c) + 2;
  const key = V.fN.toFixed(5) + V.fE.toFixed(5) + V.fU.toFixed(5) + V.rU.toFixed(5) + '|' + V.s.toFixed(2) + '|' + V.gnomonic + '|' + dark.toFixed(2) + '|' + c + '|' + W + 'x' + H + frameKey;
  if (key !== mwKey) {
    mwKey = key;
    if (!mwImg || mwImg.width !== cols || mwImg.height !== rows) { mwImgCv.width = cols; mwImgCv.height = rows; mwImg = mwImgCtx.createImageData(cols, rows); }
    const px = mwImg.data, m = rot, is = 1 / V.s, gn = V.gnomonic;
    const G = GAL, ox = -c, oy = -c; // la grille déborde d'une cellule autour de l'écran
    let o = 0;
    for (let j = 0; j < rows; j++) {
      const Y = -((oy + j * c) - V.cy) * is;
      for (let i = 0; i < cols; i++, o += 4) {
        const X = ((ox + i * c) - V.cx) * is;
        let N, E, U;
        if (gn) { N = V.fN + X * V.rN + Y * V.uN; E = V.fE + X * V.rE + Y * V.uE; U = V.fU + X * V.rU + Y * V.uU; const l = 1 / Math.sqrt(N * N + E * E + U * U); N *= l; E *= l; U *= l; }
        else { const r2 = X * X + Y * Y, q = 4 / (4 + r2), d = (4 - r2) / (4 + r2); N = d * V.fN + q * (X * V.rN + Y * V.uN); E = d * V.fE + q * (X * V.rE + Y * V.uE); U = d * V.fU + q * (X * V.rU + Y * V.uU); }
        // horizontal -> J2000 (transposée de la rotation, sans réfraction) -> galactique
        const hy = -E;
        const ex = m[0][0] * N + m[0][1] * hy + m[0][2] * U, ey = m[1][0] * N + m[1][1] * hy + m[1][2] * U, ez = m[2][0] * N + m[2][1] * hy + m[2][2] * U;
        const g0 = G[0][0] * ex + G[0][1] * ey + G[0][2] * ez, g1 = G[1][0] * ex + G[1][1] * ey + G[1][2] * ez, g2 = G[2][0] * ex + G[2][1] * ey + G[2][2] * ez;
        let lf = Math.atan2(g1, g0) * RAD; if (lf < 0) lf += 360;
        const bf = Math.asin(g2 < -1 ? -1 : g2 > 1 ? 1 : g2) * RAD + 90;
        const l0 = lf | 0, b0 = Math.min(179, bf | 0), fl = lf - l0, fb = bf - b0, l1 = l0 === 359 ? 0 : l0 + 1;
        const r0 = b0 * MWT_W, r1 = r0 + MWT_W;
        const v = (MWT[r0 + l0] * (1 - fl) + MWT[r0 + l1] * fl) * (1 - fb) + (MWT[r1 + l0] * (1 - fl) + MWT[r1 + l1] * fl) * fb;
        const a = v * dark; const A8 = a >= 1 ? 255 : (a * 255) | 0;
        px[o] = 190; px[o + 1] = 205; px[o + 2] = 255; px[o + 3] = A8;
      }
    }
    mwImgCtx.putImageData(mwImg, 0, 0);
  }
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; // fond uni dessous : « source-over » ≈ addition, et c'est le chemin le plus rapide
  // centre du pixel (i,j) de la petite image = point de grille (ox + i·c, oy + j·c)
  ctx.drawImage(mwImgCv, 0, 0, cols, rows, -c - c / 2, -c - c / 2, cols * c, rows * c); ctx.restore();
}
function render() {
  setupView();
  const w = W, h = H, L = LEVELS[Q.level];
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  picks.length = 0; nLB = 0; nVS = 0;
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
  if (S.opts.milkyway && dark > 0.05 && !camOn) drawMilkyWay(dark);
  if (S.opts.grid) drawAltAzGrid();
  if (S.opts.eqGrid) { ctx.strokeStyle = 'rgba(120,200,255,.35)'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1; drawCurve(CURVES.equ.n); ctx.setLineDash([]); }
  if (S.opts.ecliptic) { ctx.strokeStyle = 'rgba(255,200,90,.32)'; ctx.setLineDash([3, 5]); ctx.lineWidth = 1; drawCurve(CURVES.ecl.n); ctx.setLineDash([]); }
  if (S.opts.lines) { // un seul tracé pour toutes les constellations
    ctx.strokeStyle = camOn ? 'rgba(150,190,255,.6)' : `rgba(110,150,240,${(0.14 + 0.22 * dark).toFixed(3)})`; ctx.lineWidth = camOn ? 1.4 : 1.1;
    ctx.beginPath(); for (const c of CURVES.lines) pathFlat(c.n); ctx.stroke();
  }
  const lim = Math.min(effMagLimit(), L.mag);
  const zb = clamp(Math.pow(90 / V.fovDeg, 0.22), 0.85, 1.9);
  const groundOn = !AR.on && S.opts.ground;
  // 1) projection + élimination hors écran ; 2) tracé groupé par couleur et opacité (32 remplissages au lieu de milliers)
  const NB = COLBINS.length * 4; BUCKET_N.fill(0);
  const glowLim = L.glow;
  const cullD = V.gnomonic ? 0.06 : -0.97;
  for (let i = 0; i < NS; i++) {
    const m = SMAG[i]; if (m > lim) break; // catalogue trié par magnitude
    const sn = SN[i], se = SE[i], su = SU[i];
    if (groundOn && su < 0) continue;
    if (sn * V.fN + se * V.fE + su * V.fU < cullD) continue;
    if (!proj(sn, se, su) || !onScreen(10)) continue;
    const rr = Math.min(8, (0.55 + 0.42 * Math.pow(Math.max(0, lim - m + 0.6), 1.15)) * zb);
    const a = clamp((lim - m) / 1.2 + 0.25, 0.15, 1);
    const ab = a < 0.42 ? 0 : a < 0.67 ? 1 : a < 0.9 ? 2 : 3;
    const b = SCOL[i] * 4 + ab;
    if (m < glowLim) { const gs = rr * 7; ctx.globalAlpha = a * 0.7; ctx.drawImage(GLOWS[SCOL[i]], P.x - gs / 2, P.y - gs / 2, gs, gs); }
    VS_I[nVS] = i; VS_X[nVS] = P.x; VS_Y[nVS] = P.y; VS_R[nVS] = rr; VS_B[nVS] = b; nVS++;
    BUCKET_N[b + 1]++;
  }
  for (let b = 0; b < NB; b++) BUCKET_N[b + 1] += BUCKET_N[b];
  const fillPos = FILLPOS; for (let b = 0; b < NB; b++) fillPos[b] = BUCKET_N[b];
  for (let k = 0; k < nVS; k++) VS_ORD[fillPos[VS_B[k]]++] = k;
  for (let b = 0; b < NB; b++) {
    const s0 = BUCKET_N[b], s1 = BUCKET_N[b + 1]; if (s1 <= s0) continue;
    ctx.globalAlpha = BUCKET_A[b & 3]; ctx.fillStyle = COLSTR[b >> 2];
    ctx.beginPath();
    for (let j = s0; j < s1; j++) {
      const k = VS_ORD[j], x = VS_X[k], y = VS_Y[k], r = VS_R[k];
      if (r < 0.9) ctx.rect(x - r, y - r, r * 2, r * 2); // point sous-pixel : carré, bien moins coûteux qu'un disque
      else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); }
    }
    ctx.fill();
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
  drawSats(camOn, groundOn);
  drawGround();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  let font = '600 13px system-ui,sans-serif'; ctx.font = font;
  for (const [name, x, y, r, key] of bodyLabels) {
    const tw = textW(name, font);
    if (labelFits(x + r + 5, y - 8, tw, 16) || key === 'Moon' || key === 'Sun') { ctx.fillStyle = key === 'Sun' ? '#ffe39a' : key === 'Moon' ? '#f2efe4' : '#ffd9a0'; ctx.fillText(name, x + r + 5, y); }
  }
  if (S.opts.starNames) {
    const lab = Math.min(clamp(1.5 + 1.6 * Math.log2(100 / V.fovDeg), 1.5, 4.8) * L.lab, lim);
    font = '12px system-ui,sans-serif'; ctx.font = font;
    ctx.fillStyle = camOn ? 'rgba(235,240,255,.95)' : 'rgba(200,214,245,.78)';
    for (let k = 0; k < nVS; k++) { // les étoiles visibles sont déjà triées par magnitude
      const i = VS_I[k]; if (SMAG[i] > lab) break;
      const n = D.names[SHIP[i]]; if (!n || !n[0]) continue;
      const tw = textW(n[0], font), x = VS_X[k] + VS_R[k] + 4, y = VS_Y[k];
      if (labelFits(x, y - 7, tw, 14)) ctx.fillText(n[0], x, y);
    }
  }
  if (S.opts.conNames) {
    ctx.textAlign = 'center';
    font = `500 ${V.fovDeg > 140 ? 10.5 : 12}px system-ui,sans-serif`; ctx.font = font;
    ctx.fillStyle = camOn ? 'rgba(170,200,255,.85)' : 'rgba(130,160,235,.55)';
    const ls = 'letterSpacing' in ctx; if (ls) ctx.letterSpacing = '1.2px';
    for (let k = 0; k < CONS.length; k++) {
      const c = CONS[k];
      if (V.fovDeg > 120 && c.rank > 2) continue;
      if (Q.level === 2 && V.fovDeg > 90 && c.rank > 2) continue;
      const N = CONSN[k * 3], E = CONSN[k * 3 + 1], U = CONSN[k * 3 + 2];
      if (groundOn && U < 0) continue;
      if (!proj(N, E, U) || !onScreen(-10)) continue;
      const txt = c.up || (c.up = c.fr.toUpperCase());
      const tw = textW(txt, font) + txt.length * 1.2 + 10;
      if (!labelFits(P.x - tw / 2, P.y - 8, tw, 16)) continue;
      ctx.fillText(txt, P.x, P.y);
      picks.push({ kind: 'con', c, x: P.x, y: P.y, r: tw / 2, pri: 50 });
    }
    if (ls) ctx.letterSpacing = '0px';
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  drawSelection();
  drawLaser(); drawGuide();
  updateHud();
}
function selectedNEU() {
  const s = S.selected; if (!s) return null;
  if (s.kind === 'star') return [SN[s.i], SE[s.i], SU[s.i]];
  if (s.kind === 'body') return sky.bodies[s.bi].neu;
  if (s.kind === 'con') return eqjToNEU(s.c.v[0], s.c.v[1], s.c.v[2], [0, 0, 0]);
  if (s.kind === 'sat') return satNEU(s.id);
  return null;
}
function drawSelection() {
  const v = selectedNEU(); if (!v) return;
  const t = AR.on ? performance.now() / 1000 : 0;
  if (proj(v[0], v[1], v[2]) && onScreen(-8)) {
    const r = 15 + Math.sin(t * 3) * 1.5;
    ctx.strokeStyle = 'rgba(255,214,120,.95)'; ctx.lineWidth = 1.8;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(P.x, P.y, r, k * Math.PI / 2 + 0.25, k * Math.PI / 2 + Math.PI / 2 - 0.25); ctx.stroke(); }
    if (v[2] < 0 && !AR.on && S.opts.ground) { // objet caché par le sol : fantôme + mention
      ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(P.x, P.y, 5, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '600 12px system-ui,sans-serif'; ctx.fillStyle = 'rgba(255,214,120,.95)'; ctx.textAlign = 'center';
      ctx.fillText(`${objName(S.selected)} — sous l'horizon`, P.x, P.y + r + 16); ctx.textAlign = 'left';
    }
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
function objName(s) { if (s.kind === 'sat') { const o = SAT.byId.get(s.id); return o ? o.short : 'Satellite'; } return s.kind === 'star' ? starName(s.i) : s.kind === 'body' ? BODIES[s.bi].fr : s.c.fr; }
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
  const upTag = alt => alt > 0 ? '<span class="tag ok">Au-dessus de l\'horizon</span>' : `<span class="tag no">${belowText(s, alt).replace(/^s/, 'S')}</span><br>`;
  if (s.kind === 'sat') {
    const I = satInfoParts(s.id);
    if (!I) html = '<h3>Satellite</h3><div class="sub">Données orbitales indisponibles</div>';
    else {
      const np = satNextPass(I.s);
      html = `<h3>${I.s.name}</h3><div class="sub">Satellite · ${SAT_GROUPS[I.s.grp]} · NORAD ${I.s.id}</div><div class="own-line">${ownerHtml(I.s, true)}</div>${upTag(I.aa.alt)}<span class="tag ${I.lit ? 'ok' : 'no'}">${I.lit ? 'Éclairé par le Soleil' : 'Dans l\'ombre de la Terre'}</span>
      <dl class="kv" style="margin-top:10px"><dt>Altitude de l'orbite</dt><dd>${I.h != null ? Math.round(I.h).toLocaleString('fr-FR') + ' km' : '—'}</dd><dt>Distance</dt><dd>${Math.round(I.c[3]).toLocaleString('fr-FR')} km</dd>
      <dt>Vitesse</dt><dd>${num(I.c[6], 2)} km/s (${Math.round(I.c[6] * 3600).toLocaleString('fr-FR')} km/h)</dd>${I.lit ? `<dt>Magnitude estimée</dt><dd>≈ ${num(I.c[5], 1)}</dd>` : ''}
      <dt>Altitude</dt><dd>${fmtDeg(I.aa.alt)}</dd><dt>Azimut</dt><dd>${fmtDeg(I.aa.az)} ${cardinal(I.aa.az)}</dd>
      ${np ? `<dt>Prochain passage</dt><dd>${hmRel(np.rise, ms)} ${cardinal(np.azR)} → ${Math.round(np.maxEl)}° ${cardinal(np.azM)} → ${hm(np.set)} ${cardinal(np.azS)}${np.vis ? '' : ' (non visible)'}</dd>` : '<dt>Prochain passage</dt><dd>aucun (≥ 10°) sous 24 h</dd>'}
      <dt>Éléments orbitaux</dt><dd>${I.ageD < 1 ? 'moins d\'un jour' : num(I.ageD, 1) + ' j'} (CelesTrak)</dd></dl>`;
    }
  } else if (s.kind === 'star') {
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
    if (gesture.moved > 4) { cv.classList.add('dragging'); LASER.pin = null; }
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
cv.addEventListener('wheel', e => { e.preventDefault(); if (AR.on) return; LASER.pin = null; S.fov = clamp(S.fov * Math.exp(e.deltaY * 0.0012), 1 * DEG, 185 * DEG); S.dirty = true; save(); }, { passive: false });
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || AR.on) return;
  const st = 5 * DEG * Math.min(1, S.fov / (60 * DEG));
  const k = { ArrowLeft: () => S.az -= st, ArrowRight: () => S.az += st, ArrowUp: () => S.alt = clamp(S.alt + st, -1.56, 1.56), ArrowDown: () => S.alt = clamp(S.alt - st, -1.56, 1.56), '+': () => S.fov = clamp(S.fov / 1.2, DEG, 185 * DEG), '-': () => S.fov = clamp(S.fov * 1.2, DEG, 185 * DEG) }[e.key];
  if (k) { k(); S.dirty = true; save(); }
});
function handleTap(x, y, touch) {
  const th = touch ? 26 : 16; let best = null, bd = 1e9;
  for (let k = 0; k < nVS; k++) {
    const r = VS_R[k], d = Math.hypot(VS_X[k] - x, VS_Y[k] - y) - r * 0.6;
    const score = d + SMAG[VS_I[k]] * 1.6;
    if (d < th && score < bd) { bd = score; best = { kind: 'star', i: VS_I[k] }; }
  }
  for (const p of picks) {
    if (p.kind === 'con') continue;
    const d = Math.hypot(p.x - x, p.y - y) - p.r * 0.6;
    const score = d + (p.kind === 'star' ? p.pri * 1.6 : p.kind === 'sat' ? -4 : -6);
    if (d < th && score < bd) { bd = score; best = p; }
  }
  if (!best) for (const p of picks) if (p.kind === 'con' && Math.abs(p.x - x) < p.r + 8 && Math.abs(p.y - y) < 12) { best = p; break; }
  if (best) select(best.kind === 'star' ? { kind: 'star', i: best.i } : best.kind === 'body' ? { kind: 'body', bi: best.bi } : best.kind === 'sat' ? { kind: 'sat', id: best.id } : { kind: 'con', c: best.c });
  else select(null);
}
function select(s) { S.selected = s; renderInfo(); S.dirty = true; }
function objAltAz(s) {
  const v = s.kind === 'star' ? [SN[s.i], SE[s.i], SU[s.i]] : s.kind === 'body' ? sky.bodies[s.bi].neu : s.kind === 'sat' ? satNEU(s.id) : eqjToNEU(s.c.v[0], s.c.v[1], s.c.v[2], [0, 0, 0]);
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
let lastQuery = '';
function doSearch() {
  const q = fold(si.value); lastQuery = q;
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
  goToObject({ ...r.sel });
}
si.addEventListener('input', doSearch);
si.addEventListener('focus', () => { if (si.value) doSearch(); });
si.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selIdx = clamp(selIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1); [...sr.children].forEach((li, k) => li.classList.toggle('sel', k === selIdx)); }
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
const PANELS = ['tonight', 'forecast', 'layers', 'location', 'sats'];
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
  cb.onchange = () => { if (cb.dataset.opt === 'laser') { setLaser(cb.checked); return; } S.opts[cb.dataset.opt] = cb.checked; S.dirty = true; save(); };
});
$('magLimit').value = S.magLimit; $('magLimitVal').textContent = num(S.magLimit, 1);
$('magLimit').oninput = e => { S.magLimit = +e.target.value; $('magLimitVal').textContent = num(S.magLimit, 1); S.dirty = true; save(); };
function syncQualityUI() { const el = $('qualitySel'); if (el) el.value = S.quality; }
function setQuality(q) { S.quality = q; save(); const was = Q.level; initQuality(); if (Q.level !== was) { Q.n = 0; resize(); } else resize(); syncQualityUI(); }
$('qualitySel').onchange = e => setQuality(e.target.value);
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
/* ---------------- Conditions d'observation : maintenant / 6 prochaines heures (Open-Meteo) ---------------- */
const forecastState = { key: null, at: 0, byHour: new Map(), loading: false, source: '', note: '', mode: 'now', rendered: '' };
try { const m = localStorage.getItem('celeste.meteoMode'); if (m === 'now' || m === '6h') forecastState.mode = m; } catch (e) {}
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
const scoreWord = s => s < 1 ? 'impossible' : s < 2 ? 'mauvais' : s < 3 ? 'médiocre' : s < 3.6 ? 'correct' : s < 4.3 ? 'bon' : 'excellent';
function darkness(sunAlt) {
  if (sunAlt > -0.833) return { k: 0, f: 0, txt: 'Jour', cls: 'day' };
  if (sunAlt > -6) return { k: 1, f: 0.15, txt: 'Crépuscule civil', cls: 'civ' };
  if (sunAlt > -12) return { k: 2, f: 0.5, txt: 'Crépuscule nautique', cls: 'nau' };
  if (sunAlt > -18) return { k: 3, f: 0.8, txt: 'Crépuscule astronomique', cls: 'ast' };
  return { k: 4, f: 1, txt: 'Nuit noire', cls: 'night' };
}
/* État astronomique + météo pour un instant donné */
function conditionsAt(ms) {
  const t = A.MakeTime(new Date(ms));
  const sun = altOf('Sun', ms).altitude, moonH = altOf('Moon', ms), il = A.Illumination('Moon', t), elong = A.MoonPhase(t);
  const dk = darkness(sun);
  // météo : valeur horaire la plus proche (Open-Meteo donne des valeurs instantanées à l'heure pile)
  const w = forecastState.byHour.get(Math.round(ms / 3600000)) || null;
  const wx = w ? skyScore(w) : null;
  // malus Lune : illumination × hauteur au-dessus de l'horizon (jusqu'à −1,5 point en pleine Lune haute)
  const moonPen = moonH.altitude > 0 ? il.phase_fraction * Math.min(1, (moonH.altitude + 5) / 35) * 1.5 : 0;
  const obs = wx == null ? null : clamp(Math.round((wx * dk.f - moonPen * dk.f) * 10) / 10, 0, 5);
  return { ms, sun, moonAlt: moonH.altitude, moonAz: moonH.azimuth, moonIll: il.phase_fraction, moonElong: elong, dk, w, wx, obs };
}
async function loadForecast(force) {
  const key = S.loc.lat.toFixed(2) + ',' + S.loc.lon.toFixed(2);
  const fresh = forecastState.key === key && forecastState.source === 'ok' && Date.now() - forecastState.at < 3600000;
  if (!force && fresh) { renderConditions(true); return; }
  if (forecastState.loading) return;
  forecastState.loading = true; forecastState.key = key;
  $('forecastStatus').textContent = 'Chargement de la météo…';
  renderConditions(true);
  const cacheKey = 'celeste.cond.' + key;
  // Requête réduite : de la veille à J+2 (couvre l'heure choisie et les 6 h suivantes), variables utiles seulement
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${S.loc.lat}&longitude=${S.loc.lon}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,wind_speed_10m,precipitation_probability,temperature_2m&past_days=1&forecast_days=3&timezone=GMT&timeformat=unixtime`;
  let data = null, at = Date.now(), note = '';
  try {
    if (navigator.onLine === false) throw new Error('hors ligne');
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
    if (!data.hourly || !data.hourly.time) throw new Error('réponse inattendue');
    try { localStorage.setItem(cacheKey, JSON.stringify({ at, data })); } catch (e) {}
    note = `Météo Open-Meteo mise à jour à ${hm(at)} · ${S.loc.name}`;
  } catch (e) {
    let cached = null; try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (e2) {}
    if (cached && cached.data && Date.now() - cached.at < 2 * 86400000) { data = cached.data; at = cached.at; note = `⚠ Hors ligne ou service injoignable — météo en cache du ${fmt('dmed').format(new Date(cached.at))} à ${hm(cached.at)}.`; }
    else note = '⚠ Météo indisponible (hors ligne ou Open-Meteo injoignable). Lune, Soleil et obscurité restent calculés localement.';
  }
  forecastState.byHour = new Map();
  if (data) {
    const Hh = data.hourly;
    Hh.time.forEach((tt, i) => {
      if (Hh.cloud_cover[i] == null) return;
      forecastState.byHour.set(Math.round(tt / 3600), { cc: Hh.cloud_cover[i], lo: Hh.cloud_cover_low[i], mi: Hh.cloud_cover_mid[i], hi: Hh.cloud_cover_high[i], rh: Hh.relative_humidity_2m[i], vis: Hh.visibility ? Hh.visibility[i] : null, wind: Hh.wind_speed_10m[i], pp: Hh.precipitation_probability ? Hh.precipitation_probability[i] : null, temp: Hh.temperature_2m[i] });
    });
  }
  forecastState.source = data ? 'ok' : 'none'; forecastState.at = at; forecastState.note = note;
  forecastState.loading = false;
  $('forecastStatus').textContent = note;
  renderConditions(true);
}
function setMeteoMode(m) {
  forecastState.mode = m; try { localStorage.setItem('celeste.meteoMode', m); } catch (e) {}
  renderConditions(true);
}
document.querySelectorAll('#meteoMode button').forEach(b => b.onclick = () => setMeteoMode(b.dataset.mode));
const bar = (v, max, col) => `<span class="mbar"><i style="width:${clamp(v / max * 100, 0, 100).toFixed(0)}%;background:${col}"></i></span>`;
const pct = v => v == null ? '—' : Math.round(v) + ' %';
const moonRow = c => `${moonPhaseName(c.moonElong)} · ${Math.round(c.moonIll * 100)} % · ${c.moonAlt > 0 ? 'levée à ' + fmtDeg(c.moonAlt, 0) + ' ' + cardinal(c.moonAz) : 'couchée (' + fmtDeg(c.moonAlt, 0) + ')'}`;
function renderNow(ms) {
  const c = conditionsAt(ms), w = c.w;
  const ref = S.live ? `Maintenant · ${hm(ms)}` : `Heure choisie · ${fmt('dmed').format(new Date(ms))} ${hm(ms)}`;
  const sc = c.obs;
  const tip = c.dk.k === 0 ? 'Il fait jour : attendez la nuit.' : sc == null ? '' : c.dk.k < 3 ? 'Ciel encore clair : planètes et étoiles brillantes seulement.' : c.moonAlt > 0 && c.moonIll > 0.5 ? 'La Lune éclaire le ciel : objets faibles difficiles.' : sc >= 3.6 ? 'Bonnes conditions pour observer.' : sc >= 2 ? 'Observation possible entre les nuages.' : 'Ciel peu favorable.';
  let html = `<div class="cnow">
    <div class="cnow-head"><div><div class="cref">${ref}</div><div class="cstate ${c.dk.cls}">${c.dk.txt} · Soleil ${fmtDeg(c.sun, 0)}</div></div>
    <div class="cscore" style="color:${sc != null ? scoreText(sc) : 'var(--mut)'}"><b>${sc != null ? num(sc, 1) : '—'}</b><small>/5</small><span>${sc != null ? scoreWord(sc) : 'météo indisponible'}</span></div></div>
    ${tip ? `<div class="ctip">${tip}</div>` : ''}
    <dl class="cgrid">`;
  if (w) {
    html += `<dt>Nuages</dt><dd>${bar(w.cc, 100, '#9fb0d8')}<b>${pct(w.cc)}</b></dd>
      <dt class="sub">bas</dt><dd>${bar(w.lo, 100, '#8091bb')}${pct(w.lo)}</dd>
      <dt class="sub">moyens</dt><dd>${bar(w.mi, 100, '#8091bb')}${pct(w.mi)}</dd>
      <dt class="sub">hauts</dt><dd>${bar(w.hi, 100, '#8091bb')}${pct(w.hi)}</dd>
      <dt>Humidité</dt><dd>${bar(w.rh, 100, '#6fa8dc')}${pct(w.rh)}</dd>
      <dt>Vent</dt><dd>${num(w.wind, 0)} km/h</dd>
      <dt>Température</dt><dd>${num(w.temp, 0)} °C</dd>
      ${w.vis != null ? `<dt>Visibilité</dt><dd>${num(w.vis / 1000, w.vis < 10000 ? 1 : 0)} km</dd>` : ''}
      ${w.pp != null ? `<dt>Risque de pluie</dt><dd>${pct(w.pp)}</dd>` : ''}
      <dt>Indice météo</dt><dd><b style="color:${scoreText(c.wx)}">${num(c.wx, 1)}</b> /5</dd>`;
  } else html += `<dt>Météo</dt><dd>${forecastState.loading ? 'chargement…' : forecastState.source === 'ok' ? 'hors de la plage (hier à J+2)' : 'indisponible'}</dd>`;
  html += `<dt>Lune</dt><dd>${moonRow(c)}</dd></dl></div>`;
  return html;
}
function render6h(ms) {
  const h0 = Math.floor(ms / 3600000) * 3600000;
  // 1re ligne : l'instant choisi ; puis les 5 heures pleines suivantes
  const rows = [conditionsAt(ms)]; for (let i = 1; i < 6; i++) rows.push(conditionsAt(h0 + i * 3600000));
  let best = -1, bv = -1; rows.forEach((c, i) => { if (c.obs != null && c.obs > bv + 0.05) { bv = c.obs; best = i; } });
  const anyWx = rows.some(c => c.w);
  let html = `<div class="c6-ref">${S.live ? 'À partir de maintenant' : 'À partir de l\'heure choisie'} · ${fmt('dmed').format(new Date(ms))}</div>`;
  if (best >= 0 && bv > 0) html += `<div class="c6-best">★ Meilleure heure : <b>${hm(rows[best].ms)}</b> — indice <b style="color:${scoreText(bv)}">${num(bv, 1)}</b> (${scoreWord(bv)})</div>`;
  else if (anyWx) html += `<div class="c6-best muted">Aucune heure favorable dans les 6 prochaines heures.</div>`;
  html += '<ol class="c6">';
  rows.forEach((c, i) => {
    const w = c.w, sc = c.obs;
    html += `<li class="${i === best && bv > 0 ? 'best' : ''}">
      <div class="c6-l1"><span class="c6-h">${hm(c.ms)}</span>${bar(sc ?? 0, 5, sc != null ? scoreColor(sc) : '#444')}<span class="c6-s" style="color:${sc != null ? scoreText(sc) : 'var(--mut)'}">${sc != null ? num(sc, 1) : '—'}</span></div>
      <div class="c6-l2"><span class="cstate ${c.dk.cls}">${c.dk.txt}</span>${w ? `<span>☁ ${pct(w.cc)}</span><span>💧 ${pct(w.rh)}</span><span>💨 ${num(w.wind, 0)} km/h</span><span>${num(w.temp, 0)} °C</span>` : '<span>météo —</span>'}<span>☾ ${c.moonAlt > 0 ? fmtDeg(c.moonAlt, 0) : 'couchée'}</span></div></li>`;
  });
  html += '</ol><p class="fine">Indice d\'observation 0–5 : météo (nuages bas/moyens/hauts, humidité, visibilité, vent, pluie) × obscurité, moins la gêne de la Lune.</p>';
  return html;
}
/* Rendu HTML uniquement quand le panneau est ouvert et que l'heure (à la minute) ou le mode change : aucun redessin continu */
function renderConditions(force) {
  if ($('panel-forecast').classList.contains('hidden')) return;
  const ms = simMs();
  const key = forecastState.mode + '|' + Math.floor(ms / 60000) + '|' + forecastState.at + '|' + forecastState.loading + '|' + S.live + '|' + S.loc.lat + S.loc.lon;
  if (!force && key === forecastState.rendered) return;
  forecastState.rendered = key;
  document.querySelectorAll('#meteoMode button').forEach(b => { const on = b.dataset.mode === forecastState.mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  $('condContent').innerHTML = forecastState.mode === '6h' ? render6h(ms) : renderNow(ms);
}
function drawForecastChart() { renderConditions(true); } // compatibilité (redimensionnement)

/* ---------------- Pointeur laser ---------------- */
const LASER = { target: null, score: 0, lostAt: 0, last: 0, lastHtml: 0, key: '', con: '' };
const laserActive = () => !!S.opts.laser;
const laserRadiusDeg = () => AR.on ? clamp(AR.fov * 0.06, 3, 5) : clamp(V.fovDeg * 0.045, 1.5, 5); // ~4° en mode caméra
const sameSel = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === 'star' ? a.i === b.i : a.kind === 'body' ? a.bi === b.bi : a.kind === 'sat' ? a.id === b.id : a.c === b.c);
function sepDeg(v) { return Math.acos(clamp(v[0] * V.fN + v[1] * V.fE + v[2] * V.fU, -1, 1)) * RAD; }
function laserScore(sel, R) {
  if (sel.kind === 'sat') { const c = satCur(sel.id); if (!c) return { sep: 999, score: 99 }; const sep = sepDeg(c); return { sep, score: sep / R - (c[4] ? 0.35 : 0) }; }
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
  if (now - LASER.last < (AR.on ? 125 : 160)) return; // ~6-8 Hz
  // vue et ciel inchangés : inutile de refaire la recherche (sauf rafraîchissement lent du panneau)
  const vk = V.fN.toFixed(4) + V.fE.toFixed(4) + V.fU.toFixed(4) + V.fovDeg.toFixed(1) + frameKey + (GUIDE.target ? 'g' : '') + (satOn() ? 's' + SAT.ver : '');
  if (vk === LASER.vk && now - LASER.last < 1500) return;
  LASER.vk = vk; LASER.last = now;
  const prev = LASER.target;
  if (LASER.pin && !AR.on && S.tween) { LASER.target = LASER.pin; LASER.vk = ''; renderLaserPanel(now); return; }
  const R = laserRadiusDeg(); const lim = AR.on ? clamp(effMagLimit(), 3.5, 5) : Math.min(effMagLimit(), 5.5);
  const groundOn = !AR.on && S.opts.ground;
  let best = null, bestScore = 1e9;
  sky.bodies.forEach((bs, bi) => {
    if (groundOn && bs.alt < -1) return;
    if (bs.b.key !== 'Sun' && bs.b.key !== 'Moon' && bs.mag != null && bs.mag > lim + 1.5) return;
    const r = laserScore({ kind: 'body', bi }, R);
    if (r.sep < R * 1.2 && r.score < bestScore) { bestScore = r.score; best = { kind: 'body', bi }; }
  });
  if (satOn()) for (const st of SAT.fine) { // satellites (éclairés en priorité sur les étoiles)
    if (!st.ok || (groundOn && st.cur[2] < 0)) continue;
    const c = st.cur, sep = sepDeg(c); if (sep > R * 1.2) continue;
    const sc = sep / R - (c[4] ? 0.35 : 0); if (sc < bestScore) { bestScore = sc; best = { kind: 'sat', id: st.id }; }
  }
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
      if (now - LASER.lostAt < 350) { best = cur; bestScore = c.score; LASER.vk = ''; } // délai de grâce : on revérifie au prochain tour
    }
  }
  // Cible de guidage (mode caméra) prioritaire dès qu'elle est dans le rayon
  if (AR.on && GUIDE.target && GUIDE.target.kind !== 'con') { const gs = laserScore(GUIDE.target, R); if (gs.sep < R) { best = GUIDE.target; bestScore = gs.score; } }
  if (best && !sameSel(best, cur)) LASER.lostAt = 0;
  LASER.target = best; LASER.score = bestScore;
  if (!sameSel(prev, best) && !(prev == null && best == null)) Q.ovl = true;
  if (!best) LASER.con = centreConstellation();
  renderLaserPanel(now);
}
function distText(sel) {
  if (sel.kind === 'sat') { const c = satCur(sel.id); return c ? `${Math.round(c[3]).toLocaleString('fr-FR')} km` : 'inconnue'; }
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
  const key = t ? (t.kind + (t.i ?? t.bi ?? t.id)) : 'none:' + LASER.con;
  if (key === LASER.key && now - LASER.lastHtml < 1000) return;
  LASER.key = key; LASER.lastHtml = now;
  if (!t) {
    el.classList.add('empty');
    el.innerHTML = `<div class="lz-name"><span class="lz-dot"></span>Visez un astre…</div><div class="lz-row">${LASER.con ? 'Constellation : <b>' + LASER.con + '</b> · ' : ''}rayon de capture ${num(laserRadiusDeg(), 1)}°</div>`;
    return;
  }
  el.classList.remove('empty');
  const ms = simMs(); let name, type, con = '', mag, aa, r;
  if (t.kind === 'sat') {
    const I = satInfoParts(t.id); if (!I) { el.innerHTML = '<div class="lz-name">Satellite</div>'; return; }
    const np = I.aa.alt > 0 ? null : satNextPass(I.s);
    el.innerHTML = `<div class="lz-name"><span class="lz-dot on"></span>${I.s.short}<small>${ownerShort(I.s, true)} · ${I.lit ? 'éclairé' : 'dans l\'ombre de la Terre'}</small></div>
    <div class="lz-row"><span>Altitude ${I.h != null ? Math.round(I.h).toLocaleString('fr-FR') + ' km' : '?'}</span><span>Distance ${Math.round(I.c[3]).toLocaleString('fr-FR')} km</span><span>${num(I.c[6], 2)} km/s</span>${I.lit ? `<span>mag ≈ ${num(I.c[5], 1)}</span>` : ''}</div>
    <div class="lz-row"><span>Alt ${fmtDeg(I.aa.alt, 1)} · Az ${fmtDeg(I.aa.az, 0)} ${cardinal(I.aa.az)}</span>${np ? `<span>prochain passage ${hmRel(np.rise, ms)}</span>` : ''}</div>
    <div class="lz-hint">Touchez pour la fiche complète</div>`;
    LASER.lastHtml = now - 600; // rafraîchi plus souvent (objet rapide)
    return;
  }
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
function syncLaserUI() {
  const on = !!S.opts.laser, b = $('laserBtn');
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.title = on ? 'Pointeur laser : activé (toucher pour éteindre)' : 'Pointeur laser : éteint (toucher pour allumer)';
  $('laserBtnLbl').textContent = on ? 'Laser' : 'Laser off';
  const cb = document.querySelector('[data-opt=laser]'); if (cb) cb.checked = on;
}
function setLaser(on, quiet) {
  S.opts.laser = !!on; save();
  try { localStorage.setItem('celeste.laser', on ? '1' : '0'); } catch (e) {}
  LASER.vk = ''; LASER.key = '';
  if (!on) { LASER.pin = null; if (!(AR.on && GUIDE.locked)) LASER.target = null; }
  renderLaserPanel(performance.now()); syncLaserUI(); S.dirty = true;
  if (!quiet) toast(on ? 'Pointeur laser activé' : 'Pointeur laser éteint (la recherche et le guidage restent actifs)', 2200);
}
$('laserBtn').onclick = () => setLaser(!S.opts.laser);
function drawLaser() {
  if (!laserActive()) return;
  const cx = V.cx, cy = V.cy, t = AR.on ? performance.now() / 1000 : 0.26;
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
    const v = tg.kind === 'star' ? [SN[tg.i], SE[tg.i], SU[tg.i]] : tg.kind === 'sat' ? satNEU(tg.id) : sky.bodies[tg.bi].neu;
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

/* ---------------- Aller à l'objet recherché / guidage en mode caméra ---------------- */
const GUIDE = { target: null, locked: false, last: 0, info: null };
function selNEU(sel) {
  if (sel.kind === 'star') return [SN[sel.i], SE[sel.i], SU[sel.i]];
  if (sel.kind === 'body') return sky.bodies[sel.bi].neu;
  if (sel.kind === 'sat') return satNEU(sel.id);
  return eqjToNEU(sel.c.v[0], sel.c.v[1], sel.c.v[2], [0, 0, 0]);
}
const nextRiseCache = new Map();
function nextRiseMs(sel) {
  if (sel.kind === 'sat') { const s = SAT.byId.get(sel.id); const p = s && SATLIB ? satNextPass(s) : null; return p ? p.rise : null; }
  const ms = simMs();
  const key = (sel.kind === 'star' ? 's' + sel.i : sel.kind === 'body' ? 'b' + sel.bi : 'c' + sel.c.id) + '|' + Math.floor(ms / 60000) + '|' + S.loc.lat + S.loc.lon;
  if (nextRiseCache.has(key)) return nextRiseCache.get(key);
  let body;
  if (sel.kind === 'body') body = BODIES[sel.bi].key;
  else { const ra = sel.kind === 'star' ? SRA[sel.i] / 15 : sel.c.ra / 15, dec = sel.kind === 'star' ? SDEC[sel.i] : sel.c.dec; A.DefineStar(A.Body.Star2, ra, dec, 1000); body = A.Body.Star2; }
  let r = null; try { r = msOf(A.SearchRiseSet(body, observer, +1, A.MakeTime(new Date(ms)), 2)); } catch (e) {}
  if (nextRiseCache.size > 200) nextRiseCache.clear();
  nextRiseCache.set(key, r); return r;
}
function belowText(sel, alt) {
  const nr = nextRiseMs(sel);
  return `sous l'horizon (${fmtDeg(alt, 0)}) · ${nr ? 'prochain lever ' + hmRel(nr, simMs()) : 'ne se lève pas dans les 48 h'}`;
}
function goToObject(sel) {
  if (!sel) return;
  const { alt, az } = objAltAz(sel);
  if (AR.on) { setGuideTarget(sel); return; }
  const key = sel.kind === 'body' ? BODIES[sel.bi].key : '';
  const fovT = sel.kind === 'con' ? 75 : (key === 'Sun' || key === 'Moon') ? 20 : sel.kind === 'body' ? 30 : sel.kind === 'sat' ? 50 : 40;
  S.tween = { t0: performance.now(), dur: 900, az0: S.az, alt0: S.alt, fov0: S.fov, az1: S.az + angDiff(az, S.az * RAD) * DEG, alt1: clamp(alt, -89, 89) * DEG, fov1: fovT * DEG };
  select(sel);
  if (sel.kind !== 'con' && laserActive()) { LASER.pin = sel; LASER.target = sel; LASER.key = ''; LASER.vk = ''; }
  if (alt < 0) toast(`${objName(sel)} est ${belowText(sel, alt)}`, 7000);
  else toast(`${objName(sel)} : ${fmtDeg(alt, 0)} au-dessus de l'horizon, ${cardinal(az)}`, 3000);
}
function setGuideTarget(sel) {
  GUIDE.target = sel; GUIDE.locked = false; GUIDE.last = 0;
  $('arGuide').classList.toggle('hidden', !sel);
  if (sel) { LASER.target = null; LASER.key = ''; }
  S.dirty = true;
}
function flashLock() {
  const f = $('lockFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  try { if (navigator.vibrate) navigator.vibrate([70, 50, 70]); } catch (e) {}
}
function updateGuide(now) {
  const g = GUIDE.target; if (!AR.on || !g || !AR.f) return;
  const v = selNEU(g); const tgt = neuToAltAz(v);
  const sep = Math.acos(clamp(v[0] * V.fN + v[1] * V.fE + v[2] * V.fU, -1, 1)) * RAD;
  const vAz = norm360(Math.atan2(V.fE, V.fN) * RAD), vAlt = Math.asin(clamp(V.fU, -1, 1)) * RAD;
  const dAz = angDiff(tgt.az, vAz), dAlt = tgt.alt - vAlt;
  const x = v[0] * V.rN + v[1] * V.rE + v[2] * V.rU, y = v[0] * V.uN + v[1] * V.uE + v[2] * V.uU;
  const R = laserRadiusDeg() * (g.kind === 'con' ? 2.5 : 1);
  if (!GUIDE.locked && sep < R) { GUIDE.locked = true; flashLock(); if (g.kind !== 'con') { LASER.target = g; LASER.key = ''; } }
  else if (GUIDE.locked && sep > R * 1.6) GUIDE.locked = false;
  GUIDE.info = { sep, dAz, dAlt, alt: tgt.alt, az: tgt.az, arrowAng: Math.atan2(-y, x) * RAD, locked: GUIDE.locked };
  if (now - GUIDE.last < 150) return; GUIDE.last = now;
  const name = objName(g);
  let html;
  if (GUIDE.locked) html = `<div class="gd-main ok">🎯 ${name} est dans le viseur</div><div class="gd-sub">${tgt.alt < 0 ? belowText(g, tgt.alt) + ' — caché par le sol' : laserActive() ? 'Touchez la fiche en haut pour tous les détails' : 'Touchez ici pour la fiche complète'}</div>`;
  else {
    const parts = [];
    if (Math.abs(tgt.alt) < 82 && Math.abs(vAlt) < 82 && Math.abs(dAz) > 3) parts.push(`${dAz > 0 ? '→ Tournez à droite' : '← Tournez à gauche'} ${Math.round(Math.abs(dAz))}°`);
    if (Math.abs(dAlt) > 3) parts.push(`${dAlt > 0 ? '↑ Levez le téléphone' : '↓ Baissez le téléphone'} ${Math.round(Math.abs(dAlt))}°`);
    if (!parts.length) parts.push('Presque ! Centrez le point laser');
    html = `<div class="gd-main">${parts.join('<br>')}</div><div class="gd-sub">${name} à ${Math.round(sep)}° du centre${tgt.alt < 0 ? ' · ' + belowText(g, tgt.alt) : ''}</div>`;
  }
  $('arGuideText').innerHTML = html; $('arGuide').classList.toggle('locked', GUIDE.locked);
}
function drawGuide() {
  const g = GUIDE.target; if (!AR.on || !g || !GUIDE.info) return;
  const v = selNEU(g); const t = performance.now() / 1000;
  const col = GUIDE.locked ? '90,255,140' : '255,210,90';
  if (proj(v[0], v[1], v[2]) && onScreen(-30)) {
    const x = P.x, y = P.y, r = 22 + 3 * Math.sin(t * 5);
    ctx.save(); ctx.strokeStyle = `rgba(${col},.95)`; ctx.lineWidth = 2.5; ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
    if (!GUIDE.locked) { ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(V.cx, V.cy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]); }
    ctx.shadowBlur = 0; ctx.fillStyle = `rgba(${col},1)`; ctx.font = '700 14px system-ui,sans-serif'; ctx.textAlign = 'center';
    if (!GUIDE.locked) ctx.fillText(objName(g), x, y - r - 8);
    ctx.restore();
    return;
  }
  const ang = GUIDE.info.arrowAng * DEG, c = Math.cos(ang), s = Math.sin(ang);
  const mx = W / 2 - 50, my = H / 2 - 150;
  const k = Math.min(Math.abs(mx / (c || 1e-9)), Math.abs(my / (s || 1e-9)));
  const ax = V.cx + c * k, ay = V.cy + s * k, sc = 1 + 0.08 * Math.sin(t * 6);
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang); ctx.scale(sc, sc);
  ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = 18; ctx.fillStyle = `rgba(${col},.97)`;
  ctx.beginPath(); ctx.moveTo(30, 0); ctx.lineTo(-16, -24); ctx.lineTo(-6, 0); ctx.lineTo(-16, 24); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.save(); ctx.font = '700 14px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(${col},1)`; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
  ctx.fillText(`${objName(g)} · ${Math.round(GUIDE.info.sep)}°`, ax - c * 56, ay - s * 56 + 5); ctx.restore();
}
$('arGuideClear').onclick = () => setGuideTarget(null);
$('arGuideText').addEventListener('click', () => { if (GUIDE.target && GUIDE.locked) select({ ...GUIDE.target }); });
$('searchForm').addEventListener('submit', e => { e.preventDefault(); if (!results.length || fold(si.value) !== lastQuery) doSearch(); pickResult(selIdx || 0); });

/* ---------------- Mode caméra (réalité augmentée) ---------------- */
const AR = { lastAbs: 0, relative: false, paused: false, wantCam: false, on: false, camera: false, stream: null, f: null, u: null, basis: null, raw: null, offset: null, absolute: false, fov: 66, userHead: 0, gotEvent: false, evName: null, camMsg: '' };
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
  const now = performance.now();
  if (e.type === 'deviceorientationabsolute') AR.lastAbs = now;
  else if (AR.lastAbs && now - AR.lastAbs < 1000) return; // Android : l'événement absolu prime sur le relatif
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
  } else if (e.absolute === true || e.type === 'deviceorientationabsolute') { AR.offset = 0; AR.absolute = true; if (AR.relative) setRelative(false); }
  else { if (AR.offset == null) AR.offset = 0; AR.absolute = false; }
  S.dirty = true;
}
/* Orientation relative seulement (pas de boussole) : curseur « Cap » élargi à ±180° + calibrage */
function setRelative(on) {
  AR.relative = on; const h = $('arHead');
  h.min = on ? -180 : -30; h.max = on ? 180 : 30;
  if (!on) { AR.userHead = clamp(AR.userHead, -30, 30); h.value = AR.userHead; $('arHeadVal').textContent = (AR.userHead > 0 ? '+' : '') + AR.userHead + '°'; }
  $('arCalib').classList.toggle('hidden', !on);
}
function calibrate() {
  if (!AR.f) return;
  const g = GUIDE.target, tgtAz = g ? objAltAz(g).az : 0;
  const cur = norm360(Math.atan2(AR.f[1], AR.f[0]) * RAD);
  let u = Math.round(norm360(AR.userHead + angDiff(tgtAz, cur) + 180) - 180);
  AR.userHead = u; $('arHead').value = u; $('arHeadVal').textContent = (u > 0 ? '+' : '') + u + '°';
  AR.f = null; AR.u = null; S.dirty = true;
  toast(g ? `Cap calé sur ${objName(g)}` : 'Cap calé : le centre de l\'écran est maintenant le Nord', 3000);
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
const CAM_TRIES = [
  { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false },
  { video: { facingMode: 'environment' }, audio: false },
  { video: true, audio: false }];
function openCamera() {
  // 720p suffit (la vidéo est en fond) et économise batterie/GPU ; on assouplit les contraintes si l'appareil les refuse
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return Promise.resolve(null);
  const attempt = k => {
    let p; try { p = md.getUserMedia(CAM_TRIES[k]); } catch (e) { p = Promise.reject(e); }
    return p.catch(err => (k + 1 < CAM_TRIES.length && err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError' || err.name === 'NotReadableError' || err.name === 'TypeError' || err.name === 'AbortError')) ? attempt(k + 1) : err);
  };
  return attempt(0);
}
function attachCamera(res) {
  AR.stream = res; AR.camera = true; AR.wantCam = true; const v = $('camera'); v.srcObject = res; v.classList.add('on');
  const p = v.play(); if (p && p.catch) p.catch(() => {});
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
    camP = openCamera();
  }
  AR.on = true; AR.f = null; AR.u = null; AR.raw = null; AR.offset = null; AR.gotEvent = false; AR.absolute = false; arLast = 0; AR.camMsg = ''; AR.lastAbs = 0; AR.paused = false; AR.wantCam = false; setRelative(false);
  const carry = LASER.pin || (S.selected && S.selected.kind !== 'con' ? S.selected : null); LASER.pin = null;
  document.body.classList.add('ar'); $('arBar').classList.remove('hidden');
  if (carry) setGuideTarget({ ...carry }); $('arBtn').classList.add('on');
  PANELS.forEach(n => $('panel-' + n).classList.add('hidden'));
  arMsg(window.isSecureContext ? 'Initialisation des capteurs…' : '⚠ Page non sécurisée (file:// ou http) : l\'iPhone bloque caméra et capteurs hors HTTPS. Ouvrez la version HTTPS de l\'application.');
  AR.evName = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  permP.then(perm => {
    if (!AR.on) return;
    if (perm !== 'granted') { arFail(/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Accès aux capteurs de mouvement refusé. Sur iPhone : Réglages › Apps › Safari › « Mouvement et orientation » (et page en HTTPS), puis rechargez.' : 'Capteurs d\'orientation refusés ou indisponibles sur cet appareil : le mode caméra nécessite un téléphone ou une tablette avec gyroscope et boussole.'); return; }
    addOrientListeners();
    setTimeout(() => {
      if (!AR.on) return;
      if (!AR.gotEvent) arFail('Capteurs d\'orientation indisponibles : le mode caméra nécessite un téléphone ou une tablette avec gyroscope et boussole' + (window.isSecureContext ? '.' : ', ouvert en HTTPS.'));
      else if (!AR.absolute) { setRelative(true); arMsg(GUIDE.target ? `Boussole indisponible (orientation relative). Visez ${objName(GUIDE.target)} puis touchez « Calibrer », ou ajustez « Cap ».` : 'Boussole indisponible (orientation relative) : pointez le Nord puis touchez « Calibrer », ou ajustez « Cap » sur une étoile connue.'); }
      else arMsg(AR.camera ? 'Pointez le téléphone vers le ciel. Ajustez « Champ » et « Cap » si le ciel est décalé.' : (AR.camMsg || 'Mode gyroscope seul.'));
    }, 2500);
  });
  camP.then(res => {
    if (!AR.on) { if (res && res.getTracks) res.getTracks().forEach(t => t.stop()); return; }
    if (res && res.getTracks) {
      attachCamera(res);
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
  removeOrientListeners(); AR.wantCam = false; AR.paused = false; setRelative(false);
  LASER.target = null; LASER.key = ''; setGuideTarget(null);
  document.body.classList.remove('ar'); $('arBar').classList.add('hidden'); $('arBtn').classList.remove('on'); arMsg('');
  S.dirty = true;
}
function addOrientListeners() {
  // Chrome / Samsung Internet : on écoute l'absolu ET le relatif ; l'absolu est prioritaire s'il arrive
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
  window.addEventListener('deviceorientation', onOrient);
}
function removeOrientListeners() { window.removeEventListener('deviceorientationabsolute', onOrient); window.removeEventListener('deviceorientation', onOrient); }
$('arCalib').onclick = calibrate;
// hauteur réelle de la barre AR (elle passe sur 2-3 lignes sur petit écran) : le guidage se place au-dessus
if (window.ResizeObserver) new ResizeObserver(() => { const h = $('arBar').offsetHeight; if (h) document.body.style.setProperty('--arbar', h + 'px'); }).observe($('arBar'));
$('arBtn').onclick = startAR;
$('arExit').onclick = stopAR;
$('arFov').oninput = e => { AR.fov = +e.target.value; $('arFovVal').textContent = AR.fov + '°'; S.dirty = true; };
$('arHead').oninput = e => { AR.userHead = +e.target.value; $('arHeadVal').textContent = (AR.userHead > 0 ? '+' : '') + AR.userHead + '°'; S.dirty = true; };

/* ---------------- Satellites (mode avancé caché) : CelesTrak + satellite.js (MIT) ---------------- */
const SATLIB = window.satellite || null;
const SAT_GROUPS = { stations: 'Stations spatiales', visual: 'Satellites brillants', starlink: 'Starlink' };
const SAT = {
  adv: false, opts: { iss: true, stations: true, visual: true, starlink: false, country: '' },
  g: { stations: { list: [], at: 0, state: '', note: '' }, visual: { list: [], at: 0, state: '', note: '' }, starlink: { list: [], at: 0, state: '', note: '' } },
  byId: new Map(), fine: [], fineDirty: true, t0: 0, t1: -1, ver: 0, drawn: 0, lastRedraw: 0,
  cand: [], scan: null, lastScanMs: -1e15, scanKey: '', passes: null, passJob: null, passKey: ''
};
const SAT_CAP = [600, 250, 100];          // Starlink affichés au maximum selon le niveau de qualité
const SAT_REDRAW = [40, 66, 100];          // ms entre deux images quand des satellites bougent à l'écran
try {
  SAT.adv = localStorage.getItem('celeste.adv') === '1';
  const o = JSON.parse(localStorage.getItem('celeste.sats') || 'null'); if (o) Object.assign(SAT.opts, o);
} catch (e) {}
const satOn = () => SAT.adv && !!SATLIB && (SAT.opts.iss || SAT.opts.stations || SAT.opts.visual || SAT.opts.starlink);
const satMs = () => S.live && !S.playing ? Date.now() : simMs(); // temps continu (l'horloge « en direct » avance par pas de 1 s)
/* Observateur (ECEF, WGS84) */
const OB = { key: '', x: 0, y: 0, z: 0, sp: 0, cp: 1, sl: 0, cl: 1 };
function obSetup() {
  const k = S.loc.lat + ',' + S.loc.lon; if (k === OB.key) return; OB.key = k;
  const la = S.loc.lat * DEG, lo = S.loc.lon * DEG, a = 6378.137, e2 = 0.00669437999014;
  OB.sp = Math.sin(la); OB.cp = Math.cos(la); OB.sl = Math.sin(lo); OB.cl = Math.cos(lo);
  const N = a / Math.sqrt(1 - e2 * OB.sp * OB.sp);
  OB.x = N * OB.cp * OB.cl; OB.y = N * OB.cp * OB.sl; OB.z = N * (1 - e2) * OB.sp;
  SAT.fineDirty = true; SAT.lastScanMs = -1e15; SAT.passKey = '';
}
function sunEci(ms) { const v = A.GeoVector('Sun', A.MakeTime(new Date(ms)), true); const l = Math.hypot(v.x, v.y, v.z); return [v.x / l, v.y / l, v.z / l]; }
const rtmp = [0, 0, 0];
/* État topocentrique d'un satellite : out = [N, E, U (réfractés), distance km, éclairé 0/1, magnitude, vitesse km/s] */
function satState(s, date, gmst, sun, out) {
  let pv; try { pv = SATLIB.propagate(s.rec, date); } catch (e) { return false; }
  if (!pv || !pv.position || typeof pv.position !== 'object') return false;
  const p = pv.position, c = Math.cos(gmst), sn = Math.sin(gmst);
  const rx = p.x * c + p.y * sn - OB.x, ry = -p.x * sn + p.y * c - OB.y, rz = p.z - OB.z;
  const e = -OB.sl * rx + OB.cl * ry, n = -OB.sp * OB.cl * rx - OB.sp * OB.sl * ry + OB.cp * rz, u = OB.cp * OB.cl * rx + OB.cp * OB.sl * ry + OB.sp * rz;
  const rg = Math.sqrt(e * e + n * n + u * u);
  refractNEU(n / rg, e / rg, u / rg, rtmp);
  out[0] = rtmp[0]; out[1] = rtmp[1]; out[2] = rtmp[2]; out[3] = rg;
  const d = p.x * sun[0] + p.y * sun[1] + p.z * sun[2];
  let lit = 1; if (d < 0) { const qx = p.x - d * sun[0], qy = p.y - d * sun[1], qz = p.z - d * sun[2]; if (qx * qx + qy * qy + qz * qz < 40589641) lit = 0; } // ombre cylindrique (R = 6371 km)
  out[4] = lit;
  // magnitude : sphère diffuse, référence à 1000 km et 90° de phase
  const sfx = sun[0] * c + sun[1] * sn, sfy = -sun[0] * sn + sun[1] * c, sfz = sun[2];
  const cph = clamp(-(sfx * rx + sfy * ry + sfz * rz) / rg, -1, 1), ph = Math.acos(cph);
  const F = Math.max(0.01, (Math.sin(ph) + (Math.PI - ph) * cph)); // = π·F(φ)
  out[5] = s.std + 5 * Math.log10(rg / 1000) - 2.5 * Math.log10(F);
  const v = pv.velocity; out[6] = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : 0;
  return true;
}
function satNames(name, id) {
  if (id === 25544) return { name: 'ISS — Station spatiale internationale', short: 'ISS', std: -1.8 };
  if (id === 48274) return { name: 'Tiangong — station spatiale chinoise', short: 'Tiangong', std: -0.8 };
  return { name, short: name, std: null };
}
/* Lecture TLE (3 lignes), découpée en tranches pour ne pas bloquer l'interface (Starlink ≈ 10 000 objets) */
function parseTLE(group, text) {
  return new Promise(resolve => {
    const L = text.split(/\r?\n/).map(x => x.trimEnd()).filter(x => x.length); const out = []; const seen = new Set(); let i = 0;
    const std = group === 'starlink' ? 5.5 : group === 'visual' ? 4.0 : 3.0;
    const step = () => {
      const t0 = performance.now();
      while (i + 2 < L.length + 0 && performance.now() - t0 < 8) {
        const n = L[i], l1 = L[i + 1], l2 = L[i + 2];
        if (!l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') { i++; continue; }
        i += 3;
        if (group === 'stations') { const k = l2.slice(8, 63); if (seen.has(k)) continue; seen.add(k); } // modules amarrés = même orbite que l'ISS
        let rec; try { rec = SATLIB.twoline2satrec(l1, l2); } catch (e) { continue; }
        if (!rec || rec.error) continue;
        const id = +l1.slice(2, 7); const nm = satNames(n.trim(), id);
        out.push({ id, name: nm.name, short: nm.short, grp: group, iss: id === 25544, std: nm.std != null ? nm.std : std, rec, epoch: (rec.jdsatepoch - 2440587.5) * 86400000, a: null, b: null, cur: null, tail: null, ok: false });
      }
      if (i + 2 < L.length) setTimeout(step, 0); else resolve(out);
    };
    step();
  });
}
const TLE_URL = g => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;
async function loadSatGroup(g) {
  const G = SAT.g[g]; if (G.state === 'loading' || (G.state === 'ok' && Date.now() - G.at < 6 * 3600000)) return;
  G.state = 'loading'; satStatus();
  const key = 'celeste.tle.' + g; let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
  let text = null, at = 0, note = '';
  if (cached && Date.now() - cached.at < 6 * 3600000) { text = cached.text; at = cached.at; note = 'cache'; }
  else {
    try {
      if (navigator.onLine === false) throw new Error('hors ligne');
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(TLE_URL(g), { signal: ctl.signal, cache: 'no-store' }); clearTimeout(to);
      const t = await r.text();
      if (!r.ok || !/^1 \d{5}/m.test(t)) throw new Error('réponse CelesTrak invalide (' + r.status + ')');
      text = t; at = Date.now(); note = 'réseau';
      try { localStorage.setItem(key, JSON.stringify({ at, text })); } catch (e) { /* quota : pas de cache local pour ce groupe */ }
    } catch (e) {
      if (cached) { text = cached.text; at = cached.at; note = 'cache ancien'; }
      else { G.state = 'error'; G.note = 'données indisponibles (hors ligne ?)'; satStatus(); return; }
    }
  }
  let list = await parseTLE(g, text);
  // l'ISS et les stations figurent aussi dans « visual » : une seule copie, rattachée au groupe stations
  if (g === 'visual') { const ids = new Set(SAT.g.stations.list.map(x => x.id)); list = list.filter(x => !x.iss && !ids.has(x.id)); }
  if (g === 'stations') { // vaisseaux amarrés (Progress, Soyouz, Dragon, Tianzhou…) : même position que la station, on ne garde que la station
    const d = new Date(), pos = x => { try { const r = SATLIB.propagate(x.rec, d); return r && r.position; } catch (e) { return null; } };
    const hubs = list.filter(x => x.id === 25544 || x.id === 48274).map(pos).filter(Boolean);
    list = list.filter(x => { if (x.id === 25544 || x.id === 48274) return true; const p = pos(x); return !p || !hubs.some(h => Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z) < 15); });
  }
  if (g === 'stations' && SAT.g.visual.list.length) {
    const ids = new Set(list.map(x => x.id)); SAT.g.visual.list = SAT.g.visual.list.filter(x => !ids.has(x.id));
    for (let k = INDEX.length - 1; k >= 0; k--) if (INDEX[k].sel.kind === 'sat' && INDEX[k].grp === 'visual' && ids.has(INDEX[k].sel.id)) INDEX.splice(k, 1);
  }
  for (const s of G.list) if (SAT.byId.get(s.id) === s) SAT.byId.delete(s.id);
  G.list = list; G.at = at; G.state = 'ok';
  G.note = `${list.length} objets · données du ${fmt('dmed').format(new Date(at))} ${hm(at)}${note === 'cache ancien' ? ' (hors ligne : dernier cache)' : ''}`;
  for (const s of list) SAT.byId.set(s.id, s);
  // index de recherche
  for (let k = INDEX.length - 1; k >= 0; k--) if (INDEX[k].sel.kind === 'sat' && INDEX[k].grp === g) INDEX.splice(k, 1);
  for (const s of list) INDEX.push({ label: s.name, sub: `Satellite · ${SAT_GROUPS[g]} · n° ${s.id}`, keys: s.iss ? ['iss', 'station spatiale internationale', fold(s.name), String(s.id)] : [fold(s.name), fold(s.short), String(s.id)], sel: { kind: 'sat', id: s.id }, rank: s.iss ? 0.5 : g === 'starlink' ? 4 : 3, grp: g });
  SAT.fineDirty = true; SAT.lastScanMs = -1e15; SAT.passKey = ''; S.dirty = true; satStatus();
  loadSatcat(g);
}
function satEnsureData() {
  if (!satOn()) return;
  if (SAT.opts.iss || SAT.opts.stations) loadSatGroup('stations');
  if (SAT.opts.visual) loadSatGroup('visual');
  if (SAT.opts.starlink) loadSatGroup('starlink');
}
/* Balayage Starlink par tranches : ne garde que les satellites levés et éclairés, triés par éclat, plafonnés selon la qualité */
const scanOut = new Float64Array(7);
function scanStep(ms) {
  const list = SAT.g.starlink.list; if (!list.length) return;
  const key = OB.key + '|' + Q.level;
  if (!SAT.scan) {
    if (Math.abs(ms - SAT.lastScanMs) < 20000 && key === SAT.scanKey) return;
    SAT.scan = { i: 0, ms, date: new Date(ms), gmst: SATLIB.gstime(new Date(ms)), sun: sunEci(ms), res: [] };
  }
  const sc = SAT.scan, t0 = performance.now(), sunAlt = sky.sunAlt;
  while (sc.i < list.length && performance.now() - t0 < 3) {
    for (let k = 0; k < 64 && sc.i < list.length; k++, sc.i++) {
      const s = list[sc.i];
      if (!satState(s, sc.date, sc.gmst, sc.sun, scanOut)) continue;
      if (scanOut[2] > -0.05 && (scanOut[4] || sunAlt > -6)) sc.res.push([s, scanOut[4] ? scanOut[5] : scanOut[5] + 10]);
    }
  }
  if (sc.i >= list.length) {
    sc.res.sort((a, b) => a[1] - b[1]);
    SAT.cand = sc.res.slice(0, SAT_CAP[Q.level]).map(x => x[0]);
    SAT.lastScanMs = sc.ms; SAT.scanKey = key; SAT.scan = null; SAT.fineDirty = true;
  }
}
function buildFine(fast) {
  const L = [];
  const cf = SAT.opts.country ? satPassesFilter : () => true;
  for (const s of SAT.g.stations.list) if ((s.iss ? SAT.opts.iss : SAT.opts.stations) && cf(s)) L.push(s);
  if (SAT.opts.visual) for (const s of SAT.g.visual.list) if (cf(s)) L.push(s);
  if (SAT.opts.starlink && !fast && (!SAT.opts.country || SAT.opts.country === 'US')) for (const s of SAT.cand) L.push(s);
  for (const sel of [S.selected, GUIDE.target, LASER.pin]) if (sel && sel.kind === 'sat') { const s = SAT.byId.get(sel.id); if (s && cf(s) && !L.includes(s)) L.push(s); }
  for (const s of SAT.fine) if (!L.includes(s)) { s.ok = false; s.tail = null; }
  SAT.fine = L;
}
const trackOut = new Float64Array(7);
function computeBatch(ms, rate) {
  const fast = rate > 60; // lecture accélérée : Starlink masqué, positions recalculées ~8 fois par seconde
  buildFine(fast);
  const step = rate === 0 ? 0 : rate <= 30 ? 1000 * Math.max(1, rate) : rate * 125;
  const dir = S.playing && S.speed < 0 ? -1 : 1;
  const ta = ms, tb = ms + dir * step;
  const da = new Date(ta), db = new Date(tb), ga = SATLIB.gstime(da), gb = SATLIB.gstime(db), sa = sunEci(ta), sb = step ? sunEci(tb) : sa;
  for (const s of SAT.fine) {
    if (!s.a) { s.a = new Float64Array(7); s.b = new Float64Array(7); s.cur = new Float64Array(7); }
    s.ok = satState(s, da, ga, sa, s.a) && (step ? satState(s, db, gb, sb, s.b) : (s.b.set(s.a), true));
    // traînée (2 min passées, +2 min pour l'ISS et l'objet sélectionné), hors Starlink sauf sélection
    const sel = S.selected && S.selected.kind === 'sat' && S.selected.id === s.id;
    if (s.ok && s.a[2] > -0.15 && (s.grp !== 'starlink' || sel) && !fast) {
      const fut = s.iss || sel ? 6 : 0, n = 7 + fut; if (!s.tail || s.tail.length !== n * 3) s.tail = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { const t = ta + (k - 6) * 20000; const d = new Date(t); if (satState(s, d, SATLIB.gstime(d), sa, trackOut)) { s.tail[k * 3] = trackOut[0]; s.tail[k * 3 + 1] = trackOut[1]; s.tail[k * 3 + 2] = trackOut[2]; } }
      s.tailN = n;
    } else s.tail = null;
  }
  SAT.t0 = ta; SAT.t1 = tb; SAT.fineDirty = false; SAT.ver++; S.dirty = true;
}
function satTick(now) {
  if (!satOn()) { if (SAT.fine.length) { SAT.fine = []; SAT.drawn = 0; S.dirty = true; } return; }
  obSetup();
  const ms = satMs(), rate = S.playing ? Math.abs(S.speed) : (S.live ? 1 : 0);
  if (SAT.opts.starlink && rate <= 60 && (!SAT.opts.country || SAT.opts.country === 'US')) scanStep(ms);
  const f = SAT.t1 !== SAT.t0 ? (ms - SAT.t0) / (SAT.t1 - SAT.t0) : (ms === SAT.t0 ? 0 : -1);
  if (SAT.fineDirty || f < 0 || f > 1) computeBatch(ms, rate);
  const k = SAT.t1 !== SAT.t0 ? clamp((ms - SAT.t0) / (SAT.t1 - SAT.t0), 0, 1) : 0;
  for (const s of SAT.fine) {
    if (!s.ok) continue; const a = s.a, b = s.b, c = s.cur;
    const N = a[0] + (b[0] - a[0]) * k, E = a[1] + (b[1] - a[1]) * k, U = a[2] + (b[2] - a[2]) * k, l = Math.sqrt(N * N + E * E + U * U) || 1;
    c[0] = N / l; c[1] = E / l; c[2] = U / l; c[3] = a[3] + (b[3] - a[3]) * k; c[4] = k < 0.5 ? a[4] : b[4]; c[5] = a[5] + (b[5] - a[5]) * k; c[6] = a[6];
  }
  // satellites en mouvement visibles à l'écran : redessin limité (25/15/10 i/s selon la qualité), sinon aucun
  // intervalle adapté au mouvement apparent : on ne redessine que lorsque le satellite le plus rapide a bougé d'environ 0,7 px
  if (rate > 0 && SAT.drawn > 0) {
    const iv = Math.max(SAT_REDRAW[Q.level], Math.min(2000, 700 / Math.max(1e-6, (SAT.pxs || 0) * rate)));
    if (now - SAT.lastRedraw > iv) { SAT.lastRedraw = now; S.dirty = true; }
  }
}
/* Position d'un satellite sélectionné même hors de la liste calculée */
const satTmp = new Float64Array(7);
function satCur(id) {
  const s = SAT.byId.get(id); if (!s || !SATLIB) return null;
  const ms = satMs();
  if (s.ok && s.cur && ms >= Math.min(SAT.t0, SAT.t1) - 1500 && ms <= Math.max(SAT.t0, SAT.t1) + 1500 && SAT.fine.includes(s)) return s.cur;
  obSetup(); const d = new Date(ms);
  return satState(s, d, SATLIB.gstime(d), sunEci(ms), satTmp) ? satTmp : null;
}
const satNEU = id => { const c = satCur(id); return c ? [c[0], c[1], c[2]] : [0, 0, -1]; };
const SATCOL = { iss: '255,214,110', stations: '120,230,255', visual: '235,240,255', starlink: '150,190,255' };
function drawSats(camOn, groundOn) {
  SAT.drawn = 0; SAT.pxs = 0; if (!satOn() || !SAT.fine.length) return;
  const dtS = Math.max(1e-3, (SAT.t1 - SAT.t0) / 1000);
  const selId = S.selected && S.selected.kind === 'sat' ? S.selected.id : -1;
  // traînées
  ctx.lineWidth = 1.2;
  for (const s of SAT.fine) {
    if (!s.ok || !s.tail || (groundOn && s.cur[2] < -0.02)) continue;
    const col = s.iss ? SATCOL.iss : SATCOL[s.grp];
    ctx.strokeStyle = `rgba(${col},${s.cur[4] ? 0.45 : 0.18})`; ctx.setLineDash(s.iss || s.id === selId ? [] : [2, 4]);
    ctx.beginPath(); pathFlat(s.tail); ctx.stroke();
  }
  ctx.setLineDash([]);
  // Starlink et autres sans traînée calculée : court trait dans le sens du mouvement (≈ 40 s), sans propagation supplémentaire
  if (SAT.t1 !== SAT.t0) {
    const kk = 40 / dtS; ctx.beginPath(); let anyS = false;
    for (const s of SAT.fine) {
      if (!s.ok || s.tail || !s.cur[4] || (groundOn && s.cur[2] < 0)) continue;
      const c = s.cur, a = s.a, b = s.b;
      if (!proj(c[0], c[1], c[2]) || !onScreen(12)) continue; const x0 = P.x, y0 = P.y;
      if (!proj(c[0] - (b[0] - a[0]) * kk, c[1] - (b[1] - a[1]) * kk, c[2] - (b[2] - a[2]) * kk)) continue;
      ctx.moveTo(x0, y0); ctx.lineTo(P.x, P.y); anyS = true;
    }
    if (anyS) { ctx.strokeStyle = `rgba(${SATCOL.starlink},.38)`; ctx.lineWidth = 1.2; ctx.stroke(); }
  }
  // points : un tracé par catégorie
  const cats = ['starlink', 'visual', 'stations', 'iss'];
  for (const cat of cats) {
    for (const lit of [0, 1]) {
      ctx.beginPath(); let any = false;
      for (const s of SAT.fine) {
        if (!s.ok || (s.iss ? 'iss' : s.grp) !== cat || s.cur[4] !== lit) continue;
        const c = s.cur; if (groundOn && c[2] < 0) continue;
        if (!proj(c[0], c[1], c[2]) || !onScreen(12)) continue;
        const r = lit ? clamp(3.4 - 0.42 * c[5], 1.8, s.iss ? 5.5 : 4.2) : 1.8;
        if (lit) { ctx.moveTo(P.x + r, P.y); ctx.arc(P.x, P.y, r, 0, 6.2832); } else { ctx.moveTo(P.x + r, P.y); ctx.arc(P.x, P.y, r, 0, 6.2832); }
        picks.push({ kind: 'sat', id: s.id, x: P.x, y: P.y, r: r + 5, pri: s.iss ? -20 : -10 });
        SAT.drawn++; any = true;
        const a = s.a, b = s.b, w = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.hypot(a[0], a[1], a[2]) / dtS * V.s; if (w > SAT.pxs) SAT.pxs = w; // px par seconde simulée
      }
      if (!any) continue;
      if (lit) { ctx.fillStyle = `rgb(${SATCOL[cat]})`; ctx.shadowColor = `rgb(${SATCOL[cat]})`; ctx.shadowBlur = cat === 'iss' ? 10 : 4; ctx.fill(); ctx.shadowBlur = 0; }
      else { ctx.strokeStyle = 'rgba(150,160,185,.55)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
  // étiquettes
  ctx.font = '600 12px system-ui,sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (const s of SAT.fine) {
    if (!s.ok) continue; const c = s.cur;
    if (!(s.iss || s.id === selId || (s.grp !== 'starlink' && c[4] && V.fovDeg < 70))) continue;
    if (groundOn && c[2] < 0) continue;
    if (!proj(c[0], c[1], c[2]) || !onScreen(0)) continue;
    const tw = textW(s.short, ctx.font);
    if (s.iss || s.id === selId || labelFits(P.x + 7, P.y - 7, tw, 14)) { ctx.fillStyle = s.iss ? '#ffd66e' : 'rgba(190,225,255,.9)'; ctx.fillText(s.short, P.x + 7, P.y); }
  }
  ctx.textBaseline = 'alphabetic';
}
/* Passages : recherche par pas de 60 s sur 24 h, affinée par dichotomie ; découpée en tranches (≈ 8 ms) */
function satPassesFor(s, ctxP) {
  const out = [], n = ctxP.n, st = new Float64Array(7); let prevEl = null, cur = null;
  const evalAt = t => { const d = new Date(t); return satState(s, d, SATLIB.gstime(d), ctxP.sunAt(t), st) ? st : null; };
  const elAt = t => { const r = evalAt(t); return r ? Math.asin(clamp(r[2], -1, 1)) * RAD : -90; };
  const refine = (a, b, up) => { for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if ((elAt(m) > 0) === up) b = m; else a = m; } return (a + b) / 2; };
  for (let k = 0; k < n; k++) {
    const t = ctxP.t0 + k * 60000, r = satState(s, ctxP.dates[k], ctxP.gm[k], ctxP.sunAt(t), st);
    const el = r ? Math.asin(clamp(st[2], -1, 1)) * RAD : -90;
    if (prevEl != null && prevEl <= 0 && el > 0) cur = { s, rise: refine(t - 60000, t, true), maxEl: -90, max: t, vis: false, mag: 99 };
    if (cur && el > 0) {
      if (el > cur.maxEl) { cur.maxEl = el; cur.max = t; }
      const sunAlt = ctxP.sunAltAt(t);
      if (st[4] && sunAlt < -6) { cur.vis = true; cur.mag = Math.min(cur.mag, st[5]); if (!cur.v0) cur.v0 = t; cur.v1 = t; }
    }
    if (cur && prevEl > 0 && el <= 0) { cur.set = refine(t - 60000, t, false); if (cur.maxEl >= 10) out.push(cur); cur = null; }
    prevEl = el;
  }
  for (const p of out) {
    // maximum affiné (pas de 10 s autour)
    let best = p.max, be = p.maxEl; for (let t = p.max - 50000; t <= p.max + 50000; t += 10000) { const e = elAt(t); if (e > be) { be = e; best = t; } }
    p.max = best; p.maxEl = be;
    const az = t => { const r = evalAt(t); return r ? norm360(Math.atan2(r[1], r[0]) * RAD) : 0; };
    p.azR = az(p.rise); p.azM = az(p.max); p.azS = az(p.set);
  }
  return out;
}
function passContext(t0, hours) {
  const n = hours * 60 + 1, dates = [], gm = new Float64Array(n);
  for (let k = 0; k < n; k++) { dates.push(new Date(t0 + k * 60000)); gm[k] = SATLIB.gstime(dates[k]); }
  const ns = hours * 12 + 2, sunV = [], sunA = new Float64Array(ns);
  for (let k = 0; k < ns; k++) { const t = t0 + k * 300000; sunV.push(sunEci(t)); sunA[k] = altOf('Sun', t).altitude; }
  const idx = t => clamp(Math.round((t - t0) / 300000), 0, ns - 1);
  return { t0, n, dates, gm, sunAt: t => sunV[idx(t)], sunAltAt: t => { const x = (t - t0) / 300000, i = clamp(Math.floor(x), 0, ns - 2), f = clamp(x - i, 0, 1); return sunA[i] + (sunA[i + 1] - sunA[i]) * f; } };
}
function startPassJob() {
  if (!SATLIB) return;
  obSetup();
  const list = [...SAT.g.stations.list.filter(s => s.iss ? SAT.opts.iss : SAT.opts.stations), ...(SAT.opts.visual ? SAT.g.visual.list : [])];
  const key = OB.key + '|' + list.length + '|' + Math.floor(satMs() / 1800000);
  if (key === SAT.passKey && (SAT.passes || SAT.passJob)) { renderPasses(); return; }
  SAT.passKey = key; SAT.passes = null;
  const t0 = Math.floor(satMs() / 60000) * 60000, ctxP = passContext(t0, 24);
  const job = { i: 0, list, ctxP, res: [], t0 }; SAT.passJob = job;
  const step = () => {
    if (SAT.passJob !== job) return;
    const ts = performance.now();
    while (job.i < list.length && performance.now() - ts < 8) { job.res.push(...satPassesFor(list[job.i], ctxP)); job.i++; }
    if (job.i < list.length) { renderPasses(); setTimeout(step, 0); }
    else { SAT.passes = job.res.filter(p => p.vis).sort((a, b) => a.rise - b.rise); SAT.passJob = null; renderPasses(); }
  };
  renderPasses(); setTimeout(step, 0);
}
function renderPasses() {
  const el = $('satPassList'); if (!el || $('panel-sats').classList.contains('hidden')) return;
  const job = SAT.passJob;
  if (!SAT.g.stations.list.length && !SAT.g.visual.list.length) { el.innerHTML = '<p class="muted">Chargement des orbites CelesTrak…</p>'; return; }
  if (job) { el.innerHTML = `<p class="muted">Calcul des passages… ${Math.round(job.i / Math.max(1, job.list.length) * 100)} %</p>`; return; }
  const P2 = SAT.passes || [];
  if (!P2.length) { el.innerHTML = '<p class="muted">Aucun passage visible (satellite éclairé, ciel sombre, hauteur ≥ 10°) dans les 24 prochaines heures.</p>'; return; }
  // ISS en tête (toujours), puis les autres passages assez brillants pour l'œil nu (mag ≤ 4,5), dans l'ordre chronologique
  const row = p => { const k = P2.indexOf(p); return `<li data-k="${k}" class="${p.s.iss ? 'iss' : ''}">
    <div class="ps-l1"><b>${p.s.iss ? '★ ' : ''}${p.s.short}</b><span>${fmt('dshort').format(new Date(p.rise))} · max <b>${Math.round(p.maxEl)}°</b>${p.mag < 50 ? ` · mag ${num(p.mag, 1)}` : ''}</span></div>
    <div class="ps-own">${ownerHtml(p.s)}</div>
    <div class="ps-l2"><span>↑ ${hm(p.rise)} ${cardinal(p.azR)}</span><span>▲ ${hm(p.max)} ${cardinal(p.azM)}</span><span>↓ ${hm(p.set)} ${cardinal(p.azS)}</span>${p.v0 - p.rise > 90000 || p.set - p.v1 > 90000 ? `<span class="ps-vis">visible ${hm(p.v0)}–${hm(Math.min(p.set, p.v1 + 60000))}</span>` : ''}</div></li>`; };
  const issP = P2.filter(p => p.s.iss && satPassesFilter(p.s)), oth = P2.filter(p => !p.s.iss && p.mag <= 4.5 && satPassesFilter(p.s)), shown = oth.slice(0, 40);
  el.innerHTML = `<h4 class="ps-h">★ ISS</h4>` + (issP.length ? '<ol class="passes">' + issP.map(row).join('') + '</ol>' : `<p class="muted">${!SAT.opts.iss ? 'ISS désactivée dans Calques.' : !satPassesFilter(SAT.byId.get(25544)) ? 'ISS masquée par le filtre de pays.' : 'Aucun passage visible de l\'ISS dans les 24 h.'}</p>`)
    + `<h4 class="ps-h">Autres satellites brillants <small>(${SAT.opts.country ? ($('satCountry').selectedOptions[0] || {}).textContent.replace(/ \(\d+\)$/, '') + ' · ' : ''}mag ≤ 4,5 · ${shown.length}${oth.length > shown.length ? ' / ' + oth.length : ''})</small></h4>`
    + (shown.length ? '<ol class="passes">' + shown.map(row).join('') + '</ol>' : '<p class="muted">Aucun.</p>');
  el.querySelectorAll('li[data-k]').forEach(li => li.onclick = () => {
    const p = P2[+li.dataset.k];
    // moment visé : le maximum s'il est visible, sinon l'instant visible (éclairé, ciel sombre) le plus proche du maximum
    const tt = p.max >= p.v0 && p.max <= p.v1 ? p.max : Math.abs(p.v0 - p.max) < Math.abs(p.v1 - p.max) ? p.v0 : p.v1;
    window.__celeste.setTime(tt); PANELS.forEach(n => $('panel-' + n).classList.add('hidden'));
    goToObject({ kind: 'sat', id: p.s.id }); toast(`Heure réglée sur ${tt === p.max ? 'le maximum du passage' : 'le passage visible'} (${hm(tt)}) — « Maintenant » pour revenir`, 5000);
  });
}
/* Prochain passage d'un seul satellite (fiche, « sous l'horizon ») */
const satPassCache = new Map();
function satNextPass(s) {
  const ms = satMs(), key = s.id + '|' + Math.floor(ms / 60000) + '|' + OB.key;
  if (satPassCache.has(key)) return satPassCache.get(key);
  obSetup(); const t0 = Math.floor(ms / 60000) * 60000; const all = satPassesFor(s, passContext(t0, 24));
  const r = all.find(p => p.rise > ms) || null;
  if (satPassCache.size > 50) satPassCache.clear(); satPassCache.set(key, r); return r;
}
function satInfoParts(id) {
  const s = SAT.byId.get(id), c = satCur(id); if (!s || !c) return null;
  const ms = satMs(), d = new Date(ms), pv = SATLIB.propagate(s.rec, d);
  let h = null; try { h = SATLIB.eciToGeodetic(pv.position, SATLIB.gstime(d)).height; } catch (e) {}
  const aa = neuToAltAz(c);
  return { s, c, h, aa, lit: !!c[4], ageD: (Date.now() - s.epoch) / 86400000 };
}
function satStatus() {
  const el = $('satStatus'); if (!el) return;
  const parts = [];
  for (const g of ['stations', 'visual', 'starlink']) { const G = SAT.g[g]; if (G.state) parts.push(`${SAT_GROUPS[g]} : ${G.state === 'loading' ? 'chargement…' : G.note}`); }
  el.textContent = !SATLIB ? 'satellite.js indisponible' : parts.join(' · ') || 'Aucun groupe chargé';
}
function saveSatOpts() { try { localStorage.setItem('celeste.sats', JSON.stringify(SAT.opts)); } catch (e) {} }
function syncSatUI() {
  $('satSection').classList.toggle('hidden', !SAT.adv);
  document.querySelectorAll('[data-sat]').forEach(cb => { cb.checked = !!SAT.opts[cb.dataset.sat]; });
  syncOwnerFilter(); satStatus();
}
document.querySelectorAll('[data-sat]').forEach(cb => cb.onchange = () => {
  SAT.opts[cb.dataset.sat] = cb.checked; saveSatOpts(); SAT.fineDirty = true; SAT.lastScanMs = -1e15; SAT.passKey = ''; satEnsureData(); syncOwnerFilter(); S.dirty = true;
});
$('satCountry').onchange = e => {
  SAT.opts.country = e.target.value; saveSatOpts(); SAT.fineDirty = true; SAT.lastScanMs = -1e15; S.dirty = true;
  if (S.selected && S.selected.kind === 'sat' && !satPassesFilter(SAT.byId.get(S.selected.id))) select(null);
  if (!$('panel-sats').classList.contains('hidden')) renderPasses();
};
$('satPassBtn').onclick = () => { openPanel('sats', true); satEnsureData(); startPassJob(); };
/* ---------------- Pays / organisation propriétaire (CelesTrak SATCAT, champ OWNER) ---------------- */
// code SATCAT → [drapeau, nom français] ; liste complète des codes CelesTrak (satcat/sources.php)
const OWNERS = {
  ISS: ['🌐', 'Station internationale (USA, Russie, Europe, Japon, Canada)'], US: ['🇺🇸', 'États-Unis'], CIS: ['🇷🇺', 'Russie (ex-URSS)'], PRC: ['🇨🇳', 'Chine'],
  ESA: ['🇪🇺', 'Europe (ESA)'], ESRO: ['🇪🇺', 'Europe (ESRO)'], EUME: ['🇪🇺', 'Europe (EUMETSAT)'], EUTE: ['🇪🇺', 'Europe (Eutelsat)'], FR: ['🇫🇷', 'France'], JPN: ['🇯🇵', 'Japon'],
  IND: ['🇮🇳', 'Inde'], ISRO: ['🇮🇳', 'Inde (ISRO)'], CA: ['🇨🇦', 'Canada'], UK: ['🇬🇧', 'Royaume-Uni'], GER: ['🇩🇪', 'Allemagne'], IT: ['🇮🇹', 'Italie'], SPN: ['🇪🇸', 'Espagne'],
  AB: ['🌐', 'Arabsat (Ligue arabe)'], ABS: ['🌐', 'ABS (Asia Broadcast Satellite)'], AC: ['🌐', 'AsiaSat'], ALG: ['🇩🇿', 'Algérie'], ANG: ['🇦🇴', 'Angola'], ARGN: ['🇦🇷', 'Argentine'],
  ARM: ['🇦🇲', 'Arménie'], ASRA: ['🇦🇹', 'Autriche'], AUS: ['🇦🇺', 'Australie'], AZER: ['🇦🇿', 'Azerbaïdjan'], BEL: ['🇧🇪', 'Belgique'], BELA: ['🇧🇾', 'Biélorussie'], BERM: ['🇧🇲', 'Bermudes'],
  BGD: ['🇧🇩', 'Bangladesh'], BHR: ['🇧🇭', 'Bahreïn'], BHUT: ['🇧🇹', 'Bhoutan'], BOL: ['🇧🇴', 'Bolivie'], BRAZ: ['🇧🇷', 'Brésil'], BUL: ['🇧🇬', 'Bulgarie'], BWA: ['🇧🇼', 'Botswana'],
  CHBZ: ['🇨🇳🇧🇷', 'Chine / Brésil'], CHTU: ['🇨🇳🇹🇷', 'Chine / Turquie'], CHLE: ['🇨🇱', 'Chili'], COL: ['🇨🇴', 'Colombie'], CRI: ['🇨🇷', 'Costa Rica'], CZCH: ['🇨🇿', 'Tchéquie'],
  DEN: ['🇩🇰', 'Danemark'], DJI: ['🇩🇯', 'Djibouti'], ECU: ['🇪🇨', 'Équateur'], EGYP: ['🇪🇬', 'Égypte'], EST: ['🇪🇪', 'Estonie'], ETH: ['🇪🇹', 'Éthiopie'], FGER: ['🇫🇷🇩🇪', 'France / Allemagne'],
  FIN: ['🇫🇮', 'Finlande'], FRIT: ['🇫🇷🇮🇹', 'France / Italie'], GHA: ['🇬🇭', 'Ghana'], GLOB: ['🌐', 'Globalstar'], GREC: ['🇬🇷', 'Grèce'], GRSA: ['🇬🇷🇸🇦', 'Grèce / Arabie saoudite'],
  GUAT: ['🇬🇹', 'Guatemala'], HRV: ['🇭🇷', 'Croatie'], HUN: ['🇭🇺', 'Hongrie'], IM: ['🌐', 'Inmarsat'], INDO: ['🇮🇩', 'Indonésie'], IRAN: ['🇮🇷', 'Iran'], IRAQ: ['🇮🇶', 'Irak'],
  IRID: ['🌐', 'Iridium'], IRL: ['🇮🇪', 'Irlande'], ISRA: ['🇮🇱', 'Israël'], ITSO: ['🌐', 'Intelsat'], KAZ: ['🇰🇿', 'Kazakhstan'], KEN: ['🇰🇪', 'Kenya'], LAOS: ['🇱🇦', 'Laos'],
  LKA: ['🇱🇰', 'Sri Lanka'], LTU: ['🇱🇹', 'Lituanie'], LUXE: ['🇱🇺', 'Luxembourg'], MA: ['🇲🇦', 'Maroc'], MALA: ['🇲🇾', 'Malaisie'], MCO: ['🇲🇨', 'Monaco'], MDA: ['🇲🇩', 'Moldavie'],
  MEX: ['🇲🇽', 'Mexique'], MMR: ['🇲🇲', 'Birmanie'], MNE: ['🇲🇪', 'Monténégro'], MNG: ['🇲🇳', 'Mongolie'], MUS: ['🇲🇺', 'Maurice'], NATO: ['🌐', 'OTAN'], NETH: ['🇳🇱', 'Pays-Bas'],
  NICO: ['🌐', 'New ICO'], NIG: ['🇳🇬', 'Nigeria'], NKOR: ['🇰🇵', 'Corée du Nord'], NOR: ['🇳🇴', 'Norvège'], NPL: ['🇳🇵', 'Népal'], NZ: ['🇳🇿', 'Nouvelle-Zélande'], O3B: ['🌐', 'O3b Networks'],
  ORB: ['🌐', 'Orbcomm'], PAKI: ['🇵🇰', 'Pakistan'], PERU: ['🇵🇪', 'Pérou'], POL: ['🇵🇱', 'Pologne'], POR: ['🇵🇹', 'Portugal'], PRY: ['🇵🇾', 'Paraguay'], PRES: ['🇨🇳🇪🇺', 'Chine / Europe (ESA)'],
  QAT: ['🇶🇦', 'Qatar'], RASC: ['🌐', 'RascomStar-QAF'], ROC: ['🇹🇼', 'Taïwan'], ROM: ['🇷🇴', 'Roumanie'], RP: ['🇵🇭', 'Philippines'], RWA: ['🇷🇼', 'Rwanda'], SAFR: ['🇿🇦', 'Afrique du Sud'],
  SAUD: ['🇸🇦', 'Arabie saoudite'], SDN: ['🇸🇩', 'Soudan'], SEAL: ['🌐', 'Sea Launch'], SEN: ['🇸🇳', 'Sénégal'], SES: ['🇱🇺', 'SES (Luxembourg)'], SGJP: ['🇸🇬🇯🇵', 'Singapour / Japon'],
  SING: ['🇸🇬', 'Singapour'], SKOR: ['🇰🇷', 'Corée du Sud'], SLB: ['🇸🇧', 'Îles Salomon'], STCT: ['🇸🇬🇹🇼', 'Singapour / Taïwan'], SVN: ['🇸🇮', 'Slovénie'], SWED: ['🇸🇪', 'Suède'],
  SWTZ: ['🇨🇭', 'Suisse'], THAI: ['🇹🇭', 'Thaïlande'], TMMC: ['🇹🇲🇲🇨', 'Turkménistan / Monaco'], TUN: ['🇹🇳', 'Tunisie'], TURK: ['🇹🇷', 'Turquie'], UAE: ['🇦🇪', 'Émirats arabes unis'],
  UKR: ['🇺🇦', 'Ukraine'], URY: ['🇺🇾', 'Uruguay'], USBZ: ['🇺🇸🇧🇷', 'États-Unis / Brésil'], VAT: ['🇻🇦', 'Vatican'], VENZ: ['🇻🇪', 'Venezuela'], VTNM: ['🇻🇳', 'Viêt Nam'], ZWE: ['🇿🇼', 'Zimbabwe'],
  TBD: ['🏳️', 'Pays inconnu'], UNK: ['🏳️', 'Pays inconnu']
};
const OWN_TTL = 7 * 86400000;
const OWN = { g: {}, byId: new Map(), lazy: new Set(), ver: 0 };
const SATCAT_URL = q => `https://celestrak.org/satcat/records.php?${q}&FORMAT=json`;
// Starlink : tous les objets du groupe ont OWNER = US (vérifié sur les 11 124 fiches) ; on évite de télécharger 3,7 Mo
const OWN_GROUP_DEFAULT = { starlink: 'US' };
function ownerOf(s, lazy) {
  if (!s) return { code: '', flag: '🏳️', name: 'Pays inconnu', known: false };
  let code = OWN.byId.get(s.id) || OWN_GROUP_DEFAULT[s.grp] || '';
  const o = OWNERS[code];
  if (!o) { if (!code && lazy) satcatLazy(s); return { code: code || '?', flag: '🏳️', name: code ? `Pays inconnu (${code})` : 'Pays inconnu', known: false }; }
  return { code, flag: o[0], name: s.grp === 'starlink' && code === 'US' ? 'États-Unis (SpaceX)' : o[1], known: code !== 'TBD' && code !== 'UNK' };
}
const ownerHtml = (s, lazy) => { const o = ownerOf(s, lazy); return `<span class="own${o.known ? '' : ' unk'}" title="${o.name}">${o.flag} ${o.name}</span>`; };
const ownerShort = (s, lazy) => { const o = ownerOf(s, lazy); return o.known ? `${o.flag} ${o.name.replace(/ \(.*\)$/, '')}` : `${o.flag} inconnu`; };
function parseSatcat(text) {
  const arr = JSON.parse(text); if (!Array.isArray(arr)) throw new Error('format');
  const m = {}; for (const r of arr) if (r && r.NORAD_CAT_ID) m[r.NORAD_CAT_ID] = String(r.OWNER || '').trim() || 'UNK';
  return m;
}
function applyOwners(m) { for (const k in m) OWN.byId.set(+k, m[k]); OWN.ver++; syncOwnerFilter(); refreshOwnerIndex(); SAT.fineDirty = true; SAT.passKey = ''; S.dirty = true; if ($('panel-sats') && !$('panel-sats').classList.contains('hidden') && !SAT.passJob) renderPasses(); }
async function loadSatcat(g) {
  if (OWN_GROUP_DEFAULT[g]) { syncOwnerFilter(); refreshOwnerIndex(); return; }
  const st = OWN.g[g] || (OWN.g[g] = { state: '', at: 0 }); if (st.state === 'loading' || (st.state === 'ok' && Date.now() - st.at < OWN_TTL)) return;
  const key = 'celeste.satcat.' + g; let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) {}
  if (cached && cached.m && Date.now() - cached.at < OWN_TTL) { st.state = 'ok'; st.at = cached.at; applyOwners(cached.m); return; }
  st.state = 'loading';
  try {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(SATCAT_URL('GROUP=' + g), { signal: ctl.signal }); clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = parseSatcat(await r.text()); if (!Object.keys(m).length) throw new Error('vide');
    st.state = 'ok'; st.at = Date.now();
    try { localStorage.setItem(key, JSON.stringify({ at: st.at, m })); } catch (e) {}
    applyOwners(m);
  } catch (e) {
    if (cached && cached.m) { st.state = 'ok'; st.at = cached.at; st.stale = true; applyOwners(cached.m); } // hors ligne : dernière copie
    else { st.state = 'error'; st.at = Date.now(); OWN.ver++; syncOwnerFilter(); } // « Pays inconnu » affiché, nouvel essai au prochain chargement
  }
}
// satellite sélectionné absent du catalogue de groupe : requête unitaire (CATNR), une seule fois par objet
function satcatLazy(s) {
  // seulement si le catalogue du groupe a bien été chargé (objet manquant) ; jamais en rafale (≤ 10 par session)
  if (!s || OWN.lazy.has(s.id) || OWN.lazy.size >= 10 || OWN_GROUP_DEFAULT[s.grp] || (OWN.g[s.grp] || {}).state !== 'ok') return;
  OWN.lazy.add(s.id);
  fetch(SATCAT_URL('CATNR=' + s.id)).then(r => r.ok ? r.text() : Promise.reject()).then(t => { const m = parseSatcat(t); if (Object.keys(m).length) applyOwners(m); }).catch(() => {});
}
function refreshOwnerIndex() {
  for (const it of INDEX) if (it.sel.kind === 'sat') { const s = SAT.byId.get(it.sel.id); if (!s) continue; const o = ownerOf(s); it.sub = `Satellite · ${o.flag} ${o.name.replace(/ \(.*\)$/, '')} · ${SAT_GROUPS[s.grp]} · n° ${s.id}`; }
}
// filtre par pays : liste construite à partir des satellites chargés (effectifs), mémorisée dans SAT.opts.country
const ownFilterKey = s => { const o = ownerOf(s); return o.known ? o.code : '?'; };
const satPassesFilter = s => !SAT.opts.country || ownFilterKey(s) === SAT.opts.country;
function syncOwnerFilter() {
  const el = $('satCountry'); if (!el) return;
  const cnt = new Map();
  for (const g of ['stations', 'visual', 'starlink']) { if (g === 'starlink' && !SAT.opts.starlink) continue; if ((g === 'visual' && !SAT.opts.visual)) continue; for (const s of SAT.g[g].list) { if (g === 'stations' && !(s.iss ? SAT.opts.iss : SAT.opts.stations)) continue; const k = ownFilterKey(s); cnt.set(k, (cnt.get(k) || 0) + 1); } }
  const cur = SAT.opts.country || '';
  if (cur && !cnt.has(cur)) cnt.set(cur, 0);
  const items = [...cnt].map(([k, n]) => [k, n, k === '?' ? '🏳️ Pays inconnu' : `${OWNERS[k] ? OWNERS[k][0] : '🏳️'} ${OWNERS[k] ? OWNERS[k][1] : k}`]).sort((a, b) => b[1] - a[1] || a[2].localeCompare(b[2], 'fr'));
  const html = '<option value="">Tous les pays</option>' + items.map(([k, n, l]) => `<option value="${k}">${l} (${n})</option>`).join('');
  if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
  el.value = cur;
}
/* Déverrouillage : 5 touchers rapides sur le logo / titre */
let brandTaps = [];
document.querySelector('#topbar .brand').addEventListener('click', () => {
  const now = performance.now(); brandTaps = brandTaps.filter(t => now - t < 2500); brandTaps.push(now);
  if (brandTaps.length < 5) return;
  brandTaps = []; SAT.adv = !SAT.adv;
  try { localStorage.setItem('celeste.adv', SAT.adv ? '1' : '0'); } catch (e) {}
  toast(SAT.adv ? 'Mode avancé activé — satellites dans Calques' : 'Mode avancé désactivé', 3000);
  syncSatUI(); if (SAT.adv) satEnsureData(); else { SAT.fine = []; SAT.drawn = 0; if (S.selected && S.selected.kind === 'sat') select(null); $('panel-sats').classList.add('hidden'); }
  S.dirty = true;
});

/* ---------------- Boucle ---------------- */
let lastT = performance.now(), lastLive = 0, lastInfo = 0, lastCond = 0;
function frame(now) {
  requestAnimationFrame(frame);
  Q.frames++;
  const dt = Math.min(0.25, (now - lastT) / 1000); lastT = now;
  if (S.playing) { S.anchor += dt * 1000 * S.speed; S.dirty = true; }
  else if (S.live && now - lastLive > 1000) { S.anchor = Date.now(); lastLive = now; }
  if (S.tween) {
    const tw = S.tween, k = clamp((now - tw.t0) / tw.dur, 0, 1), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    S.az = lerp(tw.az0, tw.az1, e); S.alt = lerp(tw.alt0, tw.alt1, e); S.fov = lerp(tw.fov0, tw.fov1, e);
    if (k >= 1) { S.tween = null; save(); }
    S.dirty = true;
  }
  // AR : ~30 i/s suffisent (capteurs lissés) et divisent par deux le travail GPU
  if (AR.on && now - Q.lastRender < 31) { updateClock(); return; }
  if (AR.on) { updateAR(now); S.dirty = true; }
  const changed = updateSky(false);
  satTick(now);
  const las = laserActive();
  if (las || AR.on) setupView();
  if (AR.on) updateGuide(now);
  if (las) updateLaser(now); else if (LASER.key) { LASER.key = ''; if (!(AR.on && GUIDE.locked)) LASER.target = null; renderLaserPanel(now); }
  if (changed || S.dirty || Q.ovl) {
    const t0 = performance.now();
    render(); S.dirty = false; Q.ovl = false;
    Q.cost += (performance.now() - t0 - Q.cost) * 0.1; Q.renders++; Q.lastRender = now;
    qualityTick(now, true);
  }
  updateClock();
  if (now - lastCond > 1000) { lastCond = now; renderConditions(false); }
  if (S.selected && (changed || S.selected.kind === 'sat') && now - lastInfo > (S.playing ? 300 : 1000)) { lastInfo = now; renderInfo(); }
}
/* Onglet masqué : rAF est suspendu par le navigateur ; on coupe aussi capteurs et caméra (batterie) */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (AR.on) {
      removeOrientListeners(); AR.paused = true;
      if (AR.stream) { AR.stream.getTracks().forEach(t => t.stop()); AR.stream = null; AR.camera = false; $('camera').srcObject = null; }
    }
    return;
  }
  if (S.live) S.anchor = Date.now();
  if (AR.on && AR.paused) {
    AR.paused = false; addOrientListeners(); AR.f = null; AR.u = null;
    if (AR.wantCam) openCamera().then(res => { if (!AR.on || !res || !res.getTracks) { if (res && res.getTracks) res.getTracks().forEach(t => t.stop()); return; } attachCamera(res); S.dirty = true; });
  }
  S.dirty = true;
});

/* ---------------- Démarrage ---------------- */
initQuality(); syncSatUI(); if (SAT.adv) satEnsureData(); applyNight(); syncLocUI(); syncTimeUI(); syncLaserUI(); syncQualityUI(); resize(); updateSky(true);
requestAnimationFrame(frame);
if ((location.protocol === 'https:' || location.hostname === 'localhost') && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__celeste = {
  S, sky, AR, select, centerOn, setLocation, openPanel, loadForecast, forecastState, BODIES,
  setTime(ms) { S.live = false; S.playing = false; S.anchor = ms; S.slider = 0; slider.value = 0; syncTimeUI(); S.dirty = true; updateSky(true); },
  bodyAltAz() { updateSky(true); return sky.bodies.map(b => ({ key: b.b.key, alt: b.alt, az: b.az, mag: b.mag })); },
  starAltAzByName(name) { const it = INDEX.find(x => x.label === name && x.sel.kind === 'star'); return it ? starAltAz(it.sel.i) : null; },
  project(alt, az) { const v = altAzVec(alt, az); return proj(v[0], v[1], v[2]) ? { x: P.x, y: P.y } : null; },
  guide: () => ({ target: GUIDE.target && objName(GUIDE.target), ...GUIDE.info, text: $('arGuideText').innerText }),
  laser: () => ({ target: LASER.target && objName(LASER.target), kind: LASER.target && LASER.target.kind, radius: laserRadiusDeg(), html: $('laserPanel').innerText }),
  aimAltAz(alt, az) { S.az = az * DEG; S.alt = alt * DEG; S.dirty = true; },
  perf: () => ({ renders: Q.renders, frames: Q.frames, level: Q.level, levelName: LEVELS[Q.level].name, dpr: DPR, ema: +Q.ema.toFixed(1), renderMs: +Q.cost.toFixed(2), auto: Q.auto, lowEnd, hwc: HWC, mem: DMEM, canvas: cv.width + 'x' + cv.height }),
  setLaser, setQuality: q => setQuality(q), calibrate,
  sat: () => { const s = SAT.byId.get(25544), c = s && satCur(25544); return { adv: SAT.adv, opts: { ...SAT.opts }, groups: Object.fromEntries(Object.entries(SAT.g).map(([k, v]) => [k, { n: v.list.length, state: v.state, note: v.note }])), fine: SAT.fine.length, drawn: SAT.drawn, cand: SAT.cand.length, iss: c ? { ...neuToAltAz(c), range: c[3], lit: c[4], mag: c[5], speed: c[6] } : null, passes: SAT.passes ? SAT.passes.length : null, passJob: !!SAT.passJob }; },
  owner: id => ownerOf(SAT.byId.get(id)), ownStats: () => ({ known: OWN.byId.size, g: JSON.parse(JSON.stringify(OWN.g)), ver: OWN.ver, lazy: [...OWN.lazy] }),
  fineOwn: () => [...new Set(SAT.fine.map(ownFilterKey))],
  satPasses: () => (SAT.passes || []).map(p => ({ id: p.s.id, own: ownerShort(p.s), code: ownFilterKey(p.s), name: p.s.short, rise: p.rise, max: p.max, set: p.set, maxEl: p.maxEl, azR: p.azR, azM: p.azM, azS: p.azS, mag: p.mag, iss: p.s.iss })),
  satAt: (id, ms) => { const s = SAT.byId.get(id); if (!s) return null; obSetup(); const d = new Date(ms), o = new Float64Array(7); if (!satState(s, d, SATLIB.gstime(d), sunEci(ms), o)) return null; const pv = SATLIB.propagate(s.rec, d), g = SATLIB.eciToGeodetic(pv.position, SATLIB.gstime(d)); return { ...neuToAltAz(o), range: o[3], lit: o[4], lat: g.latitude * RAD, lon: g.longitude * RAD, h: g.height }; },
  simMs, search(q) { si.value = q; doSearch(); pickResult(0); }
};
})();
