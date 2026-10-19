import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { localize, t } from "./i18n.test-support.js";
import vm from "node:vm";

import { projectDisplayLabel } from "./project-labels.js";
import { createSelectionBar } from "./selection-bar.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}
/** Arrays and objects from the vm have different prototypes; convert them to ordinary values in this realm before comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.id = "";
    this.title = "";
    this.type = "";
    this.className = "";
    this.parentElement = null;
    this.classList = { toggle() {} };
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  emit(name) { return this.listeners[name]?.(); }
  get text() {
    return [this.textContent, ...this.children.map((child) => child.text)].join(" ").trim();
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

const PROJECTS = [
  { id: "root-a/one", name: "one", rootId: "root-a" },
  { id: "root-a/two", name: "two", rootId: "root-a" },
];

function summary(id, overrides = {}) {
  return {
    id,
    title: id.toUpperCase(),
    projectId: "root-a/one",
    state: "not_loaded",
    marked: false,
    ...overrides,
  };
}

function harness({ view = "active", selectionMode = false } = {}) {
  const requests = [];
  const responders = [];
  const notices = [];
  const confirmations = [];
  const storage = new Map();
  let confirmAnswer = true;
  let resets = 0;
  let titleUpdates = 0;
  const elements = new Proxy({}, {
    get(target, key) {
      if (!target[key]) {
        target[key] = new FakeElement();
        target[key].parentElement = new FakeElement();
      }
      return target[key];
    },
  });
  const context = vm.createContext({
    t,
    localize,
    projectDisplayLabel,
    PROJECT_KEY: "project",
    TEMPORARY_ERROR: { tone: "error" },
    TEMPORARY_WARNING: { tone: "warning" },
    TEMPORARY_INFO: { tone: "info" },
    SESSION_ORGANIZING_BUSY_MESSAGE: "这个项目有正在执行的任务，暂时不能整理会话。",
    state: {
      generation: 1,
      authenticated: true,
      projectId: "root-a/one",
      projects: PROJECTS,
      sessionId: null,
      sessionTitle: "",
      sessionView: view,
      sessions: [],
      markedSessions: [],
      sessionCursor: null,
      sessionLoading: false,
      sessionLoadError: null,
      sessionLoadGeneration: 0,
      navigationBusy: false,
      running: false,
    },
    elements,
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    },
    request(type, payload = {}) {
      requests.push({ type, ...payload });
      const respond = responders.shift();
      if (!respond) return Promise.reject(new Error(`unexpected request ${type}`));
      return respond(type, payload);
    },
    stateGet: (key) => storage.get(key) ?? "",
    stateSet: (key, value) => storage.set(key, value),
    showNotice: (message, options) => notices.push({ message, options }),
    errorMessage: (error) => error.message,
    updateControls() {},
    updateConversationTitle() {
      titleUpdates++;
      elements.currentSessionTitle.textContent = context.state.sessionTitle;
    },
    appendSessionText(container, session) {
      const title = new FakeElement("span");
      title.textContent = session.title || "新会话";
      container.append(title);
    },
    createSessionRename: () => new FakeElement("button"),
    createSessionMark: () => new FakeElement("button"),
    mergeSessions: (existing, incoming) => [...existing, ...incoming],
    setNavigationBusy(busy) { context.state.navigationBusy = busy; },
    setSessionView(nextView) { context.state.sessionView = nextView; },
    invalidateOpenIntent() {},
    resetCurrentSession() {
      resets++;
      context.state.sessionId = null;
      context.state.sessionTitle = "";
    },
    showEmpty() {},
    resumeSession() {},
    closeMobileSidebar() {},
    trashRemainingText: () => "",
    formatDate: () => "",
  });
  vm.runInContext([
    section("async function loadProjects(", "/** Starts one create or open operation"),
    section("function setSessionView(", "function appendSessionText("),
    section("function visibleSessionSummaries(", "function mergeSessions("),
  ].join("\n"), context);
  const views = {
    active: { actions: [
      { id: "archive", labelKey: "selection.archive", doneKey: "selection.doneArchive", icon: "archive" },
      { id: "trash-active", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
    ] },
    archived: { actions: [
      { id: "unarchive", labelKey: "selection.unarchive", doneKey: "selection.doneUnarchive", icon: "unarchive" },
      { id: "trash-archived", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
    ] },
    trash: { actions: [
      { id: "restore-trash", labelKey: "selection.restore", doneKey: "selection.doneRestore", icon: "restore" },
      { id: "delete-trash", labelKey: "selection.purge", doneKey: "selection.donePurge", icon: "purge", danger: true, permanent: true },
    ] },
  };
  const selectionBar = createSelectionBar({
    container: elements.selectionHeading,
    views,
    initialView: view,
    getId: (session) => session.id,
    getTitle: (session) => session.title,
    isSelectable: (session) => context.sessionSelectable(session),
    isPinned: (session) => Boolean(session.marked),
    executeAction: (action, ids) => context.executeSessionSelectionAction(action, ids),
    refreshItems: () => context.loadSessions(),
    confirm: async (message, options) => {
      confirmations.push({ message, options });
      return confirmAnswer;
    },
    notify: (message, tone) => context.showNotice(
      message,
      tone === "error" ? context.TEMPORARY_ERROR : context.TEMPORARY_INFO,
    ),
    onSelectionChange: () => context.renderSessionList(),
    onBusyChange: (busy) => context.setNavigationBusy(busy),
    document: context.document,
  });
  context.selectionBar = selectionBar;
  if (selectionMode && view !== "trash") selectionBar.setManualSelection(true);
  return {
    context,
    selectionBar,
    elements,
    requests,
    notices,
    confirmations,
    get resets() { return resets; },
    get titleUpdates() { return titleUpdates; },
    rejectConfirm() { confirmAnswer = false; },
    byId(id) {
      return [elements.selectionHeading, ...elements.selectionHeading.walk()]
        .find((element) => element.id === id);
    },
    /** Result of the next request: Error means failure; deferred lets the test control completion. */
    respond(result) {
      responders.push(() => {
        if (result instanceof Error) return Promise.reject(result);
        if (result && typeof result.promise?.then === "function") return result.promise;
        return Promise.resolve(result);
      });
    },
    listText() { return elements.sessionList.text; },
    checkboxes() {
      return [...elements.sessionList.walk()].filter((node) => node.type === "checkbox");
    },
  };
}

for (const [label, view, searchTerm] of [
  ["recent", "active", ""],
  ["archived", "archived", ""],
  ["trash", "trash", ""],
  ["search", "active", "needle"],
]) {
  test(`a failed ${label} directory read shows an error with retry, not an empty list`, async () => {
    const h = harness({ view });
    h.elements.sessionSearchInput.value = searchTerm;
    h.respond(new Error("主机扫描目录失败。"));
    await h.context.loadSessions();

    const text = h.listText();
    assert.match(text, /会话列表没有读取成功：主机扫描目录失败。/u);
    assert.doesNotMatch(text, /还没有会话|还没有归档会话|回收站是空的|没有找到匹配的会话/u);
    assert.equal(h.context.state.sessionLoading, false);
    const alert = [...h.elements.sessionList.walk()].find((node) => node.attributes.role === "alert");
    assert.ok(alert, "error state is announced");

    const retry = [...h.elements.sessionList.walk()].find((node) => node.textContent === "重试");
    h.respond({ sessions: [summary("a")], marked: [], nextCursor: null });
    retry.listeners.click();
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].view, view);
    assert.equal(h.context.state.sessionLoadError, null);
    assert.match(h.listText(), /\bA\b/u);
    assert.doesNotMatch(h.listText(), /没有读取成功/u);
  });
}

test("a stale failure does not overwrite a newer successful directory read", async () => {
  const h = harness();
  const first = deferred();
  h.respond(first);
  h.respond({ sessions: [summary("a")], marked: [], nextCursor: null });
  const older = h.context.loadSessions();
  await h.context.loadSessions();
  first.reject(new Error("old failure"));
  await older;

  assert.equal(h.context.state.sessionLoadError, null);
  assert.deepEqual(h.notices, []);
  assert.match(h.listText(), /\bA\b/u);
});

test("a failed next page keeps the loaded list and only reports a notice", async () => {
  const h = harness();
  h.context.state.sessions = [summary("a")];
  h.context.state.sessionCursor = "cursor-1";
  h.respond(new Error("page failed"));
  await h.context.loadSessions({ append: true });

  assert.equal(h.context.state.sessionLoadError, null);
  assert.equal(h.context.state.sessionCursor, "cursor-1");
  assert.match(h.listText(), /\bA\b/u);
  assert.deepEqual(h.notices.map((notice) => notice.message), ["page failed"]);
});

test("a project that left the whitelist releases the open session and falls back to another project", async () => {
  const h = harness();
  h.context.state.projectId = "root-b/gone";
  h.context.state.sessionId = "session-1";
  h.respond({ projects: PROJECTS });
  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.context.loadProjects(1);

  assert.ok(h.resets >= 1);
  assert.equal(h.context.state.sessionId, null);
  assert.equal(h.context.state.projectId, "root-a/one");
  assert.deepEqual(h.requests.map((request) => [request.type, request.projectId]), [
    ["projects.list", undefined],
    ["sessions.list", "root-a/one"],
  ]);
  assert.deepEqual(h.elements.projectSelect.children.map((option) => option.value), [
    "root-a/one",
    "root-a/two",
  ]);
  assert.match(h.notices[0].message, /项目已不可用/u);
});

test("an empty whitelist releases the open session instead of failing the connection", async () => {
  const h = harness();
  h.context.state.sessionId = "session-1";
  h.context.state.sessions = [summary("a")];
  h.respond({ projects: [] });
  await h.context.loadProjects(1);

  assert.equal(h.context.state.sessionId, null);
  assert.equal(h.context.state.projectId, null);
  assert.deepEqual(plain(h.context.state.sessions), []);
  assert.equal(h.requests.length, 1);
});

test("pinned sessions from another project cannot join the current project's batch", async () => {
  const h = harness({ selectionMode: true });
  h.context.state.markedSessions = [
    summary("other", { projectId: "root-a/two", marked: true }),
    summary("pinned", { marked: true }),
  ];
  h.context.state.sessions = [summary("a"), summary("b")];
  h.context.renderSessionList();

  const [other, pinned] = h.checkboxes();
  assert.equal(other.disabled, true);
  assert.equal(pinned.disabled, false);

  h.byId("selection-select-all-button").emit("click");
  assert.deepEqual(h.selectionBar.selectedIds(), ["a", "b"]);
  assert.equal(h.selectionBar.toggle("other"), false);
  assert.equal(h.selectionBar.toggle("pinned"), true);
  assert.equal(h.byId("selection-count").textContent, "已选择 3 项");

  h.respond({ succeeded: ["a", "b", "pinned"], failed: [] });
  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.selectionBar.runAction("archive");
  assert.deepEqual(plain(h.requests[0]), {
    type: "sessions.mutate",
    projectId: "root-a/one",
    sessionIds: ["a", "b", "pinned"],
    action: "archive",
  });
});

test("a refresh drops selections that left the list so confirmation and request agree", async () => {
  const h = harness({ view: "trash", selectionMode: true });
  h.context.state.sessions = [summary("a"), summary("b")];
  h.context.renderSessionList();
  for (const checkbox of h.checkboxes()) {
    checkbox.checked = true;
    checkbox.listeners.change();
  }
  assert.equal(h.byId("selection-count").textContent, "已选择 2 项");

  // Another device restored A and renamed B.
  h.respond({ sessions: [summary("b", { title: "Renamed B" })], marked: [], nextCursor: null });
  await h.context.loadSessions();
  assert.equal(h.byId("selection-count").textContent, "已选择 1 项");

  h.respond({ succeeded: ["b"], failed: [] });
  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.selectionBar.runAction("delete-trash");
  assert.deepEqual(h.confirmations.map((entry) => entry.message), [
    "立刻永久删除「Renamed B」。这一步无法撤销，会话原文会一并删除。继续吗？",
  ]);
  assert.deepEqual(plain(h.requests.at(-2)), {
    type: "sessions.mutate",
    projectId: "root-a/one",
    sessionIds: ["b"],
    action: "delete-trash",
  });
});

test("trash keeps backend failures selected through the codex-remote result adapter", async () => {
  const h = harness({ view: "trash" });
  h.context.state.sessions = [summary("a"), summary("b")];
  h.context.renderSessionList();
  h.selectionBar.toggle("a");
  h.selectionBar.toggle("b");
  h.respond({
    succeeded: ["a"],
    failed: [{ sessionId: "b", message: "这个会话仍在整理。" }],
  });
  h.respond({ sessions: [summary("b")], marked: [], nextCursor: null });
  await h.selectionBar.runAction("restore-trash");

  assert.deepEqual(h.selectionBar.selectedIds(), ["b"]);
  assert.deepEqual(h.notices, [{
    message: "已完成 1 项，1 项失败：这个会话仍在整理。",
    options: { tone: "error" },
  }]);
});

test("nothing is deleted when every selected session left the list", async () => {
  const h = harness({ view: "trash", selectionMode: true });
  h.context.state.sessions = [summary("a")];
  h.context.renderSessionList();
  const [checkbox] = h.checkboxes();
  checkbox.checked = true;
  checkbox.listeners.change();

  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.context.loadSessions();
  await h.selectionBar.runAction("delete-trash");

  assert.equal(h.byId("selection-count").textContent, "已选择 0 项");
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.requests.map((request) => request.type), ["sessions.list"]);
});

test("bulk actions wait while the list is being refreshed", async () => {
  const h = harness({ view: "trash", selectionMode: true });
  h.context.state.sessions = [summary("a")];
  h.context.renderSessionList();
  const [checkbox] = h.checkboxes();
  checkbox.checked = true;
  checkbox.listeners.change();

  const refresh = deferred();
  h.respond(refresh);
  const loading = h.context.loadSessions();
  h.selectionBar.setDisabled(true);
  await h.selectionBar.runAction("delete-trash");
  await h.selectionBar.runAction("restore-trash");
  assert.deepEqual(h.confirmations, []);
  assert.deepEqual(h.requests.map((request) => request.type), ["sessions.list"]);
  refresh.resolve({ sessions: [summary("a")], marked: [], nextCursor: null });
  await loading;
});

test("a completed batch reports success without adding an undo action", async () => {
  const h = harness({ selectionMode: true });
  h.context.state.sessions = [summary("a")];
  h.context.renderSessionList();
  const [checkbox] = h.checkboxes();
  checkbox.checked = true;
  checkbox.listeners.change();
  h.respond({ succeeded: ["a"], failed: [] });
  h.respond({ sessions: [], marked: [], nextCursor: null });
  await h.selectionBar.runAction("archive");
  assert.deepEqual(plain(h.requests[0]), {
    type: "sessions.mutate",
    projectId: "root-a/one",
    sessionIds: ["a"],
    action: "archive",
  });
  assert.deepEqual(h.notices, [{ message: "已归档 1 个会话。", options: { tone: "info" } }]);
  assert.equal(h.context.state.navigationBusy, false);
});

test("a rename seen in the refreshed list updates the current conversation title", async () => {
  const h = harness();
  h.context.state.sessionId = "a";
  h.context.state.sessionTitle = "Old title";
  h.respond({
    sessions: [summary("a", { title: "New title" }), summary("b", { title: "Other" })],
    marked: [],
    nextCursor: null,
  });
  await h.context.loadSessions();

  assert.equal(h.context.state.sessionTitle, "New title");
  assert.equal(h.elements.currentSessionTitle.textContent, "New title");
  assert.equal(h.titleUpdates, 1);
});

test("the current title follows a pinned copy and ignores lists without the current session", async () => {
  const h = harness();
  h.context.state.sessionId = "a";
  h.context.state.sessionTitle = "Old title";
  h.respond({
    sessions: [summary("b", { title: "Other" })],
    marked: [],
    nextCursor: null,
  });
  await h.context.loadSessions();
  assert.equal(h.context.state.sessionTitle, "Old title");
  assert.equal(h.titleUpdates, 0);

  h.respond({
    sessions: [],
    marked: [summary("a", { title: "Pinned title", marked: true })],
    nextCursor: null,
  });
  await h.context.loadSessions();
  assert.equal(h.context.state.sessionTitle, "Pinned title");
});

test("a superseded list result cannot rename the current conversation", async () => {
  const h = harness();
  h.context.state.sessionId = "a";
  h.context.state.sessionTitle = "Current";
  const stale = deferred();
  h.respond(stale);
  h.respond({ sessions: [summary("a", { title: "Current" })], marked: [], nextCursor: null });
  const older = h.context.loadSessions();
  await h.context.loadSessions();
  stale.resolve({ sessions: [summary("a", { title: "Stale" })], marked: [], nextCursor: null });
  await older;

  assert.equal(h.context.state.sessionTitle, "Current");
});
