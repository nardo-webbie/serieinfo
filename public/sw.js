// Minimal service worker — maakt de app installeerbaar als PWA
// en laat Share Target werken op Android/iOS

const CACHE = "serieinfo-v2"; // bumped to force old cached clients to refresh
const SHELL = ["/", "/index.html"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network first, cache fallback — API calls gaan altijd live
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // API calls en externe requests: altijd network
  if (url.pathname.startsWith("/api/") || url.origin !== location.origin) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell: network first, cache fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("/index.html")))
  );
});
