/* Woordjes service worker — offline cache for the PWA.
   Note: service workers only register over HTTPS or localhost. Over a plain-http
   Wi-Fi IP (v0 testing) the app still works fully online; offline install kicks in
   once the app is served over HTTPS (a later deploy step). */
const CACHE = 'woordjes-v0-1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/engine.js',
  './js/app.js',
  './data/words.json',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached ||
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
