// Funciona sin conexión. La app se pide primero a internet (así cada actualización se ve al abrirla)
// y la copia guardada se usa solo si no hay conexión. Las llamadas a GitHub no pasan por aquí.
const CACHE = 'finanzas-v4';
const FILES = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'js/engine.js', 'js/store.js', 'js/sync.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('index.html'))),
  );
});
