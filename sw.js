// MAXGEAR service worker: versioned precache for offline play + install.
//
// Update model ("opt-in"): bump VERSION on every deploy. The page registers
// with { updateViaCache: 'none' } and calls reg.update() on load, so a changed
// sw.js is detected at launch and the new cache is precached in the background.
// The new worker then WAITS: main.js shows an "update ready" button on the
// title screen, and only that tap sends SKIP_WAITING. When the new worker
// takes control, main.js reloads — only ever from the title screen.
// GET_VERSION lets the page display the version that is actually serving it.
//
// All paths are RELATIVE so the app works from a GitHub Pages subpath.

const VERSION = 'v1.5.2'; // title version tag + user opt-in updates
const CACHE = `maxgear-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/audio.js',
  './js/bulletStyle.js',
  './js/campaign.js',
  './js/collisions.js',
  './js/config.js',
  './js/effects.js',
  './js/enemies.js',
  './js/gates.js',
  './js/icons.js',
  './js/input.js',
  './js/level.js',
  './js/main.js',
  './js/obstacles.js',
  './js/pickups.js',
  './js/player.js',
  './js/previews.js',
  './js/projectiles.js',
  './js/render.js',
  './js/saves.js',
  './js/ui.js',
  './js/upgrades.js',
  './js/utils.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  // No skipWaiting() here: after precaching, the new worker stays WAITING
  // until the user accepts the update from the title screen.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'GET_VERSION' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
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
