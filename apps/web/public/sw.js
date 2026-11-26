const CACHE = 'dorham-shell-v1';
const SHELL = ['__DORHAM_PRECACHE__'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Retain one prior Dorham shell for tabs that loaded before this worker.
    const older = (await caches.keys()).filter(key => key.startsWith('dorham-shell-') && key !== CACHE);
    await Promise.all(older.slice(0, -1).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/avatars/')) return;
  if (!event.request.mode.includes('navigate') && !url.pathname.includes('/assets/') && !url.pathname.startsWith('/emojis/') && !url.pathname.startsWith('/profile-pictures/') && !url.pathname.startsWith('/audio/') && !['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest', '/'].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Public shell bytes are identical for every Origin; CORS Vary headers must
    // not make module-script requests miss entries populated during installation.
    let cached = await cache.match(event.request, { ignoreVary: true });
    if (!cached && url.pathname.includes('/assets/')) {
      const previous = (await caches.keys()).find(key => key.startsWith('dorham-shell-') && key !== CACHE);
      if (previous) cached = await (await caches.open(previous)).match(event.request, { ignoreVary: true });
    }
    if (event.request.mode !== 'navigate' && cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
      return response;
    } catch { return cached || (event.request.mode === 'navigate' ? await cache.match('./', { ignoreVary: true }) : undefined) || Response.error(); }
  })());
});
