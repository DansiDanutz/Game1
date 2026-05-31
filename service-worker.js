/* Service worker for Shikaku PWA.
   Goal: make the app installable + work offline, WITHOUT ever trapping users on
   a stale build (the site auto-deploys often). Strategy:
     - navigations (HTML): network-first, fall back to cached shell when offline
     - same-origin GET assets: stale-while-revalidate (fast, self-healing)
   A versioned cache is wiped on activate so old assets don't linger. */
const VERSION = 'shikaku-v2';
const SHELL = [
  './', './index.html',
  './css/styles.css',
  './js/config.js', './js/cloud.js', './js/levels.js',
  './js/puzzle.js', './js/effects.js', './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // let cross-origin (Supabase, CDN) pass through

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => { caches.open(VERSION).then(c => c.put('./index.html', res.clone())); return res; })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => {
      const live = fetch(req).then(res => {
        if (res && res.status === 200) caches.open(VERSION).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || live;
    })
  );
});
