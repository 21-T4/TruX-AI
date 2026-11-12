/* TruX service worker.
 * - HTML, /js/ and /css/ are network-first so a deploy is picked up on the next load.
 * - Icons and other static files are stale-while-revalidate.
 * - /api/ is never touched.
 * - Push messages from FCM are shown directly from the raw `push` event, so the
 *   worker doesn't need to load the Firebase SDK or embed any config. */
const CACHE_NAME = 'trux-ai-v46';
const ASSETS_TO_CACHE = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function readPush(event) {
  if (!event.data) return {};
  try { return event.data.json() || {}; } catch { return { notification: { body: event.data.text() } }; }
}

self.addEventListener('push', (event) => {
  const payload = readPush(event);
  const data = payload.data || {};
  const note = payload.notification || {};
  const title = note.title || data.title || 'TruX';
  const body = note.body || data.body || 'Your response is ready.';
  const url = data.url || payload.fcmOptions?.link || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Skip the notification when TruX is already open and visible.
      if (clients.some((c) => c.visibilityState === 'visible')) return undefined;
      return self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.chatId ? 'trux-chat-' + data.chatId : 'trux-response',
        renotify: true,
        data: { url }
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  const targetUrl = event.notification?.data?.url || '/';
  event.notification?.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => 'focus' in client);
      if (existing) {
        existing.focus();
        if ('navigate' in existing && targetUrl) return existing.navigate(targetUrl);
        return existing;
      }
      return self.clients.openWindow ? self.clients.openWindow(targetUrl) : undefined;
    })
  );
});

function networkFirst(request) {
  return fetch(new Request(request, { cache: 'no-cache' }))
    .then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => cached || Response.error()));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  const isDocument = request.mode === 'navigate' || request.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isDocument) {
    // Never serve a stale shell: a cached index.html could point at old scripts.
    event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
    return;
  }
  if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
