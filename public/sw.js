/**
 * Offline shell for lightdb.
 *
 * Two rules, and getting either wrong bricks the app on the next deploy:
 *
 * 1. HTML is network-first. index.html names content-hashed asset files. Serve
 *    a cached copy after a redeploy and it points at hashes that no longer
 *    exist on the server -- every one 404s and the page renders blank with no
 *    error a user can see. Cache-first is only safe for the immutable assets.
 *
 * 2. Precache failures must not be fatal. `cache.addAll` rejects atomically on
 *    a single 404, aborting the install event and leaving nothing cached at
 *    all. For an app whose whole premise is working with no network, that is
 *    the worst possible outcome, so assets are added individually.
 */

// Bump on any change to caching behaviour. Activation purges every other cache,
// which is what rescues clients holding a bad one.
const CACHE_NAME = 'lightdb-v2';

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

/** Network-first: always prefer fresh HTML, fall back to cache when offline. */
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put('./index.html', response.clone());
    }
    return response;
  } catch {
    // Offline. Any cached shell will do; the router works from the URL.
    return (
      (await cache.match(request)) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      Response.error()
    );
  }
}

/** Cache-first: assets carry a content hash, so a hit is never stale. */
async function handleAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    request.mode === 'navigate' ? handleNavigation(request) : handleAsset(request)
  );
});
