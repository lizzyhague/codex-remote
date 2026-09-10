import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { AttachmentDisplayIndex } from "./attachment-index.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApprovalEvent, ApprovalRequest } from "../approvals/broker.ts";
import {
  CodexTurnCancelledError,
  type CodexStreamEvent,
} from "../app-server/turn-session.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import type { TrashStore } from "../sessions/trash-store.ts";
import { ProjectTaskLocks } from "../server/project-locks.ts";
import {
  SessionWorkerManager,
  type SessionWorkerManagerOptions,
  WorkerManagerError,
} from "./manager.ts";
import type { SessionWorker, SessionWorkerOptions } from "./session-worker.ts";
import { WorkerStateStore } from "./state-store.ts";

test("keeps an accepted turn running after the browser disconnects", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "后台继续",
  );
  const worker = await fixture.waitForWorker();
  fixture.manager.clientDisconnected("phone");
  await delay(20);

  assert.equal(worker.interruptCount, 0);
  worker.complete("completed");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");
  assert.equal(fixture.store.require(accepted.taskId).status, "completed");
});

test("cancels the whole manual turn when an offline approval outlives grace", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 5 });
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "需要权限",
  );
  const worker = await fixture.waitForWorker();
  worker.requestApproval();

  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  const task = fixture.store.require(accepted.taskId);
  assert.equal(worker.cancelledApprovals, 1);
  assert.equal(worker.interruptCount, 1);
  assert.equal(task.interruptionReason, "no_client_for_permission");
});

test("auto-approves an execution request for an offline Full access turn", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 1,
    fullAccess: true,
    persistedFullAccess: true,
  });
  fixture.manager.start();
  fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "继续执行");
  const worker = await fixture.waitForWorker();
  worker.requestApproval();
  await delay(5);

  assert.equal(worker.approved, 1);
  assert.equal(worker.interruptCount, 0);
  worker.complete("completed");
});


test("restores Full access after replacing a transient Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 1 });
  const toggled = await fixture.manager.toggleFullAccess("project-1", "thread-1");
  assert.equal(toggled.fullAccessEnabled, true);
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "继续执行",
  );
  await waitFor(() => fixture.workers[1]?.started === true);
  const worker = fixture.workers[1]!;
  assert.equal(worker.fullAccessEnabled, true);
  assert.equal(fixture.store.require(accepted.taskId).permissionMode, "full_access");
  worker.requestApproval();
  await delay(5);
  assert.equal(worker.approved, 1);
  assert.equal(worker.interruptCount, 0);
  worker.complete("completed");
});

test("restores persisted Full access in a new manager", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 1,
    persistedFullAccess: true,
  });
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "继续执行",
  );
  await waitFor(() => fixture.workers[0]?.started === true);
  const worker = fixture.workers[0]!;
  assert.equal(worker.fullAccessEnabled, true);
  assert.equal(fixture.store.require(accepted.taskId).permissionMode, "full_access");
  worker.requestApproval();
  await delay(5);
  assert.equal(worker.approved, 1);
  assert.equal(worker.interruptCount, 0);
  worker.complete("completed");
});

test("fails before starting a turn when Full access cannot be restored", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 1,
    persistedFullAccess: true,
    toggleFullAccessFails: true,
  });
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "继续执行",
  );
  await waitFor(() => fixture.store.require(accepted.taskId).status === "failed");
  assert.equal(fixture.workers[0]?.started, false);
  const events = fixture.store.eventsForTask(accepted.taskId);
  const completed = events.at(-1)?.event;
  assert.match(String(completed?.error), /权限/u);
});
test("blocks a new session when a trusted reading is below the memory threshold", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 5,
    minAvailableMemoryBytes: 1_073_741_824,
    availableMemory: async () => ({
      availableBytes: 512 * 1_048_576,
      platform: "darwin" as const,
      source: "darwin-vm-stat" as const,
    }),
  });
  fixture.manager.start();
  await assert.rejects(
    fixture.manager.startSession("project-1"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "worker_memory_low");
      assert.match(String((error as Error).message), /当前可用 512 MiB/u);
      return true;
    },
  );
  assert.equal(fixture.workers.length, 0);
});

test("opens the session with a notice when the memory reading degrades", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 5,
    minAvailableMemoryBytes: 1_073_741_824,
    availableMemory: async () => ({
      availableBytes: 216 * 1_048_576,
      platform: "darwin" as const,
      source: "os-freemem" as const,
      degradedReason: "vm_stat 输出缺少 Pages occupied by compressor（压缩器占用页）",
    }),
  });
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  assert.equal(fixture.workers.length, 1);
  assert.match(String(opened.notice), /已经放行/u);
  assert.match(String(opened.notice), /compressor/u);
});

test("keeps a brand-new empty thread only while a browser is attached", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 5 });
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  const worker = fixture.workers[0]!;
  fixture.manager.attachSession("phone", opened.opened.session.id);
  await delay(10);
  assert.equal(worker.closeCount, 0);
  fixture.manager.detachSession("phone");
  await waitFor(() => worker.closeCount === 1);
  assert.equal(worker.started, false);
});

test("promotes the empty-session Worker for the first accepted message", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  fixture.manager.attachSession("phone", opened.opened.session.id);
  fixture.manager.enqueueMessage(
    "project-1",
    opened.opened.session.id,
    "message-1",
    "第一条",
  );
  await waitFor(() => fixture.workers[0]?.started === true);
  assert.equal(fixture.workers.length, 1);
  fixture.workers[0]!.complete("completed");
});

test("fails a promoted new-session task when its Worker exits", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  fixture.manager.attachSession("phone", opened.opened.session.id);
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    opened.opened.session.id,
    "message-1",
    "第一条",
  );
  const worker = await fixture.waitForWorker();
  worker.exitUnexpectedly();

  await waitFor(() => fixture.store.require(accepted.taskId).status === "failed");
  assert.equal(fixture.store.require(accepted.taskId).status, "failed");
  assert.equal(worker.closeCount, 1);
});

test("counts a Worker that is still starting against the capacity limit", async (context) => {
  let releaseCreate!: () => void;
  let reportCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    reportCreateStarted = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    maxWorkers: 1,
    beforeWorkerCreate: async () => {
      reportCreateStarted();
      await createGate;
    },
  });

  const first = fixture.manager.startSession("project-1");
  await createStarted;
  await assert.rejects(
    fixture.manager.startSession("project-1"),
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "worker_capacity",
  );
  releaseCreate();
  await first;
});

test("serializes short-lived Workers for the same historical thread", async (context) => {
  let releaseFirst!: () => void;
  let reportFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    reportFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let createCalls = 0;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    maxWorkers: 2,
    beforeWorkerCreate: async () => {
      createCalls += 1;
      if (createCalls === 1) {
        reportFirstStarted();
        await firstGate;
      }
    },
  });

  const first = fixture.manager.resumeSession("project-1", "thread-1");
  await firstStarted;
  const second = fixture.manager.resumeSession("project-1", "thread-1");
  await delay(10);
  assert.equal(createCalls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(createCalls, 2);
});

test("leases attachment paths only while the persisted task is pending", async (context) => {
  let released = 0;
  const uploads: NonNullable<SessionWorkerManagerOptions["uploads"]> = {
    async createLease(binding, ownerId, attachmentIds) {
      assert.deepEqual(binding, { caller: "codex", projectId: "project-1", sessionId: "thread-1" });
      return {
        leaseId: "lease-1",
        ownerId,
        expiresAtMs: Date.now() + 900_000,
        attachments: attachmentIds.map((id) => ({
          id,
          ...binding,
          originalName: "screen.png",
          path: "/private/uploads/screen.png",
          declaredMime: "image/png",
          detectedMime: "image/png",
          kind: "image" as const,
          size: 12,
          sha256: "a".repeat(64),
          createdAtMs: 1,
          expiresAtMs: 2,
        })),
      };
    },
    async renewLease(leaseId) {
      return { leaseId, expiresAtMs: Date.now() + 900_000 };
    },
    async releaseLease() {
      released += 1;
    },
  };
  const fixture = await managerFixture(context, { offlineGraceMs: 10, uploads });
  const prepared = await fixture.manager.prepareMessageAttachments(
    "project-1",
    "thread-1",
    ["attachment-1"],
  );
  const accepted = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-attachment",
    "看图",
    prepared,
  );
  fixture.manager.start();
  const worker = await fixture.waitForWorker();
  assert.equal("path" in fixture.store.require(accepted.taskId).attachments[0]!, false);
  assert.equal(worker.startedAttachments[0]?.path, "/private/uploads/screen.png");
  worker.complete("completed");
  await waitFor(() => released === 1);
});

test("deduplicates an accepted attachment message before asking for a new lease", async (context) => {
  let createCalls = 0;
  const uploads: NonNullable<SessionWorkerManagerOptions["uploads"]> = {
    async createLease(binding, ownerId, attachmentIds) {
      createCalls += 1;
      if (createCalls > 1) throw new Error("附件已经过期，不应再次申请租约");
      return {
        leaseId: "lease-idempotent",
        ownerId,
        expiresAtMs: Date.now() + 900_000,
        attachments: attachmentIds.map((id) => ({
          id,
          ...binding,
          originalName: "screen.png",
          path: "/private/uploads/screen.png",
          declaredMime: "image/png",
          detectedMime: "image/png",
          kind: "image" as const,
          size: 12,
          sha256: "a".repeat(64),
          createdAtMs: 1,
          expiresAtMs: 2,
        })),
      };
    },
    async renewLease(leaseId) {
      return { leaseId, expiresAtMs: Date.now() + 900_000 };
    },
    async releaseLease() {},
  };
  const fixture = await managerFixture(context, { offlineGraceMs: 10, uploads });
  const first = await fixture.manager.enqueueMessageWithAttachments(
    "project-1",
    "thread-1",
    "message-idempotent",
    "看图",
    ["attachment-1"],
  );
  const retried = await fixture.manager.enqueueMessageWithAttachments(
    "project-1",
    "thread-1",
    "message-idempotent",
    "看图",
    ["attachment-1"],
  );

  assert.equal(first.duplicate, false);
  assert.equal(retried.duplicate, true);
  assert.equal(retried.taskId, first.taskId);
  assert.equal(createCalls, 1);
});

test("accepts a PDF attachment and hides its storage path from browser events", async (context) => {
  const uploads: NonNullable<SessionWorkerManagerOptions["uploads"]> = {
    async createLease(binding, ownerId, attachmentIds) {
      return {
        leaseId: "lease-pdf",
        ownerId,
        expiresAtMs: Date.now() + 900_000,
        attachments: attachmentIds.map((id) => ({
          id,
          ...binding,
          originalName: "report.pdf",
          path: "/private/uploads/report.pdf",
          declaredMime: "application/pdf",
          detectedMime: "application/pdf",
          kind: "file" as const,
          size: 12,
          sha256: "b".repeat(64),
          createdAtMs: 1,
          expiresAtMs: 2,
        })),
      };
    },
    async renewLease(leaseId) {
      return { leaseId, expiresAtMs: Date.now() + 900_000 };
    },
    async releaseLease() {},
  };
  const fixture = await managerFixture(context, { offlineGraceMs: 10, uploads });
  const events: Array<Record<string, unknown>> = [];
  fixture.manager.onEvent((event) => events.push(event.event));

  const accepted = await fixture.manager.enqueueMessageWithAttachments(
    "project-1",
    "thread-1",
    "message-pdf",
    "看报告",
    ["attachment-pdf"],
  );
  fixture.manager.start();
  const worker = await fixture.waitForWorker();
  assert.equal(accepted.duplicate, false);
  assert.equal(fixture.store.findByClientMessageId("message-pdf")?.id, accepted.taskId);
  assert.equal(worker.startedAttachments[0]?.path, "/private/uploads/report.pdf");
  worker.emitAssistant("/private/uploads/report.pdf 已打开");
  worker.complete("completed");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("/private/uploads/report.pdf"), false);
  assert.ok(serialized.includes("附件：report.pdf") || serialized.includes("report.pdf"));
});

test("rejects another thread in the same project before the first task ends", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.start();
  const first = fixture.manager.enqueueMessage("project-1", "thread-1", "message-b", "B 在跑");
  await fixture.waitForWorker("thread-1");

  assert.throws(
    () => fixture.manager.enqueueMessage("project-1", "thread-2", "message-a", "A 想发"),
    (error: unknown) => error instanceof WorkerManagerError && error.code === "project_busy",
  );
  assert.equal(fixture.store.findByClientMessageId("message-a"), null);
  assert.equal(fixture.store.eventsForTask(first.taskId).some((item) =>
    item.event.type === "task.queued"
  ), true);
  fixture.workers[0]!.complete("completed");
  await waitFor(() => fixture.store.require(first.taskId).status === "completed");
  await delay(20);
  assert.equal(fixture.store.findByClientMessageId("message-a"), null);
});

test("rejects a second message on the same thread", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.start();
  fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "第一条");
  await fixture.waitForWorker();
  assert.throws(
    () => fixture.manager.enqueueMessage("project-1", "thread-1", "message-2", "第二条"),
    (error: unknown) =>
      error instanceof WorkerManagerError && error.code === "task_already_running",
  );
  assert.equal(fixture.store.findByClientMessageId("message-2"), null);
});

test("duplicate clientMessageId retries are not blocked by the busy check", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.start();
  const first = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "同一条");
  const retried = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "同一条");
  assert.equal(retried.duplicate, true);
  assert.equal(retried.taskId, first.taskId);
  assert.equal(fixture.store.findByClientMessageId("message-1")?.id, first.taskId);
});

test("different projects stay independent and capacity still queues", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10, maxWorkers: 1 });
  fixture.manager.start();
  const first = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "项目一");
  await fixture.waitForWorker("thread-1");
  const second = fixture.manager.enqueueMessage("project-2", "thread-2", "message-2", "项目二");
  assert.equal(second.duplicate, false);
  assert.equal(fixture.store.require(second.taskId).status, "queued");
  fixture.workers[0]!.complete("completed");
  await waitFor(() => fixture.store.require(second.taskId).status === "running");
});

test("stopping a queued task never starts a Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10, maxWorkers: 1 });
  await fixture.manager.startSession("project-2");
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "排队");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "queued");
  const stopped = await fixture.manager.stopTask("thread-1");
  assert.equal(stopped.requested, true);
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  assert.equal(fixture.store.require(accepted.taskId).interruptionReason, "user_requested");
  assert.equal(fixture.workers.some((worker) => worker.startTurnCalls > 0), false);
  assert.equal(
    fixture.store.eventsForTask(accepted.taskId).filter((item) =>
      item.event.type === "task.completed"
    ).length,
    1,
  );
  assert.equal(fixture.locks.acquire("project-1", "probe", "thread-x"), true);
  fixture.locks.release("project-1", "probe");
});

test("stopping a launching task never calls startTextTurn", async (context) => {
  let releaseCreate!: () => void;
  let reportCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    reportCreateStarted = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeWorkerCreate: async () => {
      reportCreateStarted();
      await createGate;
    },
  });
  context.after(() => releaseCreate());
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "启动中");
  await createStarted;
  const stopped = await fixture.manager.stopTask("thread-1");
  assert.equal(stopped.requested, true);
  releaseCreate();
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  assert.equal(fixture.workers.some((worker) => worker.startTurnCalls > 0), false);
  assert.equal(fixture.locks.acquire("project-1", "probe", "thread-x"), true);
  fixture.locks.release("project-1", "probe");
});

test("stopping during turn/start interrupts once and keeps the project busy", async (context) => {
  let releaseStart!: () => void;
  let reportStartStarted!: () => void;
  const startStarted = new Promise<void>((resolve) => {
    reportStartStarted = resolve;
  });
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    autoCompleteOnInterrupt: false,
    beforeStartTurn: async () => {
      reportStartStarted();
      await startGate;
    },
  });
  context.after(() => releaseStart());
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "飞行中");
  await startStarted;
  const firstStop = fixture.manager.stopTask("thread-1");
  const secondStop = fixture.manager.stopTask("thread-1");
  releaseStart();
  assert.equal((await firstStop).requested, true);
  assert.equal((await secondStop).requested, true);
  await waitFor(() => fixture.workers[0]?.interruptCount === 1);
  assert.equal(fixture.workers[0]!.interruptCount, 1);
  assert.throws(
    () => fixture.manager.enqueueMessage("project-1", "thread-2", "message-2", "还不能发"),
    (error: unknown) => error instanceof WorkerManagerError && error.code === "project_busy",
  );
  fixture.workers[0]!.complete("interrupted");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  const next = fixture.manager.enqueueMessage("project-1", "thread-2", "message-3", "现在可以");
  assert.equal(next.duplicate, false);
});

test("stopping compact before native start does not compact", async (context) => {
  let releaseCreate!: () => void;
  let reportCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    reportCreateStarted = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeWorkerCreate: async () => {
      reportCreateStarted();
      await createGate;
    },
  });
  context.after(() => releaseCreate());
  fixture.manager.start();
  const accepted = fixture.manager.enqueueCommandTask(
    "project-1",
    "thread-1",
    "compact-1",
    "compact",
  );
  await createStarted;
  assert.equal((await fixture.manager.stopTask("thread-1")).requested, true);
  releaseCreate();
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  assert.equal(fixture.workers.reduce((sum, worker) => sum + worker.compactCalls, 0), 0);
});

test("stopping review before native start does not review", async (context) => {
  let releaseCreate!: () => void;
  let reportCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => {
    reportCreateStarted = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeWorkerCreate: async () => {
      reportCreateStarted();
      await createGate;
    },
  });
  context.after(() => releaseCreate());
  fixture.manager.start();
  const accepted = fixture.manager.enqueueCommandTask(
    "project-1",
    "thread-1",
    "review-1",
    "review",
  );
  await createStarted;
  assert.equal((await fixture.manager.stopTask("thread-1")).requested, true);
  releaseCreate();
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  assert.equal(fixture.workers.reduce((sum, worker) => sum + worker.reviewCalls, 0), 0);
});

test("busy attachment messages release the lease and leave no mapping", async (context) => {
  let released = 0;
  const uploads: NonNullable<SessionWorkerManagerOptions["uploads"]> = {
    async createLease(binding, ownerId, attachmentIds) {
      return {
        leaseId: `lease-${ownerId}`,
        ownerId,
        expiresAtMs: Date.now() + 900_000,
        attachments: attachmentIds.map((id) => ({
          id,
          ...binding,
          originalName: "note.txt",
          path: "/private/uploads/note.txt",
          declaredMime: "text/plain",
          detectedMime: "text/plain",
          kind: "file" as const,
          size: 4,
          sha256: "c".repeat(64),
          createdAtMs: 1,
          expiresAtMs: 2,
        })),
      };
    },
    async renewLease(leaseId) {
      return { leaseId, expiresAtMs: Date.now() + 900_000 };
    },
    async releaseLease() {
      released += 1;
    },
  };
  const fixture = await managerFixture(context, { offlineGraceMs: 10, uploads });
  fixture.manager.start();
  await fixture.manager.enqueueMessageWithAttachments(
    "project-1",
    "thread-1",
    "message-1",
    "先跑",
    ["attachment-1"],
  );
  await fixture.waitForWorker("thread-1");
  const prepared = await fixture.manager.prepareMessageAttachments(
    "project-1",
    "thread-2",
    ["attachment-2"],
    "看附件",
  );
  assert.throws(
    () => fixture.manager.enqueueMessage(
      "project-1",
      "thread-2",
      "message-2",
      "看附件",
      prepared,
    ),
    (error: unknown) => error instanceof WorkerManagerError && error.code === "project_busy",
  );
  await waitFor(() => released === 1);
  assert.equal(fixture.store.findByClientMessageId("message-2"), null);
  assert.deepEqual(fixture.attachmentIndex.peek("thread-2"), []);
});

test("repeated stop on a running task interrupts once", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    autoCompleteOnInterrupt: false,
  });
  fixture.manager.start();
  const accepted = fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "重复停");
  const worker = await fixture.waitForWorker();
  const first = fixture.manager.stopTask("thread-1");
  const second = fixture.manager.stopTask("thread-1");
  assert.equal((await first).requested, true);
  assert.equal((await second).requested, true);
  assert.equal(worker.interruptCount, 1);
  worker.complete("interrupted");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  assert.equal(
    fixture.store.eventsForTask(accepted.taskId).filter((item) =>
      item.event.type === "task.completed"
    ).length,
    1,
  );
});

async function managerFixture(
  context: test.TestContext,
  options: {
    offlineGraceMs: number;
    fullAccess?: boolean;
    persistedFullAccess?: boolean;
    toggleFullAccessFails?: boolean;
    maxWorkers?: number;
    minAvailableMemoryBytes?: number;
    availableMemory?: SessionWorkerManagerOptions["availableMemory"];
    beforeWorkerCreate?: () => Promise<void>;
    beforeStartTurn?: () => Promise<void>;
    beforeCompact?: () => Promise<void>;
    beforeReview?: () => Promise<void>;
    autoCompleteOnInterrupt?: boolean;
    uploads?: SessionWorkerManagerOptions["uploads"];
  },
) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-manager-"));
  const store = await WorkerStateStore.open(path.join(directory, "work.sqlite"));
  const attachmentIndex = await AttachmentDisplayIndex.open(directory);
  if (options.persistedFullAccess !== undefined) {
    store.setSessionFullAccess("thread-1", options.persistedFullAccess, 1);
  }
  const workers: FakeWorker[] = [];
  const locks = new ProjectTaskLocks();
  const manager = new SessionWorkerManager({
    store,
    projects: {} as ProjectCatalog,
    trash: {} as TrashStore,
    locks,
    ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
    offlineGraceMs: options.offlineGraceMs,
    queueRetryMs: 5,
    minAvailableMemoryBytes: options.minAvailableMemoryBytes ?? 0,
    availableMemory: options.availableMemory ?? (async () => ({
      availableBytes: Number.MAX_SAFE_INTEGER,
      platform: "linux" as const,
      source: "linux-meminfo" as const,
    })),
    workerFactory: async (workerOptions) => {
      await options.beforeWorkerCreate?.();
      const worker = new FakeWorker(
        workerOptions,
        options.fullAccess === true,
        options.toggleFullAccessFails === true,
        {
          ...(options.beforeStartTurn ? { beforeStartTurn: options.beforeStartTurn } : {}),
          ...(options.beforeCompact ? { beforeCompact: options.beforeCompact } : {}),
          ...(options.beforeReview ? { beforeReview: options.beforeReview } : {}),
          ...(options.autoCompleteOnInterrupt === undefined
            ? {}
            : { autoCompleteOnInterrupt: options.autoCompleteOnInterrupt }),
        },
      );
      workers.push(worker);
      return worker as unknown as SessionWorker;
    },
    ...(options.uploads ? { uploads: options.uploads } : {}),
    attachmentIndex,
  });
  context.after(async () => {
    await manager.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    manager,
    store,
    workers,
    locks,
    attachmentIndex,
    waitForWorker: async (threadId?: string) => {
      await waitFor(() =>
        workers.some((worker) => worker.started && (!threadId || worker.threadId === threadId))
      );
      return workers.find((worker) =>
        worker.started && (!threadId || worker.threadId === threadId)
      )!;
    },
  };
}

let fakeThreadSerial = 0;

class FakeWorker {
  readonly opened;
  readonly commands;
  readonly turns;
  readonly approvals;
  readonly interactions = {
    pendingForThread: () => [],
    answer: () => false,
    cancelThread: () => 0,
  };
  started = false;
  startedAttachments: Array<{ path: string }> = [];
  startTurnCalls = 0;
  compactCalls = 0;
  reviewCalls = 0;
  interruptCount = 0;
  closeCount = 0;
  cancelledApprovals = 0;
  approved = 0;
  readonly autoCompleteOnInterrupt: boolean;
  #threadId: string;
  #activeTurnId: string | null = null;
  #starting = false;
  #pendingInterrupt = false;
  #interruptPromise: Promise<boolean> | null = null;
  #interruptRequested = false;
  #pendingResolve: ((value: boolean) => void) | null = null;
  #pendingApproval: ApprovalRequest | null = null;
  readonly #options: SessionWorkerOptions;
  #fullAccess: boolean;
  readonly #toggleFullAccessFails: boolean;
  readonly #beforeStartTurn?: (() => Promise<void>) | undefined;
  readonly #beforeCompact?: (() => Promise<void>) | undefined;
  readonly #beforeReview?: (() => Promise<void>) | undefined;

  constructor(
    options: SessionWorkerOptions,
    fullAccess: boolean,
    toggleFullAccessFails: boolean,
    extras: {
      beforeStartTurn?: (() => Promise<void>) | undefined;
      beforeCompact?: (() => Promise<void>) | undefined;
      beforeReview?: (() => Promise<void>) | undefined;
      autoCompleteOnInterrupt?: boolean | undefined;
    } = {},
  ) {
    this.#options = options;
    this.#threadId = options.threadId ?? `new-thread-${++fakeThreadSerial}`;
    this.#fullAccess = fullAccess;
    this.#toggleFullAccessFails = toggleFullAccessFails;
    this.#beforeStartTurn = extras.beforeStartTurn;
    this.#beforeCompact = extras.beforeCompact;
    this.#beforeReview = extras.beforeReview;
    this.autoCompleteOnInterrupt = extras.autoCompleteOnInterrupt !== false;
    this.opened = {
      session: {
        id: this.#threadId,
        sessionId: "native-session-1",
        title: "测试会话",
        preview: "",
        createdAt: 1,
        updatedAt: 1,
        lastReplyAt: null,
        state: "idle" as const,
        projectId: options.projectId,
        marked: false,
        deletedAt: null,
        purgeAt: null,
      },
      turns: [],
      activeTurnId: null,
      runtime: {
        cwd: "/tmp/project",
        model: "test",
        reasoningEffort: null,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspace-write" },
        activePermissionProfile: null,
      },
    };
    this.commands = {
      fullAccessEnabled: () => this.#fullAccess,
      toggleFullAccess: async () => {
        if (this.#toggleFullAccessFails) throw new Error("测试权限恢复失败");
        this.#fullAccess = !this.#fullAccess;
        return {
          fullAccessEnabled: this.#fullAccess,
        };
      },
      compact: async () => {
        await this.#beforeCompact?.();
        this.compactCalls += 1;
        this.#activeTurnId = "native-turn-1";
        this.#stream({
          type: "turn_started",
          threadId: this.#threadId,
          turnId: "native-turn-1",
        });
        return "native-turn-1";
      },
      review: async () => {
        await this.#beforeReview?.();
        this.reviewCalls += 1;
        this.#activeTurnId = "native-turn-1";
        this.#stream({
          type: "turn_started",
          threadId: this.#threadId,
          turnId: "native-turn-1",
        });
        return "native-turn-1";
      },
    };
    const thisOwner = this;
    this.turns = {
      get activeTurnId() {
        return thisOwner.#activeTurnId;
      },
      setAttachmentMappings: () => {},
      startTextTurn: async (_text: string, attachments: Array<{ path: string }> = []) => {
        thisOwner.#starting = true;
        try {
          if (thisOwner.#pendingInterrupt) {
            thisOwner.#resolvePending(true);
            throw new CodexTurnCancelledError();
          }
          await thisOwner.#beforeStartTurn?.();
          thisOwner.startTurnCalls += 1;
          thisOwner.started = true;
          thisOwner.startedAttachments = attachments;
          thisOwner.#activeTurnId = "native-turn-1";
          thisOwner.#stream({
            type: "turn_started",
            threadId: thisOwner.#threadId,
            turnId: "native-turn-1",
          });
          if (thisOwner.#pendingInterrupt) {
            thisOwner.#interruptRequested = true;
            thisOwner.interruptCount += 1;
            thisOwner.#resolvePending(true);
            if (thisOwner.autoCompleteOnInterrupt) thisOwner.complete("interrupted");
          }
          return "native-turn-1";
        } finally {
          thisOwner.#starting = false;
        }
      },
      interruptActiveTurn: async () => {
        if (thisOwner.#interruptPromise) return thisOwner.#interruptPromise;
        if (thisOwner.#activeTurnId) {
          if (thisOwner.#interruptRequested) return true;
          thisOwner.#interruptRequested = true;
          thisOwner.interruptCount += 1;
          if (thisOwner.autoCompleteOnInterrupt) thisOwner.complete("interrupted");
          return true;
        }
        if (thisOwner.#starting) {
          thisOwner.#pendingInterrupt = true;
          thisOwner.#interruptPromise = new Promise<boolean>((resolve) => {
            thisOwner.#pendingResolve = resolve;
          }).finally(() => {
            thisOwner.#interruptPromise = null;
          });
          return thisOwner.#interruptPromise;
        }
        return false;
      },
    };
    this.approvals = {
      pendingForThread: () => this.#pendingApproval ? [this.#pendingApproval] : [],
      answer: (id: string, answer: string) => {
        if (this.#pendingApproval?.id !== id) return false;
        this.#pendingApproval = null;
        if (answer === "approve_once") this.approved += 1;
        this.#options.onApprovalEvent?.({
          type: "approval_resolved",
          approvalId: id,
          resolution: answer === "approve_once" ? "approved" : "declined",
        });
        return true;
      },
      cancelThread: () => {
        if (!this.#pendingApproval) return 0;
        const id = this.#pendingApproval.id;
        this.#pendingApproval = null;
        this.cancelledApprovals += 1;
        this.#options.onApprovalEvent?.({
          type: "approval_resolved",
          approvalId: id,
          resolution: "cancelled",
        });
        return 1;
      },
    };
  }

  get threadId(): string {
    return this.#threadId;
  }

  #resolvePending(value: boolean): void {
    this.#pendingInterrupt = false;
    this.#pendingResolve?.(value);
    this.#pendingResolve = null;
  }

  get fullAccessEnabled(): boolean {
    return this.#fullAccess;
  }

  requestApproval(): void {
    this.#pendingApproval = {
      id: "approval-1",
      kind: "file_change",
      threadId: this.#threadId,
      turnId: "native-turn-1",
      itemId: "item-1",
      reason: "写文件",
      startedAtMs: Date.now(),
    };
    this.#options.onApprovalEvent?.({
      type: "approval_requested",
      approval: this.#pendingApproval,
    });
  }

  emitAssistant(text: string): void {
    if (!this.#activeTurnId) return;
    this.#stream({
      type: "assistant_text_completed",
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
      itemId: "assistant-1",
      text,
    });
  }

  complete(status: "completed" | "interrupted"): void {
    if (!this.#activeTurnId) return;
    this.#stream({
      type: "turn_completed",
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
      status,
      error: null,
    });
    this.#activeTurnId = null;
  }

  exitUnexpectedly(): void {
    this.#options.onUnexpectedExit?.(
      this.threadId,
      new Error("测试 Worker 异常退出"),
    );
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  #stream(event: CodexStreamEvent): void {
    this.#options.onStreamEvent?.(event);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时。");
    await delay(2);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
