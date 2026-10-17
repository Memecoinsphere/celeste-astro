/* Service worker (actif uniquement en HTTPS/localhost) : mise en cache hors ligne de l'application. */
const CACHE = 'celeste-v5';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'skydata.js', 'astronomy.browser.min.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // Open-Meteo : réseau direct
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
