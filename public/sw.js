const CACHE_NAME = "codex-remote-shell-v42";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=29",
  "/boot.js?v=12",
  "/app.js?v=34",
  "/display-timezone.js?v=1",
  "/markdown.js?v=15",
  "/slash-menu.js?v=16",
  "/manifest.webmanifest?v=15",
  "/icon-192.png?v=13",
  "/icon-512.png?v=13",
  "/icon-512-maskable.png?v=13",
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
  if (url.origin !== self.location.origin) return;

  const isAppRoot = url.pathname === "/" || url.pathname === "/index.html";
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (isAppRoot && response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => isAppRoot
          ? caches.match("/").then((cached) => cached ?? Response.error())
          : Response.error()),
    );
    return;
  }

  if (!APP_SHELL.includes(`${url.pathname}${url.search}`)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});
