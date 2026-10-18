#!/usr/bin/env python3
"""celeste-bridge.py — passerelle Céleste ↔ monture Sky-Watcher SynScan (et autres). Un seul fichier.

Matériel prévu : monture Sky-Watcher EQ5 GoTo + raquette SynScan (v04.37.03) + câble RJ12 → USB
(puce FTDI ou Prolific) branché sur le PC. Le PC et l'iPhone doivent être sur le même Wi-Fi.

LANCER (Windows)
  1. Installer Python 3 (python.org — cocher « Add python.exe to PATH »).
  2. Dans l'invite de commandes :      pip install pyserial
  3. Dans le dossier de ce fichier :   python celeste-bridge.py        (ou : py celeste-bridge.py)
  Allumez et alignez d'abord la monture sur la raquette. Le port COM de la raquette est trouvé tout seul
  (test « Ka » → « a# » puis « V »). Si aucun port ne répond, la liste des ports s'affiche et vous
  choisissez ; sinon la recherche recommence toute seule toutes les 5 s (câble rebranché = reconnexion auto).

PARE-FEU : au premier lancement, Windows demande « Autoriser l'accès ? » pour Python.
  Cochez « Réseaux privés » puis « Autoriser l'accès ». Sans ça, l'iPhone ne peut pas joindre le PC.

SUR L'IPHONE : ouvrez dans Safari l'adresse affichée au lancement, par ex. http://192.168.1.20:8765/
  (pas le site github.io : Safari ne peut ni ouvrir une connexion TCP brute, ni appeler le PC depuis une
  page HTTPS ; la passerelle sert donc elle-même l'application et relaie les commandes).
  Puis Calques › 🔭 Télescope : « Sky-Watcher SynScan », liaison « Passerelle PC → port série »,
  « Port du PC » laissé vide (= la raquette détectée), « Monture » Équatoriale, puis Connecter.

AUTRES LOGICIELS (SkySafari, Stellarium, programmes PC…) : connexion « SynScan » / « NexStar » en
  TCP (Wi-Fi) sur l'IP du PC, port 4030. Les commandes du protocole série SynScan sont relayées telles
  quelles (réponses terminées par « # ») ; le texte façon LX200 (« :GR# »…) est aussi transmis tel quel.
  Un verrou empêche deux clients (iPhone + SkySafari…) de mélanger leurs commandes.

OPTIONS
  --port COM3          port de la raquette (sinon détection automatique ; Linux : /dev/ttyUSB0)
  --baud 9600          vitesse (la raquette SynScan : 9600, 8 bits, sans parité, 1 bit d'arrêt)
  --tcp-port 4030      serveur TCP brut (0 = désactivé)
  --http-port 8765     application Céleste + relais pour l'iPhone
  --no-serial          ne pas chercher de raquette (monture simulée seulement)
  --https              certificat auto-signé (utile seulement pour GPS/caméra de l'iPhone via la passerelle)
  --local-only         écoute sur ce PC seulement (127.0.0.1)
  --lat/--lon, --sim-speed, -v (journal détaillé)
  Arrêt : Ctrl+C.
Aussi : relais vers une monture TCP (OnStep Wi-Fi, ser2net, INDI), ASCOM Alpaca du réseau local, et
monture simulée (LX200, NexStar, Alpaca, INDI) pour essayer sans matériel.
Sécurité : seules les pages Céleste (cette passerelle, localhost, memecoinsphere.github.io) peuvent
utiliser le relais HTTP ; le relais Alpaca est limité au réseau local. Le port TCP 4030 est ouvert à tout
le réseau local (comme un module Wi-Fi SynScan) : utilisez --local-only ou --tcp-port 0 sinon.
"""
import argparse, http.server, ipaddress, json, math, os, re, socket, socketserver, ssl, subprocess, sys, threading, time, urllib.parse, urllib.request, itertools
from xml.etree import ElementTree as ET

VERSION = '2.0'
try:
    import serial, serial.tools.list_ports  # type: ignore
    HAVE_SERIAL = True
except Exception:
    HAVE_SERIAL = False
HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = None


# ---------------------------------------------------------------- canaux
class Chan:
    def __init__(self):
        self.buf = bytearray(); self.cv = threading.Condition(); self.closed = False; self.used = time.time(); self.label = ''

    def push(self, b):
        with self.cv:
            self.buf += b; self.cv.notify_all()

    def _take(self, n, term, any_):
        if any_:
            if not self.buf: return None
            b = bytes(self.buf); self.buf.clear(); return b
        if n:
            if len(self.buf) < n: return None
            b = bytes(self.buf[:n]); del self.buf[:n]; return b
        if term:
            i = self.buf.find(term)
            if i < 0: return None
            b = bytes(self.buf[:i + len(term)]); del self.buf[:i + len(term)]; return b
        return b''

    def read(self, n, term, any_, timeout):
        self.used = time.time(); end = time.time() + min(max(timeout, 0.01), 10)
        with self.cv:
            while True:
                b = self._take(n, term, any_)
                if b is not None: return b, False
                left = end - time.time()
                if left <= 0 or self.closed: return (b'', False) if any_ else (bytes(self.buf), True)
                self.cv.wait(left)

    def flush(self):
        with self.cv: self.buf.clear()

    def close(self):
        self.closed = True
        with self.cv: self.cv.notify_all()


class SerialChan(Chan):
    def __init__(self, port, baud):
        super().__init__()
        if not HAVE_SERIAL: raise RuntimeError('pyserial manquant : installez-le avec « pip install pyserial »')
        self.s = serial.Serial(port, int(baud or 9600), timeout=0.05, write_timeout=2); self.label = 'série ' + port
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while not self.closed:
            try:
                b = self.s.read(256)
                if b: self.push(b)
            except Exception:
                self.close(); break

    def write(self, b): self.used = time.time(); self.s.write(b)

    def close(self):
        super().close()
        try: self.s.close()
        except Exception: pass


class TcpChan(Chan):
    def __init__(self, host, port):
        super().__init__()
        self.sock = socket.create_connection((host, int(port)), timeout=5); self.sock.settimeout(0.2); self.label = f'TCP {host}:{port}'
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while not self.closed:
            try:
                b = self.sock.recv(4096)
                if not b: self.close(); break
                self.push(b)
            except socket.timeout:
                continue
            except OSError:
                self.close(); break

    def write(self, b): self.used = time.time(); self.sock.sendall(b)

    def close(self):
        super().close()
        try: self.sock.close()
        except Exception: pass


# ---------------------------------------------------------------- monture simulée
def lst_hours(lon):
    jd = time.time() / 86400 + 2440587.5
    return (18.697374558 + 24.06570982441908 * (jd - 2451545.0) + lon / 15) % 24


class SimMount:
    RATES = [0.002, 0.1, 0.8, 3.0]

    def __init__(self, lat, lon, speed=8.0):
        self.lat, self.lon = lat, lon
        self.ra = (lst_hours(lon) - 1) % 24; self.dec = 30.0
        self.off = [0.4 / 15, -0.3]; self.tgt = None; self.slewing = False; self.tracking = True; self.parked = False
        self.vel = {'ns': 0.0, 'ew': 0.0}; self.rate = 2; self.speed = speed; self.t = time.time(); self.park_goal = False
        self.lock = threading.RLock()

    def step(self):
        with self.lock:
            now = time.time(); dt = min(2.0, now - self.t); self.t = now
            if not self.tracking and not self.parked: self.ra = (self.ra + dt * 1.00273790935 / 3600) % 24
            if self.slewing and self.tgt:
                s = self.speed * dt; dra = ((self.tgt[0] - self.ra) * 15 + 540) % 360 - 180; ddec = self.tgt[1] - self.dec
                self.ra = (self.ra + max(-s, min(s, dra)) / 15) % 24; self.dec += max(-s, min(s, ddec))
                if abs(dra) <= s and abs(ddec) <= s:
                    self.slewing = False
                    if self.park_goal: self.parked = True; self.tracking = False; self.park_goal = False
            if self.vel['ns']: self.dec = max(-90, min(90, self.dec + self.vel['ns'] * dt))
            if self.vel['ew']: self.ra = (self.ra + self.vel['ew'] * dt / 15) % 24

    def rep(self):
        self.step(); return ((self.ra + self.off[0]) % 24, self.dec + self.off[1])

    def alt(self, ra, dec):
        h = (lst_hours(self.lon) - ra) * 15 * math.pi / 180; f = self.lat * math.pi / 180; d = dec * math.pi / 180
        return math.degrees(math.asin(math.sin(f) * math.sin(d) + math.cos(f) * math.cos(d) * math.cos(h)))

    def goto(self, ra, dec):
        if self.parked: return 'parquée'
        if self.alt(ra, dec) < 0: return 'sous l\'horizon'
        self.step(); self.tgt = ((ra - self.off[0]) % 24, dec - self.off[1]); self.slewing = True; return None

    def sync(self, ra, dec):
        self.step(); self.off = [ra - self.ra, dec - self.dec]

    def stop(self):
        self.step(); self.slewing = False; self.vel = {'ns': 0.0, 'ew': 0.0}

    def park(self):
        self.step(); self.tgt = (lst_hours(self.lon), 90.0); self.slewing = True; self.park_goal = True

    def actual(self):
        self.step(); return {'ra': self.ra, 'dec': self.dec}


def lx_ra(h):
    s = round((h % 24) * 3600) % 86400; return '%02d:%02d:%02d' % (s // 3600, s // 60 % 60, s % 60)


def lx_dec(d):
    s = round(min(90, abs(d)) * 3600); return '%s%02d*%02d:%02d' % ('-' if d < 0 else '+', s // 3600, s // 60 % 60, s % 60)


def lx_parse_ra(t):
    m = re.search(r'(\d{1,2}):(\d{1,2})([:.])(\d+)', t)
    if not m: return None
    return int(m[1]) + ((int(m[2]) + int(m[4][0]) / 10) / 60 if m[3] == '.' else int(m[2]) / 60 + int(m[4]) / 3600)


def lx_parse_dec(t):
    m = re.search(r"([+-])?\s*(\d{1,3})[*\xdf\xb0:'](\d{1,2})(?:[:'](\d{1,2}))?", t)
    if not m: return None
    v = int(m[2]) + int(m[3]) / 60 + (int(m[4]) / 3600 if m[4] else 0); return -v if m[1] == '-' else v


def nx_enc(deg):
    v = round((deg % 360) / 360 * 16777216) % 16777216; return '%08X' % (v * 256)


def nx_parse(t):
    m = re.search(r'([0-9A-Fa-f]{8}),([0-9A-Fa-f]{8})', t)
    if not m: return None
    ra = int(m[1], 16) / 4294967296 * 360; dec = int(m[2], 16) / 4294967296 * 360
    return ra / 15, dec - 360 if dec > 180 else dec


class SimChan(Chan):
    """Monture fictive au niveau octet : LX200, NexStar ou INDI."""
    def __init__(self, proto, mount, ident='Celeste Bridge Sim LX200'):
        super().__init__(); self.proto = proto; self.ident = ident; self.m = mount; self.inb = ''; self.long = True; self.sr = self.sd = 0.0; self.label = 'simulateur ' + proto
        self.indi_on = False; self.ocs = 'TRACK'; self.slew_rate = 'SLEW_FIND'
        if proto == 'indi': threading.Thread(target=self.indi_tick, daemon=True).start()

    def write(self, b):
        self.used = time.time(); self.inb += b.decode('latin-1')
        out = getattr(self, 'h_' + self.proto)()
        if out: self.push(out.encode('latin-1'))

    # ---- LX200
    def h_lx200(self):
        out = ''
        while '#' in self.inb:
            c, self.inb = self.inb.split('#', 1)
            if ':' not in c: continue
            out += self.lx(c[c.index(':') + 1:])
        return out

    def lx(self, c):
        m = self.m; ra, dec = m.rep()
        if c == 'GVP': return self.ident + '#'
        if c == 'GR': return (lx_ra(ra) if self.long else lx_ra(ra)[:5] + '.' + str(int(round(ra * 3600) % 60 // 6))) + '#'
        if c == 'GD': return (lx_dec(dec) if self.long else lx_dec(dec)[:6]) + '#'
        if c == 'U': self.long = not self.long; return ''
        if c.startswith('Sr'): v = lx_parse_ra(c[2:]); self.sr = v if v is not None else self.sr; return '1' if v is not None else '0'
        if c.startswith('Sd'): v = lx_parse_dec(c[2:]); self.sd = v if v is not None else self.sd; return '1' if v is not None else '0'
        if c == 'MS':
            e = m.goto(self.sr, self.sd)
            return '0' if not e else ('6Parked#' if e == 'parquée' else '1Below horizon#')
        if c == 'CM': m.sync(self.sr, self.sd); return 'N/A#'
        if c == 'Q': m.stop(); return ''
        if re.fullmatch(r'Q[nsew]', c): m.step(); m.vel['ns' if c[1] in 'ns' else 'ew'] = 0.0; return ''
        if re.fullmatch(r'M[nsew]', c):
            if m.parked: return ''
            m.step(); ax = 'ns' if c[1] in 'ns' else 'ew'; m.vel[ax] = (1 if c[1] in 'ne' else -1) * m.RATES[m.rate]; return ''
        if re.fullmatch(r'R[GCMS]', c): m.rate = 'GCMS'.index(c[1]); return ''
        if c == 'Te':
            if m.parked: return '0'
            m.step(); m.tracking = True; return '1'
        if c == 'Td': m.step(); m.tracking = False; return '1'
        if c == 'D': return '\x7f#' if m.slewing else '#'
        if c == 'GU': return ('' if m.tracking else 'n') + ('' if m.slewing else 'N') + ('P' if m.parked else 'p') + '#'
        if c == 'hP': m.park(); return ''
        if c == 'hR': m.parked = False; m.tracking = True; return '1'
        return ''

    # ---- NexStar
    def h_nexstar(self):
        L = {'K': 2, 'r': 18, 's': 18, 'P': 8, 'T': 2}; out = ''; m = self.m
        while self.inb:
            n = L.get(self.inb[0], 1)
            if len(self.inb) < n: break
            c, self.inb = self.inb[:n], self.inb[n:]; ch = c[0]; ra, dec = m.rep()
            if ch == 'K': out += c[1] + '#'
            elif ch == 'V': out += '\x04\x29#'
            elif ch == 'J': out += '\x01#'
            elif ch == 'e': out += nx_enc(ra * 15) + ',' + nx_enc(dec) + '#'
            elif ch in 'rs':
                q = nx_parse(c[1:])
                if q: (m.goto if ch == 'r' else m.sync)(*q)
                out += '#'
            elif ch == 'L': out += ('1' if m.slewing else '0') + '#'
            elif ch == 'M': m.stop(); out += '#'
            elif ch == 't': out += ('\x02' if m.tracking else '\x00') + '#'
            elif ch == 'T': m.step(); m.tracking = ord(c[1]) > 0; out += '#'
            elif ch == 'P':
                m.step(); ax = 'ew' if ord(c[2]) == 16 else 'ns'; sg = 1 if ord(c[3]) == 36 else -1; r = ord(c[4])
                m.vel[ax] = sg * ([0, 0.002, 0.002, 0.01, 0.1, 0.1, 0.5, 0.8, 2, 3][r]) if r else 0.0; out += '#'
            else: out += '#'
        return out

    # ---- INDI (serveur minimal)
    DEV = 'Telescope Simulator (Celeste)'

    def indi_defs(self):
        d = self.DEV; on = lambda b: 'On' if b else 'Off'; m = self.m; ra, dec = m.rep()
        sw = lambda name, rule, items, label='': f'<defSwitchVector device="{d}" name="{name}" label="{label or name}" group="Main" state="Ok" perm="rw" rule="{rule}">' + ''.join(f'<defSwitch name="{k}">{on(v)}</defSwitch>' for k, v in items) + '</defSwitchVector>\n'
        x = f'<defTextVector device="{d}" name="DRIVER_INFO" group="General Info" state="Idle" perm="ro"><defText name="DRIVER_NAME">Celeste Sim</defText><defText name="DRIVER_INTERFACE">5</defText></defTextVector>\n'
        x += sw('CONNECTION', 'OneOfMany', [('CONNECT', self.indi_on), ('DISCONNECT', not self.indi_on)])
        if self.indi_on:
            x += f'<defNumberVector device="{d}" name="EQUATORIAL_EOD_COORD" group="Main" state="Ok" perm="rw"><defNumber name="RA" format="%010.6m" min="0" max="24" step="0">{ra:.6f}</defNumber><defNumber name="DEC" format="%010.6m" min="-90" max="90" step="0">{dec:.6f}</defNumber></defNumberVector>\n'
            x += sw('ON_COORD_SET', 'OneOfMany', [('TRACK', self.ocs == 'TRACK'), ('SLEW', self.ocs == 'SLEW'), ('SYNC', self.ocs == 'SYNC')])
            x += sw('TELESCOPE_ABORT_MOTION', 'AtMostOne', [('ABORT', False)])
            x += sw('TELESCOPE_TRACK_STATE', 'OneOfMany', [('TRACK_ON', m.tracking), ('TRACK_OFF', not m.tracking)])
            x += sw('TELESCOPE_MOTION_NS', 'AtMostOne', [('MOTION_NORTH', False), ('MOTION_SOUTH', False)])
            x += sw('TELESCOPE_MOTION_WE', 'AtMostOne', [('MOTION_WEST', False), ('MOTION_EAST', False)])
            x += sw('TELESCOPE_PARK', 'OneOfMany', [('PARK', m.parked), ('UNPARK', not m.parked)])
            x += sw('TELESCOPE_SLEW_RATE', 'OneOfMany', [(k, k == self.slew_rate) for k in ('SLEW_GUIDE', 'SLEW_CENTERING', 'SLEW_FIND', 'SLEW_MAX')])
        return x

    def indi_state(self):
        m = self.m; ra, dec = m.rep(); st = 'Busy' if m.slewing else 'Ok'
        x = f'<setNumberVector device="{self.DEV}" name="EQUATORIAL_EOD_COORD" state="{st}"><oneNumber name="RA">{ra:.6f}</oneNumber><oneNumber name="DEC">{dec:.6f}</oneNumber></setNumberVector>\n'
        x += f'<setSwitchVector device="{self.DEV}" name="TELESCOPE_TRACK_STATE" state="Ok"><oneSwitch name="TRACK_ON">{"On" if m.tracking else "Off"}</oneSwitch><oneSwitch name="TRACK_OFF">{"Off" if m.tracking else "On"}</oneSwitch></setSwitchVector>\n'
        x += f'<setSwitchVector device="{self.DEV}" name="TELESCOPE_PARK" state="Ok"><oneSwitch name="PARK">{"On" if m.parked else "Off"}</oneSwitch><oneSwitch name="UNPARK">{"Off" if m.parked else "On"}</oneSwitch></setSwitchVector>\n'
        return x

    def indi_tick(self):
        while not self.closed:
            time.sleep(0.5)
            if self.indi_on: self.push(self.indi_state().encode())

    def h_indi(self):
        out = ''; m = self.m
        if '<getProperties' in self.inb:
            self.inb = re.sub(r'<getProperties[^>]*/>', '', self.inb); out += self.indi_defs()
        for mt in list(re.finditer(r'<(new)(Number|Switch|Text)Vector\b[\s\S]*?</new\2Vector>', self.inb)):
            el = ET.fromstring(mt.group(0)); name = el.get('name'); vals = {c.get('name'): c.text.strip() for c in el}
            if name == 'CONNECTION':
                was = self.indi_on; self.indi_on = vals.get('CONNECT') == 'On'
                if self.indi_on and not was: out += self.indi_defs()
            elif not self.indi_on: continue
            elif name == 'ON_COORD_SET': self.ocs = next((k for k, v in vals.items() if v == 'On'), self.ocs)
            elif name == 'EQUATORIAL_EOD_COORD':
                ra, dec = float(vals['RA']), float(vals['DEC'])
                if self.ocs == 'SYNC': m.sync(ra, dec)
                else:
                    e = m.goto(ra, dec)
                    if e: out += f'<message device="{self.DEV}" timestamp="{time.strftime("%Y-%m-%dT%H:%M:%S")}" message="GoTo refusé : {e}"/>\n'
                out += self.indi_state()
            elif name == 'TELESCOPE_ABORT_MOTION': m.stop()
            elif name == 'TELESCOPE_TRACK_STATE': m.step(); m.tracking = vals.get('TRACK_ON') == 'On'
            elif name == 'TELESCOPE_PARK':
                if vals.get('PARK') == 'On': m.park()
                elif vals.get('UNPARK') == 'On': m.parked = False
            elif name == 'TELESCOPE_SLEW_RATE': self.slew_rate = next((k for k, v in vals.items() if v == 'On'), self.slew_rate)
            elif name in ('TELESCOPE_MOTION_NS', 'TELESCOPE_MOTION_WE'):
                m.step(); r = {'SLEW_GUIDE': 0.002, 'SLEW_CENTERING': 0.1, 'SLEW_FIND': 0.8, 'SLEW_MAX': 3}[self.slew_rate]
                ax = 'ns' if name.endswith('NS') else 'ew'; pos, neg = ('MOTION_NORTH', 'MOTION_SOUTH') if ax == 'ns' else ('MOTION_EAST', 'MOTION_WEST')
                m.vel[ax] = r if vals.get(pos) == 'On' else -r if vals.get(neg) == 'On' else 0.0
        self.inb = re.sub(r'<(new)(Number|Switch|Text)Vector\b[\s\S]*?</new\2Vector>', '', self.inb).lstrip()
        if len(self.inb) > 100000: self.inb = ''
        return out


def sim_alpaca(m, method, path, p):
    """Monture ASCOM Alpaca fictive (Telescope v1)."""
    name = path.rstrip('/').split('/')[-1].lower(); ok = lambda v=None: {'Value': v, 'ErrorNumber': 0, 'ErrorMessage': ''}
    err = lambda n, msg: {'ErrorNumber': n, 'ErrorMessage': msg}
    ra, dec = m.rep(); b = lambda k: str(p.get(k, '')).lower() == 'true'
    if method == 'GET':
        v = {'name': 'Celeste Alpaca Simulator', 'connected': True, 'cansync': True, 'canpark': True, 'canunpark': True, 'cansettracking': True,
             'canslewasync': True, 'equatorialsystem': 1, 'axisrates': [{'Minimum': 0.0, 'Maximum': 3.0}], 'rightascension': ra, 'declination': dec,
             'slewing': m.slewing or any(m.vel.values()), 'tracking': m.tracking, 'atpark': m.parked}
        return ok(v[name]) if name in v else err(0x400, 'non implémenté')
    if name == 'connected': return ok()
    if name in ('slewtocoordinatesasync', 'slewtocoordinates'):
        e = m.goto(float(p['RightAscension']), float(p['Declination']))
        return err(0x408 if e == 'parquée' else 0x401, 'GoTo refusé : ' + e) if e else ok()
    if name == 'synctocoordinates': m.sync(float(p['RightAscension']), float(p['Declination'])); return ok()
    if name == 'abortslew': m.stop(); return ok()
    if name == 'moveaxis': m.step(); m.vel['ew' if int(p['Axis']) == 0 else 'ns'] = float(p['Rate']); return ok()
    if name == 'tracking': m.step(); m.tracking = b('Tracking'); return ok()
    if name == 'park': m.park(); return ok()
    if name == 'unpark': m.parked = False; return ok()
    return err(0x400, 'non implémenté')


# ---------------------------------------------------------------- raquette SynScan partagée (TCP + iPhone)
def log(msg): print(time.strftime('%H:%M:%S ') + msg, flush=True)


def syn_version(r):
    """« 042503# » (SynScan : 6 chiffres hexa) → 04.37.03 ; « \\x04\\x29# » (NexStar : 2 octets) → 4.41."""
    t = r[:-1] if r.endswith(b'#') else r
    if re.fullmatch(rb'[0-9A-Fa-f]{6}', t): return '%02d.%02d.%02d' % tuple(int(t[i:i + 2], 16) for i in (0, 2, 4))
    if len(t) == 2: return '%d.%d' % (t[0], t[1])
    return t.decode('latin-1') or '?'


def read_until(s, term, timeout):
    end = time.time() + timeout; b = b''
    while time.time() < end:
        b += s.read(64)
        if term in b: break
    return b


def probe(port, baud, timeout=1.2):
    """Ouvre le port en 9600 8N1 et teste une raquette : écho « Ka » → « a# », sinon « V ». Rend (Serial, version) ou None."""
    s = serial.Serial(port, baud, bytesize=8, parity='N', stopbits=1, timeout=0.05, write_timeout=1)
    try:
        time.sleep(0.15); s.reset_input_buffer()
        s.write(b'Ka'); r = read_until(s, b'#', timeout)
        if not r.endswith(b'a#'):
            s.reset_input_buffer(); s.write(b'V'); r = read_until(s, b'#', timeout)
            if not r.endswith(b'#'): s.close(); return None
            return s, syn_version(r)
        s.reset_input_buffer(); s.write(b'V'); return s, syn_version(read_until(s, b'#', timeout))
    except Exception:
        s.close(); raise


def port_rank(p):  # câbles USB-série courants (FTDI, Prolific, CH340, CP210x) en premier
    return 0 if re.search(r'ftdi|prolific|pl2303|ch34|cp210|usb.?serial|serial.?usb|usb', (p.description or '') + ' ' + (p.hwid or ''), re.I) else 1


class Hub:
    """Un seul port série pour tout le monde. Chaque échange (commande + réponse) se fait sous « bail » :
    un seul client à la fois parle à la raquette ; les octets reçus vont au client qui a le bail."""
    def __init__(self, port, baud, scan=True):
        self.want, self.baud, self.scan = port, baud, scan
        self.ser = None; self.port = None; self.version = None; self.stop = False; self.wlock = threading.Lock()
        self.cv = threading.Condition(); self.owner = None; self.lease_end = 0.0; self.sink = None; self.warned = False

    @property
    def connected(self): return self.ser is not None

    def start(self):
        threading.Thread(target=self.reader, daemon=True).start(); threading.Thread(target=self.keeper, daemon=True).start()

    # -- connexion / reconnexion
    def detect(self, quiet=False):
        if not HAVE_SERIAL: return None
        ports = sorted(serial.tools.list_ports.comports(), key=port_rank)
        for p in ports:
            try:
                r = probe(p.device, self.baud)
            except Exception as e:
                if ARGS.verbose: log(f'  {p.device} : {e}')
                continue
            if r: return p.device, r
        return None

    def attach(self, port, s, ver, how='trouvée'):
        self.ser, self.port, self.version = s, port, ver; self.warned = False
        log(f'Raquette SynScan {how} sur {port}' + (f' (version {ver})' if ver else ' (pas de réponse pour l\'instant : est-elle allumée ?)'))

    def try_connect(self):
        if self.want:
            try:
                r = probe(self.want, self.baud)
                if r: self.attach(self.want, *r); return True
                s = serial.Serial(self.want, self.baud, bytesize=8, parity='N', stopbits=1, timeout=0.05, write_timeout=1)
                self.attach(self.want, s, None, 'ouverte'); return True
            except Exception as e:
                if not self.warned: log(f'Port {self.want} indisponible ({e}) — nouvel essai toutes les 3 s'); self.warned = True
                return False
        if not self.scan: return False
        r = self.detect()
        if r: self.attach(r[0], *r[1]); return True
        if not self.warned: log('Aucune raquette SynScan détectée — nouvelle recherche toutes les 5 s (câble branché ? raquette allumée ?)'); self.warned = True
        return False

    def drop(self, why):
        s, self.ser = self.ser, None
        if s:
            try: s.close()
            except Exception: pass
            log(f'Raquette déconnectée ({self.port} : {why}) — reconnexion automatique…')

    def keeper(self):
        while not self.stop:
            if self.ser is None and (self.want or self.scan) and HAVE_SERIAL:
                with self.cv:  # pas de détection pendant un échange
                    busy = self.owner is not None and time.time() < self.lease_end
                if not busy: self.try_connect()
            time.sleep(3 if self.want else 5)

    def reader(self):
        while not self.stop:
            s = self.ser
            if s is None: time.sleep(0.1); continue
            try:
                b = s.read(256)
            except Exception as e:
                if s is self.ser: self.drop(str(e).split('\n')[0][:80])
                continue
            if b:
                with self.cv: sink = self.sink
                if sink: sink.push(b)

    def write(self, b):
        s = self.ser
        if s is None: raise RuntimeError('raquette SynScan déconnectée — vérifiez le câble (reconnexion automatique)')
        try:
            with self.wlock: s.write(b)
        except Exception as e:
            self.drop(str(e).split('\n')[0][:80]); raise RuntimeError('raquette SynScan déconnectée (' + str(e)[:60] + ')')

    # -- bail (verrou partagé)
    def acquire(self, owner, lease=2.5, wait=12.0):
        end = time.time() + wait
        with self.cv:
            while self.owner not in (None, owner) and time.time() < self.lease_end:
                left = min(end, self.lease_end) - time.time()
                if time.time() >= end: raise RuntimeError('raquette occupée par un autre client')
                self.cv.wait(max(0.01, left))
            self.owner = owner; self.lease_end = time.time() + lease; self.sink = owner

    def release(self, owner):
        with self.cv:
            if self.owner is owner: self.owner = None; self.cv.notify_all()

    def close(self):
        self.stop = True; s, self.ser = self.ser, None
        if s:
            try: s.close()
            except Exception: pass


# Protocole série de la raquette SynScan (= NexStar) : longueur des commandes et des réponses
SYN_CMD_LEN = {'K': 2, 'T': 2, 'r': 18, 's': 18, 'b': 18, 'R': 10, 'S': 10, 'B': 10, 'P': 8, 'W': 9, 'H': 9}
SYN_REPLY_LEN = {'K': 2, 'J': 2, 'm': 2, 't': 2, 'L': 2, 'p': 2, 'w': 9, 'h': 9}  # réponses binaires : longueur fixe (un octet peut valoir « # »)
SYN_TIMEOUT = {'r': 3.5, 's': 3.5, 'b': 3.5, 'R': 3.5, 'S': 3.5, 'B': 3.5, 'P': 3.0, 'K': 1.5}
LX_NOREPLY = re.compile(r':(Q[nsew]?|M[nsew]|R[GCMS]|U|hP|TQ|TS|TL|TM|F[+\-QSF]|Q[nsew])#')


def split_cmd(buf):
    """Découpe le flux d'un client en commandes. Rend (commande, reste) ou (None, buf) si incomplet."""
    if not buf: return None, buf
    c = chr(buf[0])
    if c == ':':
        i = buf.find(b'#')
        return (buf[:i + 1], buf[i + 1:]) if i >= 0 else (None, buf)
    if buf[0] == 6: return buf[:1], buf[1:]  # ACK LX200
    if c in '#\r\n ': return b'', buf[1:]   # séparateurs ignorés
    n = SYN_CMD_LEN.get(c, 1)
    return (buf[:n], buf[n:]) if len(buf) >= n else (None, buf)


def transact(hub, owner, cmd):
    """Un échange sous bail : écrit la commande, lit la réponse avec le bon cadrage, puis libère la raquette."""
    hub.acquire(owner, lease=5.0)
    try:
        owner.flush(); hub.write(cmd); c = chr(cmd[0])
        if c == ':' or cmd[0] == 6:  # LX200 : transmis tel quel, réponse « …# », un caractère, ou rien
            if LX_NOREPLY.fullmatch(cmd.decode('latin-1')): b, _ = owner.read(0, b'', True, 0.15); return b
            out = b''; end = time.time() + 2.0; first = True
            while time.time() < end:
                b, _ = owner.read(0, b'', True, 1.0 if first else 0.15)
                if not b: break
                out += b; first = False
                if out.endswith(b'#'): break
            return out
        n = ord(cmd[7:8] or b'\x01') + 1 if c == 'P' else SYN_REPLY_LEN.get(c, 0)
        b, to = owner.read(n, b'' if n else b'#', False, SYN_TIMEOUT.get(c, 2.0))
        if to and ARGS.verbose: log(f'  pas de réponse complète à {cmd!r} ({b!r})')
        return b
    finally:
        hub.release(owner)


class TcpClient(socketserver.BaseRequestHandler):
    def handle(self):
        who = '%s:%d' % self.client_address[:2]; s = self.request; s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1); s.settimeout(1.0)
        log(f'Client TCP connecté : {who}'); me = Chan(); me.label = 'TCP ' + who; buf = b''; last = time.time()
        try:
            while not HUB.stop:
                try:
                    d = s.recv(4096)
                    if not d: break
                    buf += d; last = time.time()
                except socket.timeout:
                    if buf and time.time() - last > 2: buf = b''  # commande incomplète abandonnée
                    continue
                while True:
                    cmd, buf = split_cmd(buf)
                    if cmd is None: break
                    if not cmd: continue
                    if ARGS.verbose: log(f'  {who} → {cmd!r}')
                    try: rep = transact(HUB, me, cmd)
                    except RuntimeError as e:
                        if ARGS.verbose or HUB.connected: log(f'  {who} : {e}')
                        rep = b''
                    if rep: s.sendall(rep)
        except (ConnectionError, OSError):
            pass
        finally:
            log(f'Client TCP déconnecté : {who}')


class HubChan(Chan):
    """Canal HTTP (iPhone) vers la raquette partagée : le bail est pris à l'écriture et rendu après la lecture."""
    def __init__(self, hub):
        super().__init__(); self.hub = hub; self.label = 'raquette SynScan ' + (hub.port or '') + (f' (v{hub.version})' if hub.version else '')

    def write(self, b):
        self.used = time.time(); self.hub.acquire(self, lease=2.5); self.hub.write(b)

    def read(self, n, term, any_, timeout):
        try: return super().read(n, term, any_, timeout)
        finally: self.hub.release(self)

    def close(self):
        self.hub.release(self); super().close()
        with self.hub.cv:
            if self.hub.sink is self: self.hub.sink = None


# ---------------------------------------------------------------- serveur HTTP
CHANS = {}; IDS = itertools.count(1); SIM = None; LOCK = threading.Lock(); HUB = None


def sim_mount():
    global SIM
    if SIM is None: SIM = SimMount(ARGS.lat, ARGS.lon, ARGS.sim_speed)
    return SIM


def is_private_host(host):
    try:
        infos = socket.getaddrinfo(host, None)
        return all(ipaddress.ip_address(i[4][0]).is_private or ipaddress.ip_address(i[4][0]).is_loopback or ipaddress.ip_address(i[4][0]).is_link_local for i in infos)
    except Exception:
        return False


def alpaca_discover(timeout=1.5):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1); s.settimeout(0.3); found = {}
    try:
        for addr in ('255.255.255.255', '<broadcast>'):
            try: s.sendto(b'alpacadiscovery1', (addr, 32227))
            except OSError: pass
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, (host, _) = s.recvfrom(1024); port = json.loads(data.decode()).get('AlpacaPort')
                if port: found[f'{host}:{port}'] = {'host': host, 'port': port}
            except socket.timeout: continue
            except (ValueError, OSError): continue
    finally:
        s.close()
    return list(found.values())


def ports_list():
    if not HAVE_SERIAL: return []
    return [{'device': p.device, 'desc': (p.description or '') + (' — raquette SynScan détectée' if HUB and p.device == HUB.port and HUB.connected else '')} for p in serial.tools.list_ports.comports()]


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.webmanifest': 'application/manifest+json', '.js': 'text/javascript'}
    server_version = 'CelesteBridge/' + VERSION

    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)

    def log_message(self, fmt, *a):
        if ARGS.verbose: sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % a))

    def origin_ok(self):
        o = self.headers.get('Origin')
        if not o: return True
        host = self.headers.get('Host', '')
        if o in ('http://' + host, 'https://' + host): return True
        if re.fullmatch(r'https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?', o): return True
        return o in ARGS.allow_origin

    def cors(self):
        o = self.headers.get('Origin')
        if o and self.origin_ok():
            self.send_header('Access-Control-Allow-Origin', o); self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Private-Network', 'true')

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.cors(); self.send_header('Content-Type', 'application/json'); self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_OPTIONS(self):
        if not self.path.startswith('/api/') or not self.origin_ok(): self.send_response(403); self.end_headers(); return
        self.send_response(204); self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '600'); self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/'):
            if not self.origin_ok(): return self.send_json({'error': 'origine refusée'}, 403)
            if self.path.startswith('/api/info'): return self.send_json({'bridge': 'celeste', 'version': VERSION, 'serial': HAVE_SERIAL, 'ports': ports_list(), 'sim': True, 'synscan': {'port': HUB.port if HUB else None, 'connected': bool(HUB and HUB.connected), 'version': HUB.version if HUB else None, 'tcp_port': ARGS.tcp_port}})
            if self.path.startswith('/api/sim/state'):
                m = sim_mount(); a = m.actual(); return self.send_json({**a, 'off': m.off, 'slewing': m.slewing, 'tracking': m.tracking, 'parked': m.parked})
            if self.path.startswith('/api/alpaca/discover'): return self.send_json({'servers': alpaca_discover()})
            return self.send_json({'error': 'inconnu'}, 404)
        return super().do_GET()

    def end_headers(self):
        if not self.path.startswith('/api/'): self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_POST(self):
        if not self.path.startswith('/api/'): return self.send_json({'error': 'inconnu'}, 404)
        if not self.origin_ok(): return self.send_json({'error': 'origine refusée'}, 403)
        if not self.headers.get('Content-Type', '').startswith('application/json'): return self.send_json({'error': 'JSON attendu'}, 415)
        try:
            n = int(self.headers.get('Content-Length', 0)); req = json.loads(self.rfile.read(min(n, 1 << 20)) or b'{}')
            return self.send_json(self.api(self.path.split('?')[0], req))
        except Exception as e:
            return self.send_json({'error': str(e) or e.__class__.__name__}, 400)

    def api(self, path, r):
        if path == '/api/open':
            kind = r.get('kind')
            if kind == 'serial':
                port = (r.get('port') or '').strip()
                if HUB and (not port or port.lower() in ('auto', 'synscan') or HUB.port and port.lower() == HUB.port.lower() or HUB.want and port.lower() == HUB.want.lower()):
                    if not HUB.connected: raise RuntimeError('raquette SynScan non détectée par la passerelle — câble branché, raquette allumée ? (nouvel essai automatique)')
                    ch = HubChan(HUB)  # même port que le serveur TCP : verrou partagé
                else:
                    if not port: raise RuntimeError('indiquez le port série (ex. COM3, /dev/ttyUSB0)')
                    with LOCK:
                        for k, c in list(CHANS.items()):
                            if c.label == 'série ' + port: c.close(); del CHANS[k]
                    ch = SerialChan(port, r.get('baud', 9600))
            elif kind == 'tcp':
                ch = TcpChan(r.get('host'), r.get('port'))
            elif kind == 'sim':
                proto = r.get('proto', 'lx200')
                if proto not in ('lx200', 'nexstar', 'indi'): raise RuntimeError('protocole simulé inconnu')
                ch = SimChan(proto, sim_mount())
            else:
                raise RuntimeError('type de canal inconnu')
            i = str(next(IDS))
            with LOCK: CHANS[i] = ch
            print(f'[passerelle] canal {i} ouvert : {ch.label}')
            return {'id': i, 'info': ch.label}
        if path == '/api/sim/center':  # simulateur seulement : « l'utilisateur centre l'objet » (tests)
            m = sim_mount(); m.step(); m.ra, m.dec = float(r['ra']), float(r['dec']); return {'ok': True}
        if path == '/api/alpaca':
            base = r.get('base', ''); method = r.get('method', 'GET').upper(); p = r.get('params') or {}; apath = r.get('path', '')
            if not re.fullmatch(r'/(api/v1|management)/[a-z0-9/]+', apath): raise RuntimeError('chemin Alpaca invalide')
            if base == 'sim': return sim_alpaca(sim_mount(), method, apath, p)
            u = urllib.parse.urlparse(base)
            if u.scheme not in ('http', 'https') or not u.hostname or not is_private_host(u.hostname): raise RuntimeError('serveur Alpaca hors du réseau local refusé')
            data = urllib.parse.urlencode({k: str(v) for k, v in p.items()})
            url = base.rstrip('/') + apath + ('?' + data if method == 'GET' else '')
            req = urllib.request.Request(url, data=None if method == 'GET' else data.encode(), method=method, headers={'Content-Type': 'application/x-www-form-urlencoded'})
            with urllib.request.urlopen(req, timeout=15) as resp: return json.loads(resp.read().decode())
        ch = CHANS.get(str(r.get('id')))
        if not ch: raise RuntimeError('canal fermé — reconnectez')
        if path == '/api/write':
            if ch.closed: raise RuntimeError('liaison perdue avec la monture')
            ch.write(r.get('data', '').encode('latin-1')); return {'ok': True}
        if path == '/api/read':
            b, to = ch.read(int(r.get('n') or 0), (r.get('term') or '').encode('latin-1'), bool(r.get('any')), float(r.get('timeout') or 1500) / 1000)
            return {'data': b.decode('latin-1'), 'timeout': to, 'closed': ch.closed}
        if path == '/api/flush': ch.flush(); return {'ok': True}
        if path == '/api/close':
            ch.close(); CHANS.pop(str(r.get('id')), None); return {'ok': True}
        raise RuntimeError('inconnu')


def janitor():
    while True:
        time.sleep(30)
        with LOCK:
            for k, c in list(CHANS.items()):
                if c.closed or time.time() - c.used > 900: c.close(); del CHANS[k]


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); ip = s.getsockname()[0]; s.close(); return ip
    except OSError:
        return '127.0.0.1'


def ask_port(hub):
    """Aucune raquette trouvée au démarrage : liste les ports et demande lequel utiliser."""
    ports = sorted(serial.tools.list_ports.comports(), key=port_rank)
    if not ports:
        print('  Aucun port série sur ce PC : branchez le câble USB de la raquette (installez le pilote FTDI/Prolific si besoin).'); return
    print('  Aucun port n\'a répondu comme une raquette SynScan (allumée ? câble bien enfoncé ?). Ports disponibles :')
    for i, p in enumerate(ports, 1): print(f'    {i}. {p.device}  {p.description or ""}')
    if not (sys.stdin and sys.stdin.isatty()): return
    try: a = input('  Numéro ou nom du port (Entrée = continuer la recherche automatique) : ').strip()
    except EOFError: return
    if not a: return
    hub.want = ports[int(a) - 1].device if a.isdigit() and 1 <= int(a) <= len(ports) else a


def main():
    global ARGS, HUB
    ap = argparse.ArgumentParser(description='Passerelle Céleste ↔ raquette SynScan (TCP + application pour iPhone)')
    ap.add_argument('--port', help='port de la raquette : COM3, /dev/ttyUSB0… (défaut : détection automatique)')
    ap.add_argument('--baud', type=int, default=9600); ap.add_argument('--tcp-port', type=int, default=4030)
    ap.add_argument('--http-port', type=int, default=8765); ap.add_argument('--no-serial', action='store_true')
    ap.add_argument('--https', action='store_true'); ap.add_argument('--local-only', action='store_true')
    ap.add_argument('--allow-origin', action='append', default=['https://memecoinsphere.github.io'])
    ap.add_argument('--lat', type=float, default=46.16); ap.add_argument('--lon', type=float, default=-1.15); ap.add_argument('--sim-speed', type=float, default=8.0); ap.add_argument('-v', '--verbose', action='store_true')
    ARGS = ap.parse_args()
    for f in (sys.stdout, sys.stderr):  # console Windows : jamais de plantage sur un accent
        try: f.reconfigure(errors='replace')
        except Exception: pass
    if ARGS.port and ARGS.port.isdigit():  # ancienne syntaxe de celeste_bridge.py : --port 8765 = port HTTP
        ARGS.http_port, ARGS.port = int(ARGS.port), None
    host = '127.0.0.1' if ARGS.local_only else '0.0.0.0'
    httpd = http.server.ThreadingHTTPServer((host, ARGS.http_port), H); httpd.daemon_threads = True
    scheme = 'http'
    if ARGS.https:
        cert, key = os.path.join(HERE, 'cert.pem'), os.path.join(HERE, 'key.pem')
        if not (os.path.exists(cert) and os.path.exists(key)):
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '365', '-subj', '/CN=celeste.local'], check=True)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key); httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True); scheme = 'https'
    HUB = Hub(ARGS.port, ARGS.baud, scan=not ARGS.no_serial and not ARGS.port)
    tcpd = None
    if ARGS.tcp_port:
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        tcpd = socketserver.ThreadingTCPServer((host, ARGS.tcp_port), TcpClient); tcpd.daemon_threads = True
        threading.Thread(target=tcpd.serve_forever, kwargs={'poll_interval': 0.5}, daemon=True).start()
    threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': 0.5}, daemon=True).start()
    threading.Thread(target=janitor, daemon=True).start()
    ip = lan_ip()
    print(f'Passerelle Céleste v{VERSION}  (Ctrl+C pour arrêter)')
    print(f'  iPhone (même Wi-Fi), dans Safari : {scheme}://{ip}:{ARGS.http_port}/   puis Calques › Télescope › « Sky-Watcher SynScan » › « Passerelle PC → port série »')
    print(f'  Sur ce PC : {scheme}://localhost:{ARGS.http_port}/')
    if tcpd: print(f'  SkySafari / Stellarium : SynScan en TCP sur {ip}, port {ARGS.tcp_port}')
    try:
        if not HAVE_SERIAL:
            print('  pyserial absent : installez-le avec « pip install pyserial » (en attendant : monture simulée seulement)')
        elif not ARGS.no_serial:
            print('  Recherche de la raquette SynScan…' if not ARGS.port else f'  Ouverture de {ARGS.port}…', flush=True)
            if not HUB.try_connect() and not ARGS.port:
                ask_port(HUB)
                if HUB.want: HUB.scan = False; HUB.warned = False; HUB.try_connect()
        HUB.start()
        while True: time.sleep(0.5)
    except KeyboardInterrupt:
        print('\nArrêt.')
    finally:
        HUB.close()
        for c in list(CHANS.values()): c.close()
        try: httpd.server_close()
        except Exception: pass
        if tcpd:
            try: tcpd.server_close()
            except Exception: pass


if __name__ == '__main__':
    main()
