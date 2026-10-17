/*
 * Always fetch HTML from the origin; content-versioned scripts and styles can remain cached long term.
 * Frontend changes do not require bumping this name; change it only when the service-worker cache format changes.
 * Sessions, authentication, and file contents never enter the cache. There are no push or background notifications.
 * Keep versioned assets referenced by the current and previous offline pages, and clean up the rest after each switch.
 */
const CACHE_NAME = "codex-remote-shell-v43";
const ASSET_PATH = /^\/assets\/[a-f0-9]{64}\/[a-zA-Z0-9_.-]+\.(?:js|css)$/;
const ICONS = [
  "/icon.svg",
  "/logo.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(fetch(new URL("/", self.location.origin), { cache: "no-cache" }).then((response) => {
    if (!response.ok) throw new Error("Offline page could not be installed");
    return saveOfflinePage(response);
  }));
});

// Do not forcibly take over existing pages; ordinary navigation can load the new versioned URLs.
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("codex-remote-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)),
  )));
});

async function versionedAsset(request) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
  } catch (error) {
    console.warn("Offline cache is unavailable", error);
  }
  const response = await fetch(request);
  if (response.ok && cache) {
    try { await cache.put(request, response.clone()); }
    catch (error) { console.warn("Resource could not be saved offline", error); }
  }
  return response;
}

function offlineAssets(html) {
  const list = /<meta name="codex-remote-assets" content="([^"]*)">/.exec(html);
  if (!list || !list[1]) return null;
  const assets = list[1].split(",");
  return assets.every((asset) => ASSET_PATH.test(asset)) ? assets : null;
}

// Switch the offline page only once at a time so one cleanup cannot delete assets just validated by another.
let offlineUpdate = Promise.resolve();

function saveOfflinePage(response) {
  const update = offlineUpdate.then(() => replaceOfflinePage(response));
  offlineUpdate = update.catch(() => {});
  return update;
}

async function replaceOfflinePage(response) {
  const assets = offlineAssets(await response.clone().text());
  if (!assets) return;
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(assets.map(async (asset) => {
    const resource = await versionedAsset(new Request(new URL(asset, self.location.origin)));
    if (!resource.ok || !await cache.match(asset)) throw new Error("Offline resources are incomplete");
  }));
  const previous = await cache.match("/");
  const previousAssets = previous ? offlineAssets(await previous.text()) ?? [] : [];
  // Switch the offline HTML last so any failed script download retains the previous complete page.
  await cache.put("/", response);
  // Keep only the new offline page and the set it replaced; no page references older versioned assets.
  const keep = new Set([...assets, ...previousAssets].map((asset) => new URL(asset, self.location.origin).href));
  try {
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      if (ASSET_PATH.test(url.pathname) && !keep.has(url.href)) await cache.delete(request);
    }
  } catch (error) {
    console.warn("Old offline resources could not be removed", error);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const isAppRoot = url.pathname === "/" || url.pathname === "/index.html";
  if (request.mode === "navigate") {
    const network = fetch(request, { cache: "no-cache" });
    if (isAppRoot) {
      event.waitUntil(network.then((response) => response.ok ? saveOfflinePage(response.clone()) : undefined)
        .catch((error) => console.warn("Offline page could not be updated", error)));
    }
    event.respondWith(network.catch(async () => {
      if (!isAppRoot) return Response.error();
      const cache = await caches.open(CACHE_NAME);
      return await cache.match("/") ?? Response.error();
    }));
    return;
  }

  if (ASSET_PATH.test(url.pathname)) {
    const response = versionedAsset(request);
    event.respondWith(response);
    event.waitUntil(response.then(() => {}, () => {}));
    return;
  }

  if (ICONS.includes(url.pathname)) {
    const response = (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(request, { cache: "no-cache" });
        if (fresh.ok) await cache.put(request, fresh.clone());
        return fresh;
      } catch {
        return await cache.match(request) ?? Response.error();
      }
    })();
    event.respondWith(response);
    event.waitUntil(response.then(() => {}, () => {}));
  }
});
