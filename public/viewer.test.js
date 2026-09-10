import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { renderMarkdown } from "./markdown.js";

const viewer = (await readFile(new URL("./viewer.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/u, "")
  .replace("void loadFile()", "loadFile()");

async function view(filePath, response) {
  const elements = new Map();
  function element(tagName) {
    return {
      tagName,
      children: [],
      listeners: {},
      textContent: "",
      hidden: false,
      append(...children) { this.children.push(...children); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      setAttribute(name, value) { this[name] = value; },
    };
  }
  const document = {
    createElement: element,
    createTextNode(textContent) { return { textContent }; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element("div"));
      return elements.get(id);
    },
  };
  document.getElementById("viewer-login").hidden = true;
  const requests = [];
  await vm.runInNewContext(viewer, {
    document,
    URLSearchParams,
    location: { pathname: "/view", search: `?${new URLSearchParams({ path: filePath })}` },
    renderMarkdown: (text) => renderMarkdown(text, document),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return response;
    },
  });
  return { elements, requests };
}

test("viewer renders Markdown as DOM text and encodes special path characters", async () => {
  const file = "/projects/demo/文档 # ? %.md";
  const { elements, requests } = await view(
    file,
    new Response("# Title\n\n<script>alert(1)</script>"),
  );
  assert.equal(new URL(requests[0].url, "https://example.com").searchParams.get("path"), file);
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(elements.get("viewer-status").hidden, true);
  const markdown = elements.get("file-content").children[0];
  assert.equal(markdown.children[0].tagName, "h1");
  assert.equal(markdown.children[1].children[0].textContent, "<script>alert(1)</script>");
});

test("viewer uses an image context for SVG and retains the target on login", async () => {
  const file = "/projects/demo/image.svg";
  const shown = await view(
    file,
    new Response(null, { headers: { "content-type": "image/svg+xml" } }),
  );
  assert.equal(shown.requests[0].options.method, "HEAD");
  const image = shown.elements.get("file-content").children[0];
  assert.equal(image.tagName, "img");
  assert.equal(image.src, shown.requests[0].url);

  const denied = await view(file, new Response(null, { status: 401 }));
  assert.equal(denied.elements.get("file-content").children.length, 0);
  const login = denied.elements.get("viewer-login");
  assert.equal(login.hidden, false);
  const returnTo = new URL(login.href, "https://example.com").searchParams.get("returnTo");
  assert.equal(new URL(returnTo, "https://example.com").searchParams.get("path"), file);
});

test("viewer reports missing files without offering a download", async () => {
  const { elements } = await view("/projects/demo/missing.md", new Response(null, { status: 404 }));
  assert.equal(elements.get("file-content").children.length, 0);
  assert.match(elements.get("viewer-status").textContent, /文件不存在/u);
  assert.equal(elements.get("viewer-login").hidden, true);
});

test("service worker never caches file or authentication responses", async () => {
  const handlers = {};
  const puts = [];
  const caches = {
    open: async () => ({ addAll: async () => {}, put: async (...args) => puts.push(args), match: async () => null }),
    match: async () => null,
    keys: async () => [],
    delete: async () => true,
  };
  vm.runInNewContext(await readFile(new URL("./sw.js", import.meta.url), "utf8"), {
    self: {
      location: { origin: "https://example.com" },
      addEventListener: (name, handler) => { handlers[name] = handler; },
    },
    caches,
    URL,
    Request,
    Response,
    console: { warn() {} },
    fetch: async () => new Response("ok"),
  });
  for (const route of [
    "/raw?path=%2Fprojects%2Fdemo%2Fnote.md",
    "/auth/session",
    "/auth/login",
    "/attachments/upload",
    "/viewer.js",
    "/viewer.css",
  ]) {
    let intercepted = false;
    handlers.fetch({
      request: { method: route === "/auth/login" ? "POST" : "GET", url: `https://example.com${route}`, mode: "cors" },
      respondWith() { intercepted = true; },
      waitUntil() {},
    });
    assert.equal(intercepted, false, route);
  }
  let navigation;
  const pending = [];
  handlers.fetch({
    request: { method: "GET", url: "https://example.com/view?path=note.md", mode: "navigate" },
    respondWith(promise) { navigation = promise; },
    waitUntil(value) { pending.push(value); },
  });
  await navigation;
  await Promise.all(pending);
  assert.deepEqual(puts, [], "the viewer navigation must not enter the app-shell cache");
});
