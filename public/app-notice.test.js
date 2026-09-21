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
    displayTextWithAttachments: (text) => text,
    addMessage: () => ({}),
    applySettingsUpdated() {},
    resetCurrentSession() {},
    showEmpty() {},
    loadSessions() {},
    receiveUserMessage() {},
    splitAttachmentDisplayText: (text) => ({ text, attachments: [] }),
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

test("a live final task error is retained in the timeline but replay does not duplicate it", () => {
  const h = eventHarness();
  const event = {
    type: "task.completed",
    taskId: "task-1",
    sessionId: "session-1",
    status: "failed",
    error: "最终失败。",
  };
  h.context.handleServerEvent(event);
  assert.deepEqual(h.notes, ["任务失败：最终失败。"]);
  assert.deepEqual(plain(h.shown), [{
    text: "最终失败。",
    options: { lifetime: "temporary", tone: "error" },
  }]);

  h.context.handleServerEvent(event, true);
  assert.deepEqual(h.notes, ["任务失败：最终失败。"]);
  assert.equal(h.shown.length, 1);
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

function outboxHarness(request) {
  const shown = [];
  const clearedNotices = [];
  const removed = [];
  const outbox = {
    projectId: "project-1",
    sessionId: "session-1",
    clientMessageId: "message-1",
    text: "hello",
    attachmentIds: [],
  };
  const context = vm.createContext({
    state: { authenticated: true, projectId: "project-1", sessionId: "session-1" },
    loadOutbox: () => [outbox],
    request,
    clearOutbox: (id) => removed.push(id),
    clearNotice: (key) => clearedNotices.push(key),
    showNotice: (text, options) => shown.push({ text, options }),
    deliveryNoticeKey: (id) => `delivery:${id}`,
    errorMessage: (error) => error.message,
  });
  vm.runInContext(
    section("async function retryOutboxForCurrentSession()", "function createClientMessageId("),
    context,
  );
  return { context, shown, clearedNotices, removed };
}

test("a successful outbox retry clears its delivery state", async () => {
  const h = outboxHarness(async () => ({ accepted: true }));
  await h.context.retryOutboxForCurrentSession();
  assert.deepEqual(h.removed, ["message-1"]);
  assert.deepEqual(h.clearedNotices, ["delivery:message-1"]);
  assert.deepEqual(h.shown, []);
});

test("a definitive outbox failure replaces delivery state with a persistent error", async () => {
  const h = outboxHarness(async () => {
    throw Object.assign(new Error("后端拒绝。"), { code: "rejected" });
  });
  await h.context.retryOutboxForCurrentSession();
  assert.deepEqual(h.removed, ["message-1"]);
  assert.deepEqual(h.clearedNotices, ["delivery:message-1"]);
  assert.deepEqual(plain(h.shown), [{
    text: "保留消息重试失败：后端拒绝。",
    options: {
      lifetime: "persistent",
      tone: "error",
      key: "delivery:message-1",
    },
  }]);
});
