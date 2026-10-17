import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./theme.js", import.meta.url), "utf8");

function run({ stored = null, systemLight = false, storage = true } = {}) {
  const attributes = {};
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
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } },
  });
  return {
    theme: () => attributes["data-theme"],
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

test("未保存选择时跟随系统及系统后续变化", () => {
  const page = run({ systemLight: true });
  assert.equal(page.api.get(), "system");
  assert.equal(page.theme(), "light");
  page.setSystem(false);
  assert.equal(page.theme(), "dark");
});

test("手动选择覆盖系统，并能恢复为跟随系统", () => {
  const page = run({ stored: "dark", systemLight: true });
  assert.equal(page.theme(), "dark");
  page.api.set("light");
  assert.equal(page.theme(), "light");
  assert.equal(page.store.get("codex-remote.theme"), "light");
  page.api.set("system");
  assert.equal(page.theme(), "light");
  assert.equal(page.store.has("codex-remote.theme"), false);
});

test("无效选择按跟随系统处理", () => {
  const page = run({ stored: "sepia", systemLight: false });
  assert.equal(page.api.get(), "system");
  assert.equal(page.theme(), "dark");
});

test("本地存储不可用时仍能切换当前页面", () => {
  const page = run({ storage: false, systemLight: false });
  page.api.set("light");
  assert.equal(page.api.get(), "light");
  assert.equal(page.theme(), "light");
});

test("其他标签页修改选择时同步当前页面", () => {
  const page = run({ systemLight: false });
  page.storageEvent("codex-remote.theme", "light");
  assert.equal(page.theme(), "light");
  page.storageEvent("codex-remote.theme", null);
  assert.equal(page.theme(), "dark");
});

test("所有页面都在样式表之前加载主题脚本", async () => {
  for (const name of ["index.html", "view.html"]) {
    const html = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
    const script = html.indexOf('<script src="/theme.js"></script>');
    assert.notEqual(script, -1, name);
    assert.ok(script < html.indexOf('<link rel="stylesheet" href="/styles.css">'), name);
  }
});
