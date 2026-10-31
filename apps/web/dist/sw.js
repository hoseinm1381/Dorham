const CACHE = 'dorham-shell-f62a15101af3';
const SHELL = ["./","./icon.svg","./icon-192.png","./icon-512.png","./manifest.webmanifest","./assets/index-x9NPctVC.js","./assets/index-DPmjjShL.css","./assets/livekit-CE0wJGYJ.js","./assets/mesh-DIx4MSD0.js","./assets/native-DrUZr5bt.js","./assets/Vazirmatn-Variable-BeciDpKm.woff2","./profile-pictures/alien.webp","./profile-pictures/astronaut.webp","./profile-pictures/bear.webp","./profile-pictures/bot.webp","./profile-pictures/cat.webp","./profile-pictures/comet.webp","./profile-pictures/cyborg.webp","./profile-pictures/fox.webp","./profile-pictures/frog.webp","./profile-pictures/owl.webp","./profile-pictures/panda.webp","./profile-pictures/penguin.webp","./profile-pictures/planet.webp","./profile-pictures/rabbit.webp","./profile-pictures/retro.webp","./profile-pictures/robot.webp","./audio/rnnoise-worklet.js","./audio/rnnoise.wasm"];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))); self.clients.claim(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/avatars/')) return;
  if (!event.request.mode.includes('navigate') && !url.pathname.includes('/assets/') && !url.pathname.startsWith('/profile-pictures/') && !url.pathname.startsWith('/audio/') && !['/icon.svg', '/manifest.webmanifest', '/'].includes(url.pathname)) return;
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
