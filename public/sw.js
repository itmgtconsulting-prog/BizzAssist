const CACHE_NAME = 'bizzassist-v3';

// Only cache truly static assets — never cache HTML pages or auth-protected routes.
const STATIC_ASSETS = ['/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Delete ALL old caches on activation (forces clean slate)
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Network-first for all same-origin HTML navigations (pages).
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
    return;
  }

  // In development: always network-first to avoid stale chunk errors.
  // Turbopack chunk filenames can collide across rebuilds, causing
  // "module factory is not available" runtime errors (e.g. AlertTriangle bug).
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Production: cache-first for content-hashed static chunks.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Network-first for everything else (API calls, external tiles, etc.)
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((c) => c || Response.error()))
  );
});
