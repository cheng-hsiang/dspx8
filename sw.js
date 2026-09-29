const VERSION = '0.1.0';
const CACHE = `dspx8s-${VERSION}`;
const PRECACHE = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './icons/icon-192.png', './icons/icon-512.png',
  './js/ui/app.js', './js/ui/statusbar.js', './js/ui/components/dialog.js', './js/ui/components/regtable.js',
  './js/ui/pages/bluetooth.js', './js/ui/pages/sound.js', './js/ui/pages/eq.js', './js/ui/pages/modes.js', './js/ui/pages/log.js',
  './js/core/logger.js', './js/core/store.js', './js/core/queue.js', './js/core/device.js', './js/core/report.js', './js/core/storage.js',
  './js/transport/transport.js', './js/transport/ble.js', './js/transport/fake-device.js',
  './js/protocol/crc16.js', './js/protocol/frame.js', './js/protocol/codec.js', './js/protocol/tables.js', './js/protocol/addrmap.js', './js/protocol/commands.js', './js/protocol/summary.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'cached', version: VERSION });
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
    const clients = await self.clients.matchAll();
    for (const c of clients) c.postMessage({ type: 'cached', version: VERSION });
  })());
});

self.addEventListener('message', (event) => { if (event.data?.type === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await cache.match('./index.html');
      if (fallback && req.mode === 'navigate') return fallback;
      throw err;
    }
  })());
});
