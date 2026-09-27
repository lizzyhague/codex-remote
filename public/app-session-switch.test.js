import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

const OPEN_INTENT = section("function beginOpenIntent(", "async function startSession(");
const RESUME = section("async function resumeSession(sessionId)", "function applyOpenedSession(");
const LOAD_OLDER = section("async function loadOlderHistory()", "async function sendMessage()");
const LOADING_LABEL = section("function showSessionLoading(", "function hideEmpty(");
const LOADING_EVENTS = section(
  "function handleLoadingSessionEvent(",
  "function isTaskProgressEvent(",
);

function resumeContext(overrides = {}) {
  const timeline = [];
  const context = vm.createContext({
    state: {
      sessionId: "session-1",
      projectId: "project-1",
      composerProjectId: "project-1",
      composerSessionId: "session-1",
      navigationBusy: false,
      openGeneration: 0,
      openIntent: null,
      sessionLoading: false,
      sessionOpenState: null,
      sessionResumeTimer: null,
      sessionResumeInFlight: false,
      authenticated: true,
      running: false,
      stopping: false,
      controlsTask: false,
    },
    SESSION_LOADING_RETRY_MS: 1_000,
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
      context.state.sessionOpenState = null;
      timeline.push({ kind: "session", id: opened.session.id });
    },
    showNotice: (message) => timeline.push({ kind: "notice", message }),
    showSessionLoading: (loadState) => timeline.push({
      kind: "loading",
      ...(loadState ? { loadState } : {}),
    }),
    showEmpty: (text) => timeline.push({ kind: "empty", text }),
    clearCurrentSessionNotice: () => {},
    persistCurrentComposerDraft: () => true,
    abortAttachmentUploads: () => {},
    renderSessionMetrics: () => {},
    setCurrentSessionState: () => {},
    updateConversationTitle: () => {},
    closeMobileSidebar: () => {},
    loadComposerDraftForCurrentSession: () => {},
    clearTimeout: () => {},
    setTimeout: () => 1,
    resetCurrentSession: () => {
      context.state.sessionId = null;
      timeline.push({ kind: "reset" });
    },
    updateControls: () => {},
    errorMessage: (error) => error.message,
    ...overrides,
  });
  vm.runInContext(OPEN_INTENT + RESUME, context);
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

test("a queued session stays on a truthful loading screen and remains controllable", async () => {
  const { context, timeline } = resumeContext({
    request: async () => ({
      loadState: "queued",
      sessionId: "session-2",
      activeTaskId: "task-2",
      controlsActiveTask: true,
    }),
  });
  await context.resumeSession("session-2");
  assert.deepEqual(timeline, [
    { kind: "loading" },
    { kind: "loading", loadState: "queued" },
  ]);
  assert.equal(context.state.sessionId, "session-2");
  assert.equal(context.state.sessionOpenState, "queued");
  assert.equal(context.state.running, true);
  assert.equal(context.state.controlsTask, true);
  assert.equal(context.state.navigationBusy, false);
});

test("a loading session replaces the status with real history once the Worker is ready", async () => {
  let ready = false;
  const { context, timeline } = resumeContext({
    request: async () => ready
      ? { loadState: "ready", session: { id: "session-2" } }
      : {
        loadState: "starting",
        sessionId: "session-2",
        activeTaskId: "task-2",
        controlsActiveTask: true,
      },
  });
  await context.resumeSession("session-2");
  ready = true;
  await context.refreshLoadingSession();
  assert.deepEqual(timeline, [
    { kind: "loading" },
    { kind: "loading", loadState: "starting" },
    { kind: "session", id: "session-2" },
  ]);
  assert.equal(context.state.sessionOpenState, null);
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const outcome of ["success", "failure"]) {
  test(`a late ${outcome} for a session removed by another device is not drawn`, async () => {
    const reply = deferred();
    const { context, timeline } = resumeContext({ request: () => reply.promise });
    const opening = context.resumeSession("session-2");
    assert.equal(context.state.navigationBusy, true);

    // 另一台设备把正在打开的目标归档；页面此时仍显示“加载中”。
    assert.equal(context.cancelRemovedOpenIntent({
      type: "sessions.changed",
      projectId: "project-1",
      sessionIds: ["session-2"],
      change: "archive",
      closedSessionId: null,
    }), true);
    assert.equal(context.state.sessionId, null);
    assert.equal(context.state.navigationBusy, false);

    if (outcome === "success") reply.resolve({ session: { id: "session-2" } });
    else reply.reject(new Error("会话在打开过程中已被关闭或移走，请重新选择。"));
    await opening;

    assert.deepEqual(timeline, [
      { kind: "loading" },
      { kind: "reset" },
      { kind: "empty", text: "这个会话已经移出当前列表。请选择其他会话。" },
    ], "迟到的结果既不重新打开会话，也不再弹错误");
    assert.equal(context.state.sessionId, null);
    assert.equal(context.state.navigationBusy, false);
  });
}

test("only removals of the session being opened cancel the open", async () => {
  const reply = deferred();
  const { context, timeline } = resumeContext({ request: () => reply.promise });
  const opening = context.resumeSession("session-2");
  for (const event of [
    { projectId: "project-1", sessionIds: ["session-9"], change: "archive" },
    { projectId: "project-1", sessionIds: ["session-2"], change: "rename" },
    { projectId: "project-1", sessionIds: ["session-2"], change: "mark" },
    { projectId: "project-2", sessionIds: ["session-2"], change: "trash" },
  ]) {
    assert.equal(context.cancelRemovedOpenIntent({ type: "sessions.changed", ...event }), false);
  }
  reply.resolve({ session: { id: "session-2" } });
  await opening;
  assert.deepEqual(timeline, [
    { kind: "loading" },
    { kind: "session", id: "session-2" },
  ]);
});

test("a superseded open neither draws its result nor releases the newer open's lock", async () => {
  const replies = [deferred(), deferred()];
  let call = 0;
  const { context, timeline } = resumeContext({
    findSessionSummary: (id) => ({ id, projectId: "project-1" }),
    request: () => replies[call++].promise,
  });
  const first = context.resumeSession("session-2");
  const second = context.resumeSession("session-3");
  replies[0].resolve({ session: { id: "session-2" } });
  await first;
  assert.equal(context.state.navigationBusy, true, "更新的打开仍在途");
  replies[1].resolve({ session: { id: "session-3" } });
  await second;
  assert.deepEqual(timeline.filter((entry) => entry.kind === "session"), [
    { kind: "session", id: "session-3" },
  ]);
  assert.equal(context.state.navigationBusy, false);
});

function loadOlderContext(navigationBusy) {
  const requests = [];
  const context = vm.createContext({
    state: {
      projectId: "project-1",
      sessionId: "session-1",
      authenticated: true,
      navigationBusy,
    },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: {
      loadOlderButton: { disabled: false, textContent: "加载更早" },
      historyLoader: { hidden: true, after() {} },
      timeline: { scrollHeight: 100, scrollTop: 0, children: [] },
    },
    request: async (type, payload) => {
      requests.push({ type, payload });
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

  // 后端会核对点击时看到的项目和会话，不会在导航后推进新会话的游标。
  const idle = loadOlderContext(false);
  await idle.context.loadOlderHistory();
  assert.deepEqual(JSON.parse(JSON.stringify(idle.requests)), [{
    type: "history.older",
    payload: { projectId: "project-1", sessionId: "session-1" },
  }]);
});

test("session loading states explain what the backend is waiting for", () => {
  const messages = [];
  const context = vm.createContext({
    showEmpty: (message) => messages.push(message),
  });
  vm.runInContext(LOADING_LABEL, context);
  context.showSessionLoading();
  context.showSessionLoading("queued");
  context.showSessionLoading("starting");
  context.showSessionLoading("restoring");
  assert.deepEqual(messages, [
    "正在载入会话……",
    "任务正在排队，等待可用 Worker……",
    "正在启动 Codex 并恢复会话……",
    "正在恢复运行中的任务……",
  ]);
});

test("worker events advance a loading session without drawing partial history", () => {
  const rendered = [];
  const retries = [];
  const context = vm.createContext({
    state: {
      sessionId: "session-1",
      sessionOpenState: "queued",
      running: true,
      controlsTask: true,
      stopping: false,
    },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    scheduleLoadingSessionResume: (delay) => retries.push(delay),
    showSessionLoading: (loadState) => rendered.push(loadState),
    updateControls: () => {},
    showNotice: () => {},
  });
  vm.runInContext(LOADING_EVENTS, context);

  assert.equal(context.handleLoadingSessionEvent({
    type: "task.starting", sessionId: "session-1",
  }, false), true);
  assert.equal(context.state.sessionOpenState, "starting");
  assert.deepEqual(rendered, ["starting"]);

  assert.equal(context.handleLoadingSessionEvent({
    type: "task.started", sessionId: "session-1",
  }, false), true);
  assert.equal(context.state.sessionOpenState, "restoring");
  assert.deepEqual(retries, [0]);
  assert.deepEqual(rendered, ["starting", "restoring"]);

  assert.equal(context.handleLoadingSessionEvent({
    type: "message.delta", sessionId: "another-session",
  }, false), false);
});
