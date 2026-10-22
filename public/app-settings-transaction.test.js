import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { localize, t } from "./i18n.test-support.js";
import vm from "node:vm";

import {
  DISPLAY_TIMEZONE_KEY,
  deviceTimeZone,
  formatDisplayTime,
  loadDisplayTimezonePreference,
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
    this.children = [];
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll() { return []; }
  replaceChildren(...children) { this.children = children; }
}

/** At 2026-01-15T12:00:00Z: Shanghai 20:00, Tokyo 21:00, New York 07:00. */
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
    t,
    localize,
    DISPLAY_TIMEZONE_KEY,
    deviceTimeZone,
    formatDisplayTime,
    resolveDisplayTimeZone,
    loadDisplayTimezonePreference: () => loadDisplayTimezonePreference(localStorage),
    saveDisplayTimezonePreference: (input) => saveDisplayTimezonePreference(input, localStorage),
    state: {
      displayTimezone: loadDisplayTimezonePreference(localStorage),
      developerInstructions: "",
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultModelDraft: null,
      defaultReasoningEffortDraft: null,
      settingsModels: [],
      settingsModelsState: "idle",
      settingsModelsError: "",
      modelDefaultsMessage: "",
      defaultPermissions: null,
      defaultPermissionsDraft: null,
      settingsPermissions: [],
      settingsPermissionsState: "idle",
      settingsPermissionsError: "",
      appSettingsLoadGeneration: 0,
      appSettingsLoadState: "idle",
      appSettingsBusy: false,
    },
    elements,
    document: { createElement: () => new FakeElement() },
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
    async open({
      models = [],
      permissions = [],
      settings = {
        developerInstructions: "",
        defaultModel: null,
        defaultReasoningEffort: null,
        defaultPermissions: null,
      },
    } = {}) {
      this.respond(settings);
      this.respond(models);
      this.respond(permissions);
      elements.appSettingsButton.listeners.click();
      await tick();
      assert.equal(dialog.open, true);
    },
    pickTimezone(value) {
      elements.displayTimezoneSelect.value = value;
      elements.displayTimezoneSelect.listeners.change();
    },
    otherTabSaves(prefs) {
      storage.set(DISPLAY_TIMEZONE_KEY, JSON.stringify(prefs));
      windowListeners.storage({ key: DISPLAY_TIMEZONE_KEY });
    },
    save(section) {
      const button = section === "defaults"
        ? elements.modelDefaultsSaveButton
        : elements.developerInstructionsSaveButton;
      button.listeners.click();
    },
  };
}

const closePaths = {
  "the close button": (h) => h.elements.appSettingsCloseButton.listeners.click(),
  // Escape makes the dialog dispatch an unprevented cancel, then close and dispatch close.
  Escape: (h) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    h.elements.appSettingsDialog.listeners.cancel(event);
    assert.equal(event.defaultPrevented, false);
    h.elements.appSettingsDialog.close();
  },
};

for (const [label, close] of Object.entries(closePaths)) {
  test(`a timezone change applies and persists immediately, and ${label} keeps it`, async () => {
    const h = harness();
    await h.open();
    assert.match(h.shown, /20:00/u);

    h.pickTimezone("Asia/Tokyo");
    assert.match(h.shown, /21:00/u);
    assert.match(h.lastRendered, /21:00/u, "visible lists are redrawn with the new zone");
    assert.deepEqual(h.stored(), { followDevice: false, cityTimeZone: "Asia/Tokyo" });

    close(h);
    assert.equal(h.elements.appSettingsDialog.open, false);
    assert.match(h.shown, /21:00/u);
    assert.deepEqual(h.stored(), { followDevice: false, cityTimeZone: "Asia/Tokyo" });

    await h.open();
    assert.equal(h.elements.displayTimezoneSelect.value, "Asia/Tokyo");
  });
}

test("the developer-instructions section saves alone without touching the timezone", async () => {
  const h = harness();
  await h.open();
  h.elements.developerInstructionsInput.value = "be brief";
  h.respond({ developerInstructions: "be brief" });
  h.save("instructions");
  await tick();

  assert.equal(h.elements.appSettingsDialog.open, true);
  assert.deepEqual(Object.keys(h.requests.at(-1)).sort(), ["developerInstructions", "type"]);
  assert.equal(h.requests.at(-1).developerInstructions, "be brief");
  assert.deepEqual(h.stored(), SHANGHAI);
});

test("saving either section preserves the other section's unsaved draft", async () => {
  const h = harness();
  await h.open({ permissions: PERMISSION_OPTIONS });
  h.elements.defaultPermissionsSelect.value = ":danger-full-access";
  h.elements.defaultPermissionsSelect.listeners.change();
  h.elements.developerInstructionsInput.value = "新指令";
  h.respond({
    developerInstructions: "新指令",
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissions: null,
  });
  h.save("instructions");
  await tick();

  assert.equal(h.context.state.defaultPermissionsDraft, ":danger-full-access");

  h.elements.developerInstructionsInput.value = "还没保存的第二版";
  h.respond({
    developerInstructions: "新指令",
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissions: ":danger-full-access",
  });
  h.save("defaults");
  await tick();

  assert.equal(h.elements.developerInstructionsInput.value, "还没保存的第二版");
  assert.equal(h.elements.appSettingsDialog.open, true);
});

test("an unavailable saved model and effort stay visible", async () => {
  const h = harness();
  await h.open({
    settings: {
      developerInstructions: "",
      defaultModel: "gpt-retired",
      defaultReasoningEffort: "ultra",
    },
  });

  assert.equal(h.elements.defaultModelSelect.value, "gpt-retired");
  assert.equal(h.elements.defaultReasoningEffortSelect.value, "ultra");
  assert.equal(
    h.elements.defaultModelSelect.children.find((option) => option.value === "gpt-retired")?.textContent,
    "gpt-retired（当前不可用）",
  );
  assert.equal(
    h.elements.defaultReasoningEffortSelect.children.find((option) => option.value === "ultra")?.textContent,
    "ultra（当前不可用）",
  );
});

test("changing models resets an unsupported effort to that model's default", async () => {
  const h = harness();
  await h.open({
    models: [
      {
        id: "gpt-a",
        displayName: "GPT A",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      },
      {
        id: "gpt-b",
        displayName: "GPT B",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
    ],
    settings: {
      developerInstructions: "",
      defaultModel: "gpt-a",
      defaultReasoningEffort: "high",
    },
  });

  h.elements.defaultModelSelect.value = "gpt-b";
  h.elements.defaultModelSelect.listeners.change();
  assert.equal(h.context.state.defaultModelDraft, "gpt-b");
  assert.equal(h.context.state.defaultReasoningEffortDraft, null);
  assert.match(h.elements.modelDefaultsStatus.textContent, /已改为跟随模型默认/u);

  h.elements.defaultModelSelect.value = "";
  h.elements.defaultModelSelect.listeners.change();
  assert.equal(h.elements.defaultReasoningEffortSelect.disabled, true);
  assert.equal(h.elements.defaultReasoningEffortSelect.children.length, 1);
  assert.equal(h.elements.defaultReasoningEffortSelect.children[0].textContent, "跟随 Codex 默认");
});

test("a failed model list does not make an instructions save submit defaults", async () => {
  const h = harness();
  const settings = {
    developerInstructions: "旧指令",
    defaultModel: "gpt-saved",
    defaultReasoningEffort: "high",
  };
  await h.open({ models: new Error("列表失败"), settings });
  h.elements.developerInstructionsInput.value = "新指令";
  h.respond({ ...settings, developerInstructions: "新指令" });
  h.save("instructions");
  await tick();

  assert.deepEqual(h.requests.at(-1), {
    type: "settings.update",
    developerInstructions: "新指令",
  });
});

const PERMISSION_OPTIONS = [
  { id: ":read-only", label: "只读", description: "只读说明", allowed: true, fullAccess: false },
  { id: ":workspace", label: "自动（可修改项目）", description: "项目说明", allowed: true, fullAccess: false },
  { id: ":danger-full-access", label: "完全访问", description: "完全访问说明", allowed: true, fullAccess: true },
  { id: ":blocked", label: ":blocked", description: "", allowed: false, fullAccess: false },
];

test("default permissions list allowed profiles and save the chosen one", async () => {
  const h = harness();
  await h.open({ permissions: PERMISSION_OPTIONS });

  assert.deepEqual(
    h.elements.defaultPermissionsSelect.children.map((option) => option.value),
    ["", ":read-only", ":workspace", ":danger-full-access"],
  );
  assert.equal(h.elements.defaultPermissionsSelect.disabled, false);

  h.elements.defaultPermissionsSelect.value = ":danger-full-access";
  h.elements.defaultPermissionsSelect.listeners.change();
  assert.equal(h.elements.defaultPermissionsStatus.textContent, "完全访问说明");
  h.respond({
    developerInstructions: "",
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissions: ":danger-full-access",
  });
  h.save("defaults");
  await tick();

  assert.equal(h.requests.at(-1).defaultPermissions, ":danger-full-access");
  assert.equal(h.context.state.defaultPermissions, ":danger-full-access");
});

test("an unavailable saved permission stays visible and a failed list is not submitted by another section", async () => {
  const unavailable = harness();
  await unavailable.open({
    permissions: PERMISSION_OPTIONS,
    settings: {
      developerInstructions: "",
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultPermissions: ":blocked",
    },
  });
  assert.equal(unavailable.elements.defaultPermissionsSelect.value, ":blocked");
  assert.equal(
    unavailable.elements.defaultPermissionsSelect.children.find((option) => option.value === ":blocked")
      ?.textContent,
    ":blocked（当前不可用）",
  );

  const failed = harness();
  const settings = {
    developerInstructions: "",
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissions: ":danger-full-access",
  };
  await failed.open({ permissions: new Error("权限列表失败"), settings });
  assert.equal(failed.elements.defaultPermissionsSelect.disabled, true);
  assert.match(failed.elements.defaultPermissionsStatus.textContent, /权限列表失败/u);
  failed.elements.developerInstructionsInput.value = "新指令";
  failed.respond({ ...settings, developerInstructions: "新指令" });
  failed.save("instructions");
  await tick();
  assert.deepEqual(failed.requests.at(-1), {
    type: "settings.update",
    developerInstructions: "新指令",
  });
});

test("a failed save keeps the dialog and its backend draft", async () => {
  const h = harness();
  await h.open();
  h.elements.developerInstructionsInput.value = "还要继续改";
  h.respond(new Error("写入失败。"));
  h.save("instructions");
  assert.equal(h.elements.developerInstructionsInput.disabled, true);
  await tick();

  assert.equal(h.elements.appSettingsDialog.open, true);
  assert.equal(h.elements.developerInstructionsSaveStatus.textContent, "写入失败。");
  assert.equal(h.elements.developerInstructionsInput.value, "还要继续改");
  assert.equal(h.elements.developerInstructionsInput.disabled, false);
});

test("following the device keeps the previous city for switching back", async () => {
  const h = harness({ stored: { followDevice: false, cityTimeZone: "Asia/Tokyo" } });
  await h.open();
  assert.equal(h.elements.displayTimezoneSelect.value, "Asia/Tokyo");

  h.pickTimezone("device");
  assert.equal(h.elements.displayTimezoneSelect.value, "device");
  assert.deepEqual(h.stored(), { followDevice: true, cityTimeZone: "Asia/Tokyo" });
  assert.equal(h.shown, formatDisplayTime(STAMP * 1_000, deviceTimeZone()));
});

test("another tab's saved zone refreshes the page and the open select", async () => {
  const h = harness();
  h.otherTabSaves({ followDevice: false, cityTimeZone: "Asia/Tokyo" });
  assert.match(h.shown, /21:00/u);
  assert.match(h.lastRendered, /21:00/u);
  assert.equal(h.elements.displayTimezoneSelect.value, "Asia/Tokyo");

  await h.open();
  h.otherTabSaves({ followDevice: false, cityTimeZone: "Europe/London" });
  assert.match(h.shown, /12:00/u);
  assert.equal(h.elements.displayTimezoneSelect.value, "Europe/London");
});
