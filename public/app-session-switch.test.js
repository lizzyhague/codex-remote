import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

const RESUME = section("async function resumeSession(sessionId)", "function applyOpenedSession(");
const LOAD_OLDER = section("async function loadOlderHistory()", "async function sendMessage()");

function resumeContext(overrides = {}) {
  const timeline = [];
  const context = vm.createContext({
    state: {
      sessionId: "session-1",
      projectId: "project-1",
      navigationBusy: false,
      sessionLoading: false,
    },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: { projectSelect: { value: "project-1" } },
    findSessionSummary: () => ({ id: "session-2", projectId: "project-1" }),
    directoryAvailable: () => true,
    showAlert: () => {
      throw new Error("不应弹出目录提示");
    },
    loadSessions: async () => {},
    stateSet: () => {},
    PROJECT_KEY: "project",
    setNavigationBusy: (busy) => {
      context.state.navigationBusy = busy;
    },
    request: async () => ({ session: { id: "session-2" } }),
    applyOpenedSession: (opened) => {
      context.state.sessionId = opened.session.id;
      timeline.push({ kind: "session", id: opened.session.id });
    },
    showNotice: (message) => timeline.push({ kind: "notice", message }),
    showSessionLoading: () => timeline.push({ kind: "loading" }),
    showEmpty: (text) => timeline.push({ kind: "empty", text }),
    resetCurrentSession: () => {
      context.state.sessionId = null;
      timeline.push({ kind: "reset" });
    },
    updateControls: () => {},
    errorMessage: (error) => error.message,
    ...overrides,
  });
  vm.runInContext(RESUME, context);
  return { context, timeline };
}

test("switching sessions takes the old one off screen before the new one arrives", async () => {
  const { context, timeline } = resumeContext();
  await context.resumeSession("session-2");
  assert.deepEqual(timeline, [
    { kind: "loading" },
    { kind: "session", id: "session-2" },
  ]);
  assert.equal(context.state.navigationBusy, false);
});

test("reopening the session already on screen does not blank the timeline", async () => {
  const { context, timeline } = resumeContext({
    findSessionSummary: () => ({ id: "session-1", projectId: "project-1" }),
    request: async () => ({ session: { id: "session-1" } }),
  });
  await context.resumeSession("session-1");
  assert.deepEqual(timeline, [{ kind: "session", id: "session-1" }]);
});

test("a failed switch falls back to no session instead of an empty one", async () => {
  const { context, timeline } = resumeContext({
    request: async () => {
      throw new Error("打开失败");
    },
  });
  await context.resumeSession("session-2");
  assert.deepEqual(timeline.map((entry) => entry.kind), [
    "loading",
    "notice",
    "reset",
    "empty",
  ]);
  assert.equal(context.state.sessionId, null);
});

function loadOlderContext(navigationBusy) {
  const requests = [];
  const context = vm.createContext({
    state: { sessionId: "session-1", authenticated: true, navigationBusy },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: {
      loadOlderButton: { disabled: false, textContent: "加载更早" },
      historyLoader: { hidden: true, after() {} },
      timeline: { scrollHeight: 100, scrollTop: 0, children: [] },
    },
    request: async (type) => {
      requests.push(type);
      return { tasks: [], hasOlder: false };
    },
    renderTasks: () => 0,
    showNotice: () => {},
    errorMessage: (error) => error.message,
  });
  vm.runInContext(LOAD_OLDER, context);
  return { context, requests };
}

test("loading older history is refused while a session switch is in flight", async () => {
  const busy = loadOlderContext(true);
  await busy.context.loadOlderHistory();
  assert.deepEqual(busy.requests, []);

  // 后端翻页用的是连接当前打开的会话，所以这一页只有在没有切换时才安全。
  const idle = loadOlderContext(false);
  await idle.context.loadOlderHistory();
  assert.deepEqual(idle.requests, ["history.older"]);
});
