import assert from "node:assert/strict";
import fs, { mkdtemp, rm, stat } from "node:fs/promises";
import { AttachmentDisplayIndex } from "./attachment-index.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApprovalEvent, ApprovalRequest } from "../approvals/broker.ts";
import {
  CodexInterruptTimeoutError,
  CodexTurnCancelledError,
  type CodexStreamEvent,
} from "../app-server/turn-session.ts";
import { formatPrivateAttachmentPathsBlock } from "../attachments/private-paths.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import type { TrashStore } from "../sessions/trash-store.ts";
import { ProjectTaskLocks } from "../server/project-locks.ts";
import {
  MAX_TIMER_DELAY_MS,
  SessionWorkerManager,
  type SessionWorkerManagerOptions,
  WorkerManagerError,
} from "./manager.ts";
import type { SessionWorker, SessionWorkerOptions } from "./session-worker.ts";
import { WorkerStateStore } from "./state-store.ts";
import { ApplicationSettingsStore } from "../settings/store.ts";
import type { WorkerInteractionRequest } from "./interaction-broker.ts";

test("keeps an accepted turn running after the browser disconnects", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
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

test("publishes complete approval paths and resolves an answer only once", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 50 });
  const events: Array<{ audience: string; event: Record<string, unknown> }> = [];
  fixture.manager.onEvent((stored) => events.push({
    audience: stored.audience,
    event: stored.event,
  }));
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "需要审批",
  );
  const worker = await fixture.waitForWorker();

  worker.requestCommandApproval("cat /home/private/project/secret.txt");
  const commandEvents = () => events.filter(({ event }) => event.type === "approval.requested");
  await waitFor(() => commandEvents().length === 1);
  const commandEvent = commandEvents()[0]!;
  assert.equal(commandEvent.audience, "all");
  assert.deepEqual(commandEvent.event.sourceSession, {
    id: "thread-1",
    title: "测试会话",
  });
  assert.ok(JSON.stringify(commandEvent.event).includes("/home/private/project/secret.txt"));
  assert.deepEqual(commandEvent.event.approval, {
    id: "command-approval-1",
    kind: "command",
    reason: "读取 /home/private/project/secret.txt",
    startedAtMs: (commandEvent.event.approval as { startedAtMs: number }).startedAtMs,
    commandSummary: "cat /home/private/project/secret.txt",
    network: { host: "registry.npmjs.org", protocol: "https" },
    canApprove: true,
  });

  // 新设备认证时会得到同一条仍有效的待答项；它回答后所有设备收到全局终态。
  fixture.manager.clientAuthenticated("computer");
  await waitFor(() => commandEvents().length === 2);
  assert.deepEqual(fixture.manager.answerApproval("command-approval-1", "approve_once"), {
    answered: true,
  });
  assert.throws(
    () => fixture.manager.answerApproval("command-approval-1", "approve_once"),
    (error: unknown) => error instanceof WorkerManagerError && error.code === "approval_not_found",
  );
  const commandResolved = events.filter(({ event }) =>
    event.type === "approval.resolved" && event.approvalId === "command-approval-1"
  );
  assert.equal(commandResolved.length, 1);
  assert.equal(commandResolved[0]?.audience, "all");

  worker.requestPermissionsApproval({
    network: { enabled: true },
    fileSystem: {
      read: ["/home/private/project/secret.txt"],
      write: ["/"],
      entries: [{
        access: "read",
        path: {
          type: "special",
          value: { kind: "project_roots", subpath: "src/generated" },
        },
      }],
    },
  });
  await waitFor(() => commandEvents().length === 3);
  const permissionEvent = commandEvents()[2]!.event;
  assert.ok(JSON.stringify(permissionEvent).includes("/home/private/project/secret.txt"));
  assert.deepEqual(
    (permissionEvent.approval as { permissionSummary: string[] }).permissionSummary,
    [
      "网络：允许额外网络访问",
      "读取：/home/private/project/secret.txt",
      "写入：文件系统根目录",
      "读取：项目目录/src/generated",
    ],
  );
  assert.equal((permissionEvent.approval as { canApprove: boolean }).canApprove, true);
  fixture.manager.answerApproval("permissions-approval-1", "decline");
  worker.complete("completed");
});

test("refuses approval when a future permission shape cannot be displayed completely", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 50 });
  const events: Record<string, unknown>[] = [];
  fixture.manager.onEvent((stored) => events.push(stored.event));
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "需要审批");
  const worker = await fixture.waitForWorker();
  worker.requestPermissionsApproval({ futureCapability: { secret: true } });
  await waitFor(() => events.some((event) => event.type === "approval.requested"));
  const requested = events.find((event) => event.type === "approval.requested")!;
  assert.equal((requested.approval as { canApprove: boolean }).canApprove, false);
  assert.throws(
    () => fixture.manager.answerApproval("permissions-approval-1", "approve_once"),
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "approval_scope_unavailable",
  );
  assert.deepEqual(fixture.manager.answerApproval("permissions-approval-1", "decline"), {
    answered: true,
  });
  worker.complete("completed");
});

test("task completion globally resolves pending approval and interaction cards", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 50 });
  const events: Array<{ audience: string; event: Record<string, unknown> }> = [];
  fixture.manager.onEvent((stored) => events.push({
    audience: stored.audience,
    event: stored.event,
  }));
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "等待回答");
  const worker = await fixture.waitForWorker();
  worker.requestApproval();
  worker.requestInteraction();
  worker.complete("completed");

  await waitFor(() => worker.closeCount === 1);
  const resolved = events.filter(({ event }) =>
    event.type === "approval.resolved" || event.type === "interaction.resolved"
  );
  assert.deepEqual(resolved.map(({ audience, event }) => ({
    audience,
    type: event.type,
    id: event.approvalId ?? event.interactionId,
  })), [
    { audience: "all", type: "approval.resolved", id: "approval-1" },
    { audience: "all", type: "interaction.resolved", id: "interaction-1" },
  ]);
});

test("an unexpected Worker exit globally resolves every pending request", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 50 });
  const events: Array<{ audience: string; event: Record<string, unknown> }> = [];
  fixture.manager.onEvent((stored) => events.push({
    audience: stored.audience,
    event: stored.event,
  }));
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "等待回答",
  );
  const worker = await fixture.waitForWorker();
  worker.requestApproval();
  worker.requestInteraction();
  worker.exitUnexpectedly();

  await waitFor(() => fixture.store.require(accepted.taskId).status === "failed");
  await waitFor(() => worker.closeCount === 1);
  const resolved = events.filter(({ event }) =>
    event.type === "approval.resolved" || event.type === "interaction.resolved"
  );
  assert.equal(resolved.length, 2);
  assert.ok(resolved.every(({ audience }) => audience === "all"));
});

test("cancels the whole manual turn when an offline approval outlives grace", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 5 });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
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

test("reconnecting mid-sweep spares the turns the sweep has not reached", async (context) => {
  let reconnected = false;
  let fixture!: Awaited<ReturnType<typeof managerFixture>>;
  fixture = await managerFixture(context, {
    offlineGraceMs: 5,
    beforeInterrupt: async () => {
      // 第一路的中断还在路上，客户端就回来了。
      if (reconnected) return;
      reconnected = true;
      fixture.manager.clientAuthenticated("phone");
    },
  });
  // 两个审批要在宽限到点之前就挂着，才会走到逐路处理的那个循环。
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "需要权限",
  );
  const second = await fixture.manager.enqueueMessage(
    "project-2",
    "thread-2",
    "message-2",
    "也需要权限",
  );
  await waitFor(() => fixture.workers.length === 2);
  const [firstWorker, secondWorker] = fixture.workers;
  firstWorker!.requestApproval();
  secondWorker!.requestApproval();
  await waitFor(() =>
    fixture.store.require(second.taskId).status === "waiting_for_permission"
  );

  fixture.manager.clientDisconnected("phone");
  await waitFor(() => fixture.store.require(first.taskId).status === "interrupted");
  await delay(20);

  // 第二路的审批还挂着，等着刚回来的客户端去答。
  assert.equal(secondWorker!.interruptCount, 0);
  assert.equal(secondWorker!.cancelledApprovals, 0);
  assert.equal(secondWorker!.approved, 0);
  assert.equal(fixture.store.require(second.taskId).status, "waiting_for_permission");
  secondWorker!.complete("completed");
});

test("auto-approves an execution request for an offline Full access turn", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 1,
    fullAccess: true,
    persistedDesiredFullAccess: true,
  });
  fixture.manager.start();
  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "继续执行");
  const worker = await fixture.waitForWorker();
  worker.requestApproval();
  await delay(5);

  assert.equal(worker.approved, 1);
  assert.equal(worker.interruptCount, 0);
  worker.complete("completed");
});

test("stages model and permission changes during an active task for the next turn", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    fullAccess: true,
    persistedDesiredFullAccess: true,
  });
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "还在执行");
  const running = await fixture.waitForWorker("thread-1");

  const permission = await fixture.manager.runCommand(
    "project-1",
    "thread-1",
    "permission-1",
    "permissions",
    ":workspace",
    null,
    null,
  );
  const model = await fixture.manager.runCommand(
    "project-1",
    "thread-1",
    "model-1",
    "model",
    "next-model",
    "high",
    null,
  );
  assert.equal(permission.title, "权限将在下一轮生效");
  assert.equal(model.title, "模型将在下一轮生效");
  // 正在跑的这一轮不受影响。
  assert.equal(running.setPermissionsCalls, 0);
  assert.equal(running.fullAccessEnabled, true);
  assert.deepEqual(fixture.store.sessionPendingTurnSettings("thread-1"), {
    permissions: ":workspace",
    model: { id: "next-model", effort: "high" },
  });
  assert.equal(fixture.store.sessionDesiredFullAccess("thread-1"), false);

  running.complete("completed");
  await waitFor(() => fixture.store.require(first.taskId).status === "completed");
  await waitFor(() => fixture.workers.every((worker) => worker.closeCount > 0));

  const second = await fixture.manager.enqueueMessage("project-1", "thread-1", "message-2", "下一轮");
  assert.equal(fixture.store.require(second.taskId).permissionMode, "manual");
  await waitFor(() => fixture.workers.length === 2 && fixture.workers[1]!.started);
  const next = fixture.workers[1]!;
  assert.deepEqual(next.startedSettings, {
    model: "next-model",
    effort: "high",
    permissions: ":workspace",
    approvalPolicy: "on-request",
  });
  assert.equal(fixture.store.sessionPendingTurnSettings("thread-1"), null);
  next.complete("completed");
  await waitFor(() => fixture.store.require(second.taskId).status === "completed");
  await waitFor(() => next.closeCount > 0);

  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-3", "再下一轮");
  await waitFor(() => fixture.workers.length === 3 && fixture.workers[2]!.started);
  assert.deepEqual(fixture.workers[2]!.startedSettings, {});
});

test("keeps a newer staged choice made after the next turn was submitted", async (context) => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startCount = 0;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeStartTurn: async () => {
      startCount += 1;
      if (startCount === 2) await startGate;
    },
  });
  context.after(() => releaseStart());
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "第一轮");
  const running = await fixture.waitForWorker("thread-1");
  await fixture.manager.runCommand(
    "project-1", "thread-1", "permission-1", "permissions", ":read-only", null, null,
  );
  running.complete("completed");
  await waitFor(() => fixture.store.require(first.taskId).status === "completed");
  await waitFor(() => running.closeCount > 0);

  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-2", "第二轮");
  await waitFor(() => startCount === 2);
  // 第二轮已经送出 `:read-only`，Codex 还没确认时用户又选了一次。
  await fixture.manager.runCommand(
    "project-1", "thread-1", "permission-2", "permissions", ":workspace", null, null,
  );
  releaseStart();
  await waitFor(() => fixture.workers[1]?.started === true);
  assert.equal(fixture.workers[1]!.startedSettings?.permissions, ":read-only");
  assert.deepEqual(fixture.store.sessionPendingTurnSettings("thread-1"), {
    permissions: ":workspace",
  });
});

test("an idle permission change drops the staged permission but keeps a staged model", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "第一轮");
  const running = await fixture.waitForWorker("thread-1");
  await fixture.manager.runCommand(
    "project-1", "thread-1", "permission-1", "permissions", ":read-only", null, null,
  );
  await fixture.manager.runCommand(
    "project-1", "thread-1", "model-1", "model", "next-model", null, null,
  );
  running.complete("completed");
  await waitFor(() => fixture.store.require(first.taskId).status === "completed");
  await waitFor(() => running.closeCount > 0);

  await fixture.manager.runCommand(
    "project-1", "thread-1", "permission-2", "permissions", ":workspace", null, null,
  );
  assert.deepEqual(fixture.store.sessionPendingTurnSettings("thread-1"), {
    model: { id: "next-model", effort: null },
  });
});

test("serializes task admission after a concurrent permission change in both directions", async (context) => {
  for (const scenario of [
    {
      name: "disable",
      initial: true,
      option: ":workspace",
      expectedMode: "manual" as const,
    },
    {
      name: "enable",
      initial: false,
      option: ":full-access",
      expectedMode: "full_access" as const,
    },
  ]) {
    let permissionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    let releasePermission!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    context.after(() => releasePermission());
    const fixture = await managerFixture(context, {
      offlineGraceMs: 10,
      fullAccess: scenario.initial,
      persistedDesiredFullAccess: scenario.initial,
      beforeSetPermissions: async () => {
        permissionStarted();
        await permissionGate;
      },
    });
    fixture.manager.start();

    const command = fixture.manager.runCommand(
      "project-1",
      "thread-1",
      `permission-${scenario.name}`,
      "permissions",
      scenario.option,
      null,
      null,
    );
    await started;
    let admissionSettled = false;
    const admission = fixture.manager.enqueueMessage(
      "project-1",
      "thread-1",
      `message-${scenario.name}`,
      `concurrent ${scenario.name}`,
    ).finally(() => {
      admissionSettled = true;
    });
    await delay(0);
    assert.equal(admissionSettled, false, `${scenario.name}: admission must wait for settings`);

    releasePermission();
    await command;
    const accepted = await admission;
    assert.equal(
      fixture.store.require(accepted.taskId).permissionMode,
      scenario.expectedMode,
    );
    assert.equal(
      fixture.store.sessionDesiredFullAccess("thread-1"),
      scenario.expectedMode === "full_access",
    );
    const worker = await fixture.waitForWorker("thread-1");
    assert.equal(worker.fullAccessEnabled, scenario.expectedMode === "full_access");
    worker.complete("completed");
  }
});

test("rejects a permission change that linearizes after task admission", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.start();

  const admission = fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-first",
    "先准入",
  );
  const command = fixture.manager.runCommand(
    "project-1",
    "thread-1",
    "permission-second",
    "permissions",
    ":full-access",
    null,
    null,
  );

  const accepted = await admission;
  await assert.rejects(
    command,
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "task_already_running",
  );
  assert.equal(fixture.store.require(accepted.taskId).permissionMode, "manual");
  const worker = await fixture.waitForWorker("thread-1");
  worker.complete("completed");
});

test("restart preserves newer desired settings while old effective snapshots run", async (context) => {
  for (const scenario of [
    {
      name: "old-full-new-manual",
      effectiveMode: "full_access" as const,
      desired: false,
    },
    {
      name: "old-manual-new-full",
      effectiveMode: "manual" as const,
      desired: true,
    },
  ]) {
    const fixture = await managerFixture(context, {
      offlineGraceMs: 10,
      fullAccess: scenario.desired,
      persistedDesiredFullAccess: scenario.desired,
      persistedTaskPermissionMode: scenario.effectiveMode,
    });
    fixture.manager.start();

    const oldWorker = await fixture.waitForWorker("thread-1");
    assert.equal(oldWorker.fullAccessEnabled, scenario.effectiveMode === "full_access");
    assert.equal(
      fixture.store.sessionDesiredFullAccess("thread-1"),
      scenario.desired,
      `${scenario.name}: old reconcile must not overwrite desired setting`,
    );
    oldWorker.complete("completed");
    await waitFor(() => fixture.store.require("persisted-task").status === "completed");

    const next = await fixture.manager.enqueueMessage(
      "project-1",
      "thread-1",
      `next-${scenario.name}`,
      "下一轮",
    );
    assert.equal(
      fixture.store.require(next.taskId).permissionMode,
      scenario.desired ? "full_access" : "manual",
    );
    await waitFor(() => fixture.workers[1]?.started === true);
    assert.equal(fixture.workers[1]!.fullAccessEnabled, scenario.desired);
    fixture.workers[1]!.complete("completed");
  }
});


test("restores Full access after replacing a transient Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 1 });
  const changed = await fixture.manager.runCommand(
    "project-1",
    "thread-1",
    "permission-1",
    "permissions",
    ":full-access",
    null,
    null,
  );
  assert.equal(changed.fullAccessEnabled, undefined);
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
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
    persistedDesiredFullAccess: true,
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
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
    persistedDesiredFullAccess: true,
    toggleFullAccessFails: true,
  });
  fixture.manager.start();
  const events: Array<Record<string, unknown>> = [];
  fixture.manager.onEvent((event) => events.push(event.event));
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "继续执行",
  );
  await waitFor(() => fixture.store.require(accepted.taskId).status === "failed");
  assert.equal(fixture.workers[0]?.started, false);
  const completed = events.at(-1);
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

test("a queued task started on a degraded memory reading carries a replayable notice", async (context) => {
  let degraded = true;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 50,
    minAvailableMemoryBytes: 1_073_741_824,
    availableMemory: async () => degraded
      ? {
        availableBytes: 216 * 1_048_576,
        platform: "linux" as const,
        source: "os-freemem" as const,
        degradedReason: "/proc/meminfo 缺少 MemAvailable",
      }
      : {
        availableBytes: Number.MAX_SAFE_INTEGER,
        platform: "linux" as const,
        source: "linux-meminfo" as const,
      },
  });
  const events: Array<{ audience: string; event: Record<string, unknown> }> = [];
  fixture.manager.onEvent((stored) => events.push({
    audience: stored.audience,
    event: stored.event,
  }));
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "后台启动",
  );
  const worker = await fixture.waitForWorker();

  // 读数降级仍按原决定放行，同时 task.starting 带上与 direct 路径同源的提示。
  const starting = events.find((entry) => entry.event.type === "task.starting");
  assert.equal(starting?.audience, "session");
  assert.match(String(starting?.event.notice), /已经放行/u);
  assert.match(String(starting?.event.notice), /MemAvailable/u);

  // 重连时从事件日志回放，提示仍在。
  fixture.manager.clientDisconnected("phone");
  fixture.manager.clientAuthenticated("tablet");
  const resumed = await fixture.manager.resumeSession("project-1", "thread-1");
  assert.equal(resumed.loadState, "ready");
  if (resumed.loadState !== "ready") throw new Error("会话没有恢复完成");
  assert.equal(resumed.activeTaskId, accepted.taskId);
  const replayed = resumed.replayEvents.find((stored) => stored.event.type === "task.starting");
  assert.equal(replayed?.event.notice, starting?.event.notice);
  worker.complete("completed");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");

  // 可信读数下启动的任务不带提示。
  degraded = false;
  const next = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-2",
    "正常启动",
  );
  await waitFor(() => fixture.store.eventsForTask(next.taskId)
    .some((stored) => stored.event.type === "task.starting"));
  const normal = fixture.store.eventsForTask(next.taskId)
    .find((stored) => stored.event.type === "task.starting");
  assert.equal("notice" in normal!.event, false);
});

for (const offlineGraceMs of [MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS + 1, 2_592_000_000]) {
  test(`an offline grace of ${offlineGraceMs} ms never collapses to an immediate interrupt`, async (context) => {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    context.after(() => process.off("warning", onWarning));
    const fixture = await managerFixture(context, { offlineGraceMs });
    fixture.manager.clientAuthenticated("phone");
    fixture.manager.start();
    const accepted = await fixture.manager.enqueueMessage(
      "project-1",
      "thread-1",
      "message-1",
      "需要权限",
    );
    const worker = await fixture.waitForWorker();
    worker.requestApproval();
    await waitFor(() => fixture.store.require(accepted.taskId).status === "waiting_for_permission");
    fixture.manager.clientDisconnected("phone");
    await delay(50);

    assert.equal(worker.interruptCount, 0);
    assert.equal(worker.cancelledApprovals, 0);
    assert.equal(fixture.store.require(accepted.taskId).status, "waiting_for_permission");
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), []);
    worker.complete("completed");
    await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");
  });
}

test("passes application settings into session workers without mutating an active one", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-manager-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await ApplicationSettingsStore.open(path.join(directory, "settings.json"));
  await settings.update({ developerInstructions: "始终用中文回复。" });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 5,
    settings,
  });
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  assert.equal(fixture.createdOptions[0]?.settings, settings);
  const firstWorker = fixture.workers[0];
  const resumed = await fixture.manager.resumeSession("project-1", opened.opened.session.id);
  assert.equal(resumed.loadState, "ready");
  if (resumed.loadState !== "ready") throw new Error("会话没有恢复完成");
  assert.equal(resumed.opened.session.id, opened.opened.session.id);
  assert.equal(fixture.workers.length, 1);
  assert.equal(fixture.workers[0], firstWorker);
});

test("keeps a brand-new empty thread only while a browser is attached", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 5 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  const worker = fixture.workers[0]!;
  fixture.manager.attachSession("phone", "project-1", opened.opened.session.id);
  await delay(10);
  assert.equal(worker.closeCount, 0);
  fixture.manager.detachSession("phone");
  await waitFor(() => worker.closeCount === 1);
  assert.equal(worker.started, false);
});

test("closes a brand-new empty thread when its caller never attaches", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 5 });
  fixture.manager.start();
  await fixture.manager.startSession("project-1");
  const worker = fixture.workers[0]!;

  await waitFor(() => worker.closeCount === 1);
  assert.equal(worker.started, false);
});

test("a disconnected client cannot attach to a session", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 5 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  const worker = fixture.workers[0]!;

  fixture.manager.clientDisconnected("phone");
  fixture.manager.attachSession("phone", "project-1", opened.opened.session.id);

  await waitFor(() => worker.closeCount === 1);
  assert.equal(worker.started, false);
});

test("promotes the empty-session Worker for the first accepted message", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  fixture.manager.attachSession("phone", "project-1", opened.opened.session.id);
  await fixture.manager.enqueueMessage(
    "project-1",
    opened.opened.session.id,
    "message-1",
    "第一条",
  );
  await waitFor(() => fixture.workers[0]?.started === true);
  assert.equal(fixture.workers.length, 1);
  fixture.workers[0]!.complete("completed");
});

test("rejects the wrong project before reusing or attaching an active Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 20 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "正在执行",
  );
  const worker = await fixture.waitForWorker("thread-1");

  await assert.rejects(
    fixture.manager.resumeSession("project-2", "thread-1"),
    isProjectMismatch,
  );
  await assert.rejects(
    fixture.manager.enqueueMessage("project-2", "thread-1", "message-2", "错误项目"),
    isProjectMismatch,
  );
  await assert.rejects(
    fixture.manager.runCommand(
      "project-2",
      "thread-1",
      "command-1",
      "model",
      "gpt-test",
      null,
      null,
    ),
    isProjectMismatch,
  );
  assert.throws(
    () => fixture.manager.attachSession("phone", "project-2", "thread-1"),
    isProjectMismatch,
  );
  worker.complete("completed");
});

test("rejects the wrong project before reusing a provisional Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 20 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  const threadId = opened.opened.session.id;
  fixture.manager.attachSession("phone", "project-1", threadId);

  await assert.rejects(fixture.manager.resumeSession("project-2", threadId), isProjectMismatch);
  await assert.rejects(
    fixture.manager.enqueueMessage("project-2", threadId, "message-1", "错误项目"),
    isProjectMismatch,
  );
  await assert.rejects(
    fixture.manager.commandOptions("project-2", threadId, "model"),
    isProjectMismatch,
  );
  assert.throws(
    () => fixture.manager.attachSession("phone", "project-2", threadId),
    isProjectMismatch,
  );
  assert.equal(fixture.store.pendingForThread(threadId), null);
  assert.equal(fixture.workers[0]!.started, false);
});

test("rejects the wrong project for a persisted pending session", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 20 });
  fixture.store.admit({
    id: "pending-task",
    clientMessageId: "pending-message",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "仍在排队",
    permissionMode: "manual",
    createdAtMs: 1,
  });

  await assert.rejects(
    fixture.manager.resumeSession("project-2", "thread-1"),
    isProjectMismatch,
  );
  assert.throws(
    () => fixture.manager.attachSession("phone", "project-2", "thread-1"),
    isProjectMismatch,
  );
  assert.equal(fixture.store.require("pending-task").status, "queued");
});

test("never promotes a provisional Worker under a different project's lock", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 50 });
  fixture.manager.clientAuthenticated("phone");
  const opened = await fixture.manager.startSession("project-1");
  const threadId = opened.opened.session.id;
  fixture.manager.attachSession("phone", "project-1", threadId);
  fixture.store.admit({
    id: "stale-wrong-project-task",
    clientMessageId: "stale-wrong-project-message",
    projectId: "project-2",
    threadId,
    kind: "message",
    payload: "不能在错误目录启动",
    permissionMode: "manual",
    createdAtMs: 1,
  });

  fixture.manager.start();
  await waitFor(() => fixture.store.require("stale-wrong-project-task").status === "failed");
  assert.equal(fixture.workers[0]!.startTurnCalls, 0);
  assert.equal(fixture.workers[0]!.started, false);
  assert.equal(fixture.locks.acquire("project-2", "probe", "probe-session"), true);
  assert.equal(fixture.locks.release("project-2", "probe"), true);
  const resumed = await fixture.manager.resumeSession("project-1", threadId);
  assert.equal(resumed.loadState, "ready");
});

test("fails a promoted new-session task when its Worker exits", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  fixture.manager.attachSession("phone", "project-1", opened.opened.session.id);
  const accepted = await fixture.manager.enqueueMessage(
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

test("releases an attached provisional Worker as soon as it exits unexpectedly", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 60_000, maxWorkers: 1 });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const opened = await fixture.manager.startSession("project-1");
  const threadId = opened.opened.session.id;
  fixture.manager.attachSession("phone", "project-1", threadId);
  const dead = fixture.workers[0]!;

  dead.exitUnexpectedly();
  await waitFor(() => dead.closeCount === 1);

  // 页面仍 attach，但死亡 Worker 已不占容量；首条消息改由新 Worker 恢复会话。
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    threadId,
    "message-1",
    "第一条",
  );
  const replacement = await fixture.waitForWorker(threadId);
  assert.notEqual(replacement, dead);
  assert.equal(dead.startTurnCalls, 0);
  assert.equal(fixture.createdOptions[1]?.threadId, threadId);
  replacement.complete("completed");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");
  await waitFor(() => replacement.closeCount === 1);
  await fixture.manager.startSession("project-1");
  assert.equal(fixture.workers.length, 3);
});

test("never publishes a new-session Worker that exited before registration", async (context) => {
  let exitNext = true;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 60_000,
    maxWorkers: 1,
    afterWorkerCreate: (worker) => {
      if (!exitNext) return;
      exitNext = false;
      worker.exitUnexpectedly();
    },
  });

  await assert.rejects(
    fixture.manager.startSession("project-1"),
    (error: unknown) => error instanceof WorkerManagerError && error.code === "worker_exited",
  );
  assert.equal(fixture.workers[0]!.closeCount, 1);
  const next = await fixture.manager.startSession("project-1");
  assert.equal(next.loadState, "ready");
  assert.equal(fixture.workers.length, 2);
});

test("a stale Worker's late exit does not fail the thread's newer Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 60_000 });
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "第一条",
  );
  const stale = await fixture.waitForWorker("thread-1");
  stale.complete("completed");
  await waitFor(() => fixture.store.require(first.taskId).status === "completed");
  await waitFor(() => stale.closeCount === 1);

  const second = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-2",
    "第二条",
  );
  await waitFor(() => fixture.workers.length === 2 && fixture.workers[1]!.started);
  const current = fixture.workers[1]!;

  stale.exitUnexpectedly();
  await delay(10);
  assert.equal(fixture.store.require(second.taskId).status, "running");
  assert.equal(current.closeCount, 0);
  current.complete("completed");
  await waitFor(() => fixture.store.require(second.taskId).status === "completed");
});

test("shutdown waits for an active Worker whose terminal cleanup is still closing", async (context) => {
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 60_000,
    beforeWorkerClose: () => closeGate,
  });
  fixture.manager.start();
  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "第一条");
  const worker = await fixture.waitForWorker("thread-1");
  worker.complete("completed");
  await waitFor(() => worker.closeCount === 1);

  let closeSettled = false;
  const closing = fixture.manager.close().then(() => {
    closeSettled = true;
  });
  await delay(10);
  assert.equal(closeSettled, false);
  assert.equal(fixture.locks.acquire("project-1", "probe", "probe-session"), false);

  releaseClose();
  await closing;
  assert.equal(fixture.locks.acquire("project-1", "probe", "probe-session"), true);
});

test("shutdown waits for a reclaimed provisional Worker that is still closing", async (context) => {
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 5,
    beforeWorkerClose: () => closeGate,
  });
  fixture.manager.start();
  await fixture.manager.startSession("project-1");
  const worker = fixture.workers[0]!;
  await waitFor(() => worker.closeCount === 1);

  let closeSettled = false;
  const closing = fixture.manager.close().then(() => {
    closeSettled = true;
  });
  await delay(10);
  assert.equal(closeSettled, false);

  releaseClose();
  await closing;
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

test("shutdown waits for a late new-session Worker and does not publish it", async (context) => {
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

  const starting = fixture.manager.startSession("project-1");
  const rejected = assert.rejects(
    starting,
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "worker_manager_closed",
  );
  await createStarted;
  let closeSettled = false;
  const closing = fixture.manager.close().then(() => {
    closeSettled = true;
  });
  await delay(0);
  assert.equal(closeSettled, false);

  releaseCreate();
  await rejected;
  await closing;
  assert.equal(fixture.workers.length, 1);
  assert.equal(fixture.workers[0]!.closeCount, 1);
  await assert.rejects(
    fixture.manager.resumeSession("project-1", fixture.workers[0]!.threadId),
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "worker_manager_closed",
  );
});

test("shutdown closes and waits for an in-flight transient Worker", async (context) => {
  let releaseRewind!: () => void;
  let reportRewindStarted!: () => void;
  const rewindStarted = new Promise<void>((resolve) => {
    reportRewindStarted = resolve;
  });
  const rewindGate = new Promise<void>((resolve) => {
    releaseRewind = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeRewind: async () => {
      reportRewindStarted();
      await rewindGate;
    },
  });

  const rewinding = fixture.manager.runCommand(
    "project-1",
    "thread-1",
    "rewind-1",
    "rewind",
    null,
    null,
    "turn-1",
  );
  const rejected = assert.rejects(
    rewinding,
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "worker_manager_closed",
  );
  await rewindStarted;
  let closeSettled = false;
  const closing = fixture.manager.close().then(() => {
    closeSettled = true;
  });
  await waitFor(() => fixture.workers[0]?.closeCount === 1);
  assert.equal(closeSettled, false);

  releaseRewind();
  await rejected;
  await closing;
  assert.equal(fixture.workers[0]!.closeCount, 1);
});

for (const phase of ["memory gate", "worker creation", "permission restore"] as const) {
  test(`shutdown during ${phase} keeps the accepted task queued for restart`, async (context) => {
    let reportEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      reportEntered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.after(() => release());
    let memoryCalls = 0;
    let createCalls = 0;
    let toggleCalls = 0;
    const fixture = await managerFixture(context, {
      offlineGraceMs: 10,
      ...(phase === "permission restore" ? { persistedDesiredFullAccess: true } : {}),
      availableMemory: async () => {
        if (phase === "memory gate" && ++memoryCalls === 1) {
          reportEntered();
          await gate;
        }
        return {
          availableBytes: Number.MAX_SAFE_INTEGER,
          platform: "linux" as const,
          source: "linux-meminfo" as const,
        };
      },
      beforeWorkerCreate: async (signal) => {
        if (phase !== "worker creation" || ++createCalls > 1) return;
        reportEntered();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("测试 Worker 启动被后端终止"));
          }, { once: true });
        });
      },
      beforeToggleFullAccess: async () => {
        if (phase !== "permission restore" || ++toggleCalls > 1) return;
        reportEntered();
        await gate;
      },
    });
    fixture.manager.start();
    const accepted = await fixture.manager.enqueueMessage(
      "project-1",
      "thread-1",
      "message-1",
      "重启后继续",
    );
    await entered;
    const closing = fixture.manager.close();
    release();
    await closing;

    const kept = fixture.store.require(accepted.taskId);
    assert.equal(kept.status, "queued");
    assert.equal(kept.interruptionReason, null);
    assert.equal(
      fixture.store.eventsForTask(accepted.taskId).some((item) =>
        item.event.type === "task.completed"
      ),
      false,
    );
    assert.equal(fixture.workers.some((worker) => worker.startTurnCalls > 0), false);
    assert.equal(fixture.workers.every((worker) => worker.closeCount === 1), true);
    assert.equal(fixture.locks.acquire("project-1", "probe", "thread-x"), true);
    fixture.locks.release("project-1", "probe");

    const restarted = fixture.restartManager();
    restarted.start();
    await waitFor(() => fixture.workers.some((worker) => worker.started));
    const worker = fixture.workers.find((each) => each.started)!;
    assert.equal(worker.startTurnCalls, 1);
    assert.equal(fixture.store.require(accepted.taskId).status, "running");
    worker.complete("completed");
    await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");
  });
}

test("shutdown after turn/start records a backend interruption, not a user stop", async (context) => {
  let reportStartStarted!: () => void;
  const startStarted = new Promise<void>((resolve) => {
    reportStartStarted = resolve;
  });
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  context.after(() => releaseStart());
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeStartTurn: async () => {
      reportStartStarted();
      await startGate;
    },
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "turn 已经发出",
  );
  await startStarted;
  const closing = fixture.manager.close();
  releaseStart();
  await closing;

  const task = fixture.store.require(accepted.taskId);
  assert.equal(task.status, "interrupted");
  assert.equal(task.interruptionReason, "backend_stopping");
  assert.equal(fixture.workers[0]!.interruptCount, 1);
  assert.equal(fixture.workers[0]!.closeCount, 1);

  const restarted = fixture.restartManager();
  restarted.start();
  await delay(20);
  assert.equal(fixture.workers.length, 1);
  assert.equal(fixture.store.require(accepted.taskId).interruptionReason, "backend_stopping");
});

test("shutdown force-closes a launch whose turn/start and interrupt never answer", async (context) => {
  let reportStartStarted!: () => void;
  const startStarted = new Promise<void>((resolve) => {
    reportStartStarted = resolve;
  });
  let failStart: ((error: Error) => void) | null = null;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeStartTurn: async () => {
      reportStartStarted();
      await new Promise<void>((_resolve, reject) => {
        failStart = reject;
      });
    },
    // 真实 CodexTurnSession 的截止时间到点后就是这个错误。
    beforeInterrupt: async () => {
      throw new CodexInterruptTimeoutError(10);
    },
    // 关闭 Worker 会让仍在等待的 turn/start 随连接关闭而失败。
    beforeWorkerClose: async () => {
      failStart?.(new Error("codex app-server 连接已经关闭。"));
    },
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "turn/start 一直不返回",
  );
  await startStarted;
  await fixture.manager.close();

  const task = fixture.store.require(accepted.taskId);
  assert.equal(task.status, "interrupted");
  assert.equal(task.interruptionReason, "backend_stopping");
  assert.equal(fixture.workers[0]!.closeCount, 1);
});

test("shutdown still closes an active Worker whose interrupt times out", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    autoCompleteOnInterrupt: false,
    beforeInterrupt: async () => {
      throw new CodexInterruptTimeoutError(10);
    },
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "运行中",
  );
  const worker = await fixture.waitForWorker();
  await fixture.manager.close();
  assert.equal(worker.closeCount, 1);
  // 没有收到 turn 终态，留给重启按后端重启中断，而不是用户停止。
  assert.equal(fixture.store.require(accepted.taskId).status, "running");
  fixture.restartManager();
  const recovered = fixture.store.require(accepted.taskId);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.interruptionReason, "backend_restarted");
});

test("a browser stop whose interrupt times out ends the task and frees the project", async (context) => {
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    autoCompleteOnInterrupt: false,
    beforeInterrupt: async () => {
      throw new CodexInterruptTimeoutError(10);
    },
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "停不下来",
  );
  const worker = await fixture.waitForWorker();

  assert.deepEqual(await fixture.manager.stopTask("thread-1"), { requested: true });
  const task = fixture.store.require(accepted.taskId);
  assert.equal(task.status, "interrupted");
  assert.equal(task.interruptionReason, "user_requested");
  assert.equal(
    fixture.store.eventsForTask(accepted.taskId).filter((item) =>
      item.event.type === "task.completed"
    ).length,
    1,
  );
  await waitFor(() => worker.closeCount === 1);
  await waitFor(() => {
    const free = fixture.locks.acquire("project-1", "probe", "thread-x");
    if (free) fixture.locks.release("project-1", "probe");
    return free;
  });
});

test("one Worker whose interrupt times out does not hold the offline sweep", async (context) => {
  let interrupts = 0;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 5,
    beforeInterrupt: async () => {
      interrupts += 1;
      if (interrupts === 1) throw new CodexInterruptTimeoutError(10);
    },
  });
  fixture.manager.clientAuthenticated("phone");
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "需要权限",
  );
  const second = await fixture.manager.enqueueMessage(
    "project-2",
    "thread-2",
    "message-2",
    "也需要权限",
  );
  await waitFor(() => fixture.workers.length === 2);
  for (const worker of fixture.workers) worker.requestApproval();
  await waitFor(() =>
    fixture.store.require(second.taskId).status === "waiting_for_permission"
  );

  fixture.manager.clientDisconnected("phone");
  await waitFor(() =>
    fixture.store.require(first.taskId).status === "interrupted" &&
    fixture.store.require(second.taskId).status === "interrupted"
  );
  for (const taskId of [first.taskId, second.taskId]) {
    assert.equal(fixture.store.require(taskId).interruptionReason, "no_client_for_permission");
  }
  assert.deepEqual(
    fixture.workers.map((worker) => worker.interruptCount).sort(),
    [0, 1],
  );
  await waitFor(() => fixture.workers.every((worker) => worker.closeCount === 1));
});

test("times out a Worker startup and frees the project without user action", async (context) => {
  let createCalls = 0;
  let aborts = 0;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    workerStartTimeoutMs: 5,
    beforeWorkerCreate: async (signal) => {
      createCalls += 1;
      if (createCalls > 1) return;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          aborts += 1;
          reject(new Error("测试 Worker 启动被后端终止"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "这次启动会卡住",
  );

  await waitFor(() => fixture.store.require(first.taskId).status === "failed");
  assert.equal(aborts, 1);
  assert.equal(
    fixture.store.require(first.taskId).error,
    "Codex Worker 启动超时，任务没有开始。请重试。",
  );

  const reopened = await fixture.manager.resumeSession("project-1", "thread-1");
  assert.equal(reopened.loadState, "ready");
  if (reopened.loadState === "ready") {
    assert.deepEqual(
      reopened.replayEvents.map(({ event }) => event.type),
      ["task.queued", "task.starting", "task.completed"],
    );
    assert.equal(
      reopened.replayEvents.at(-1)?.event.error,
      "Codex Worker 启动超时，任务没有开始。请重试。",
    );
  }

  const second = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-2",
    "message-2",
    "下一次仍然能启动",
  );
  await fixture.waitForWorker("thread-2");
  assert.equal(fixture.store.require(second.taskId).status, "running");
});

test("fails a message that never receives a native turn id", async (context) => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  context.after(() => releaseStart());
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    taskStartTimeoutMs: 5,
    beforeStartTurn: () => startGate,
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "这条消息没有开始",
  );

  await waitFor(() => fixture.store.require(accepted.taskId).status === "failed");
  const failed = fixture.store.require(accepted.taskId);
  assert.equal(failed.nativeTurnId, null);
  assert.equal(failed.error, "Codex 没有开始处理这条消息，请重试。");
  assert.deepEqual(fixture.store.eventsForTask(accepted.taskId).at(-1)?.event, {
    type: "task.completed",
    sessionId: "thread-1",
    taskId: accepted.taskId,
    status: "failed",
    error: "Codex 没有开始处理这条消息，请重试。",
    interruptionReason: null,
  });
  await waitFor(() => fixture.workers[0]?.closeCount === 1);

  releaseStart();
});

test("keeps compact's no-turn timeout as a successful terminal task", async (context) => {
  let releaseCompact!: () => void;
  const compactGate = new Promise<void>((resolve) => {
    releaseCompact = resolve;
  });
  context.after(() => releaseCompact());
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    taskStartTimeoutMs: 5,
    beforeCompact: () => compactGate,
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueCommandTask(
    "project-1",
    "thread-1",
    "compact-1",
    "compact",
  );

  await waitFor(() => fixture.store.require(accepted.taskId).status === "completed");
  const completed = fixture.store.require(accepted.taskId);
  assert.equal(completed.nativeTurnId, null);
  assert.equal(completed.error, null);
  assert.deepEqual(fixture.store.eventsForTask(accepted.taskId), []);
  await waitFor(() => fixture.workers[0]?.closeCount === 1);

  releaseCompact();
});

test("requires rewind to name its target turn and returns a small receipt", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });

  await assert.rejects(
    fixture.manager.runCommand(
      "project-1",
      "thread-1",
      "command-1",
      "rewind",
      null,
      null,
      null,
    ),
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "rewind_target_required",
  );

  assert.deepEqual(
    await fixture.manager.runCommand(
      "project-1",
      "thread-1",
      "command-2",
      "rewind",
      null,
      null,
      "turn-2",
    ),
    {
      kind: "rewind",
      outcome: "reverted",
      targetTurnId: "turn-2",
      title: "已回退一轮",
      lines: [
        "指定的一轮已从当前会话的对话上下文中移除。",
        "这一轮已经造成的文件改动仍然保留。",
      ],
    },
  );
});

test("does not replay an interrupted turn after rewind removed it", async (context) => {
  let workerCreations = 0;
  const interruptedTurn = {
    id: "native-turn-1",
    rootTurnId: null,
    items: [],
    itemsView: "summary",
    status: "interrupted",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  } as Turn;
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    afterWorkerCreate: (worker) => {
      workerCreations += 1;
      // 第一次恢复和执行 rewind 时，持久化历史里仍有这一轮；rewind 后的
      // 第二次恢复模拟 Codex 返回已经删掉该 turn 的历史。
      if (workerCreations === 2 || workerCreations === 3) {
        (worker.opened.turns as Turn[]).push(interruptedTurn);
      }
    },
  });
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "会被停止并回退",
  );
  const active = await fixture.waitForWorker();
  assert.deepEqual(await fixture.manager.stopTask("thread-1"), { requested: true });
  await waitFor(() => active.closeCount === 1);
  assert.equal(fixture.store.require(accepted.taskId).nativeTurnId, "native-turn-1");

  const before = await fixture.manager.resumeSession("project-1", "thread-1");
  assert.equal(before.loadState, "ready");
  if (before.loadState !== "ready") throw new Error("会话没有恢复完成");
  assert.ok(before.replayEvents.some(({ event }) => event.type === "task.queued"));

  await fixture.manager.runCommand(
    "project-1",
    "thread-1",
    "rewind-1",
    "rewind",
    null,
    null,
    "native-turn-1",
  );
  const after = await fixture.manager.resumeSession("project-1", "thread-1");
  assert.equal(after.loadState, "ready");
  if (after.loadState !== "ready") throw new Error("会话没有恢复完成");
  assert.deepEqual(after.opened.turns, []);
  assert.deepEqual(after.replayEvents, []);
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
          // 未声明的私有别名：只能留在内存租约里，不能进 SQLite。
          storagePath: "/private/uploads/screen.png",
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
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-attachment",
    "看图",
    prepared,
  );
  fixture.manager.start();
  const worker = await fixture.waitForWorker();
  assert.equal("path" in fixture.store.require(accepted.taskId).attachments[0]!, false);
  assert.equal("storagePath" in fixture.store.require(accepted.taskId).attachments[0]!, false);
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
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-b",
    "B 在跑",
  );
  await fixture.waitForWorker("thread-1");

  await assert.rejects(
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
  await fixture.manager.enqueueMessage("project-1", "thread-1", "message-1", "第一条");
  await fixture.waitForWorker();
  await assert.rejects(
    () => fixture.manager.enqueueMessage("project-1", "thread-1", "message-2", "第二条"),
    (error: unknown) =>
      error instanceof WorkerManagerError && error.code === "task_already_running",
  );
  assert.equal(fixture.store.findByClientMessageId("message-2"), null);
});

test("duplicate clientMessageId retries are not blocked by the busy check", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "同一条",
  );
  const retried = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "同一条",
  );
  assert.equal(retried.duplicate, true);
  assert.equal(retried.taskId, first.taskId);
  assert.equal(fixture.store.findByClientMessageId("message-1")?.id, first.taskId);
});

test("different projects stay independent and capacity still queues", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10, maxWorkers: 1 });
  fixture.manager.start();
  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "项目一",
  );
  await fixture.waitForWorker("thread-1");
  const second = await fixture.manager.enqueueMessage(
    "project-2",
    "thread-2",
    "message-2",
    "项目二",
  );
  assert.equal(second.duplicate, false);
  assert.equal(fixture.store.require(second.taskId).status, "queued");
  fixture.workers[0]!.complete("completed");
  await waitFor(() => fixture.store.require(second.taskId).status === "running");
});

test("reports queued and starting without returning stale session history", async (context) => {
  let createCalls = 0;
  let reportSecondCreate!: () => void;
  let releaseSecondCreate!: () => void;
  const secondCreateStarted = new Promise<void>((resolve) => {
    reportSecondCreate = resolve;
  });
  const secondCreateGate = new Promise<void>((resolve) => {
    releaseSecondCreate = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    maxWorkers: 1,
    beforeWorkerCreate: async () => {
      createCalls += 1;
      if (createCalls === 2) {
        reportSecondCreate();
        await secondCreateGate;
      }
    },
  });
  context.after(() => releaseSecondCreate());
  fixture.manager.start();

  const first = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "先占住",
  );
  const firstWorker = await fixture.waitForWorker("thread-1");
  const second = await fixture.manager.enqueueMessage(
    "project-2",
    "thread-2",
    "message-2",
    "等待中",
  );
  const queued = await fixture.manager.resumeSession("project-2", "thread-2");
  assert.deepEqual(queued, {
    loadState: "queued",
    projectId: "project-2",
    sessionId: "thread-2",
    activeTaskId: second.taskId,
    controlsActiveTask: true,
  });

  firstWorker.complete("completed");
  await waitFor(() => fixture.store.require(first.taskId).status === "completed");
  await secondCreateStarted;
  const starting = await fixture.manager.resumeSession("project-2", "thread-2");
  assert.equal(starting.loadState, "starting");
  assert.equal("opened" in starting, false);
  assert.equal(fixture.store.eventsForTask(second.taskId).some((stored) =>
    stored.event.type === "task.starting"
  ), true);

  releaseSecondCreate();
  await waitFor(() => fixture.store.require(second.taskId).status === "running");
  const ready = await fixture.manager.resumeSession("project-2", "thread-2");
  assert.equal(ready.loadState, "ready");
});

test("stopping a queued task never starts a Worker", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10, maxWorkers: 1 });
  await fixture.manager.startSession("project-2");
  fixture.manager.start();
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "排队",
  );
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
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "启动中",
  );
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
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "飞行中",
  );
  await startStarted;
  const firstStop = fixture.manager.stopTask("thread-1");
  const secondStop = fixture.manager.stopTask("thread-1");
  releaseStart();
  assert.equal((await firstStop).requested, true);
  assert.equal((await secondStop).requested, true);
  await waitFor(() => fixture.workers[0]?.interruptCount === 1);
  assert.equal(fixture.workers[0]!.interruptCount, 1);
  await assert.rejects(
    () => fixture.manager.enqueueMessage("project-1", "thread-2", "message-2", "还不能发"),
    (error: unknown) => error instanceof WorkerManagerError && error.code === "project_busy",
  );
  fixture.workers[0]!.complete("interrupted");
  await waitFor(() => fixture.store.require(accepted.taskId).status === "interrupted");
  const next = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-2",
    "message-3",
    "现在可以",
  );
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
  const accepted = await fixture.manager.enqueueCommandTask(
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

test("stopping compact after the instruction is sent refuses instead of interrupting", async (context) => {
  let releaseCompact!: () => void;
  let reportCompactStarted!: () => void;
  const compactStarted = new Promise<void>((resolve) => {
    reportCompactStarted = resolve;
  });
  const compactGate = new Promise<void>((resolve) => {
    releaseCompact = resolve;
  });
  const fixture = await managerFixture(context, {
    offlineGraceMs: 10,
    beforeCompact: async () => {
      reportCompactStarted();
      await compactGate;
    },
  });
  context.after(() => releaseCompact());
  fixture.manager.start();
  await fixture.manager.enqueueCommandTask("project-1", "thread-1", "compact-1", "compact");
  await compactStarted;

  // 指令已经发给 Codex：不去打断，如实回绝。放掉闸门要先于断言，
  // 否则断言失败会把压缩卡在半路，拖垮收尾。
  const stopped = await fixture.manager.stopTask("thread-1");
  releaseCompact();
  await waitFor(() => fixture.workers.some((worker) => worker.turns.activeTurnId !== null));

  assert.deepEqual(stopped, { requested: false, reason: "compact_started" });
  const worker = fixture.workers.at(-1)!;
  assert.equal(worker.compactCalls, 1);
  assert.equal(worker.interruptCount, 0);
  assert.equal(worker.closeCount, 0);
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
  await assert.rejects(
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
  const accepted = await fixture.manager.enqueueMessage(
    "project-1",
    "thread-1",
    "message-1",
    "重复停",
  );
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

test("permanent deletion clears worker state and the attachment display index", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.store.setSessionDesiredFullAccess("thread-1", true, 100);
  await fixture.attachmentIndex.register("thread-1", "message-1", [{
    id: "attachment-1",
    originalName: "report.txt",
    path: "/private/uploads/attachment-1",
  }]);

  await fixture.manager.forgetSession("thread-1");

  assert.equal(fixture.store.sessionDesiredFullAccess("thread-1"), null);
  assert.deepEqual(await fixture.attachmentIndex.mappingsFor("thread-1"), []);
});

test("permanent deletion fails without changing artifacts while a task is active", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  fixture.store.admit({
    id: "task-active",
    clientMessageId: "message-active",
    projectId: "project-1",
    threadId: "thread-1",
    kind: "message",
    payload: "still running",
    permissionMode: "manual",
    createdAtMs: 100,
  });
  fixture.store.setSessionDesiredFullAccess("thread-1", true, 100);
  const attachment = {
    id: "attachment-1",
    originalName: "report.txt",
    path: "/private/uploads/attachment-1",
  };
  await fixture.attachmentIndex.register("thread-1", "message-1", [attachment]);

  await assert.rejects(
    fixture.manager.forgetSession("thread-1"),
    /仍有 1 个任务在进行/u,
  );

  assert.equal(fixture.store.require("task-active").status, "queued");
  assert.equal(fixture.store.sessionDesiredFullAccess("thread-1"), true);
  assert.deepEqual(await fixture.attachmentIndex.mappingsFor("thread-1"), [attachment]);
});

test("permanent deletion during a history attachment sync leaves no index behind", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  const renames = pauseFirstRename(context);

  const syncing = fixture.manager.syncAttachmentMappings("thread-1", historyWithAttachments());
  await renames.reached;
  // 设备一的打开还在写索引，设备二的永久删除已经走到清理本地记录。
  const forgetting = fixture.manager.forgetSession("thread-1");
  renames.release();

  await syncing;
  await forgetting;
  await fixture.attachmentIndex.drain();
  await assert.rejects(() => stat(fixture.attachmentIndexFile("thread-1")));
  assert.deepEqual(fixture.manager.peekAttachmentMappings("thread-1"), []);
  assert.deepEqual(await fixture.attachmentIndex.mappingsFor("thread-1"), []);
});

test("a history sync that starts after permanent deletion does not rebuild the index", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  await fixture.manager.syncAttachmentMappings("thread-1", historyWithAttachments());
  await fixture.manager.forgetSession("thread-1");

  assert.deepEqual(
    await fixture.manager.syncAttachmentMappings("thread-1", historyWithAttachments()),
    [],
  );
  await assert.rejects(() => stat(fixture.attachmentIndexFile("thread-1")));
});

test("manager close waits for attachment index work that already entered", async (context) => {
  const fixture = await managerFixture(context, { offlineGraceMs: 10 });
  const renames = pauseFirstRename(context);
  const order: string[] = [];

  const syncing = fixture.manager.syncAttachmentMappings("thread-1", historyWithAttachments())
    .then((mappings) => {
      order.push("sync");
      return mappings;
    });
  await renames.reached;
  const closing = fixture.manager.close().then(() => order.push("close"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, []);
  renames.release();
  await closing;

  assert.deepEqual(order, ["sync", "close"]);
  assert.equal((await syncing).length, 2);
  await stat(fixture.attachmentIndexFile("thread-1"));
  await assert.rejects(
    fixture.manager.syncAttachmentMappings("thread-1", historyWithAttachments()),
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "worker_manager_closed",
  );
  await assert.rejects(
    fixture.manager.forgetSession("thread-1"),
    (error: unknown) => error instanceof WorkerManagerError &&
      error.code === "worker_manager_closed",
  );
});

function historyWithAttachments(): Turn[] {
  const message = (id: string, name: string) => ({
    type: "userMessage",
    id,
    content: [
      { type: "text", text: `看附件\n\n[附件：${name}.txt · attachment-${name}]` },
      {
        type: "text",
        text: formatPrivateAttachmentPathsBlock([{
          id: `attachment-${name}`,
          originalName: `${name}.txt`,
          path: `/private/uploads/${name}.txt`,
          mimeType: "text/plain",
          size: 1,
        }]),
      },
    ],
  });
  return [
    { id: "turn-1", items: [message("message-1", "one")] },
    { id: "turn-2", items: [message("message-2", "two")] },
  ] as unknown as Turn[];
}

/** 让第一次 rename 停住，模拟索引写入正在进行时插进来的其他调用。 */
function pauseFirstRename(context: test.TestContext) {
  const realRename = fs.rename.bind(fs);
  let calls = 0;
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    calls += 1;
    if (calls === 1) {
      markReached();
      await released;
    }
    return realRename(...args);
  });
  return { reached, release };
}

async function managerFixture(
  context: test.TestContext,
  options: {
    offlineGraceMs: number;
    fullAccess?: boolean;
    persistedDesiredFullAccess?: boolean;
    toggleFullAccessFails?: boolean;
    maxWorkers?: number;
    minAvailableMemoryBytes?: number;
    workerStartTimeoutMs?: number;
    taskStartTimeoutMs?: number;
    availableMemory?: SessionWorkerManagerOptions["availableMemory"];
    beforeWorkerCreate?: (signal: AbortSignal) => Promise<void>;
    afterWorkerCreate?: (worker: FakeWorker) => void;
    beforeWorkerClose?: (worker: FakeWorker) => Promise<void>;
    beforeStartTurn?: () => Promise<void>;
    beforeCompact?: () => Promise<void>;
    beforeRewind?: () => Promise<void>;
    beforeSetPermissions?: (profileId: string) => Promise<void>;
    beforeToggleFullAccess?: () => Promise<void>;
    beforeInterrupt?: () => Promise<void>;
    autoCompleteOnInterrupt?: boolean;
    persistedTaskPermissionMode?: "manual" | "full_access";
    uploads?: SessionWorkerManagerOptions["uploads"];
    settings?: ApplicationSettingsStore;
  },
) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-manager-"));
  const store = await WorkerStateStore.open(path.join(directory, "work.sqlite"));
  const attachmentIndex = await AttachmentDisplayIndex.open(directory);
  if (options.persistedDesiredFullAccess !== undefined) {
    store.setSessionDesiredFullAccess("thread-1", options.persistedDesiredFullAccess, 1);
  }
  if (options.persistedTaskPermissionMode) {
    store.admit({
      id: "persisted-task",
      clientMessageId: "persisted-message",
      projectId: "project-1",
      threadId: "thread-1",
      kind: "message",
      payload: "重启前已经接受",
      permissionMode: options.persistedTaskPermissionMode,
      createdAtMs: 2,
    });
  }
  const workers: FakeWorker[] = [];
  const createdOptions: SessionWorkerOptions[] = [];
  const locks = new ProjectTaskLocks();
  const managers: SessionWorkerManager[] = [];
  const createManager = () => new SessionWorkerManager({
    store,
    projects: {} as ProjectCatalog,
    trash: {} as TrashStore,
    locks,
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.maxWorkers ? { maxWorkers: options.maxWorkers } : {}),
    offlineGraceMs: options.offlineGraceMs,
    queueRetryMs: 5,
    ...(options.workerStartTimeoutMs
      ? { workerStartTimeoutMs: options.workerStartTimeoutMs }
      : {}),
    ...(options.taskStartTimeoutMs
      ? { taskStartTimeoutMs: options.taskStartTimeoutMs }
      : {}),
    minAvailableMemoryBytes: options.minAvailableMemoryBytes ?? 0,
    availableMemory: options.availableMemory ?? (async () => ({
      availableBytes: Number.MAX_SAFE_INTEGER,
      platform: "linux" as const,
      source: "linux-meminfo" as const,
    })),
    workerFactory: async (workerOptions) => {
      createdOptions.push(workerOptions);
      if (options.beforeWorkerCreate) {
        assert.ok(workerOptions.startupSignal);
        await options.beforeWorkerCreate(workerOptions.startupSignal);
      }
      const worker = new FakeWorker(
        workerOptions,
        options.fullAccess === true,
        options.toggleFullAccessFails === true,
        {
          ...(options.beforeStartTurn ? { beforeStartTurn: options.beforeStartTurn } : {}),
          ...(options.beforeCompact ? { beforeCompact: options.beforeCompact } : {}),
          ...(options.beforeRewind ? { beforeRewind: options.beforeRewind } : {}),
          ...(options.beforeSetPermissions
            ? { beforeSetPermissions: options.beforeSetPermissions }
            : {}),
          ...(options.beforeToggleFullAccess
            ? { beforeToggleFullAccess: options.beforeToggleFullAccess }
            : {}),
          ...(options.beforeInterrupt ? { beforeInterrupt: options.beforeInterrupt } : {}),
          ...(options.beforeWorkerClose ? { beforeClose: options.beforeWorkerClose } : {}),
          ...(options.autoCompleteOnInterrupt === undefined
            ? {}
            : { autoCompleteOnInterrupt: options.autoCompleteOnInterrupt }),
        },
      );
      workers.push(worker);
      options.afterWorkerCreate?.(worker);
      return worker as unknown as SessionWorker;
    },
    ...(options.uploads ? { uploads: options.uploads } : {}),
    attachmentIndex,
  });
  const manager = createManager();
  managers.push(manager);
  context.after(async () => {
    for (const each of managers) await each.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    manager,
    store,
    workers,
    createdOptions,
    locks,
    attachmentIndex,
    attachmentIndexFile: (threadId: string) =>
      path.join(directory, "attachment-index", `${threadId}.json`),
    /** 模拟服务重启：旧 Manager 已关闭，新 Manager 读同一个 SQLite。 */
    restartManager: () => {
      const next = createManager();
      managers.push(next);
      return next;
    },
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
  readonly interactions;
  started = false;
  startedAttachments: Array<{ path: string }> = [];
  startedSettings: Record<string, unknown> | null = null;
  setPermissionsCalls = 0;
  startTurnCalls = 0;
  compactCalls = 0;
  interruptCount = 0;
  closeCount = 0;
  exited = false;
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
  #pendingInteraction: WorkerInteractionRequest | null = null;
  readonly #options: SessionWorkerOptions;
  #fullAccess: boolean;
  readonly #toggleFullAccessFails: boolean;
  readonly #beforeStartTurn?: (() => Promise<void>) | undefined;
  readonly #beforeCompact?: (() => Promise<void>) | undefined;
  readonly #beforeRewind?: (() => Promise<void>) | undefined;
  readonly #beforeSetPermissions?: ((profileId: string) => Promise<void>) | undefined;
  readonly #beforeToggleFullAccess?: (() => Promise<void>) | undefined;
  readonly #beforeInterrupt?: (() => Promise<void>) | undefined;
  readonly #beforeClose?: ((worker: FakeWorker) => Promise<void>) | undefined;
  #closing: Promise<void> | null = null;

  constructor(
    options: SessionWorkerOptions,
    fullAccess: boolean,
    toggleFullAccessFails: boolean,
    extras: {
      beforeStartTurn?: (() => Promise<void>) | undefined;
      beforeCompact?: (() => Promise<void>) | undefined;
      beforeRewind?: (() => Promise<void>) | undefined;
      beforeSetPermissions?: ((profileId: string) => Promise<void>) | undefined;
      beforeToggleFullAccess?: (() => Promise<void>) | undefined;
      beforeInterrupt?: (() => Promise<void>) | undefined;
      beforeClose?: ((worker: FakeWorker) => Promise<void>) | undefined;
      autoCompleteOnInterrupt?: boolean | undefined;
    } = {},
  ) {
    this.#options = options;
    this.#threadId = options.threadId ?? `new-thread-${++fakeThreadSerial}`;
    this.#fullAccess = fullAccess;
    this.#toggleFullAccessFails = toggleFullAccessFails;
    this.#beforeStartTurn = extras.beforeStartTurn;
    this.#beforeCompact = extras.beforeCompact;
    this.#beforeRewind = extras.beforeRewind;
    this.#beforeSetPermissions = extras.beforeSetPermissions;
    this.#beforeToggleFullAccess = extras.beforeToggleFullAccess;
    this.#beforeInterrupt = extras.beforeInterrupt;
    this.#beforeClose = extras.beforeClose;
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
        await this.#beforeToggleFullAccess?.();
        if (this.#toggleFullAccessFails) throw new Error("测试权限恢复失败");
        this.#fullAccess = !this.#fullAccess;
        return {
          fullAccessEnabled: this.#fullAccess,
        };
      },
      stagePermissions: async (profileId: string) => ({
        permissions: profileId,
        fullAccess: profileId === ":full-access",
        message: { kind: "message" as const, title: "权限将在下一轮生效", lines: [] },
      }),
      stageModel: async (modelId: string, effort?: string | null) => ({
        model: { id: modelId, effort: effort ?? null },
        message: { kind: "message" as const, title: "模型将在下一轮生效", lines: [] },
      }),
      setPermissions: async (profileId: string) => {
        await this.#beforeSetPermissions?.(profileId);
        this.setPermissionsCalls += 1;
        this.#fullAccess = profileId === ":full-access";
        return {
          kind: "message" as const,
          title: "权限已更新",
          lines: [],
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
      rewind: async () => {
        await this.#beforeRewind?.();
        return "reverted" as const;
      },
    };
    const thisOwner = this;
    this.turns = {
      get activeTurnId() {
        return thisOwner.#activeTurnId;
      },
      setAttachmentMappings: () => {},
      startTextTurn: async (
        _text: string,
        attachments: Array<{ path: string }> = [],
        settings: Record<string, unknown> = {},
      ) => {
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
          thisOwner.startedSettings = settings;
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
        if (thisOwner.#beforeInterrupt) await thisOwner.#beforeInterrupt();
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
    this.interactions = {
      pendingForThread: () => this.#pendingInteraction ? [this.#pendingInteraction] : [],
      answer: (id: string, action: string) => {
        if (this.#pendingInteraction?.id !== id) return false;
        this.#pendingInteraction = null;
        this.#options.onInteractionEvent?.({
          type: "interaction_resolved",
          interactionId: id,
          resolution: action === "submit" ? "submitted" : "cancelled",
        });
        return true;
      },
      cancelThread: () => {
        if (!this.#pendingInteraction) return 0;
        const id = this.#pendingInteraction.id;
        this.#pendingInteraction = null;
        this.#options.onInteractionEvent?.({
          type: "interaction_resolved",
          interactionId: id,
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

  requestCommandApproval(command: string | null): void {
    this.#pendingApproval = {
      id: "command-approval-1",
      kind: "command",
      threadId: this.#threadId,
      turnId: "native-turn-1",
      itemId: "command-1",
      reason: "读取 /home/private/project/secret.txt",
      startedAtMs: Date.now(),
      command,
      network: { host: "registry.npmjs.org", protocol: "https" },
    };
    this.#options.onApprovalEvent?.({
      type: "approval_requested",
      approval: this.#pendingApproval,
    });
  }

  requestPermissionsApproval(permissions: Record<string, unknown>): void {
    this.#pendingApproval = {
      id: "permissions-approval-1",
      kind: "permissions",
      threadId: this.#threadId,
      turnId: "native-turn-1",
      itemId: "permissions-1",
      reason: "需要额外文件系统权限",
      startedAtMs: Date.now(),
      permissions,
    };
    this.#options.onApprovalEvent?.({
      type: "approval_requested",
      approval: this.#pendingApproval,
    });
  }

  requestInteraction(): void {
    this.#pendingInteraction = {
      id: "interaction-1",
      kind: "user_input",
      threadId: this.#threadId,
      turnId: "native-turn-1",
      questions: [{
        id: "choice",
        header: "选择",
        question: "继续吗？",
        isOther: false,
        isSecret: false,
        options: [{ label: "继续", description: "继续任务" }],
      }],
    };
    this.#options.onInteractionEvent?.({
      type: "interaction_requested",
      interaction: this.#pendingInteraction,
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
    this.exited = true;
    this.#options.onUnexpectedExit?.(
      this as unknown as SessionWorker,
      new Error("测试 Worker 异常退出"),
    );
  }

  /** 与 SessionWorker 相同：并发 close() 共享同一次关闭。 */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.closeCount += 1;
    await this.#beforeClose?.(this);
    this.approvals.cancelThread();
    this.interactions.cancelThread();
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

function isProjectMismatch(error: unknown): boolean {
  return error instanceof WorkerManagerError &&
    error.code === "session_project_mismatch" &&
    /不属于所选项目/u.test(error.message);
}
