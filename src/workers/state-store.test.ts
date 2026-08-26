import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkerStateStore } from "./state-store.ts";

test("persists accepted messages and deduplicates clientMessageId", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-worker-state-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "work.sqlite");
  const store = await WorkerStateStore.open(file);
  context.after(() => store.close());

  const first = store.enqueue({
    id: "task-1",
    clientMessageId: "message-1",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "你好",
    permissionMode: "manual",
    createdAtMs: 100,
  });
  const duplicate = store.enqueue({
    id: "ignored-task-id",
    clientMessageId: "message-1",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "你好",
    permissionMode: "manual",
    createdAtMs: 200,
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.task.id, "task-1");
  assert.equal(store.queued().length, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.throws(() => store.enqueue({
    id: "task-2",
    clientMessageId: "message-1",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "不同内容",
    permissionMode: "manual",
    createdAtMs: 300,
  }), /另一条消息/u);
});

test("keeps ordered browser events and marks live work interrupted after restart", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-worker-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "work.sqlite");
  let store = await WorkerStateStore.open(file);
  store.enqueue({
    id: "task-1",
    clientMessageId: "message-1",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "继续",
    permissionMode: "manual",
    createdAtMs: 100,
  });
  store.markRunning("task-1", "native-turn-1", "manual", 110);
  const first = store.appendEvent("task-1", "thread-1", {
    type: "message.delta",
    delta: "一",
  }, 120);
  store.close();

  store = await WorkerStateStore.open(file);
  context.after(() => store.close());
  const recovered = store.recoverInterrupted(200);
  const events = store.eventsForTask("task-1");

  assert.equal(recovered.length, 1);
  assert.equal(store.require("task-1").status, "interrupted");
  assert.equal(store.require("task-1").interruptionReason, "backend_restarted");
  assert.equal(events[0]?.sequence, first.sequence);
  assert.equal(events[1]?.event.type, "task.completed");
  assert.equal(events[1]?.event.interruptionReason, "backend_restarted");
});

test("persists Full access selection across state-store reopen", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-worker-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "work.sqlite");

  let store = await WorkerStateStore.open(file);
  assert.equal(store.sessionFullAccess("thread-1"), null);
  store.setSessionFullAccess("thread-1", true, 100);
  assert.equal(store.sessionFullAccess("thread-1"), true);
  store.close();

  store = await WorkerStateStore.open(file);
  context.after(() => store.close());
  assert.equal(store.sessionFullAccess("thread-1"), true);
  store.setSessionFullAccess("thread-1", false, 200);
  assert.equal(store.sessionFullAccess("thread-1"), false);
});

test("persists only public attachment metadata with an accepted message", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-worker-attachments-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = await WorkerStateStore.open(path.join(directory, "work.sqlite"));
  context.after(() => store.close());
  const attachment = {
    id: "attachment-1",
    caller: "codex" as const,
    projectId: "project-1",
    sessionId: "thread-1",
    originalName: "screen.png",
    declaredMime: "image/png",
    detectedMime: "image/png",
    kind: "image" as const,
    size: 12,
    sha256: "a".repeat(64),
    createdAtMs: 1,
    expiresAtMs: 2,
  };
  const stored = store.enqueue({
    id: "task-attachment",
    clientMessageId: "message-attachment",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "看图",
    attachments: [attachment],
    permissionMode: "manual",
    createdAtMs: 100,
  }).task;
  assert.deepEqual(stored.attachments, [attachment]);
  assert.equal("path" in stored.attachments[0]!, false);
});
