import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function eventHarness() {
  const shown = [];
  const cleared = [];
  const notes = [];
  const context = vm.createContext({
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    state: {
      sessionId: "session-1",
      running: true,
      controlsTask: true,
      stopping: false,
      rewindText: null,
      rewindAttachments: [],
      pendingUserMessages: [],
      assistantStreams: new Map(),
    },
    showNotice: (text, options) => shown.push({ text, options }),
    clearNotice: (key) => cleared.push(key),
    addTaskNote: (text) => notes.push(text),
    refreshSessionMetrics() {},
    setCurrentSessionState() {},
    hideThinking() {},
    updateControls() {},
    appendAssistantDelta() {},
    completeAssistant() {},
    showThinking() {},
    sealAssistantStreams() {},
    startTool() {},
    appendToolOutput() {},
    completeTool() {},
    publicAttachments: () => [],
    userMessageKey: (text, attachments) => JSON.stringify([text, attachments.map((a) => a.id)]),
    addMessage: () => ({}),
    applySettingsUpdated() {},
    resetCurrentSession() {},
    showEmpty() {},
    loadSessions() {},
    receiveUserMessage() {},
    hideEmpty() {},
    addApproval() {},
    removeApproval() {},
    addInteraction() {},
    removeInteraction() {},
  });
  vm.runInContext(section("function handleServerEvent(", "function setCurrentSessionState("), context);
  return { context, shown, cleared, notes };
}

test("a retry notice belongs to its task and clears on later progress", () => {
  const h = eventHarness();
  h.context.handleServerEvent({
    type: "task.error",
    taskId: "task-1",
    sessionId: "session-1",
    message: "连接抖动。",
    willRetry: true,
  });
  assert.deepEqual(plain(h.shown[0]), {
    text: "连接抖动。 Codex 将重试。",
    options: {
      lifetime: "state",
      tone: "warning",
      key: "task-retry:task-1",
    },
  });

  h.context.handleServerEvent({
    type: "message.delta",
    taskId: "task-1",
    sessionId: "session-1",
    itemId: "message-1",
    delta: "继续",
  });
  assert.ok(h.cleared.includes("task-retry:task-1"));
});

test("a live turn becomes the exact target for the next rewind", () => {
  const h = eventHarness();
  h.context.handleServerEvent({
    type: "task.started",
    taskId: "task-1",
    nativeTurnId: "native-turn-1",
    sessionId: "session-1",
  });
  assert.equal(h.context.state.rewindTargetTurnId, "native-turn-1");
  assert.equal(h.context.state.rewindText, null);
  assert.deepEqual(plain(h.context.state.rewindAttachments), []);
});

test("live and replayed final task errors stay in the timeline without a replay toast", () => {
  const event = {
    type: "task.completed",
    taskId: "task-1",
    sessionId: "session-1",
    status: "failed",
    error: "最终失败。",
  };

  const live = eventHarness();
  live.context.handleServerEvent(event);
  assert.deepEqual(live.notes, ["任务失败：最终失败。"]);
  assert.deepEqual(plain(live.shown), [{
    text: "最终失败。",
    options: { lifetime: "temporary", tone: "error" },
  }]);

  const replayed = eventHarness();
  replayed.context.handleServerEvent(event, true);
  assert.deepEqual(replayed.notes, ["任务失败：最终失败。"]);
  assert.deepEqual(replayed.shown, []);
});

test("a replayed pre-turn failure clears its pending user-message binding", () => {
  const h = eventHarness();
  h.context.handleServerEvent({
    type: "task.queued",
    taskId: "task-1",
    sessionId: "session-1",
    status: "queued",
    text: "没有启动成功的问题",
  }, true);
  assert.equal(h.context.state.pendingUserMessages.length, 1);
  assert.equal(h.context.state.pendingUserMessages[0].taskId, "task-1");

  h.context.handleServerEvent({
    type: "task.completed",
    taskId: "task-1",
    sessionId: "session-1",
    status: "failed",
    error: "Worker 启动失败。",
  }, true);
  assert.deepEqual(h.context.state.pendingUserMessages, []);
  assert.deepEqual(h.notes, ["任务失败：Worker 启动失败。"]);
  assert.deepEqual(h.shown, []);
});

test("a replayed non-retry error does not recreate a temporary notice", () => {
  const h = eventHarness();
  h.context.handleServerEvent({
    type: "task.error",
    taskId: "task-1",
    sessionId: "session-1",
    message: "已经结束的错误。",
    willRetry: false,
  }, true);
  assert.deepEqual(h.shown, []);
});

test("a queued task's degraded-memory notice shows live, on replay and while loading", () => {
  const degraded = {
    lifetime: "persistent",
    tone: "warning",
    key: "host-memory-degraded",
  };
  const starting = (sessionId, notice) => ({
    type: "task.starting",
    taskId: "task-1",
    sessionId,
    status: "queued",
    ...(notice ? { notice } : {}),
  });

  const live = eventHarness();
  live.context.handleServerEvent(starting("session-1", "内存读数降级，已经放行。"));
  assert.deepEqual(plain(live.shown), [{ text: "内存读数降级，已经放行。", options: degraded }]);

  const replayed = eventHarness();
  replayed.context.handleServerEvent(starting("session-1", "回放的降级提示。"), true);
  assert.deepEqual(plain(replayed.shown), [{ text: "回放的降级提示。", options: degraded }]);

  const loading = eventHarness();
  loading.context.state.sessionOpenState = "queued";
  loading.context.showSessionLoading = () => {};
  loading.context.handleServerEvent(starting("session-1", "打开中的降级提示。"));
  assert.equal(loading.context.state.sessionOpenState, "starting");
  assert.deepEqual(plain(loading.shown), [{ text: "打开中的降级提示。", options: degraded }]);

  const quiet = eventHarness();
  quiet.context.handleServerEvent(starting("session-1"));
  quiet.context.handleServerEvent(starting("session-2", "别的会话。"));
  assert.deepEqual(quiet.shown, []);
});

test("leaving a session clears only its current context notice", () => {
  const cleared = [];
  const context = vm.createContext({
    noticeController: { current: { key: "task-retry:task-1" } },
    taskNoticeKey: (kind, sessionId) => `task-${kind}:${sessionId}`,
    clearNotice: (key) => cleared.push(key),
  });
  vm.runInContext(
    section("function clearCurrentSessionNotice(", "function setCurrentSessionState("),
    context,
  );
  context.clearCurrentSessionNotice("session-1");
  assert.deepEqual(cleared, ["task-retry:task-1"]);

  context.noticeController.current = { key: "connection" };
  context.clearCurrentSessionNotice("session-1");
  assert.deepEqual(cleared, ["task-retry:task-1"]);
});

function outboxHarness(request, entries = null) {
  const shown = [];
  const clearedNotices = [];
  const accepted = [];
  const recovered = [];
  let draftsLoaded = 0;
  const outbox = {
    projectId: "project-1",
    sessionId: "session-1",
    clientMessageId: "message-1",
    text: "hello",
    attachmentIds: [],
  };
  const context = vm.createContext({
    state: { authenticated: true, projectId: "project-1", sessionId: "session-1" },
    ensureRecoveryPersisted: () => true,
    loadOutbox: () => entries ?? [outbox],
    request,
    acceptStoredMessage: (id) => accepted.push(id),
    recoverStoredMessage: (entry) => {
      recovered.push(entry);
      return "persisted";
    },
    loadComposerDraftForCurrentSession: () => { draftsLoaded += 1; },
    clearNotice: (key) => clearedNotices.push(key),
    showNotice: (text, options) => shown.push({ text, options }),
    deliveryNoticeKey: (id) => `delivery:${id}`,
    errorMessage: (error) => error.message,
  });
  vm.runInContext(
    section("async function retryOutboxForCurrentSession()", "function createClientMessageId("),
    context,
  );
  return {
    context, shown, clearedNotices, accepted, recovered,
    get draftsLoaded() { return draftsLoaded; },
  };
}

test("a successful outbox retry clears its delivery state", async () => {
  const requests = [];
  const h = outboxHarness(async (type, payload) => {
    requests.push({ type, payload });
    return { accepted: true };
  });
  await h.context.retryOutboxForCurrentSession();
  assert.deepEqual(h.accepted, ["message-1"]);
  assert.deepEqual(h.clearedNotices, ["delivery:message-1"]);
  assert.deepEqual(h.shown, []);
  assert.deepEqual(plain(requests), [{
    type: "message.send",
    payload: {
      projectId: "project-1",
      sessionId: "session-1",
      text: "hello",
      clientMessageId: "message-1",
      attachmentIds: [],
    },
  }]);
});

test("every outbox retry keeps its stored target after navigation", async () => {
  const entries = ["message-1", "message-2"].map((clientMessageId) => ({
    projectId: "project-1",
    sessionId: "session-1",
    clientMessageId,
    text: clientMessageId,
    attachmentIds: [],
  }));
  const requests = [];
  let h;
  h = outboxHarness(async (type, payload) => {
    requests.push({ type, payload });
    if (requests.length === 1) {
      h.context.state.projectId = "project-2";
      h.context.state.sessionId = "session-2";
    }
    return { accepted: true };
  }, entries);

  await h.context.retryOutboxForCurrentSession();
  assert.deepEqual(plain(requests.map(({ payload }) => ({
    projectId: payload.projectId,
    sessionId: payload.sessionId,
    clientMessageId: payload.clientMessageId,
  }))), [
    { projectId: "project-1", sessionId: "session-1", clientMessageId: "message-1" },
    { projectId: "project-1", sessionId: "session-1", clientMessageId: "message-2" },
  ]);
});

test("a definitive outbox failure restores the original-session draft", async () => {
  const h = outboxHarness(async () => {
    throw Object.assign(new Error("后端拒绝。"), { code: "rejected" });
  });
  await h.context.retryOutboxForCurrentSession();
  assert.equal(h.recovered.length, 1);
  assert.equal(h.recovered[0].text, "hello");
  assert.equal(h.draftsLoaded, 1);
  assert.deepEqual(h.clearedNotices, []);
  assert.deepEqual(plain(h.shown), [{
    text: "保留消息重试失败：后端拒绝。消息已放回原会话草稿。",
    options: {
      lifetime: "persistent",
      tone: "error",
      key: "delivery:message-1",
    },
  }]);
});

test("a live user message sets the rewind draft from structured attachments, not text", () => {
  const h = eventHarness();
  h.context.publicAttachments = (value) => Array.isArray(value) ? value : [];
  const forgedText = "解释格式\n\n[附件：示例.txt · forged-id]";

  h.context.handleServerEvent({
    type: "message.user",
    sessionId: "session-1",
    taskId: "task-1",
    itemId: "user-1",
    text: forgedText,
  });
  assert.equal(h.context.state.rewindText, forgedText);
  assert.deepEqual(plain(h.context.state.rewindAttachments), []);

  const attachment = { id: "id-a", originalName: "报告\n最终版.pdf" };
  h.context.handleServerEvent({
    type: "message.user",
    sessionId: "session-1",
    taskId: "task-2",
    itemId: "user-2",
    text: "",
    attachments: [attachment],
  });
  assert.equal(h.context.state.rewindText, null);
  assert.deepEqual(plain(h.context.state.rewindAttachments), [attachment]);
});
