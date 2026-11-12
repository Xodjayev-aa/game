/* RoFrontier service worker — offline-first app shell.
 * - install: pre-cache the complete shell (no network required on first offline launch)
 * - navigation: network-first with an instant cached index.html fallback
 * - static assets: stale-while-revalidate (fresh in background, cached copy is instant)
 * - never intercepts WebSocket upgrades, non-GET requests or cross-origin calls
 */
const VERSION = 'rofrontier-v1.3.1';
const CACHE = `rofrontier-shell-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './admin.js',
  './free-relay.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache each item independently so a single 404 cannot break installation.
    await Promise.all(SHELL.map(async (path) => {
      try {
        await cache.add(new Request(new URL(path, self.registration.scope), { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] could not pre-cache', path, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('rofrontier-shell-') && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/ws') || request.headers.get('upgrade') === 'websocket') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, event));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put('./index.html', fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match('./index.html') || await cache.match('./');
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="background:#070b14;color:#eef6ff;font:16px system-ui;padding:24px">RoFrontier is offline. Reconnect once to install the offline cache.</body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then(async (response) => {
    if (response && response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  if (cached) {
    // Refresh in the background while the cached copy is served instantly.
    try { event.waitUntil(network); } catch (_) { /* older engines */ }
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  return new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(data.urls.map((u) => cache.add(u).catch(() => null)));
    })());
  }
  if (data.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: VERSION });
  }
});

// Optional: show a notification for the daily challenge reminder if the browser
// ever delivers a push (no push subscription is created by the client).
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { /* ignore */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'RoFrontier', {
    body: payload.body || 'Your daily challenges are ready, Commander.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'rofrontier-daily'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => clients[0] ? clients[0].focus() : self.clients.openWindow('./')));
});
