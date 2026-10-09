/* Service worker: guscio dell'app in cache (avvio rapido + installabilità).
   Le chiamate al backend (POST verso script.google.com) NON passano dalla cache. */
const CACHE = 'ventas-v__BUILD__';
const SHELL = ['./', 'index.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mismoOrigen = url.origin === self.location.origin;
  if (!mismoOrigen && !req.url.startsWith(CDN)) return;   // Drive, Apps Script, ecc.: rete diretta

  // Pagine: prima la rete (così si vedono subito i nuovi deploy), cache come ripiego offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      const copia = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copia)); return r;
    }).catch(() => caches.match('index.html')));
    return;
  }
  // Risorse statiche: cache + aggiornamento in background
  e.respondWith(caches.match(req).then(hit => {
    const rete = fetch(req).then(r => {
      if (r && (r.ok || r.type === 'opaque')) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
      return r;
    }).catch(() => hit);
    return hit || rete;
  }));
});
