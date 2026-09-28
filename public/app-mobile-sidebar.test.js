import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [source, html] = await Promise.all([
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./index.html", import.meta.url), "utf8"),
]);
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

/** 只模拟本测试关心的焦点规则：inert 子树里的元素不能获得焦点，已聚焦元素变 inert 后焦点掉回 body。 */
function fakeDom() {
  const document = {
    body: null,
    activeElement: null,
    openDialog: null,
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    querySelector(selector) {
      assert.equal(selector, "dialog[open]");
      return this.openDialog;
    },
  };
  class Node {
    constructor(name, parent = null) {
      this.name = name;
      this.parent = parent;
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.textContent = "";
      this._inert = false;
    }
    get inert() { return this._inert; }
    set inert(value) {
      this._inert = Boolean(value);
      if (this._inert && this.contains(document.activeElement)) document.activeElement = document.body;
    }
    contains(node) {
      for (let current = node; current; current = current.parent) if (current === this) return true;
      return false;
    }
    focus() {
      for (let current = this; current; current = current.parent) if (current._inert) return;
      document.activeElement = this;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
  }
  document.body = new Node("body");
  document.activeElement = document.body;
  const appView = new Node("appView", document.body);
  const sessionSidebar = new Node("sessionSidebar", appView);
  const conversationShell = new Node("conversationShell", appView);
  const elements = {
    appView,
    sessionSidebar,
    conversationShell,
    collapseSidebarButton: new Node("collapseSidebarButton", sessionSidebar),
    appSettingsButton: new Node("appSettingsButton", sessionSidebar),
    sessionRow: new Node("sessionRow", sessionSidebar),
    sidebarBackdrop: new Node("sidebarBackdrop", appView),
    openSidebarButton: new Node("openSidebarButton", conversationShell),
    messageInput: new Node("messageInput", conversationShell),
    currentSessionTitle: new Node("currentSessionTitle", conversationShell),
    dialog: new Node("dialog", document.body),
  };
  return { document, elements };
}

function harness({ mobile = true, sidebarCollapsed = false } = {}) {
  const { document, elements } = fakeDom();
  const storage = new Map();
  const context = vm.createContext({
    SIDEBAR_COLLAPSED_KEY: "sidebar",
    state: { mobileSidebarOpen: false, sidebarCollapsed, sessionTitle: "会话" },
    elements,
    document,
    window: {
      matchMedia: () => ({ matches: context.mobile }),
      addEventListener() {},
    },
    mobile,
    stateSet: (key, value) => storage.set(key, value),
  });
  vm.runInContext([
    section("function openSidebar()", 'window.addEventListener("resize"'),
    'elements.openSidebarButton.addEventListener("click", openSidebar);',
    'elements.collapseSidebarButton.addEventListener("click", closeSidebar);',
    'elements.sidebarBackdrop.addEventListener("click", closeSidebar);',
    'document.addEventListener("keydown", closeMobileSidebarOnEscape);',
    "syncSidebarState();",
  ].join("\n"), context);
  return {
    context,
    document,
    elements,
    storage,
    /** 键盘或辅助技术激活汉堡按钮。 */
    open() {
      elements.openSidebarButton.focus();
      assert.equal(document.activeElement, elements.openSidebarButton);
      elements.openSidebarButton.listeners.click();
    },
    escape() { document.listeners.keydown({ key: "Escape" }); },
  };
}

test("wiring: the page shell has the id the drawer isolates", () => {
  assert.match(html, /<section id="conversation-shell" class="conversation-shell">/u);
  assert.match(source, /conversationShell: byId\("conversation-shell"\)/u);
});

test("opening the mobile drawer moves focus into it and isolates the covered page", () => {
  const h = harness();
  assert.equal(h.elements.sessionSidebar.inert, true);
  assert.equal(h.elements.conversationShell.inert, false);

  h.open();
  assert.equal(h.document.activeElement, h.elements.collapseSidebarButton);
  assert.equal(h.elements.sessionSidebar.inert, false);
  assert.equal(h.elements.sessionSidebar.attributes["aria-hidden"], "false");
  assert.equal(h.elements.conversationShell.inert, true, "timeline/composer are out of Tab order and AT tree");
  assert.equal(h.elements.openSidebarButton.attributes["aria-expanded"], "true");

  h.elements.messageInput.focus();
  assert.equal(h.document.activeElement, h.elements.collapseSidebarButton, "the covered page cannot take focus");
});

for (const [label, close] of Object.entries({
  Escape: (h) => h.escape(),
  "the backdrop": (h) => h.elements.sidebarBackdrop.listeners.click(),
  "the collapse button": (h) => h.elements.collapseSidebarButton.listeners.click(),
  "choosing a session": (h) => {
    h.elements.sessionRow.focus();
    h.context.closeMobileSidebar();
  },
})) {
  test(`closing the mobile drawer via ${label} returns focus to the trigger`, () => {
    const h = harness();
    h.open();
    close(h);
    assert.equal(h.context.state.mobileSidebarOpen, false);
    assert.equal(h.elements.sessionSidebar.inert, true);
    assert.equal(h.elements.conversationShell.inert, false);
    assert.equal(h.document.activeElement, h.elements.openSidebarButton);
    assert.equal(h.elements.openSidebarButton.attributes["aria-expanded"], "false");
  });
}

test("closing an already closed drawer does not steal focus", () => {
  const h = harness();
  h.elements.messageInput.focus();
  h.context.closeMobileSidebar();
  assert.equal(h.document.activeElement, h.elements.messageInput);
});

test("focus already handed to a dialog is not pulled back when the drawer closes", () => {
  const h = harness();
  h.open();
  h.elements.dialog.focus();
  h.context.closeMobileSidebar();
  assert.equal(h.document.activeElement, h.elements.dialog);
});

test("Escape inside a modal opened from the drawer leaves the drawer open", () => {
  const h = harness();
  h.open();
  h.elements.appSettingsButton.focus();
  h.document.openDialog = h.elements.dialog;
  h.elements.dialog.focus();
  h.escape();
  assert.equal(h.context.state.mobileSidebarOpen, true);
  assert.equal(h.elements.sessionSidebar.inert, false, "the dialog can return focus to the gear");

  h.document.openDialog = null;
  h.escape();
  assert.equal(h.context.state.mobileSidebarOpen, false);
});

test("growing past the mobile breakpoint releases the page isolation", () => {
  const h = harness();
  h.open();
  h.context.mobile = false;
  h.context.syncSidebarState();
  assert.equal(h.elements.conversationShell.inert, false);
  assert.equal(h.elements.sessionSidebar.inert, false);
});

test("the desktop sidebar is not modal and does not move focus", () => {
  const h = harness({ mobile: false, sidebarCollapsed: true });
  h.open();
  assert.equal(h.document.activeElement, h.elements.openSidebarButton);
  assert.equal(h.elements.conversationShell.inert, false);
  assert.equal(h.storage.get("sidebar"), "0");
  h.elements.collapseSidebarButton.listeners.click();
  assert.equal(h.elements.conversationShell.inert, false);
  assert.equal(h.storage.get("sidebar"), "1");
});
