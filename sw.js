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

const VERSION = 'v1.6.4'; // cached shells learn the arcade moved to gophercloud.games
const CACHE = `maxgear-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  // Has to be IN the cache, not merely deployed: the players this rescues
  // are the ones whose browser has stopped asking this origin for anything.
  './moved.js',
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
  // v1.6 effects: thirteen files, 168 KB for the set, so they precache with
  // everything else and the first clank of a session is never late.
  './assets/audio/shoot.m4a',
  './assets/audio/hit.m4a',
  './assets/audio/enemy-die.m4a',
  './assets/audio/explode.m4a',
  './assets/audio/hurt.m4a',
  './assets/audio/pickup.m4a',
  './assets/audio/gate-good.m4a',
  './assets/audio/gate-bad.m4a',
  './assets/audio/gate-charge.m4a',
  './assets/audio/boss-roar.m4a',
  './assets/audio/win.m4a',
  './assets/audio/lose.m4a',
  './assets/audio/click.m4a',
];

// The music bed is deliberately NOT in ASSETS. It is 2.9 MB against 1.1 MB for
// everything listed above put together, and install blocks on every entry in
// that list, so precaching it would stall each version bump behind a download on
// whatever connection the player happens to be on. The fetch handler below
// caches it on first play instead, which costs one uncached launch of music
// (the game runs fine silent, see js/audio.js) and buys an install that stays
// as fast as it was in v1.5. It needs no special case: audio.js fetches the
// track as a plain request, so the handler's own put() covers it.

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
