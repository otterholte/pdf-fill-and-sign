/* Fill & Sign service worker — offline shell + Android share-target intake. */
const V = 'fillandsign-v2';
const SHARE = 'fillandsign-share';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'tools.html', 'site.css', 'shrink.html', 'shrink.css', 'shrink.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/shrink.svg',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', 'vendor/pdf-lib.min.js',
  'vendor/caveat.woff2', 'vendor/dancing.woff2',
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

  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    if (cached) {
      fetch(e.request).then(r => { if (r.ok) caches.open(V).then(c => c.put(e.request, r.clone())); }).catch(() => {});
      return cached;
    }
    try {
      const r = await fetch(e.request);
      if (r.ok) (await caches.open(V)).put(e.request, r.clone());
      return r;
    } catch (_) {
      return (await caches.match('index.html')) || Response.error();
    }
  })());
});
