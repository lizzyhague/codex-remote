import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  DISPLAY_TIMEZONE_KEY,
  deviceTimeZone,
  formatDisplayTime,
  loadDisplayTimezonePreference,
  normalizeDisplayTimezonePreference,
  resolveDisplayTimeZone,
  saveDisplayTimezonePreference,
} from "./display-timezone.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeElement {
  constructor() {
    this.listeners = {};
    this.dataset = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.textContent = "";
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll() { return []; }
}

/** 2026-01-15T12:00:00Z：上海 20:00，东京 21:00，纽约 07:00。 */
const STAMP = 1_768_478_400;
const SHANGHAI = { followDevice: false, cityTimeZone: "Asia/Shanghai" };

function harness({ stored = SHANGHAI } = {}) {
  const storage = new Map();
  if (stored) storage.set(DISPLAY_TIMEZONE_KEY, JSON.stringify(stored));
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  const windowListeners = {};
  const rendered = [];
  const responders = [];
  const requests = [];
  const elements = new Proxy({}, {
    get(target, key) {
      if (!target[key]) target[key] = new FakeElement();
      return target[key];
    },
  });
  const dialog = elements.appSettingsDialog;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.open = false;
    dialog.listeners.close?.();
  };
  const context = vm.createContext({
    DISPLAY_TIMEZONE_KEY,
    deviceTimeZone,
    formatDisplayTime,
    resolveDisplayTimeZone,
    normalizeDisplayTimezonePreference,
    loadDisplayTimezonePreference: () => loadDisplayTimezonePreference(localStorage),
    saveDisplayTimezonePreference: (input) => saveDisplayTimezonePreference(input, localStorage),
    state: {
      displayTimezone: loadDisplayTimezonePreference(localStorage),
      displayTimezoneDraft: null,
      developerInstructions: "",
      appSettingsBusy: false,
    },
    elements,
    window: { addEventListener: (name, listener) => { windowListeners[name] = listener; } },
    request(type, payload = {}) {
      requests.push({ type, ...payload });
      const respond = responders.shift();
      if (!respond) return Promise.reject(new Error(`unexpected request ${type}`));
      return respond();
    },
    errorMessage: (error) => error.message,
    openSidebar() {},
    closeSidebar() {},
    renderSessionList() { rendered.push(context.formatDate(STAMP)); },
    renderSessionMetrics() {},
  });
  vm.runInContext([
    section("function formatDate(", "function errorMessage("),
    section("elements.openSidebarButton.addEventListener(", "elements.sessionSearchInput.addEventListener("),
  ].join("\n"), context);
  return {
    context,
    elements,
    storage,
    requests,
    get shown() { return context.formatDate(STAMP); },
    get lastRendered() { return rendered.at(-1); },
    stored() { return JSON.parse(storage.get(DISPLAY_TIMEZONE_KEY)); },
    respond(result) {
      responders.push(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
    },
    async open() {
      this.respond({ developerInstructions: "" });
      elements.appSettingsButton.listeners.click();
      await tick();
      assert.equal(dialog.open, true);
    },
    pickCity(city) {
      elements.displayTimezoneCitySelect.value = city;
      elements.displayTimezoneCitySelect.listeners.change();
    },
    otherTabSaves(prefs) {
      storage.set(DISPLAY_TIMEZONE_KEY, JSON.stringify(prefs));
      windowListeners.storage({ key: DISPLAY_TIMEZONE_KEY });
    },
  };
}

const closePaths = {
  "the cancel button": (h) => h.elements.appSettingsCancelButton.listeners.click(),
  "the close button": (h) => h.elements.appSettingsCloseButton.listeners.click(),
  // Escape：dialog 先派发 cancel（未被阻止），再关闭并派发 close。
  Escape: (h) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    h.elements.appSettingsDialog.listeners.cancel(event);
    assert.equal(event.defaultPrevented, false);
    h.elements.appSettingsDialog.close();
  },
};

for (const [label, close] of Object.entries(closePaths)) {
  test(`a timezone change previews immediately but ${label} rolls it back unsaved`, async () => {
    const h = harness();
    await h.open();
    assert.match(h.shown, /20:00/u);

    h.pickCity("Asia/Tokyo");
    assert.match(h.shown, /21:00/u, "page times preview the draft");
    assert.match(h.lastRendered, /21:00/u, "visible lists are redrawn with the preview");
    assert.deepEqual(h.stored(), SHANGHAI, "the preview is not written to local storage");

    close(h);
    assert.equal(h.elements.appSettingsDialog.open, false);
    assert.equal(h.context.state.displayTimezoneDraft, null);
    assert.match(h.shown, /20:00/u);
    assert.match(h.lastRendered, /20:00/u, "visible lists are redrawn with the saved zone");
    assert.deepEqual(h.stored(), SHANGHAI);

    await h.open();
    assert.equal(h.elements.displayTimezoneCitySelect.value, "Asia/Shanghai");
    assert.equal(h.elements.followDeviceTimezoneInput.checked, false);
  });
}

test("save commits the timezone draft together with the backend settings", async () => {
  const h = harness();
  await h.open();
  h.pickCity("America/New_York");
  h.elements.developerInstructionsInput.value = "be brief";
  h.respond({ developerInstructions: "be brief" });
  h.elements.appSettingsForm.listeners.submit({ preventDefault() {} });
  await tick();

  assert.equal(h.elements.appSettingsDialog.open, false);
  assert.deepEqual(h.stored(), { followDevice: false, cityTimeZone: "America/New_York" });
  assert.match(h.shown, /07:00/u, "closing after save does not roll back the committed zone");
  assert.equal(h.context.state.displayTimezoneDraft, null);
});

test("a failed save keeps the dialog and draft; cancelling afterwards still rolls back", async () => {
  const h = harness();
  await h.open();
  h.pickCity("Asia/Tokyo");
  h.respond(new Error("写入失败。"));
  h.elements.appSettingsForm.listeners.submit({ preventDefault() {} });
  assert.equal(h.elements.followDeviceTimezoneInput.disabled, true, "timezone is locked while saving");
  assert.equal(h.elements.displayTimezoneCitySelect.disabled, true);
  await tick();

  assert.equal(h.elements.appSettingsDialog.open, true);
  assert.equal(h.elements.appSettingsStatus.textContent, "写入失败。");
  assert.equal(h.elements.followDeviceTimezoneInput.disabled, false);
  assert.equal(h.elements.displayTimezoneCitySelect.disabled, false);
  assert.equal(h.elements.displayTimezoneCitySelect.value, "Asia/Tokyo");
  assert.deepEqual(h.stored(), SHANGHAI);
  assert.match(h.shown, /21:00/u);

  h.elements.appSettingsCancelButton.listeners.click();
  assert.deepEqual(h.stored(), SHANGHAI);
  assert.match(h.shown, /20:00/u);
});

test("follow-device is part of the same draft and keeps the previous city", async () => {
  const h = harness({ stored: { followDevice: false, cityTimeZone: "Asia/Tokyo" } });
  await h.open();
  h.elements.followDeviceTimezoneInput.checked = true;
  h.elements.followDeviceTimezoneInput.listeners.change();
  assert.equal(h.elements.displayTimezoneCitySelect.disabled, true);
  assert.equal(h.elements.displayTimezoneCitySelect.value, "Asia/Tokyo");
  assert.deepEqual(h.stored(), { followDevice: false, cityTimeZone: "Asia/Tokyo" });

  h.elements.appSettingsCloseButton.listeners.click();
  assert.equal(h.elements.followDeviceTimezoneInput.checked, false);
  assert.equal(h.elements.displayTimezoneCitySelect.disabled, false);
});

test("another tab's saved zone refreshes the page unless a draft is being previewed", async () => {
  const h = harness();
  h.otherTabSaves({ followDevice: false, cityTimeZone: "Asia/Tokyo" });
  assert.match(h.shown, /21:00/u);
  assert.match(h.lastRendered, /21:00/u);
  assert.equal(h.elements.displayTimezoneCitySelect.value, "Asia/Tokyo");

  await h.open();
  h.pickCity("America/New_York");
  h.otherTabSaves({ followDevice: false, cityTimeZone: "Europe/London" });
  assert.match(h.shown, /07:00/u, "the open draft stays on screen");
  assert.equal(h.elements.displayTimezoneCitySelect.value, "America/New_York");

  h.elements.appSettingsCancelButton.listeners.click();
  assert.equal(h.elements.displayTimezoneCitySelect.value, "Europe/London");
  assert.match(h.shown, /12:00/u, "cancel falls back to the latest saved zone, not the stale snapshot");
});

test("picking the saved zone again leaves no draft behind", async () => {
  const h = harness();
  await h.open();
  h.pickCity("Asia/Tokyo");
  h.pickCity("Asia/Shanghai");
  assert.equal(h.context.state.displayTimezoneDraft, null);
});
