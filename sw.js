/* Service worker (actif uniquement en HTTPS/localhost) : mise en cache hors ligne de l'application. */
const CACHE = 'celeste-v14';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'skydata.js', 'astronomy.browser.min.js', 'satellite.min.js', 'extreme.js', 'messier.js', 'telescope.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'celeste-tle' && k !== 'celeste-rappels').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.hostname === 'celestrak.org') { // orbites : réseau d'abord, dernière copie en secours
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open('celeste-tle').then(c => c.put(e.request, cp)); } return r; }).catch(() => caches.open('celeste-tle').then(c => c.match(e.request)).then(r => r || Response.error())));
    return;
  }
  if (u.origin !== location.origin) return; // Open-Meteo : réseau direct
  if (e.request.method !== 'GET' || u.pathname.includes('/api/')) return; // passerelle télescope : jamais en cache
  if (/\/deepsky\.json(\.gz)?$/.test(u.pathname)) { // catalogue NGC/IC : chargé à la demande puis gardé hors ligne
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { if (n.ok) c.put(e.request, n.clone()); return n; }))));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
/* Rappels (sans serveur push) : clic sur une notification → ouvre l'événement ; synchronisation périodique (Chrome Android, app installée) */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const ev = e.notification.data && e.notification.data.ev, url = new URL(ev ? './?ev=' + encodeURIComponent(ev) : './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) { if (ev) c.postMessage({ type: 'rappel-open', ev }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
function rappelsCheck() {
  const key = new URL('rappels.json', self.registration.scope).href;
  return caches.open('celeste-rappels').then(c => c.match(key).then(r => r ? r.json() : null).then(d => {
    if (!d || !d.on || !d.sched) return;
    const now = Date.now(), sent = d.sent || {}, jobs = [];
    for (const ev of d.sched) {
      if (ev.t < now - 1800000) continue;
      const due = (d.leads || [60]).filter(m => now >= ev.t - m * 60000); if (!due.length) continue;
      const m = Math.min(...due); if (sent[ev.id + '|' + m]) continue;
      (d.leads || []).forEach(L => { if (L >= m) sent[ev.id + '|' + L] = now; });
      const mins = Math.round((ev.t - now) / 60000), when = mins >= 1440 ? (mins < 2160 ? 'Demain' : 'Dans ' + Math.round(mins / 1440) + ' jours') : mins >= 60 ? 'Dans ' + Math.round(mins / 60) + ' h' : mins > 1 ? 'Dans ' + mins + ' min' : 'Maintenant';
      jobs.push(self.registration.showNotification(ev.title, { body: when + ' · ' + ev.body, tag: ev.id, icon: 'icon.svg', data: { ev: ev.id, t: ev.t }, lang: 'fr' }));
    }
    d.sent = sent;
    return Promise.all(jobs).then(() => c.put(key, new Response(JSON.stringify(d), { headers: { 'Content-Type': 'application/json' } })));
  })).catch(() => {});
}
self.addEventListener('periodicsync', e => { if (e.tag === 'celeste-rappels') e.waitUntil(rappelsCheck()); });
