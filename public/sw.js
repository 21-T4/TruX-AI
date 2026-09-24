const CACHE_NAME = 'trux-ai-v4';

try {
  importScripts(
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js'
  );

  firebase.initializeApp({
    apiKey: "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
    authDomain: "trux-ai.firebaseapp.com",
    projectId: "trux-ai",
    storageBucket: "trux-ai.firebasestorage.app",
    messagingSenderId: "59313097411",
    appId: "1:59313097411:web:32e4158bfb733fa7cfb076"
  });

  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const title = payload?.notification?.title || 'TruX-AI';
    const body = payload?.notification?.body || 'Your response is ready.';
    const url = payload?.data?.url || '/';

    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload?.data?.jobId ? 'trux-job-' + payload.data.jobId : 'trux-response',
      renotify: true,
      data: { url }
    });
  });
} catch {
  // Push messaging is optional; offline caching must continue to work if it is unavailable.
}

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install and pre-cache the shell. Failures on individual assets must not
// abort the whole install, otherwise a single 404 leaves the app uncached.

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
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    })
  );
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

// Activate and remove old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET' || request.url.includes('/api/')) return;

  const url = new URL(request.url);
  const isDocument =
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html');

  /* HTML: NETWORK FIRST.
     This used to be cache-first, which meant a freshly deployed UI only
     appeared on the *second* visit after an update. Now the newest markup
     wins whenever the network is available, and the cache is only a
     fallback for offline use. */
  if (isDocument) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
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
