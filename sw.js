/* Arda Güler bildirim PWA - service worker */
const CACHE = 'ag-shell-v2';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/badge-96.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App shell: önce ağ (güncellemeler hemen gelsin), çevrimdışıysa önbellek. API çağrıları (başka origin): dokunma.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(e.request);
        if (res && res.ok) cache.put(e.request, res.clone());
        return res;
      } catch (_) {
        const cached = await cache.match(e.request, { ignoreSearch: true });
        return cached || Response.error();
      }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.focus();
          if (target && target !== './') c.postMessage({ type: 'OPEN_URL', url: target });
          return;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// Web Push (ileride bir push sunucusu bağlanırsa hazır)
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Arda Güler', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      vibrate: [200, 100, 200, 100, 400],
      data: { url: data.url || './' }
    })
  );
});
