const CACHE = "receipt-v21";

const FILES = [
  "./",
  "./index.html",
  "./app.html",
  "./style.css?v=21",
  "./firebase-config.js?v=19",
  "./subscription.js?v=21",
  "./account.js?v=21",
  "./app.js?v=21",
  "./db.js?v=15",
  "./firebase-sync.js?v=21",
  "./manifest.json",
  "./vendor/html2canvas.min.js",
  "./vendor/jspdf.umd.min.js",
  "./icons/favicon.ico",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(FILES.map(async (url) => {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (!response.ok) throw new Error("Failed to cache " + url);
      await cache.put(url, response);
    }));
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", e => {
  const requestUrl = new URL(e.request.url);
  if (requestUrl.origin !== self.location.origin) {
    e.respondWith(fetch(e.request));
    return;
  }

  e.respondWith((async () => {
    try {
      const networkResponse = await fetch(e.request);
      if (e.request.method === "GET" && networkResponse.ok) {
        const cache = await caches.open(CACHE);
        cache.put(e.request, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      const cachedResponse = await caches.match(e.request);
      if (cachedResponse) return cachedResponse;
      throw error;
    }
  })());
});
