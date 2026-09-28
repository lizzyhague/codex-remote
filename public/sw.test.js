import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";

const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
const origin = "https://example.test";
const version = "a".repeat(64);
const asset = `/assets/${version}/app.js`;

function harness(network, hooks = {}) {
  const handlers = {};
  const stores = new Map();
  const key = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) { entries.set(key(request), response.clone()); },
        async keys() {
          await hooks.beforeKeys?.();
          return [...entries.keys()].map((url) => new Request(url));
        },
        async delete(request) { return entries.delete(key(request)); },
      };
    },
  };
  vm.runInNewContext(source, {
    self: { location: { origin }, addEventListener(name, handler) { handlers[name] = handler; } },
    caches, fetch: network, URL, Request, Response, console: { warn() {} },
  });
  return {
    caches,
    handlers,
    async cachedPaths() {
      const entries = stores.get("codex-remote-shell-v43") ?? new Map();
      return [...entries.keys()].map((url) => new URL(url).pathname).sort();
    },
    async dispatch(request) {
      const pending = [];
      let response;
      handlers.fetch({ request, respondWith(value) { response = value; }, waitUntil(value) { pending.push(value); } });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
    async activate() {
      let pending;
      handlers.activate({ waitUntil(value) { pending = value; } });
      await pending;
    },
    async install() {
      let pending;
      handlers.install({ waitUntil(value) { pending = value; } });
      await pending;
    },
  };
}

const navigation = (pathname = "/") => ({ url: `${origin}${pathname}`, method: "GET", mode: "navigate" });

test("first installation saves a complete offline page without an extra reload", async () => {
  let offline = false;
  const worker = harness(async (request) => {
    if (offline) throw new TypeError("offline");
    return new Response(request instanceof URL
      ? `<head><meta name="codex-remote-assets" content="${asset}"></head>installed`
      : "script");
  });
  await worker.install();
  offline = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /installed$/u);
});

test("reload returns current HTML; an incomplete download preserves the complete offline page", async () => {
  let html = `<head><meta name="codex-remote-assets" content="${asset}"></head>first`;
  let offline = false;
  let failAsset = false;
  const worker = harness(async (request, options) => {
    if (offline) throw new TypeError("offline");
    if (request.mode === "navigate") {
      assert.equal(options.cache, "no-cache");
      return new Response(html);
    }
    return new Response("script", { status: failAsset ? 404 : 200 });
  });
  assert.match(await (await worker.dispatch(navigation())).text(), /first$/u);
  const nextAsset = asset.replace(version, "b".repeat(64));
  html = `<head><meta name="codex-remote-assets" content="${nextAsset}"></head>second`;
  failAsset = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /second$/u);
  offline = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /first$/u);
  assert.equal((await worker.dispatch(navigation("/icon.svg"))).type, "error");
  assert.equal(await (await worker.dispatch(new Request(`${origin}${asset}`))).text(), "script");
});

const release = (letter) => {
  const hash = letter.repeat(64);
  const assets = [`/assets/${hash}/app.js`, `/assets/${hash}/styles.css`];
  return { assets, html: `<head><meta name="codex-remote-assets" content="${assets.join(",")}"></head>release-${letter}` };
};

test("each complete release keeps only its own and the replaced offline page's resources", async () => {
  let current = release("a");
  let offline = false;
  const worker = harness(async (request) => {
    if (offline) throw new TypeError("offline");
    return new Response(request.mode === "navigate" ? current.html : "resource");
  });
  const history = ["a", "b", "c", "d"].map(release);
  for (const next of history) {
    current = next;
    assert.match(await (await worker.dispatch(navigation())).text(), new RegExp(`release-${next.html.at(-1)}$`, "u"));
    await worker.dispatch(new Request(`${origin}/icon.svg`));
  }
  assert.deepEqual(
    await worker.cachedPaths(),
    ["/", "/icon.svg", ...history[2].assets, ...history[3].assets].sort(),
  );
  offline = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /release-d$/u);
  for (const asset of history[3].assets) {
    assert.equal(await (await worker.dispatch(new Request(`${origin}${asset}`))).text(), "resource");
  }
});

test("an incomplete release removes nothing; the next complete one also clears its partial download", async () => {
  let current = release("a");
  let missing = null;
  const worker = harness(async (request) => {
    if (request.mode === "navigate") return new Response(current.html);
    return new Response("resource", { status: new URL(request.url).pathname === missing ? 404 : 200 });
  });
  const [a, b, c, d] = ["a", "b", "c", "d"].map(release);
  for (const next of [a, b]) {
    current = next;
    await worker.dispatch(navigation());
  }
  current = c;
  missing = c.assets[1];
  await worker.dispatch(navigation());
  // 不完整的 c 没有替换离线页，a、b 两套都还在，c 已下载的部分暂留。
  assert.deepEqual(await worker.cachedPaths(), ["/", ...a.assets, ...b.assets, c.assets[0]].sort());
  current = d;
  missing = null;
  await worker.dispatch(navigation());
  assert.deepEqual(await worker.cachedPaths(), ["/", ...b.assets, ...d.assets].sort());
});

test("overlapping offline page updates do not delete resources the other update just committed", async () => {
  let current = release("a");
  let gate = null;
  const worker = harness(async (request) => {
    if (request.mode === "navigate") return new Response(current.html);
    return new Response("resource");
  }, {
    // 让第一次清理停在列举缓存处，第二次导航在这期间完成。
    async beforeKeys() { if (gate) await gate.promise; },
  });
  const [b, c] = ["b", "c"].map(release);
  await worker.dispatch(navigation());
  let open;
  gate = { promise: new Promise((resolve) => { open = resolve; }) };
  current = b;
  const first = worker.dispatch(navigation());
  await delay(5);
  current = c;
  const second = worker.dispatch(navigation());
  await delay(5);
  gate = null;
  open();
  await Promise.all([first, second]);
  assert.match(await (await worker.caches.open("codex-remote-shell-v43")).match("/").then((r) => r.text()), /release-c$/u);
  assert.deepEqual(await worker.cachedPaths(), ["/", ...b.assets, ...c.assets].sort());
});

test("activation cleans only Codex Remote shell caches and private requests are never intercepted", async () => {
  const worker = harness(() => { throw new Error("must not fetch"); });
  await worker.caches.open("codex-remote-shell-v42");
  await worker.caches.open("grok-remote-shell-v31");
  await worker.activate();
  assert.deepEqual(await worker.caches.keys(), ["grok-remote-shell-v31"]);
  for (const pathname of ["/auth/session", "/raw?path=example", "/attachments/upload", "/app.js"]) {
    assert.equal(await worker.dispatch(new Request(`${origin}${pathname}`)), undefined);
  }
});

test("an unwritable cache still returns networked scripts and does not claim a complete offline page", async () => {
  const handlers = {};
  vm.runInNewContext(source, {
    self: { location: { origin }, addEventListener(name, handler) { handlers[name] = handler; } },
    caches: {
      async open() { throw new Error("quota"); },
      async keys() { return []; },
    },
    fetch: async () => new Response("live-script"),
    URL, Request, Response, console: { warn() {} },
  });
  let response;
  handlers.fetch({
    request: new Request(`${origin}${asset}`),
    respondWith(value) { response = value; },
    waitUntil() {},
  });
  assert.equal(await (await response).text(), "live-script");
});

test("the worker does not skip waiting or claim existing clients", () => {
  assert.doesNotMatch(source, /skipWaiting/u);
  assert.doesNotMatch(source, /clients\.claim/u);
});
