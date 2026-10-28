const CACHE = 'dorham-shell-3ee5affdffc6';
const SHELL = ["./","./icon.svg","./icon-192.png","./icon-512.png","./manifest.webmanifest","./assets/index-Bn7zM33-.js","./assets/index-DD7b0Nbm.css"];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/avatars/')) return;
  if (!event.request.mode.includes('navigate') && !url.pathname.includes('/assets/') && !['/icon.svg', '/manifest.webmanifest', '/'].includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Public shell bytes are identical for every Origin; CORS Vary headers must
    // not make module-script requests miss entries populated during installation.
    const cached = await cache.match(event.request, { ignoreVary: true });
    if (event.request.mode !== 'navigate' && cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
      return response;
    } catch { return cached || (event.request.mode === 'navigate' ? await cache.match('./', { ignoreVary: true }) : undefined) || Response.error(); }
  })());
});
