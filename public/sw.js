const CACHE_NAME = "codex-remote-shell-v18";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=16",
  "/boot.js?v=12",
  "/app.js?v=16",
  "/markdown.js?v=12",
  "/slash-menu.js?v=12",
  "/manifest.webmanifest?v=13",
  "/icon.svg?v=12",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === "/healthz") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) =>
        cached ?? new Response("当前无法连接 VPS。", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      )),
  );
});
