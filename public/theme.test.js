import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./theme.js", import.meta.url), "utf8");

function run({ stored = null, systemLight = false, storage = true } = {}) {
  const attributes = {};
  const header = { content: "#141616", setAttribute(name, value) { if (name === "content") this.content = value; } };
  const store = new Map(stored === null ? [] : [["codex-remote.theme", stored]]);
  const mediaListeners = [];
  const windowListeners = {};
  const media = {
    matches: systemLight,
    addEventListener: (type, listener) => { if (type === "change") mediaListeners.push(listener); },
  };
  const localStorage = storage ? {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  } : {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const window = {
    matchMedia: () => media,
    addEventListener: (type, listener) => { windowListeners[type] = listener; },
  };
  vm.runInNewContext(source, {
    window,
    localStorage,
    document: {
      documentElement: { setAttribute: (name, value) => { attributes[name] = value; } },
      querySelector: (selector) => (selector === 'meta[name="theme-color"]' ? header : null),
    },
  });
  return {
    theme: () => attributes["data-theme"],
    header: () => header.content,
    api: window.codexRemoteTheme,
    store,
    setSystem(light) {
      media.matches = light;
      for (const listener of mediaListeners) listener();
    },
    storageEvent(key, value) {
      if (value === null) store.delete(key);
      else store.set(key, value);
      windowListeners.storage({ key });
    },
  };
}

test("an unsaved choice follows the system and subsequent system changes", () => {
  const page = run({ systemLight: true });
  assert.equal(page.api.get(), "system");
  assert.equal(page.theme(), "light");
  page.setSystem(false);
  assert.equal(page.theme(), "dark");
});

test("a manual choice overrides the system and can return to following it", () => {
  const page = run({ stored: "dark", systemLight: true });
  assert.equal(page.theme(), "dark");
  page.api.set("light");
  assert.equal(page.theme(), "light");
  assert.equal(page.store.get("codex-remote.theme"), "light");
  page.api.set("system");
  assert.equal(page.theme(), "light");
  assert.equal(page.store.has("codex-remote.theme"), false);
});

test("an invalid choice is treated as following the system", () => {
  const page = run({ stored: "sepia", systemLight: false });
  assert.equal(page.api.get(), "system");
  assert.equal(page.theme(), "dark");
});

test("the current page can still switch when local storage is unavailable", () => {
  const page = run({ storage: false, systemLight: false });
  page.api.set("light");
  assert.equal(page.api.get(), "light");
  assert.equal(page.theme(), "light");
});

test("changes from another tab synchronize the current page", () => {
  const page = run({ systemLight: false });
  page.storageEvent("codex-remote.theme", "light");
  assert.equal(page.theme(), "light");
  page.storageEvent("codex-remote.theme", null);
  assert.equal(page.theme(), "dark");
});

test("the PWA header color follows the applied theme", () => {
  const page = run({ systemLight: true });
  assert.equal(page.header(), "#f8f4ea");
  page.setSystem(false);
  assert.equal(page.header(), "#141616");
  page.api.set("light");
  assert.equal(page.header(), "#f8f4ea");
});

test("every page loads the theme script before stylesheets", async () => {
  for (const name of ["index.html", "view.html"]) {
    const html = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
    const script = html.indexOf('<script src="/theme.js"></script>');
    assert.notEqual(script, -1, name);
    assert.ok(script < html.indexOf('<link rel="stylesheet" href="/styles.css">'), name);
  }
});
