/* Céleste — contrôle de télescope : GoTo, Sync, suivi, déplacements manuels, STOP.
   Protocoles : Celestron NexStar / Sky-Watcher SynScan (raquette), Meade LX200 (et OnStep, compatibles LX200),
   ASCOM Alpaca (REST), INDI (XML, via la passerelle). Liaisons : Web Serial (USB / Bluetooth série),
   Web Bluetooth (adaptateur BLE-UART), passerelle PC (celeste_bridge.py), simulateur intégré.
   Pas d'autoguidage par caméra (type PHD2) : le « suivi » est celui de la monture. */
(() => {
'use strict';
const A = window.Astronomy;
const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const norm360 = x => ((x % 360) + 360) % 360;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= Encodeurs / décodeurs (fonctions pures, testées) ================= */
const ENC = {
  // LX200 format long : HH:MM:SS et sDD*MM:SS
  lxRA(h) { const s = Math.round(norm360(h * 15) / 15 * 3600) % 86400; return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); },
  lxDec(d) { const s = Math.round(Math.min(90, Math.abs(d)) * 3600); return (d < 0 ? '-' : '+') + pad(Math.floor(s / 3600)) + '*' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); },
  lxParseRA(t) {
    const m = /(\d{1,2}):(\d{1,2})([:.])(\d+)/.exec(t || ''); if (!m) return NaN;
    return +m[1] + (m[3] === '.' ? (+m[2] + +m[4][0] / 10) / 60 : +m[2] / 60 + +m[4] / 3600);
  },
  lxParseDec(t) {
    const m = /([+-])?\s*(\d{1,3})[*\u00df\u00b0:'](\d{1,2})(?:[:'](\d{1,2}))?/.exec(t || ''); if (!m) return NaN;
    const v = +m[2] + +m[3] / 60 + (m[4] ? +m[4] / 3600 : 0); return m[1] === '-' ? -v : v;
  },
  // NexStar « précis » : fraction de tour sur 24 bits, envoyée en 8 chiffres hexadécimaux (2 derniers = 00)
  nxEnc(deg) { const v = Math.round(norm360(deg) / 360 * 16777216) % 16777216; return (v * 256).toString(16).toUpperCase().padStart(8, '0'); },
  nxDecode(hex) { return parseInt(hex, 16) / 4294967296 * 360; },
  nxEnc16(deg) { return (Math.round(norm360(deg) / 360 * 65536) % 65536).toString(16).toUpperCase().padStart(4, '0'); },
  nxGoto(raH, dec) { return 'r' + ENC.nxEnc(raH * 15) + ',' + ENC.nxEnc(dec); },
  nxSync(raH, dec) { return 's' + ENC.nxEnc(raH * 15) + ',' + ENC.nxEnc(dec); },
  nxParse(t) { // « 34AB0500,12CE0500# » ou « 34AB,12CE# »
    const m = /([0-9A-Fa-f]{4,8}),([0-9A-Fa-f]{4,8})/.exec(t || ''); if (!m) return null;
    const f = h => h.length === 4 ? parseInt(h, 16) / 65536 * 360 : ENC.nxDecode(h);
    let ra = f(m[1]), dec = f(m[2]); if (dec > 180) dec -= 360; return { ra: ra / 15, dec };
  },
  nxSlew(axis, dir, rate) { // axis 'ra'|'dec' ; dir +1/-1 ; rate 0–9 (0 = arrêt)
    return String.fromCharCode(0x50, 2, axis === 'ra' ? 16 : 17, dir > 0 ? 36 : 37, clamp(rate | 0, 0, 9), 0, 0, 0);
  },
  esc(s) { return String(s).replace(/[^\x20-\x7e]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')); },
  xml(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]); }
};

/* ================= Coordonnées ================= */
function vec(raDeg, decDeg) { const r = raDeg * DEG, d = decDeg * DEG; return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]; }
function rotRaDec(rot, raH, dec, date) {
  const v = vec(raH * 15, dec), w = A.RotateVector(rot, new A.Vector(v[0], v[1], v[2], A.MakeTime(date)));
  const e = A.EquatorFromVector(w); return { ra: e.ra, dec: e.dec };
}
const j2000ToNow = (raH, dec, date) => rotRaDec(A.Rotation_EQJ_EQD(A.MakeTime(date)), raH, dec, date);
const nowToJ2000 = (raH, dec, date) => rotRaDec(A.Rotation_EQD_EQJ(A.MakeTime(date)), raH, dec, date);
function observer() { const c = window.__celeste; const l = c && c.S && c.S.loc || { lat: 46.16, lon: -1.15 }; return new A.Observer(l.lat, l.lon, 0); }
function altAzNow(raNowH, decNow, date) { const h = A.Horizon(A.MakeTime(date), observer(), raNowH, decNow, 'normal'); return { alt: h.altitude, az: h.azimuth }; }
function sepDeg(ra1H, d1, ra2H, d2) { const a = vec(ra1H * 15, d1), b = vec(ra2H * 15, d2); return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)) * RAD; }
function sunNow(date) { const e = A.Equator('Sun', A.MakeTime(date), observer(), true, true); return { ra: e.ra, dec: e.dec, ...altAzNow(e.ra, e.dec, date) }; }

/* ================= Réception (tampon commun) ================= */
class Rx {
  constructor() { this.buf = ''; this.w = null; }
  push(s) { this.buf += s; if (this.w) { const w = this.w; this.w = null; w(); } }
  flush() { this.buf = ''; }
  take(o) {
    if (o.any) { if (!this.buf) return null; const s = this.buf; this.buf = ''; return s; }
    if (o.n) { if (this.buf.length < o.n) return null; const s = this.buf.slice(0, o.n); this.buf = this.buf.slice(o.n); return s; }
    if (o.term) { const i = this.buf.indexOf(o.term); if (i < 0) return null; const s = this.buf.slice(0, i + o.term.length); this.buf = this.buf.slice(i + o.term.length); return s; }
    return '';
  }
  async read(o) {
    const end = Date.now() + (o.timeout || 1500);
    for (;;) {
      const s = this.take(o); if (s !== null) return s;
      const left = end - Date.now();
      if (left <= 0) { if (o.any) return ''; const e = new Error('pas de réponse de la monture (délai dépassé)'); e.timeout = true; e.partial = this.buf; throw e; }
      await new Promise(r => { this.w = r; setTimeout(r, Math.min(left, 250)); });
    }
  }
}
const toBytes = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
const fromBytes = u => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return s; };

/* ================= Liaisons ================= */
const SPP = '00001101-0000-1000-8000-00805f9b34fb';
class SerialT { // Web Serial : USB ou Bluetooth classique (SPP)
  constructor(o) { this.o = o; this.rx = new Rx(); this.label = o.bt ? 'Bluetooth série' : 'USB / série'; }
  async open() {
    const req = this.o.bt ? { allowedBluetoothServiceClassIds: [SPP], filters: [{ bluetoothServiceClassId: SPP }] } : {};
    this.port = await navigator.serial.requestPort(req); // appelé dans le geste utilisateur (avant tout await)
    await this.port.open({ baudRate: this.o.baud || 9600, dataBits: 8, stopBits: 1, parity: 'none' });
    this.writer = this.port.writable.getWriter(); this.alive = true; this.loop();
  }
  async loop() {
    while (this.alive && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try { for (;;) { const { value, done } = await this.reader.read(); if (done) break; if (value) this.rx.push(fromBytes(value)); } }
      catch (e) { if (this.alive) { this.alive = false; TEL.lost('liaison série interrompue'); } }
      finally { try { this.reader.releaseLock(); } catch (e) {} }
    }
  }
  write(s) { return this.writer.write(toBytes(s)); }
  read(o) { return this.rx.read(o); }
  flush() { this.rx.flush(); }
  async close() { this.alive = false; try { await this.reader.cancel(); } catch (e) {} try { this.writer.releaseLock(); } catch (e) {} try { await this.port.close(); } catch (e) {} }
}
const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e', NUS_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e', NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const HM10 = '0000ffe0-0000-1000-8000-00805f9b34fb', HM10_C = '0000ffe1-0000-1000-8000-00805f9b34fb';
class BleT { // Web Bluetooth : adaptateur série BLE (Nordic UART ou HM-10 / « FFE0 »)
  constructor(o) { this.o = o; this.rx = new Rx(); this.label = 'Bluetooth BLE'; }
  async open() {
    this.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NUS, HM10] });
    this.dev.addEventListener('gattserverdisconnected', () => { if (this.alive) { this.alive = false; TEL.lost('Bluetooth déconnecté'); } });
    const g = await this.dev.gatt.connect(); let s;
    try { s = await g.getPrimaryService(NUS); this.txc = await s.getCharacteristic(NUS_TX); this.rxc = await s.getCharacteristic(NUS_RX); }
    catch (e) { s = await g.getPrimaryService(HM10); this.txc = this.rxc = await s.getCharacteristic(HM10_C); }
    this.rxc.addEventListener('characteristicvaluechanged', ev => this.rx.push(fromBytes(new Uint8Array(ev.target.value.buffer))));
    await this.rxc.startNotifications(); this.alive = true;
  }
  async write(s) {
    const b = toBytes(s);
    for (let i = 0; i < b.length; i += 20) { const part = b.slice(i, i + 20); if (this.txc.writeValueWithoutResponse && this.txc.properties.writeWithoutResponse) await this.txc.writeValueWithoutResponse(part); else await this.txc.writeValue(part); }
  }
  read(o) { return this.rx.read(o); }
  flush() { this.rx.flush(); }
  async close() { this.alive = false; try { this.dev.gatt.disconnect(); } catch (e) {} }
}
function bridgeFetch(base, path, body) {
  const url = base.replace(/\/$/, '') + path, o = { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' };
  try { const u = new URL(url, location.href); if (u.origin !== location.origin && location.protocol === 'https:') o.targetAddressSpace = /^(localhost|127\.|\[::1\])/.test(u.hostname) ? 'loopback' : 'local'; } catch (e) {}
  return fetch(url, o).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || 'passerelle : erreur HTTP ' + r.status); return j; },
    e => { throw new Error('passerelle injoignable (' + url.replace(/\/api.*$/, '') + ') — vérifiez qu\'elle tourne, l\'adresse IP et le même Wi-Fi' + (location.protocol === 'https:' && !/localhost|127\./.test(url) ? ' ; sur iPhone, ouvrez plutôt l\'app servie par la passerelle' : '')); });
}
class BridgeT { // passerelle PC : port série du PC, TCP (OnStep Wi-Fi, ser2net, INDI) ou simulateur
  constructor(o) { this.o = o; this.label = 'passerelle'; }
  async open() {
    const r = await bridgeFetch(this.o.url, '/api/open', this.o.chan); this.id = r.id; this.info = r.info || '';
    this.label = 'passerelle · ' + (this.o.chan.kind === 'serial' ? 'série ' + this.o.chan.port : this.o.chan.kind === 'tcp' ? 'TCP ' + this.o.chan.host + ':' + this.o.chan.port : 'simulateur');
  }
  write(s) { return bridgeFetch(this.o.url, '/api/write', { id: this.id, data: s }); }
  async read(o) {
    const r = await bridgeFetch(this.o.url, '/api/read', { id: this.id, n: o.n || 0, term: o.term || '', any: !!o.any, timeout: o.timeout || 1500 });
    if (r.timeout && !o.any) { const e = new Error('pas de réponse de la monture (délai dépassé)'); e.timeout = true; e.partial = r.data; throw e; }
    return r.data || '';
  }
  flush() { return bridgeFetch(this.o.url, '/api/flush', { id: this.id }); }
  close() { return bridgeFetch(this.o.url, '/api/close', { id: this.id }).catch(() => {}); }
}

/* ================= Monture simulée (dans le navigateur) ================= */
class FakeMount {
  constructor(proto) {
    this.proto = proto; this.buf = ''; this.long = true;
    const d = new Date(), lst = A.SiderealTime(A.MakeTime(d)) + observer().longitude / 15;
    this.ra = norm360((lst - 1) * 15) / 15; this.dec = 30; // pointage réel (heures, degrés, équinoxe de la date)
    this.off = { ra: 0.4 / 15, dec: -0.3 }; // erreur de pointage de la monture (corrigée par Sync)
    this.tgt = null; this.slewing = false; this.tracking = true; this.parked = false; this.mv = { ns: 0, ew: 0 }; this.rate = 2;
    this.speed = 8; this.t = performance.now(); this.log = []; this.aligned = true;
  }
  step() {
    const now = performance.now(), dt = Math.min(2, (now - this.t) / 1000); this.t = now;
    if (!this.tracking && !this.parked) this.ra = (this.ra + dt * 1.00273790935 / 3600 + 24) % 24;
    if (this.slewing && this.tgt) {
      const s = this.speed * dt, dra = ((this.tgt.ra - this.ra) * 15 + 540) % 360 - 180, ddec = this.tgt.dec - this.dec;
      this.ra = (this.ra + clamp(dra, -s, s) / 15 + 24) % 24; this.dec += clamp(ddec, -s, s);
      if (Math.abs(dra) <= s && Math.abs(ddec) <= s) { this.slewing = false; if (this.parkGoal) { this.parked = true; this.tracking = false; this.parkGoal = false; } }
    }
    const r = [0.002, 0.1, 0.8, 3][this.rate] * dt;
    if (this.mv.ns) this.dec = clamp(this.dec + this.mv.ns * r, -90, 90);
    if (this.mv.ew) this.ra = (this.ra + this.mv.ew * r / 15 + 24) % 24;
  }
  rep() { this.step(); return { ra: (this.ra + this.off.ra + 24) % 24, dec: this.dec + this.off.dec }; }
  startGoto(ra, dec) { this.tgt = { ra: (ra - this.off.ra + 24) % 24, dec: dec - this.off.dec }; this.slewing = true; }
  altOf(ra, dec) { return altAzNow(ra, dec, new Date()).alt; }
  feed(s, out) {
    this.buf += s; this.step();
    if (this.proto === 'lx200') {
      for (;;) {
        const i = this.buf.indexOf('#'); if (i < 0) break;
        let c = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); const k = c.indexOf(':'); if (k < 0) continue; c = c.slice(k + 1);
        this.log.push(c); out(this.lx(c));
      }
    } else {
      const L = { K: 2, r: 18, s: 18, R: 10, S: 10, P: 8, T: 2, B: 10, b: 18 };
      while (this.buf.length) { const n = L[this.buf[0]] || 1; if (this.buf.length < n) break; const c = this.buf.slice(0, n); this.buf = this.buf.slice(n); this.log.push(ENC.esc(c)); out(this.nx(c)); }
    }
  }
  lx(c) {
    const p = this.rep();
    if (c === 'GVP') return 'Celeste Sim LX200#';
    if (c === 'GVN') return '1.0#';
    if (c === 'GR') return (this.long ? ENC.lxRA(p.ra) : ENC.lxRA(p.ra).slice(0, 5) + '.' + Math.floor((Math.round(p.ra * 3600) % 60) / 6)) + '#';
    if (c === 'GD') return (this.long ? ENC.lxDec(p.dec) : ENC.lxDec(p.dec).slice(0, 6)) + '#';
    if (c === 'U') { this.long = !this.long; return ''; }
    if (c.startsWith('Sr')) { const v = ENC.lxParseRA(c.slice(2)); if (!isFinite(v)) return '0'; this.sr = v; return '1'; }
    if (c.startsWith('Sd')) { const v = ENC.lxParseDec(c.slice(2)); if (!isFinite(v)) return '0'; this.sd = v; return '1'; }
    if (c === 'MS') { if (this.parked) return '6Parked#'; if (this.altOf(this.sr, this.sd) < 0) return '1Below horizon#'; this.startGoto(this.sr, this.sd); return '0'; }
    if (c === 'CM') { this.off = { ra: this.sr - this.ra, dec: this.sd - this.dec }; return 'N/A#'; }
    if (c === 'Q') { this.slewing = false; this.mv = { ns: 0, ew: 0 }; return ''; }
    if (/^Q[nsew]$/.test(c)) { if ('ns'.includes(c[1])) this.mv.ns = 0; else this.mv.ew = 0; return ''; }
    if (/^M[nsew]$/.test(c)) { if (this.parked) return ''; const d = { n: ['ns', 1], s: ['ns', -1], e: ['ew', 1], w: ['ew', -1] }[c[1]]; this.mv[d[0]] = d[1]; return ''; }
    if (/^R[GCMS]$/.test(c)) { this.rate = 'GCMS'.indexOf(c[1]); return ''; }
    if (c === 'Te') { if (this.parked) return '0'; this.tracking = true; return '1'; }
    if (c === 'Td') { this.tracking = false; return '1'; }
    if (c === 'TQ') return '';
    if (c === 'D') return this.slewing ? '\x7f#' : '#';
    if (c === 'GU') return (this.tracking ? '' : 'n') + (this.slewing ? '' : 'N') + (this.parked ? 'P' : 'p') + '#';
    if (c === 'hP') { const lst = A.SiderealTime(A.MakeTime(new Date())) + observer().longitude / 15; this.tgt = { ra: (lst + 24) % 24, dec: 90 }; this.slewing = true; this.parkGoal = true; return ''; }
    if (c === 'hR') { this.parked = false; this.tracking = true; return '1'; }
    return '';
  }
  nx(c) {
    const p = this.rep(), ch = c[0];
    if (ch === 'K') return c[1] + '#';
    if (ch === 'V') return '\x04\x29#';
    if (ch === 'm') return '\x0b#';
    if (ch === 'J') return (this.aligned ? '\x01' : '\x00') + '#';
    if (ch === 'e') return ENC.nxEnc(p.ra * 15) + ',' + ENC.nxEnc(p.dec) + '#';
    if (ch === 'E') return ENC.nxEnc16(p.ra * 15) + ',' + ENC.nxEnc16(p.dec) + '#';
    if (ch === 'r' || ch === 's') { const q = ENC.nxParse(c.slice(1)); if (!q) return '#'; if (ch === 'r') { if (this.altOf(q.ra, q.dec) >= 0) this.startGoto(q.ra, q.dec); } else this.off = { ra: q.ra - this.ra, dec: q.dec - this.dec }; return '#'; }
    if (ch === 'L') return (this.slewing ? '1' : '0') + '#';
    if (ch === 'M') { this.slewing = false; return '#'; }
    if (ch === 't') return String.fromCharCode(this.tracking ? 2 : 0) + '#';
    if (ch === 'T') { this.tracking = c.charCodeAt(1) > 0; return '#'; }
    if (ch === 'P') { const ax = c.charCodeAt(2) === 16 ? 'ew' : 'ns', dir = c.charCodeAt(3) === 36 ? 1 : -1, rate = c.charCodeAt(4); this.mv[ax] = rate ? dir : 0; if (rate) this.rate = rate >= 9 ? 3 : rate >= 7 ? 2 : rate >= 4 ? 1 : 0; return '#'; }
    return '#';
  }
}
class SimT {
  constructor(o) { this.o = o; this.rx = new Rx(); this.label = 'simulateur (' + (o.proto === 'nexstar' ? 'NexStar' : 'LX200') + ')'; }
  async open() { this.m = new FakeMount(this.o.proto); TEL.sim = this.m; if (this.o.speed) this.m.speed = this.o.speed; }
  async write(s) { await sleep(3); this.m.feed(s, r => { if (r) setTimeout(() => this.rx.push(r), 4); }); }
  read(o) { return this.rx.read(o); }
  flush() { this.rx.flush(); }
  async close() {}
}

/* ================= Pilotes ================= */
const RATES = [{ n: 'Guidage', d: 0.002 }, { n: 'Centrage', d: 0.1 }, { n: 'Recherche', d: 0.8 }, { n: 'Rapide', d: 3 }];
class LX200 {
  constructor(t, o) { this.t = t; this.o = o; this.caps = { sync: true, tracking: true, park: true, frame: o.epoch || 'jnow' }; this.name = 'LX200'; }
  async cmd(s, o) { await this.t.flush(); await this.t.write(s); return o ? this.t.read(o) : ''; }
  async connect() {
    let id = '';
    try { id = (await this.cmd(':GVP#', { term: '#', timeout: 2000 })).replace('#', ''); } catch (e) { /* certaines montures n'ont pas :GVP# */ }
    this.onstep = /on-?step/i.test(id) || !!this.o.onstep; this.name = (id || 'Monture LX200') + (this.onstep ? ' (OnStep)' : '');
    let r = await this.cmd(':GR#', { term: '#', timeout: 2500 });
    if (/\d+:\d+\.\d#/.test(r)) { await this.cmd(':U#'); r = await this.cmd(':GR#', { term: '#' }); } // passage au format long
    if (!isFinite(ENC.lxParseRA(r))) throw new Error('réponse inattendue à :GR# (' + ENC.esc(r) + ')');
    return this.name;
  }
  async setTarget(ra, dec) {
    const a = await this.cmd(':Sr' + ENC.lxRA(ra) + '#', { n: 1 }), b = await this.cmd(':Sd' + ENC.lxDec(dec) + '#', { n: 1 });
    if (a !== '1' || b !== '1') throw new Error('coordonnées refusées par la monture (' + ENC.esc(a + b) + ')');
  }
  async goto(c) {
    const [ra, dec] = c[this.caps.frame]; await this.setTarget(ra, dec);
    const r = await this.cmd(':MS#', { n: 1, timeout: 3000 });
    if (r !== '0') { let msg = ''; try { msg = await this.t.read({ term: '#', timeout: 800 }); } catch (e) {} throw new Error({ 1: 'objet sous l\'horizon (selon la monture)', 2: 'objet sous la limite haute', 4: 'objet au-dessus de la limite basse', 6: 'monture parquée' }[r] || 'GoTo refusé (' + ENC.esc(r + msg) + ')'); }
  }
  async sync(c) { const [ra, dec] = c[this.caps.frame]; await this.setTarget(ra, dec); await this.cmd(':CM#', { term: '#', timeout: 2500 }); }
  stopBytes() { return ':Q#'; }
  async abort() { await this.cmd(':Q#'); }
  async move(dir, on, rate) { if (on) { await this.cmd(':R' + 'GCMS'[rate] + '#'); await this.cmd(':M' + dir + '#'); } else await this.cmd(':Q' + dir + '#'); }
  async setTracking(on) {
    if (this.onstep || this.o.sim || this.caps.trackCmd) { const r = await this.cmd(on ? ':Te#' : ':Td#', { n: 1 }); if (r !== '1') throw new Error('suivi refusé par la monture'); return; }
    if (on) await this.cmd(':TQ#'); else throw new Error('arrêt du suivi non disponible sur ce protocole LX200 (utilisez la raquette)');
  }
  async park() { await this.cmd(':hP#'); }
  async unpark() { if (!this.onstep && !this.o.sim) throw new Error('dé-parquer depuis la raquette'); await this.cmd(':hR#', { n: 1 }); }
  async poll() {
    const ra = ENC.lxParseRA(await this.cmd(':GR#', { term: '#' })), dec = ENC.lxParseDec(await this.cmd(':GD#', { term: '#' }));
    const p = { ra, dec, frame: this.caps.frame, slewing: null, tracking: null, parked: null };
    try { p.slewing = (await this.cmd(':D#', { term: '#', timeout: 600 })).length > 1; } catch (e) {}
    if (this.onstep || this.o.sim) { try { const g = await this.cmd(':GU#', { term: '#', timeout: 600 }); p.tracking = !g.includes('n'); p.parked = g.includes('P'); this.caps.trackCmd = true; } catch (e) {} }
    return p;
  }
}
class NexStar {
  constructor(t, o) { this.t = t; this.o = o; this.caps = { sync: true, tracking: true, park: false, frame: o.epoch || 'jnow' }; this.name = 'NexStar'; }
  async cmd(s, o) { await this.t.flush(); await this.t.write(s); return o ? this.t.read(o) : ''; }
  async connect() {
    const e = await this.cmd('Kx', { term: '#', timeout: 3500 }); if (e !== 'x#') throw new Error('écho incorrect (' + ENC.esc(e) + ') — vérifiez le protocole et la vitesse 9600 bauds');
    try { const v = await this.cmd('V', { n: 3 }); this.ver = v.charCodeAt(0) + '.' + v.charCodeAt(1); } catch (er) { this.ver = '?'; }
    let al = true; try { al = (await this.cmd('J', { n: 2 })).charCodeAt(0) === 1; } catch (er) {}
    this.aligned = al; this.name = (this.o.brand || 'Raquette NexStar') + ' v' + this.ver;
    if (+this.ver.split('.')[0] < 4 && this.ver !== '?') this.caps.sync = false;
    return this.name + (al ? '' : ' — NON alignée : faites l\'alignement sur la raquette d\'abord');
  }
  async goto(c) { if (this.aligned === false) throw new Error('monture non alignée (raquette)'); const [ra, dec] = c[this.caps.frame]; const r = await this.cmd(ENC.nxGoto(ra, dec), { term: '#', timeout: 3500 }); if (r !== '#') throw new Error('GoTo refusé'); }
  async sync(c) { if (!this.caps.sync) throw new Error('Sync non disponible (raquette < v4.10)'); const [ra, dec] = c[this.caps.frame]; await this.cmd(ENC.nxSync(ra, dec), { term: '#', timeout: 3500 }); }
  async abort() { await this.cmd('M', { term: '#' }); await this.cmd(ENC.nxSlew('ra', 1, 0), { term: '#' }); await this.cmd(ENC.nxSlew('dec', 1, 0), { term: '#' }); }
  async move(dir, on, rate) { const ax = 'ns'.includes(dir) ? 'dec' : 'ra', sg = 'ne'.includes(dir) ? 1 : -1; await this.cmd(ENC.nxSlew(ax, sg, on ? [2, 5, 7, 9][rate] : 0), { term: '#' }); }
  async setTracking(on) { const mode = !on ? 0 : this.o.geom === 'altaz' ? 1 : observer().latitude >= 0 ? 2 : 3; await this.cmd('T' + String.fromCharCode(mode), { term: '#' }); this.lastTrack = on; }
  async poll() {
    const p = ENC.nxParse(await this.cmd('e', { term: '#' })); if (!p) throw new Error('position illisible');
    let sl = null, tr = this.lastTrack ?? null; try { sl = (await this.cmd('L', { term: '#', timeout: 800 }))[0] === '1'; } catch (e) {}
    try { const t = await this.cmd('t', { n: 2, timeout: 800 }); tr = t.charCodeAt(0) > 0; } catch (e) {}
    return { ra: p.ra, dec: p.dec, frame: this.caps.frame, slewing: sl, tracking: tr, parked: null };
  }
}
class Alpaca {
  constructor(o) { this.o = o; this.caps = { sync: true, tracking: true, park: true, frame: 'jnow' }; this.tx = 1; this.name = 'Alpaca'; }
  async req(method, prop, params) {
    const path = '/api/v1/telescope/' + (this.o.dev | 0) + '/' + prop, form = { ClientID: 4242, ClientTransactionID: this.tx++, ...(params || {}) };
    let j;
    if (this.o.bridge) j = await bridgeFetch(this.o.bridge, '/api/alpaca', { base: this.o.base, method, path, params: form });
    else {
      const qs = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString(), base = this.o.base.replace(/\/$/, '');
      const opt = method === 'GET' ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs };
      if (location.protocol === 'https:') opt.targetAddressSpace = /\/\/(localhost|127\.)/.test(base) ? 'loopback' : 'local';
      let r; try { r = await fetch(base + path + (method === 'GET' ? '?' + qs : ''), opt); } catch (e) { throw new Error('serveur Alpaca injoignable directement (contenu mixte HTTPS→HTTP ou CORS) — utilisez la passerelle'); }
      j = await r.json();
    }
    if (j.ErrorNumber) throw new Error('Alpaca : ' + (j.ErrorMessage || 'erreur ' + j.ErrorNumber));
    return j.Value;
  }
  async connect() {
    await this.req('PUT', 'connected', { Connected: true });
    this.name = await this.req('GET', 'name').catch(() => 'Monture Alpaca');
    const g = async (p, d) => { try { return await this.req('GET', p); } catch (e) { return d; } };
    this.caps.sync = await g('cansync', false); this.caps.park = await g('canpark', false); this.caps.unpark = await g('canunpark', false);
    this.caps.tracking = await g('cansettracking', false); this.caps.async = await g('canslewasync', true);
    const es = await g('equatorialsystem', 1); this.caps.frame = es === 2 ? 'j2000' : 'jnow';
    this.maxRate = 3; try { const r = await this.req('GET', 'axisrates', { Axis: 0 }); if (r && r.length) this.maxRate = Math.max(...r.map(x => x.Maximum)); } catch (e) {}
    return this.name + ' (coordonnées ' + (this.caps.frame === 'j2000' ? 'J2000' : 'de la date') + ')';
  }
  async goto(c) { const [ra, dec] = c[this.caps.frame]; await this.req('PUT', this.caps.async === false ? 'slewtocoordinates' : 'slewtocoordinatesasync', { RightAscension: ra, Declination: dec }); }
  async sync(c) { const [ra, dec] = c[this.caps.frame]; await this.req('PUT', 'synctocoordinates', { RightAscension: ra, Declination: dec }); }
  async abort() { await this.req('PUT', 'abortslew').catch(() => {}); for (const ax of [0, 1]) await this.req('PUT', 'moveaxis', { Axis: ax, Rate: 0 }).catch(() => {}); }
  async move(dir, on, rate) { const ax = 'ns'.includes(dir) ? 1 : 0, sg = 'ne'.includes(dir) ? 1 : -1; await this.req('PUT', 'moveaxis', { Axis: ax, Rate: on ? sg * Math.min(RATES[rate].d, this.maxRate) : 0 }); }
  async setTracking(on) { await this.req('PUT', 'tracking', { Tracking: on }); }
  async park() { await this.req('PUT', 'park'); }
  async unpark() { await this.req('PUT', 'unpark'); }
  async poll() {
    const ra = await this.req('GET', 'rightascension'), dec = await this.req('GET', 'declination');
    const g = async p => { try { return await this.req('GET', p); } catch (e) { return null; } };
    return { ra, dec, frame: this.caps.frame, slewing: await g('slewing'), tracking: await g('tracking'), parked: await g('atpark') };
  }
}
class Indi { // client INDI minimal (XML) sur flux TCP de la passerelle
  constructor(t, o) { this.t = t; this.o = o; this.caps = { sync: true, tracking: true, park: true, frame: 'jnow' }; this.buf = ''; this.props = {}; this.name = 'INDI'; }
  async pump(timeout = 60) {
    const s = await this.t.read({ any: true, timeout }); if (!s) return; this.buf += s;
    const re = /<(def|set|new)(Number|Switch|Text|Light|BLOB)Vector\b[\s\S]*?<\/\1\2Vector>|<message\b[^>]*\/>|<delProperty\b[^>]*\/>/g; let m, last = 0;
    while ((m = re.exec(this.buf))) { last = re.lastIndex; this.take(m[0]); }
    this.buf = this.buf.slice(last); if (this.buf.length > 200000) this.buf = '';
  }
  take(x) {
    const d = new DOMParser().parseFromString(x, 'text/xml').documentElement; if (!d || d.nodeName === 'parsererror') return;
    const dev = d.getAttribute('device'), name = d.getAttribute('name');
    if (d.nodeName === 'message') { const msg = d.getAttribute('message'); if (msg) TEL.log('INDI : ' + msg); return; }
    if (d.nodeName === 'delProperty') { if (this.props[dev]) { if (name) delete this.props[dev][name]; else delete this.props[dev]; } return; }
    const P = (this.props[dev] = this.props[dev] || {}), p = (P[name] = P[name] || { el: {} });
    if (d.getAttribute('state')) p.state = d.getAttribute('state');
    for (const e of d.children) { const v = e.textContent.trim(); p.el[e.getAttribute('name')] = /Number/.test(d.nodeName) ? parseFloat(v) : v; }
  }
  send(x) { return this.t.write(x + '\n'); }
  sw(prop, on, off = []) { return this.send(`<newSwitchVector device="${ENC.xml(this.dev)}" name="${prop}">` + [...on.map(n => `<oneSwitch name="${n}">On</oneSwitch>`), ...off.map(n => `<oneSwitch name="${n}">Off</oneSwitch>`)].join('') + '</newSwitchVector>'); }
  async connect() {
    await this.send('<getProperties version="1.7"/>');
    const t0 = Date.now(); let tried = false;
    while (Date.now() - t0 < 8000) {
      await this.pump(300);
      // monture = appareil qui expose EQUATORIAL_EOD_COORD ; sinon DRIVER_INTERFACE (bit 1 = télescope) ; sinon nom évocateur
      const all = Object.keys(this.props), di = d => { const p = this.props[d].DRIVER_INFO; return p && isFinite(+p.el.DRIVER_INTERFACE) ? +p.el.DRIVER_INTERFACE : null; };
      let devs = all.filter(d => this.props[d].EQUATORIAL_EOD_COORD);
      if (!devs.length) devs = all.filter(d => di(d) != null && (di(d) & 1));
      if (!devs.length && Date.now() - t0 > 1500) devs = all.filter(d => di(d) == null && this.props[d].CONNECTION && /telescop|mount|monture|lx200|celestron|sky-?watcher|synscan|eqmod|ioptron|onstep|gemini|10micron|simulator/i.test(d));
      if (devs.length) {
        this.dev = devs[0]; const P = this.props[this.dev];
        if (P.CONNECTION && P.CONNECTION.el.CONNECT !== 'On' && !tried) { tried = true; await this.sw('CONNECTION', ['CONNECT'], ['DISCONNECT']); continue; }
        if (P.EQUATORIAL_EOD_COORD) { this.name = this.dev; this.caps.park = !!P.TELESCOPE_PARK; this.caps.tracking = !!P.TELESCOPE_TRACK_STATE; return this.dev + ' (INDI)'; }
      }
    }
    throw new Error('aucune monture INDI trouvée (vérifiez indiserver et le pilote de la monture)');
  }
  async coord(mode, ra, dec) {
    const P = this.props[this.dev], ocs = P.ON_COORD_SET && Object.keys(P.ON_COORD_SET.el);
    if (ocs) await this.sw('ON_COORD_SET', [mode], ocs.filter(n => n !== mode));
    await this.send(`<newNumberVector device="${ENC.xml(this.dev)}" name="EQUATORIAL_EOD_COORD"><oneNumber name="RA">${ra.toFixed(6)}</oneNumber><oneNumber name="DEC">${dec.toFixed(6)}</oneNumber></newNumberVector>`);
    await this.pump(200);
  }
  async goto(c) { const [ra, dec] = c.jnow; if (this.parked()) throw new Error('monture parquée'); await this.coord('TRACK', ra, dec); }
  async sync(c) { const [ra, dec] = c.jnow; await this.coord('SYNC', ra, dec); await this.sw('ON_COORD_SET', ['TRACK'], ['SYNC', 'SLEW']); }
  async abort() { await this.sw('TELESCOPE_ABORT_MOTION', ['ABORT']); for (const [p, a, b] of [['TELESCOPE_MOTION_NS', 'MOTION_NORTH', 'MOTION_SOUTH'], ['TELESCOPE_MOTION_WE', 'MOTION_WEST', 'MOTION_EAST']]) await this.sw(p, [], [a, b]); }
  async move(dir, on, rate) {
    const P = this.props[this.dev], sr = P.TELESCOPE_SLEW_RATE && Object.keys(P.TELESCOPE_SLEW_RATE.el);
    if (on && sr && sr.length) { const k = sr[Math.round(rate / 3 * (sr.length - 1))]; await this.sw('TELESCOPE_SLEW_RATE', [k], sr.filter(n => n !== k)); }
    const [prop, el] = { n: ['TELESCOPE_MOTION_NS', 'MOTION_NORTH'], s: ['TELESCOPE_MOTION_NS', 'MOTION_SOUTH'], e: ['TELESCOPE_MOTION_WE', 'MOTION_EAST'], w: ['TELESCOPE_MOTION_WE', 'MOTION_WEST'] }[dir];
    if (on) await this.sw(prop, [el]); else await this.sw(prop, [], [el]);
  }
  async setTracking(on) { await this.sw('TELESCOPE_TRACK_STATE', [on ? 'TRACK_ON' : 'TRACK_OFF'], [on ? 'TRACK_OFF' : 'TRACK_ON']); }
  async park() { await this.sw('TELESCOPE_PARK', ['PARK'], ['UNPARK']); }
  async unpark() { await this.sw('TELESCOPE_PARK', ['UNPARK'], ['PARK']); }
  parked() { const p = this.props[this.dev] && this.props[this.dev].TELESCOPE_PARK; return p ? p.el.PARK === 'On' : null; }
  async poll() {
    await this.pump(150); const P = this.props[this.dev] || {}, e = P.EQUATORIAL_EOD_COORD; if (!e) throw new Error('position INDI indisponible');
    return { ra: e.el.RA, dec: e.el.DEC, frame: 'jnow', slewing: e.state === 'Busy', tracking: P.TELESCOPE_TRACK_STATE ? P.TELESCOPE_TRACK_STATE.el.TRACK_ON === 'On' : null, parked: this.parked() };
  }
}

/* ================= Montures et liaisons proposées ================= */
const LINKS = {
  serial: { n: 'Câble USB / série (Web Serial)', ok: () => 'serial' in navigator, why: 'Web Serial : Chrome/Edge sur ordinateur, Chrome Android 148+ ; jamais sur iPhone' },
  btserial: { n: 'Bluetooth classique « série » (Web Serial)', ok: () => 'serial' in navigator, why: 'Web Serial Bluetooth : Chrome ordinateur, Chrome Android 138+ ; jamais sur iPhone' },
  ble: { n: 'Bluetooth BLE (adaptateur série BLE)', ok: () => 'bluetooth' in navigator, why: 'Web Bluetooth : Chrome/Edge ordinateur et Android ; pas Safari iPhone' },
  bserial: { n: 'Passerelle PC (Wi-Fi) → port série/USB du PC', ok: () => true },
  btcp: { n: 'Passerelle PC (Wi-Fi) → TCP réseau', ok: () => true },
  balpaca: { n: 'Passerelle PC (Wi-Fi) → serveur Alpaca', ok: () => true },
  alpaca: { n: 'Alpaca direct (sans passerelle)', ok: () => true },
  bsim: { n: 'Passerelle PC → monture simulée', ok: () => true },
  sim: { n: 'Simulateur intégré (sans matériel)', ok: () => true }
};
const SER = ['serial', 'btserial', 'ble', 'bserial'];
const BRIDGE = ['bserial', 'btcp', 'balpaca', 'bsim'];
const MOUNTS = {
  nexstar: { n: 'Celestron NexStar, SE, SLT, CPC, AVX, CGX… (raquette NexStar+)', proto: 'nexstar', brand: 'Raquette Celestron', links: SER, note: 'Câble USB sur la raquette NexStar+ (ou RS-232 + adaptateur USB), 9600 bauds. Faites l\'alignement sur la raquette avant.' },
  synscan: { n: 'Sky-Watcher SynScan (raquette, câble USB/série)', proto: 'nexstar', brand: 'Raquette SynScan', links: SER, note: 'La raquette SynScan parle le protocole NexStar : câble USB/RJ-45 de la raquette, 9600 bauds, alignement fait sur la raquette.' },
  meade: { n: 'Meade LX200, LX90, LX600, ETX (AutoStar / AudioStar)', proto: 'lx200', links: SER, note: 'Câble série de la raquette (#505/#506 ou USB), 9600 bauds.' },
  onstep: { n: 'OnStep / OnStepX (USB, Bluetooth, Wi-Fi)', proto: 'lx200', onstep: true, links: [...SER, 'btcp'], tcpPort: 9999, note: 'USB ou Bluetooth série direct ; en Wi-Fi via la passerelle (TCP, port 9999).' },
  lx200: { n: 'Autre monture compatible LX200 (10Micron, Losmandy Gemini, Avalon…)', proto: 'lx200', links: [...SER, 'btcp'], tcpPort: 3490, note: 'Compatibilité LX200 annoncée par le fabricant, non vérifiée ici.' },
  alpaca: { n: 'ASCOM Alpaca (iOptron, Celestron CPWI, SynScan App, ASCOM Remote…)', proto: 'alpaca', links: ['balpaca', 'alpaca'], note: 'Toute monture pilotée par un serveur Alpaca : pilote ASCOM + ASCOM Remote sous Windows, monture Alpaca native, Alpaca Server de INDIGO, etc.' },
  indi: { n: 'INDI (KStars/Ekos, StellarMate, Astroberry) — expérimental', proto: 'indi', links: ['btcp'], tcpPort: 7624, note: 'La passerelle se connecte à indiserver (port 7624) ; la monture doit y être chargée.' },
  celwifi: { n: 'Celestron Wi-Fi (SkyPortal, Evolution, Origin)', proto: null, links: [], note: 'Protocole Wi-Fi propriétaire (AUX) non documenté : non pris en charge. Solution : CPWI + ASCOM Remote sur PC → choisir « ASCOM Alpaca ».' },
  swwifi: { n: 'Sky-Watcher Wi-Fi (AZ-GTi, Star Adventurer GTi, adaptateur SynScan Wi-Fi)', proto: null, links: [], note: 'Protocole UDP inaccessible depuis un navigateur et sans raquette : non pris en charge directement. Solution : SynScan App + pilote ASCOM + ASCOM Remote sur PC → « ASCOM Alpaca ».' },
  sim: { n: 'Simulateur (aucun matériel)', proto: 'sim', links: ['sim', 'bsim'], note: 'Monture fictive pour essayer sans télescope : GoTo, Sync, suivi, flèches, STOP.' }
};

/* ================= État et interface ================= */
const $ = id => document.getElementById(id);
const TEL = window.CELESTE_TEL = { ENC, FakeMount, j2000ToNow, nowToJ2000, MOUNTS, LINKS, sim: null, drv: null, pos: null, logLines: [] };
const DEF = { mount: 'sim', link: 'sim', baud: 9600, bridge: '', chanSerial: '', tcpHost: '192.168.4.1', tcpPort: '', alpacaBase: 'http://192.168.1.20:11111', dev: 0, geom: 'altaz', epoch: 'jnow', simProto: 'lx200', minAlt: 0, solar: false, rate: 1 };
let CFG = { ...DEF }; try { CFG = { ...DEF, ...JSON.parse(localStorage.getItem('celeste.tel') || '{}') }; } catch (e) {}
const save = () => { try { localStorage.setItem('celeste.tel', JSON.stringify(CFG)); } catch (e) {} };
let tport = null, busy = Promise.resolve(), gen = 0, pollTimer = 0, lastSel = null, wasSlewing = false, moving = null, moveTimer = 0, connecting = false;
const C = () => window.__celeste;
const toast = (m, ms) => C() && C().toast ? C().toast(m, ms) : console.log(m);
TEL.log = m => { const t = new Date(); TEL.logLines.push(pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + ' ' + m); if (TEL.logLines.length > 80) TEL.logLines.shift(); const el = $('telLog'); if (el) el.textContent = TEL.logLines.slice().reverse().join('\n'); };
function run(fn, urgent) { // file d'attente : une seule commande à la fois sur la liaison
  const g = gen, p = busy.then(() => { if (!urgent && g !== gen) throw new Error('annulé (STOP)'); return fn(); });
  busy = p.catch(() => {}); return p;
}
function wrapT(t) { // journal des octets échangés
  const w = t.write.bind(t), r = t.read.bind(t);
  t.write = s => { TEL.log('→ ' + ENC.esc(s).slice(0, 160)); return w(s); };
  t.read = async o => { const s = await r(o); if (s && !o.any) TEL.log('← ' + ENC.esc(s).slice(0, 160)); return s; };
  return t;
}
const bridgeUrl = () => (CFG.bridge || '').trim() || (TEL.servedByBridge ? location.origin : 'http://192.168.1.20:8765');

function targetOf(sel) { // coordonnées J2000 et de la date de l'objet, à l'instant réel (pas l'heure du curseur)
  const c = C(); const info = sel && c && c.telTarget(sel); if (!info) return null;
  const date = new Date();
  if (info.kind === 'sat') return { ...info, err: 'satellite : trop rapide pour un GoTo de monture (non pris en charge)' };
  let raH, dec;
  if (info.key) { const e = A.Equator(info.key, A.MakeTime(date), observer(), false, true); raH = e.ra; dec = e.dec; }
  else { raH = info.ra / 15; dec = info.dec; }
  const now = j2000ToNow(raH, dec, date), aa = altAzNow(now.ra, now.dec, date);
  return { ...info, date, j2000: [raH, dec], jnow: [now.ra, now.dec], alt: aa.alt, az: aa.az };
}
function safety(T, forSync) { // renvoie { stop: message } ou { warn: message } ou {}
  if (!T) return { stop: 'Aucun objet choisi : touchez une étoile, une planète… sur la carte.' };
  if (T.err) return { stop: T.err };
  const sun = sunNow(T.date), sep = sepDeg(T.jnow[0], T.jnow[1], sun.ra, sun.dec);
  if (T.key === 'Sun' && !CFG.solar) return { stop: '☀️ DANGER : pointer le Soleil peut rendre aveugle instantanément et détruire l\'instrument. GoTo refusé (cochez « filtre solaire certifié installé » dans les réglages de sécurité seulement si un filtre pleine ouverture est en place).' };
  if (!forSync && T.alt < CFG.minAlt) return { stop: `${T.name} est sous ${CFG.minAlt > 0 ? 'la hauteur minimale (' + CFG.minAlt + '°)' : 'l\'horizon'} : hauteur ${T.alt.toFixed(1).replace('.', ',')}°. GoTo refusé.` };
  if (sun.alt > -3 && sep < 20 && T.key !== 'Sun') return { warn: `☀️ Le Soleil est à ${sep.toFixed(0)}° de ${T.name} et au-dessus de l'horizon. Ne regardez pas dans l'instrument pendant le déplacement ; bouchez le chercheur. Continuer ?` };
  if (!forSync && T.alt < 10) return { warn: `${T.name} est très bas (${T.alt.toFixed(1).replace('.', ',')}°) : obstacles et turbulence probables. Continuer ?` };
  return {};
}
async function doGoto(sel) {
  if (!TEL.drv) return toast('Télescope non connecté'), false;
  const T = targetOf(sel || lastSel), s = safety(T);
  if (s.stop) { toast(s.stop, 7000); TEL.log('GoTo refusé : ' + s.stop); renderPanel(s.stop); return false; }
  if (s.warn && !confirm(s.warn)) return false;
  if (TEL.pos && TEL.pos.parked) { toast('Monture parquée : dé-parquez-la d\'abord.', 5000); return false; }
  const c = C(); if (c && c.S && !c.S.live) toast('GoTo calculé pour l\'heure réelle (pas l\'heure du curseur).', 3500);
  try {
    await run(() => TEL.drv.goto(T)); TEL.goal = T; wasSlewing = true;
    TEL.log(`GoTo ${T.name} : AD ${ENC.lxRA(T.jnow[0])} Déc ${ENC.lxDec(T.jnow[1])} (date) / J2000 ${ENC.lxRA(T.j2000[0])} ${ENC.lxDec(T.j2000[1])}`);
    toast(`🔭 GoTo vers ${T.name} lancé — gardez la main près de STOP`, 4000); renderPanel(); return true;
  } catch (e) { toast('GoTo : ' + e.message, 6000); TEL.log('GoTo erreur : ' + e.message); renderPanel('GoTo : ' + e.message); return false; }
}
async function doSync() {
  if (!TEL.drv) return false;
  if (!TEL.drv.caps.sync) return toast('Sync non disponible sur cette monture'), false;
  const T = targetOf(lastSel), s = safety(T, true); if (s.stop) { toast(s.stop, 6000); return false; }
  if (!confirm(`Sync : ${T.name} est-il bien centré dans l'oculaire (ou la caméra) ? La monture va recaler ses coordonnées sur cet objet.`)) return false;
  try { await run(() => TEL.drv.sync(T)); TEL.log('Sync sur ' + T.name); toast('✅ Monture synchronisée sur ' + T.name); setTimeout(poll, 200); return true; }
  catch (e) { toast('Sync : ' + e.message, 6000); TEL.log('Sync erreur : ' + e.message); return false; }
}
async function doStop() {
  gen++; stopMove(true);
  if (!TEL.drv) return;
  try { if (tport && TEL.drv.stopBytes) await tport.write(TEL.drv.stopBytes()); } catch (e) {} // envoi immédiat, hors file d'attente
  try { await run(() => TEL.drv.abort(), true); TEL.log('STOP envoyé'); toast('⛔ STOP envoyé à la monture', 2500); } catch (e) { toast('STOP : ' + e.message + ' — coupez l\'alimentation si la monture bouge encore', 8000); }
  TEL.goal = null; setTimeout(poll, 300);
}
function startMove(dir) {
  if (!TEL.drv || moving) return;
  if (TEL.pos && TEL.pos.parked) return toast('Monture parquée');
  const sun = sunNow(new Date()); if (sun.alt > -3 && !TEL.sunWarned) { TEL.sunWarned = true; toast('☀️ Soleil levé : ne déplacez pas l\'instrument vers lui', 5000); }
  moving = dir; run(() => TEL.drv.move(dir, true, CFG.rate)).catch(e => { toast('Déplacement : ' + e.message); moving = null; });
  clearTimeout(moveTimer); moveTimer = setTimeout(() => stopMove(), 20000); // garde-fou : 20 s maximum
}
function stopMove(urgent) {
  clearTimeout(moveTimer); if (!moving) return; const d = moving; moving = null;
  if (TEL.drv) run(() => TEL.drv.move(d, false, CFG.rate), true).catch(() => {});
}
TEL.lost = why => { TEL.log('Liaison perdue : ' + why); toast('🔭 Liaison perdue : ' + why, 6000); disconnect(true); };
async function connect() {
  if (connecting) return; const M = MOUNTS[CFG.mount], L = CFG.link;
  if (!M.proto) return renderPanel(M.note);
  if (!LINKS[L].ok()) return renderPanel(LINKS[L].why);
  const proto = M.proto === 'sim' ? CFG.simProto : M.proto, o = { epoch: CFG.epoch, geom: CFG.geom, brand: M.brand, onstep: !!M.onstep };
  let t = null;
  const isAlpaca = L === 'balpaca' || L === 'alpaca' || proto === 'alpaca';
  try {
    if (isAlpaca) t = null;
    else if (L === 'serial' || L === 'btserial') t = new SerialT({ baud: +CFG.baud || 9600, bt: L === 'btserial' });
    else if (L === 'ble') t = new BleT({});
    else if (L === 'sim') t = new SimT({ proto: proto === 'nexstar' ? 'nexstar' : 'lx200', speed: TEL.simSpeed });
    else if (L === 'bserial') t = new BridgeT({ url: bridgeUrl(), chan: { kind: 'serial', port: CFG.chanSerial, baud: +CFG.baud || 9600 } });
    else if (L === 'btcp') t = new BridgeT({ url: bridgeUrl(), chan: { kind: 'tcp', host: CFG.tcpHost, port: +CFG.tcpPort || M.tcpPort || 9999 } });
    else if (L === 'bsim') t = new BridgeT({ url: bridgeUrl(), chan: { kind: 'sim', proto } });
    connecting = true; renderPanel('Connexion…');
    let drv;
    if (isAlpaca) drv = new Alpaca({ base: L === 'bsim' ? 'sim' : CFG.alpacaBase, dev: CFG.dev, bridge: L === 'alpaca' ? null : bridgeUrl() });
    else {
      const op = t.open(); // Web Serial / Bluetooth : sélecteur ouvert pendant le geste utilisateur
      await op; wrapT(t); tport = t;
      drv = proto === 'nexstar' ? new NexStar(t, o) : proto === 'indi' ? new Indi(t, o) : new LX200(t, { ...o, sim: L === 'sim' || L === 'bsim' });
    }
    const name = await drv.connect(); TEL.drv = drv; TEL.linkLabel = t ? t.label : (L === 'alpaca' ? 'Alpaca direct' : 'passerelle · Alpaca');
    TEL.log('Connecté : ' + name + ' via ' + TEL.linkLabel); toast('🔭 Télescope connecté : ' + name, 3500); TEL.name = name;
    connecting = false; gen++; await poll();
    if (TEL.pos && TEL.pos.parked) toast('⚠️ La monture est parquée : dé-parquez-la avant un GoTo.', 6000);
    clearInterval(pollTimer); pollTimer = setInterval(poll, 1000);
    if (C()) { C().refreshInfo(); C().dirty(); }
  } catch (e) {
    connecting = false; TEL.log('Échec de connexion : ' + e.message);
    const msg = /No port selected|User cancelled|NotFoundError/i.test(e.name + e.message) ? 'aucun appareil choisi' : e.message;
    renderPanel('Échec de connexion : ' + msg); if (t) try { await t.close(); } catch (er) {} tport = null; TEL.drv = null; return;
  }
  renderPanel();
}
async function disconnect(silent) {
  clearInterval(pollTimer); stopMove(true);
  const t = tport, wasParked = TEL.pos && TEL.pos.parked; TEL.drv = null; tport = null; TEL.pos = null; TEL.goal = null; TEL.name = '';
  if (t) try { await t.close(); } catch (e) {}
  if (!silent) { TEL.log('Déconnecté'); if (!wasParked) toast('Télescope déconnecté. Pensez à parquer la monture (raquette) avant de l\'éteindre.', 6000); }
  if (C()) { C().refreshInfo(); C().dirty(); } renderPanel();
}
let polling = false;
async function poll() {
  if (!TEL.drv || polling) return; polling = true;
  try {
    const p = await run(() => TEL.drv.poll()), date = new Date();
    const j = p.frame === 'j2000' ? { ra: p.ra, dec: p.dec } : nowToJ2000(p.ra, p.dec, date), n = p.frame === 'j2000' ? j2000ToNow(p.ra, p.dec, date) : { ra: p.ra, dec: p.dec };
    TEL.pos = { ...p, j2000: [j.ra, j.dec], jnow: [n.ra, n.dec], ...altAzNow(n.ra, n.dec, date), t: Date.now() }; TEL.fails = 0;
    if (wasSlewing && p.slewing === false) { wasSlewing = false; if (TEL.goal) { const e = sepDeg(TEL.pos.j2000[0], TEL.pos.j2000[1], TEL.goal.j2000[0], TEL.goal.j2000[1]); toast(`🔭 Arrivé sur ${TEL.goal.name}` + (e > 0.2 ? ` (écart ${e.toFixed(1).replace('.', ',')}° — centrez puis Sync)` : ''), 4500); TEL.log('GoTo terminé, écart ' + e.toFixed(3) + '°'); } }
    if (p.slewing) wasSlewing = true;
  } catch (e) { if (!/annulé/.test(e.message)) { TEL.fails = (TEL.fails || 0) + 1; TEL.log('Lecture position : ' + e.message); if (TEL.fails >= 5) TEL.lost('la monture ne répond plus'); } }
  polling = false; renderStatus(); if (C()) C().dirty();
}

/* ---------- rendu du panneau ---------- */
const fmtRA = h => { const s = Math.round(norm360(h * 15) / 15 * 3600) % 86400; return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m ${pad(s % 60)}s`; };
const fmtDec = d => { const s = Math.round(Math.abs(d) * 60); return `${d < 0 ? '−' : '+'}${Math.floor(s / 60)}° ${pad(s % 60)}′`; };
const f1 = x => x.toFixed(1).replace('.', ',');
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
function renderStatus() {
  const el = $('telStatus'); if (!el) return;
  $('telFabStop').classList.toggle('hidden', !TEL.drv);
  document.body.classList.toggle('tel-on', !!TEL.drv);
  if (!TEL.drv) { el.innerHTML = connecting ? '⏳ Connexion…' : '<b>Non connecté</b>'; el.className = 'tel-status'; return; }
  const p = TEL.pos; let h = `<b>✅ ${ENC.xml(TEL.name)}</b><div class="fine" style="margin:2px 0 0">via ${ENC.xml(TEL.linkLabel)}</div>`;
  if (p) {
    h += `<div class="tel-pos">AD ${fmtRA(p.jnow[0])} · Déc ${fmtDec(p.jnow[1])} <span class="fine">(date)</span><br>Hauteur ${f1(p.alt)}° · Azimut ${f1(p.az)}° ${CARD[Math.round(p.az / 45) % 8]}</div>`;
    const st = []; st.push(p.slewing ? '<span class="tag warn">En mouvement</span>' : p.slewing === false ? '<span class="tag ok">Immobile</span>' : '');
    if (p.tracking != null) st.push(`<span class="tag ${p.tracking ? 'ok' : ''}">Suivi ${p.tracking ? 'actif' : 'arrêté'}</span>`);
    if (p.parked) st.push('<span class="tag no">Parquée</span>');
    if (p.alt < 0) st.push('<span class="tag no">Sous l\'horizon !</span>');
    h += '<div>' + st.join(' ') + '</div>';
  }
  el.innerHTML = h; el.className = 'tel-status on';
  const tr = $('telTrack'); if (tr && p && p.tracking != null && document.activeElement !== tr) tr.checked = p.tracking;
  const pk = $('telPark'); if (pk) { pk.classList.toggle('hidden', !(p && p.parked)); }
  $('telGoto').disabled = !!(p && p.parked);
}
function renderTarget() {
  const el = $('telTarget'); if (!el) return;
  const T = lastSel && targetOf(lastSel);
  if (!T) { el.innerHTML = '<span class="muted">Touchez un objet sur la carte (ou cherchez-le), puis revenez ici.</span>'; return; }
  const s = safety(T); el.innerHTML = `Cible : <b>${ENC.xml(T.name)}</b>` + (T.err ? '' : ` · hauteur ${f1(T.alt)}° · az. ${f1(T.az)}° ${CARD[Math.round(T.az / 45) % 8]}`) + (s.stop ? `<div class="tel-warn">${ENC.xml(s.stop)}</div>` : s.warn ? `<div class="tel-warn soft">${ENC.xml(s.warn.replace(/ Continuer \?$/, ''))}</div>` : '');
}
function linkOpts() {
  const M = MOUNTS[CFG.mount], L = CFG.link, f = [];
  const inp = (k, lbl, ph, type = 'text') => `<label class="field"><span>${lbl}</span><input data-cfg="${k}" type="${type}" value="${ENC.xml(CFG[k] ?? '')}" placeholder="${ENC.xml(ph)}"></label>`;
  if (M.proto === 'sim') f.push(`<label class="field"><span>Protocole simulé</span><select data-cfg="simProto"><option value="lx200">LX200 / OnStep</option><option value="nexstar">NexStar / SynScan</option>${L === 'bsim' ? '<option value="alpaca">Alpaca</option><option value="indi">INDI</option>' : ''}</select></label>`);
  if (L === 'serial' || L === 'bserial') f.push(`<label class="field"><span>Vitesse</span><select data-cfg="baud">${[9600, 19200, 38400, 57600, 115200].map(b => `<option>${b}</option>`).join('')}</select></label>`);
  if (BRIDGE.includes(L)) f.push(inp('bridge', 'Passerelle', bridgeUrl()) + '<button class="btn small" type="button" id="telBridgeTest">Tester la passerelle</button>');
  if (L === 'bserial') f.push(`<label class="field"><span>Port du PC</span><input data-cfg="chanSerial" list="telPorts" value="${ENC.xml(CFG.chanSerial)}" placeholder="COM3 ou /dev/ttyUSB0"><datalist id="telPorts">${(TEL.ports || []).map(p => `<option value="${ENC.xml(p.device)}">${ENC.xml(p.desc || '')}</option>`).join('')}</datalist></label>`);
  if (L === 'btcp') f.push(inp('tcpHost', 'Adresse', '192.168.4.1') + inp('tcpPort', 'Port', String(M.tcpPort || 9999), 'number'));
  if (L === 'balpaca' || L === 'alpaca') f.push(inp('alpacaBase', 'Serveur Alpaca', 'http://192.168.1.20:11111') + inp('dev', 'N° appareil', '0', 'number') + (L === 'balpaca' ? '<button class="btn small" type="button" id="telDiscover">Rechercher (découverte Alpaca)</button>' : ''));
  if (M.proto === 'nexstar' || (M.proto === 'sim' && CFG.simProto === 'nexstar')) f.push(`<label class="field"><span>Monture</span><select data-cfg="geom"><option value="altaz">Altazimutale</option><option value="eq">Équatoriale</option></select></label>`);
  if (['nexstar', 'lx200'].includes(M.proto)) f.push(`<label class="field"><span>Coordonnées</span><select data-cfg="epoch"><option value="jnow">de la date (JNow, standard)</option><option value="j2000">J2000</option></select></label>`);
  return f.join('');
}
function compatText() {
  const M = MOUNTS[CFG.mount], L = LINKS[CFG.link]; let s = M.note;
  if (L && !L.ok()) s += '<br><b>⚠️ ' + L.why + '.</b>';
  if (CFG.link === 'alpaca') s += '<br>Alpaca direct ne marche que si le serveur autorise CORS et, depuis la version HTTPS, avec Chrome 142+ (autorisation « réseau local ») ; sinon utilisez la passerelle.';
  if (BRIDGE.includes(CFG.link) && location.protocol === 'https:' && !TEL.servedByBridge) s += '<br>iPhone/Safari : ouvrez l\'adresse affichée par la passerelle (ex. http://192.168.1.20:8765) au lieu de ce site. Chrome (Android/PC) : autorisez l\'accès au réseau local.';
  return s;
}
function renderPanel(msg) {
  const box = $('telConn'); if (!box) return;
  const ms = $('telMount'), ls = $('telLink'), M = MOUNTS[CFG.mount];
  if (!ms.options.length) ms.innerHTML = Object.entries(MOUNTS).map(([k, m]) => `<option value="${k}">${m.n}</option>`).join('');
  ms.value = CFG.mount;
  if (!M.links.includes(CFG.link)) CFG.link = M.links.find(l => LINKS[l].ok()) || M.links[0] || 'sim';
  ls.innerHTML = M.links.map(l => `<option value="${l}"${LINKS[l].ok() ? '' : ' disabled'}>${LINKS[l].n}${LINKS[l].ok() ? '' : ' — indisponible ici'}</option>`).join('') || '<option>—</option>';
  ls.value = CFG.link; ls.disabled = !M.links.length || !!TEL.drv; ms.disabled = !!TEL.drv;
  $('telLinkOpts').innerHTML = M.proto ? linkOpts() : '';
  $('telLinkOpts').querySelectorAll('[data-cfg]').forEach(el => { if (el.tagName === 'SELECT') el.value = String(CFG[el.dataset.cfg]); el.disabled = !!TEL.drv; });
  $('telCompat').innerHTML = compatText();
  $('telMsg').textContent = msg || ''; $('telMsg').classList.toggle('hidden', !msg);
  $('telConnect').classList.toggle('hidden', !!TEL.drv); $('telConnect').disabled = !M.proto || connecting;
  $('telDisconnect').classList.toggle('hidden', !TEL.drv);
  document.querySelectorAll('.tel-ctl').forEach(e => e.classList.toggle('dis', !TEL.drv));
  $('telSync').disabled = !TEL.drv || !TEL.drv.caps.sync; $('telTrack').disabled = !TEL.drv || !TEL.drv.caps.tracking;
  $('telParkBtn').classList.toggle('hidden', !(TEL.drv && TEL.drv.caps.park));
  $('telRate').value = CFG.rate; $('telMinAlt').value = CFG.minAlt; $('telSolar').checked = !!CFG.solar;
  renderStatus(); renderTarget();
}

function bind() {
  if (!$('telConn')) return;
  $('telMount').onchange = e => { CFG.mount = e.target.value; save(); renderPanel(); };
  $('telLink').onchange = e => { CFG.link = e.target.value; save(); renderPanel(); };
  $('telLinkOpts').addEventListener('change', e => { const k = e.target.dataset.cfg; if (!k) return; CFG[k] = e.target.type === 'number' ? +e.target.value : e.target.value; save(); if (k === 'simProto' || k === 'baud') renderPanel(); });
  $('telLinkOpts').addEventListener('click', async e => {
    if (e.target.id === 'telBridgeTest') { try { const r = await bridgeFetch(bridgeUrl(), '/api/info'); TEL.ports = r.ports || []; renderPanel(`Passerelle OK (v${r.version}) · ports série : ${r.ports && r.ports.length ? r.ports.map(p => p.device).join(', ') : 'aucun' + (r.serial ? '' : ' (pyserial absent)')}`); } catch (er) { renderPanel(er.message); } }
    if (e.target.id === 'telDiscover') { try { const r = await bridgeFetch(bridgeUrl(), '/api/alpaca/discover'); if (r.servers && r.servers.length) { CFG.alpacaBase = 'http://' + r.servers[0].host + ':' + r.servers[0].port; save(); } renderPanel(r.servers && r.servers.length ? 'Serveurs Alpaca : ' + r.servers.map(s => s.host + ':' + s.port).join(', ') : 'Aucun serveur Alpaca trouvé sur le réseau'); } catch (er) { renderPanel(er.message); } }
  });
  $('telConnect').onclick = connect; $('telDisconnect').onclick = () => disconnect();
  $('telGoto').onclick = () => doGoto(); $('telSync').onclick = doSync;
  $('telStop').onclick = doStop; $('telFabStop').onclick = doStop;
  $('telTrack').onchange = async e => { const on = e.target.checked; try { await run(() => TEL.drv.setTracking(on)); TEL.log('Suivi ' + (on ? 'activé' : 'arrêté')); toast('Suivi ' + (on ? 'sidéral activé' : 'arrêté')); } catch (er) { e.target.checked = !on; toast('Suivi : ' + er.message, 5000); } };
  $('telParkBtn').onclick = async () => { if (!confirm('Parquer la monture (position de rangement) ?')) return; try { await run(() => TEL.drv.park()); toast('Parcage en cours…'); } catch (er) { toast('Parcage : ' + er.message); } };
  $('telUnpark').onclick = async () => { try { await run(() => TEL.drv.unpark()); toast('Monture dé-parquée'); setTimeout(poll, 300); } catch (er) { toast(er.message, 5000); } };
  $('telRate').onchange = e => { CFG.rate = +e.target.value; save(); };
  $('telMinAlt').onchange = e => { CFG.minAlt = clamp(+e.target.value || 0, -5, 60); save(); renderTarget(); };
  $('telSolar').onchange = e => { CFG.solar = e.target.checked; save(); renderTarget(); };
  document.querySelectorAll('.tel-pad [data-dir]').forEach(b => {
    const d = b.dataset.dir;
    b.addEventListener('pointerdown', e => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (er) {} startMove(d); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => stopMove());
    b.addEventListener('contextmenu', e => e.preventDefault());
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopMove(); });
  window.addEventListener('blur', () => stopMove());
  document.addEventListener('keydown', e => { if (TEL.drv && e.key === 'Escape') doStop(); });
  $('infoCard').addEventListener('click', e => { if (e.target.closest('[data-telgoto]')) doGoto(); });
  renderPanel();
}

/* ---------- interface publique pour app.js ---------- */
TEL.onSelect = s => { if (s) lastSel = s; if (!$('panel-telescope').classList.contains('hidden')) renderTarget(); };
TEL.connected = () => !!TEL.drv;
TEL.onOpen = () => renderPanel();
TEL.draw = (ctx, projEqj) => { // repère du télescope sur la carte
  if (!TEL.drv || !TEL.pos) return;
  const p = TEL.pos, q = projEqj(vec(p.j2000[0] * 15, p.j2000[1])); let g = null;
  if (TEL.goal && p.slewing) g = projEqj(vec(TEL.goal.j2000[0] * 15, TEL.goal.j2000[1]));
  ctx.save();
  if (q && g) { ctx.strokeStyle = 'rgba(120,255,170,.55)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(g.x, g.y); ctx.stroke(); ctx.setLineDash([]); }
  if (q) {
    ctx.strokeStyle = 'rgba(120,255,170,.95)'; ctx.lineWidth = 2; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.arc(q.x, q.y, 18, 0, 6.2832); ctx.stroke(); ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, 6.2832); ctx.stroke();
    ctx.beginPath(); for (const [a, b] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { ctx.moveTo(q.x + a * 10, q.y + b * 10); ctx.lineTo(q.x + a * 26, q.y + b * 26); } ctx.stroke();
    ctx.fillStyle = 'rgba(120,255,170,.95)'; ctx.font = '600 12px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.fillText(p.slewing ? 'Télescope (GoTo…)' : 'Télescope', q.x, q.y + 40);
  }
  ctx.restore();
};
TEL.api = { connect, disconnect, doGoto, doSync, doStop, startMove, stopMove, poll, cfg: () => CFG, setCfg: o => { Object.assign(CFG, o); save(); renderPanel(); }, target: () => targetOf(lastSel), safety, run, sunNow, sepDeg };
// L'app est-elle servie par la passerelle (iPhone sur le Wi-Fi) ?
if (location.protocol !== 'file:' && !/github\.io$/.test(location.hostname)) fetch('api/info', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => { if (j && j.bridge === 'celeste') { TEL.servedByBridge = true; TEL.ports = j.ports || []; if (!CFG.bridge) renderPanel(); } }).catch(() => {});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
