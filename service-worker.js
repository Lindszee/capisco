const SHELL_CACHE = 'capisco-shell-v2';
const DATA_CACHE = 'capisco-data-v2';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/styles.css',
  'js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // JSON data (episodes/shows/translations): network-first, fall back to cache when
  // offline. This content changes often — new episodes, translations, corrections —
  // and cache-first here was the reason updates needed a manual Safari data clear to
  // ever show up. Network-first means new deploys just show up automatically.
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          const cached = await cache.match(event.request);
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Audio clips: cache-first, fall back to network. These almost never change once
  // published, so caching aggressively here is what makes cards work offline/on replay
  // without re-downloading — unlike the JSON above, staleness isn't a practical risk.
  if (url.pathname.includes('/audio/')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell: network-first, fall back to cache, so updates show up when online.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
