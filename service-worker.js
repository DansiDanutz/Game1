/* Service worker for Shikaku PWA.
   Goal: installable + offline-capable, but NEVER stale. The site deploys often,
   so we use NETWORK-FIRST for everything: when online the browser always gets
   the freshest file and we refresh the cache; when offline we fall back to the
   cached copy. A versioned cache is wiped on activate, and we skipWaiting +
   claim so a new version takes over immediately (the page auto-reloads once via
   the controllerchange listener in app.js). */
const VERSION = 'shikaku-v4';
const SHELL = [
  './', './index.html',
  './css/styles.css',
  './js/config.js', './js/cloud.js', './js/levels.js',
  './js/puzzle.js', './js/effects.js', './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  // If the required shell cannot be cached, reject installation so the browser
  // keeps the last known-good worker instead of activating a broken offline app.
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // let cross-origin (Supabase, CDN) pass through

  // Network-first: fresh when online, cached fallback when offline. Keep the
  // event alive until a successful network response is persisted; otherwise a
  // browser may suspend the worker before the offline cache is refreshed.
  const networkResponse = fetch(req);
  e.waitUntil(
    networkResponse.then(res => {
      if (!res || res.status !== 200) return;
      // Clone before awaiting cache access: respondWith may start consuming the
      // original body while caches.open is still pending.
      const copy = res.clone();
      return caches.open(VERSION).then(c => c.put(req, copy));
    }).catch(() => undefined)
  );
  e.respondWith(
    networkResponse.catch(() => caches.match(req)
      .then(c => c || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
