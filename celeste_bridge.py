#!/usr/bin/env python3
"""Passerelle Céleste ↔ télescope (Windows, macOS, Linux, Raspberry Pi). Python 3.8+ ; pyserial facultatif.

Pourquoi ? Safari sur iPhone ne sait parler ni USB/série ni Bluetooth, et une page HTTPS ne peut pas
contacter un appareil http:// du réseau local. Cette passerelle tourne sur un PC du même Wi-Fi :
  • elle sert l'application Céleste sur http://<IP-du-PC>:8765/ (même origine → aucun blocage) ;
  • elle relaie les commandes vers : un port série/USB du PC (raquette NexStar/SynScan, Meade LX200,
    OnStep…), une connexion TCP (OnStep Wi-Fi port 9999, ser2net, indiserver port 7624),
    ou un serveur ASCOM Alpaca (HTTP) du réseau local ;
  • elle contient une monture simulée (LX200, NexStar, Alpaca, INDI) pour essayer sans matériel.

Usage :
  pip install pyserial            (seulement pour les ports série/USB)
  python3 celeste_bridge.py       puis ouvrir l'adresse affichée sur le téléphone
Options : --port 8765  --https (certificat auto-signé, utile pour caméra/GPS sur iPhone)
          --local-only (127.0.0.1 seulement)  --allow-origin URL  --lat/--lon (simulateur)
Sécurité : seules les pages Céleste (cette passerelle, localhost, memecoinsphere.github.io) peuvent
l'utiliser depuis un navigateur ; le relais Alpaca est limité aux adresses du réseau local.
Arrêt : Ctrl+C.
"""
import argparse, http.server, ipaddress, json, math, os, re, socket, ssl, subprocess, sys, threading, time, urllib.parse, urllib.request, itertools
from xml.etree import ElementTree as ET

VERSION = '1.0'
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


# ---------------------------------------------------------------- serveur HTTP
CHANS = {}; IDS = itertools.count(1); SIM = None; LOCK = threading.Lock()


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
    return [{'device': p.device, 'desc': p.description} for p in serial.tools.list_ports.comports()]


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
            if self.path.startswith('/api/info'): return self.send_json({'bridge': 'celeste', 'version': VERSION, 'serial': HAVE_SERIAL, 'ports': ports_list(), 'sim': True})
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
                port = r.get('port') or ''
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


def main():
    global ARGS
    ap = argparse.ArgumentParser(description='Passerelle Céleste ↔ télescope')
    ap.add_argument('--port', type=int, default=8765); ap.add_argument('--https', action='store_true'); ap.add_argument('--local-only', action='store_true')
    ap.add_argument('--allow-origin', action='append', default=['https://memecoinsphere.github.io'])
    ap.add_argument('--lat', type=float, default=46.16); ap.add_argument('--lon', type=float, default=-1.15); ap.add_argument('--sim-speed', type=float, default=8.0); ap.add_argument('-v', '--verbose', action='store_true')
    ARGS = ap.parse_args()
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1' if ARGS.local_only else '0.0.0.0', ARGS.port), H); httpd.daemon_threads = True
    scheme = 'http'
    if ARGS.https:
        cert, key = os.path.join(HERE, 'cert.pem'), os.path.join(HERE, 'key.pem')
        if not (os.path.exists(cert) and os.path.exists(key)):
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '365', '-subj', '/CN=celeste.local'], check=True)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key); httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True); scheme = 'https'
    threading.Thread(target=janitor, daemon=True).start()
    ip = lan_ip()
    print(f'Passerelle Céleste v{VERSION}')
    print(f'  Sur le téléphone (même Wi-Fi) : {scheme}://{ip}:{ARGS.port}/   — puis Calques › Télescope › liaison « Passerelle PC »')
    print(f'  Sur ce PC : {scheme}://localhost:{ARGS.port}/')
    print(f'  Ports série : {", ".join(p["device"] for p in ports_list()) or ("aucun" if HAVE_SERIAL else "pyserial absent (pip install pyserial)")}')
    print('  Ctrl+C pour arrêter.')
    try: httpd.serve_forever()
    except KeyboardInterrupt: print('\nArrêt.')


if __name__ == '__main__':
    main()
