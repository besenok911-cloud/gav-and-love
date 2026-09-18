/* GAV&LOVE — service worker for the CRM / master / client cabinets (PWA).
   Strategy: HTML = network first (fresh code, cache as offline fallback);
   own static assets = cache first; API (Worker) is never cached. */
const VERSION = "v1";
const CACHE = "gavlove-app-" + VERSION;
const SHELL = [
  "admin.html", "master.html", "cabinet.html",
  "assets/brand/logo.svg", "assets/favicon.svg",
  "assets/app/icon-192.png", "assets/app/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // API, fonts, Telegram: straight to network
  const isHtml = req.mode === "navigate" || /\.html$/.test(url.pathname);
  if (isHtml) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // Only the small app shell assets are cached; gallery photos/videos of the public site are left to the browser.
  if (/\/assets\/(brand|app)\//.test(url.pathname) || /\/(assets\/favicon\.svg|[a-z]+\.webmanifest)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
  }
});
