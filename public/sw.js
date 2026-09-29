// The panel's service worker. It makes the panel installable as a phone app, and shows a friendly
// page when the panel can't be reached, for example away from home without the VPN.
//
// It never serves old copies of the panel or its data: everything comes straight from the server,
// and only the offline page is kept, for when the server can't be reached.

const CACHE = 'wiserheat-offline-v1';
const KEEP = ['offline.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(KEEP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // everything else goes straight to the network
  event.respondWith(fetch(event.request).catch(() => caches.match('offline.html')));
});
