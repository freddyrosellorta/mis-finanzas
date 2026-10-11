// Funciona sin conexión. La app se pide primero a internet con un límite de 3 s (así cada actualización
// se ve al abrirla); si no hay red o tarda, se usa la copia guardada. Las llamadas a GitHub no pasan por aquí.
const CACHE = 'finanzas-v7';
const FILES = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'js/engine.js', 'js/store.js', 'js/sync.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-512.png'];
const TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true })
    .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') .then((r) => r || caches.match('index.html')) : undefined))
    .then((hit) => hit || Response.error());
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const fallback = () => { if (!done) { done = true; resolve(fromCache(req)); } };
    const timer = setTimeout(fallback, TIMEOUT);
    // Una navegación no admite opciones extra al volver a pedirla: se pide tal cual.
    const net = req.mode === 'navigate' ? fetch(req) : fetch(req.url, { cache: 'no-cache' });
    net.then((res) => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      if (!done) { done = true; resolve(res.ok ? res : fromCache(req).then((c) => (c.type === 'error' ? res : c))); }
    }).catch(() => { clearTimeout(timer); fallback(); });
  }));
});
