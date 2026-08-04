// MAXGEAR service worker: versioned precache for offline play + install.
//
// Update model ("updated on launch"): bump VERSION on every deploy. The page
// registers with { updateViaCache: 'none' } and calls reg.update() on load, so
// a changed sw.js is detected at launch, the new cache is precached in the
// background, skipWaiting()/clients.claim() switch over, and main.js reloads
// the page — but only while on the title screen, never mid-run.
//
// All paths are RELATIVE so the app works from a GitHub Pages subpath.

const VERSION = 'v1.0.0';
const CACHE = `maxgear-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/audio.js',
  './js/collisions.js',
  './js/config.js',
  './js/effects.js',
  './js/enemies.js',
  './js/gates.js',
  './js/input.js',
  './js/level.js',
  './js/main.js',
  './js/obstacles.js',
  './js/pickups.js',
  './js/player.js',
  './js/projectiles.js',
  './js/render.js',
  './js/ui.js',
  './js/utils.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('maxgear-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  // Cache-first from the current versioned precache: every file in a session
  // comes from ONE deploy (no module version skew). New versions arrive as a
  // whole new cache via the install/activate flow above.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
    })
  );
});
