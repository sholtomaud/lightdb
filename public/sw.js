/**
 * Offline shell for lightdb.
 *
 * An app whose whole premise is working without a network must survive its own
 * install failing. `cache.addAll` rejects atomically on a single 404, which
 * would abort the install event and leave nothing cached at all -- so assets
 * are cached individually and failures are logged rather than fatal.
 */

const CACHE_NAME = 'lightdb-v1';

const PRECACHE = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        PRECACHE.map(async (asset) => {
          try {
            await cache.add(asset);
          } catch (error) {
            console.warn(`[sw] precache miss: ${asset}`, error);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Cache successful same-origin GETs so a first online visit primes the app.
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        // Offline navigation falls back to the app shell so the router can run.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        throw error;
      }
    })()
  );
});
