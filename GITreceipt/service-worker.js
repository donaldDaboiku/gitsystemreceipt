const CACHE = "receipt-v11";

const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./db.js",
  "./firebase-sync.js",
  "./manifest.json",
  "./vendor/html2canvas.min.js",
  "./vendor/jspdf.umd.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg"
];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES))
  );
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
    const cachedResponse = await caches.match(e.request);
    if (cachedResponse) {
      return cachedResponse;
    }

    try {
      const networkResponse = await fetch(e.request);
      if (e.request.method === "GET") {
        const cache = await caches.open(CACHE);
        cache.put(e.request, networkResponse.clone());
      }
      return networkResponse;
    } catch (error) {
      console.error("Fetch failed:", error);
      throw error;
    }
  })());
});
