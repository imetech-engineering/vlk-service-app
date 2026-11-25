// Service worker: app offline beschikbaar (op locatie vaak geen bereik). Versie ophogen bij elke release.
const CACHE = 'vlk-service-v0.3.4';
const FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/vlk.js', 'js/endstop.js', 'js/chart.js',
  'js/smp.js', 'js/icons.js', 'js/eindtest.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// eerst netwerk (nieuwste versie), anders cache
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
