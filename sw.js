/* Fill & Sign service worker — offline shell + Android share-target intake. */
const V = 'fillandsign-v4';
const SHARE = 'fillandsign-share';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'tools.html', 'site.css', 'shrink.html', 'shrink.css', 'shrink.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/shrink.svg',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js',
  'vendor/caveat.woff2', 'vendor/dancing.woff2',
  'vendor/peerjs.min.js', 'vendor/qrcode.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== V && k !== SHARE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // A PDF shared into Fill & Sign from another app.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const file = fd.get('file');
        if (file) {
          const c = await caches.open(SHARE);
          await c.put('shared.pdf', new Response(file, {
            headers: { 'X-Name': encodeURIComponent(file.name || 'Shared.pdf') },
          }));
        }
      } catch (_) {}
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  /* The libraries and the icons never change without changing their name, so
     serving those from the cache is free. The app itself is a different
     matter: cache-first handed everyone the *previous* build on every visit
     and only picked up a fix on the visit after, which meant a bug could be
     fixed and still be there the next morning. So the app asks the network
     first and falls back to the cache, which keeps it working offline while
     making a plain refresh enough to get the current version. */
  const frozen = /\/(vendor|icons)\//.test(url.pathname) ||
                 url.pathname.endsWith('.woff2') || url.pathname.endsWith('.webmanifest');

  e.respondWith((async () => {
    if (frozen) {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
    }
    try {
      const r = await fetch(e.request);
      if (r.ok) (await caches.open(V)).put(e.request, r.clone());
      return r;
    } catch (_) {
      return (await caches.match(e.request, { ignoreSearch: true })) ||
             (await caches.match('index.html')) || Response.error();
    }
  })());
});
