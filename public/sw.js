// KBS School service worker: makes both apps installable and opens quickly.
//
// Records always come live from the server; nothing private is cached.
// - Pages and app files: network first, so updates arrive at once; a saved
//   copy is used only when the phone is offline.
// - Fonts and icons: cached (they rarely change).
// - /api, receipts and downloads: never cached.
// - No connection and no saved copy: a friendly offline page.

const VERSION = 'kbs-v1';
const SHELL = [
  '/',
  '/admin',
  '/offline.html',
  '/css/base.css',
  '/css/parent.css',
  '/css/admin.css',
  '/logo-64.png',
  '/logo-192.png',
  '/icon-512.png',
  '/fonts/dm-sans-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const NEVER_CACHE = /^\/(api|receipts|r)\//;
const LONG_LIVED = /^\/(fonts\/|logo|icon-)/;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname) || url.pathname === '/healthz') return;

  if (LONG_LIVED.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) caches.open(VERSION).then((cache) => cache.put(request, response.clone()));
            return response;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') {
          // A page in one of the apps: its shell, or the offline page.
          const shell = await caches.match(url.pathname.startsWith('/admin') ? '/admin' : '/');
          return shell || (await caches.match('/offline.html')) || Response.error();
        }
        return Response.error();
      }),
  );
});
