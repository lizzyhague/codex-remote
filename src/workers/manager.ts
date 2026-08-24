import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CodexStreamEvent } from "../app-server/turn-session.ts";
import type { ApprovalEvent, ApprovalRequest } from "../approvals/broker.ts";
import type { CommandName } from "../commands/catalog.ts";
import type { CommandOptions } from "../commands/runner.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import type { OpenedSession } from "../sessions/service.ts";
import type { TrashStore } from "../sessions/trash-store.ts";
import { ProjectTaskLocks } from "../server/project-locks.ts";
import { toBrowserStreamEvent } from "../server/stream-events.ts";
import { SessionWorker, type SessionWorkerOptions } from "./session-worker.ts";
import type {
  WorkerInteractionEvent,
  WorkerInteractionRequest,
} from "./interaction-broker.ts";
import {
  type StoredWorkerEvent,
  type WorkerPermissionMode,
  type WorkerStateStore,
  type WorkerTask,
  type WorkerTaskKind,
} from "./state-store.ts";

const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_MIN_AVAILABLE_MEMORY_BYTES = 1_073_741_824;
const DEFAULT_OFFLINE_GRACE_MS = 10_000;
const DEFAULT_QUEUE_RETRY_MS = 5_000;
const TASK_START_TIMEOUT_MS = 10_000;

export class WorkerManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerManagerError";
    this.code = code;
  }
}

export type ManagedSessionOpen = {
  opened: OpenedSession;
  activeTaskId: string | null;
  controlsActiveTask: boolean;
  fullAccessEnabled: boolean;
  replayEvents: StoredWorkerEvent[];
};

export type WorkerManagerEvent = StoredWorkerEvent & {
  /** 审批发给所有已认证客户端；其他事件只发给正在查看该会话的客户端。 */
  audience: "session" | "all";
};

type WorkerFactory = (options: SessionWorkerOptions) => Promise<SessionWorker>;

export type SessionWorkerManagerOptions = {
  store: WorkerStateStore;
  projects: ProjectCatalog;
  trash: TrashStore;
  locks: ProjectTaskLocks;
  codexBinary?: string;
  workingDirectory?: string;
  maxWorkers?: number;
  minAvailableMemoryBytes?: number;
  offlineGraceMs?: number;
  queueRetryMs?: number;
  now?: () => number;
  workerFactory?: WorkerFactory;
  availableMemory?: () => Promise<number>;
};

type ActiveWorker = {
  task: WorkerTask;
  worker: SessionWorker;
  ownerId: string;
  finishing: boolean;
  interruptionReason: string | null;
  startTimer: NodeJS.Timeout | null;
};

type ProvisionalWorker = {
  worker: SessionWorker;
  closeTimer: NodeJS.Timeout | null;
};

/**
 * 后端级会话主管理器。浏览器连接只负责 attach/detach；任务、writer、审批与
 * 事件日志都属于这里，因此页面断开不会销毁正在运行的 turn。
 */
export class SessionWorkerManager {
  readonly #store: WorkerStateStore;
  readonly #projects: ProjectCatalog;
  readonly #trash: TrashStore;
  readonly #locks: ProjectTaskLocks;
  readonly #codexBinary: string | undefined;
  readonly #workingDirectory: string | undefined;
  readonly #maxWorkers: number;
  readonly #minAvailableMemoryBytes: number;
  readonly #offlineGraceMs: number;
  readonly #queueRetryMs: number;
  readonly #now: () => number;
  readonly #workerFactory: WorkerFactory;
  readonly #availableMemory: () => Promise<number>;
  readonly #listeners = new Set<(event: WorkerManagerEvent) => void>();
  readonly #workers = new Map<string, ActiveWorker>();
  readonly #provisionalWorkers = new Map<string, ProvisionalWorker>();
  readonly #authenticatedClients = new Set<string>();
  readonly #clientSessions = new Map<string, string>();
  readonly #sessionFullAccess = new Map<string, boolean>();
  readonly #sessionSnapshots = new Map<string, OpenedSession>();
  readonly #threadOperationTails = new Map<string, Promise<void>>();
  #transientWorkers = 0;
  #workerReservations = 0;
  #offlineSinceMs: number | null = null;
  #offlineTimer: NodeJS.Timeout | null = null;
  #queueRetryTimer: NodeJS.Timeout | null = null;
  #scheduleTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: SessionWorkerManagerOptions) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#trash = options.trash;
    this.#locks = options.locks;
    this.#codexBinary = options.codexBinary;
    this.#workingDirectory = options.workingDirectory;
    this.#maxWorkers = positiveInteger(options.maxWorkers, DEFAULT_MAX_WORKERS);
    this.#minAvailableMemoryBytes = nonnegativeInteger(
      options.minAvailableMemoryBytes,
      DEFAULT_MIN_AVAILABLE_MEMORY_BYTES,
    );
    this.#offlineGraceMs = nonnegativeInteger(
      options.offlineGraceMs,
      DEFAULT_OFFLINE_GRACE_MS,
    );
    this.#queueRetryMs = positiveInteger(options.queueRetryMs, DEFAULT_QUEUE_RETRY_MS);
    this.#now = options.now ?? Date.now;
    this.#workerFactory = options.workerFactory ?? SessionWorker.create;
    this.#availableMemory = options.availableMemory ?? readAvailableMemory;
    this.#store.recoverInterrupted(this.#now());
  }

  onEvent(listener: (event: WorkerManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#authenticatedClients.size === 0) this.#armOfflineGrace();
    this.#schedule();
  }

  clientAuthenticated(clientId: string): void {
    if (this.#closed) return;
    this.#authenticatedClients.add(clientId);
    this.#offlineSinceMs = null;
    if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
    this.#offlineTimer = null;
    for (const active of this.#workers.values()) {
      for (const approval of active.worker.approvals.pendingForThread(active.task.threadId)) {
        const stored = this.#storedApprovalEvent(active.task.id, approval.id);
        if (stored) this.#emit(stored, "all");
      }
      for (const interaction of active.worker.interactions.pendingForThread(active.task.threadId)) {
        const stored = this.#storedInteractionEvent(active.task.id, interaction.id);
        if (stored) this.#emit(stored, "all");
      }
    }
  }

  clientDisconnected(clientId: string): void {
    this.detachSession(clientId);
    if (!this.#authenticatedClients.delete(clientId) || this.#authenticatedClients.size > 0) {
      return;
    }
    this.#armOfflineGrace();
  }

  async startSession(projectId: string): Promise<ManagedSessionOpen> {
    if (this.#workerCount() >= this.#maxWorkers) {
      throw new WorkerManagerError("worker_capacity", "活动 Worker 已达到上限，请稍后再试。");
    }
    this.#workerReservations += 1;
    let worker: SessionWorker;
    try {
      if (!await this.#hasAvailableMemory()) {
        throw new WorkerManagerError("worker_memory_low", "VPS 可用内存不足，暂时不能新建会话。");
      }
      worker = await this.#createWorker(projectId);
    } finally {
      this.#workerReservations -= 1;
    }
    this.#provisionalWorkers.set(worker.threadId, { worker, closeTimer: null });
    this.#sessionSnapshots.set(worker.threadId, worker.opened);
    const fullAccessEnabled = this.#recordFullAccess(worker.threadId, worker.fullAccessEnabled);
    return {
      opened: worker.opened,
      activeTaskId: null,
      controlsActiveTask: false,
      fullAccessEnabled,
      replayEvents: [],
    };
  }

  async resumeSession(projectId: string, threadId: string): Promise<ManagedSessionOpen> {
    const active = this.#workers.get(threadId);
    if (active) {
      return this.#managedOpen(active.worker.opened, active.worker.fullAccessEnabled);
    }
    const provisional = this.#provisionalWorkers.get(threadId);
    if (provisional) {
      return this.#managedOpen(provisional.worker.opened, provisional.worker.fullAccessEnabled);
    }
    const pending = this.#store.pendingForThread(threadId);
    const snapshot = this.#sessionSnapshots.get(threadId);
    if (pending && snapshot) {
      return this.#managedOpen(snapshot, this.#sessionFullAccess.get(threadId) === true);
    }
    if (pending) {
      throw new WorkerManagerError(
        "worker_starting",
        "这个会话的后台 Worker 正在启动，请稍后重新打开。",
      );
    }
    return this.#withTransientWorker(projectId, threadId, async (worker) => {
      this.#sessionSnapshots.set(threadId, worker.opened);
      return this.#managedOpen(worker.opened, worker.fullAccessEnabled);
    });
  }

  enqueueMessage(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    text: string,
  ): { accepted: true; taskId: string; status: WorkerTask["status"]; duplicate: boolean } {
    return this.#enqueue(projectId, threadId, clientMessageId, "message", text);
  }

  enqueueCommandTask(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    kind: Extract<WorkerTaskKind, "compact" | "review">,
  ): { accepted: true; taskId: string; status: WorkerTask["status"]; duplicate: boolean } {
    return this.#enqueue(projectId, threadId, clientMessageId, kind, "");
  }

  async stopTask(threadId: string): Promise<{ requested: boolean }> {
    const active = this.#workers.get(threadId);
    if (!active) return { requested: false };
    active.interruptionReason = "user_requested";
    active.worker.approvals.cancelThread(threadId);
    active.worker.interactions.cancelThread(threadId);
    return { requested: await active.worker.turns.interruptActiveTurn() };
  }

  async answerInteraction(
    interactionId: string,
    action: "submit" | "cancel",
    answers: Record<string, string[]>,
  ): Promise<{ answered: true }> {
    for (const active of this.#workers.values()) {
      if (!active.worker.interactions.answer(interactionId, action, answers)) continue;
      if (action === "cancel") {
        active.interruptionReason = "user_input_cancelled";
        active.worker.approvals.cancelThread(active.task.threadId);
        await active.worker.turns.interruptActiveTurn().catch(() => false);
      }
      return { answered: true };
    }
    throw new WorkerManagerError(
      "interaction_not_found",
      "这个问题已经处理过，或不属于仍在运行的任务。",
    );
  }

  commandOptions(
    projectId: string,
    threadId: string,
    command: CommandName,
  ): Promise<CommandOptions> {
    return this.#withIdleWorker(projectId, threadId, (worker) =>
      worker.commands.options(command));
  }

  async runCommand(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    command: CommandName,
    option: string | null,
    argument: string | null,
  ): Promise<Record<string, unknown>> {
    if (command === "compact" || command === "review") {
      const queued = this.enqueueCommandTask(
        projectId,
        threadId,
        clientMessageId,
        command,
      );
      return {
        kind: "task",
        title: command === "compact" ? "正在压缩会话" : "正在检查未提交的改动",
        lines: ["任务已由后端接收，可以关闭页面。"],
        ...queued,
      };
    }

    if (command === "rewind") {
      return this.#withIdleWorker(projectId, threadId, async (worker) => ({
        kind: "rewind",
        title: "已回退一轮",
        lines: [
          "最近一轮已从当前会话的对话上下文中移除。",
          "这一轮已经造成的文件改动仍然保留。",
        ],
        turns: await worker.commands.rewind(),
      }));
    }

    const result = await this.#withIdleWorker(projectId, threadId, async (worker) => {
      if (command === "model") {
        if (!option) throw new WorkerManagerError("command_option_required", "请先选择一个模型。");
        return worker.commands.setModel(option, argument);
      }
      if (command === "permissions") {
        if (!option) throw new WorkerManagerError("command_option_required", "请先选择一种权限。");
        return worker.commands.setPermissions(option);
      }
      if (command === "plan") return worker.commands.togglePlan();
      if (command === "rename") {
        if (!argument) {
          throw new WorkerManagerError(
            "command_argument_required",
            "请在 /rename 后面写一个会话名称。",
          );
        }
        return worker.commands.rename(argument);
      }
      if (command === "status") return worker.commands.status();
      if (command === "usage") {
        if (!option) {
          throw new WorkerManagerError("command_option_required", "请先选择要查看的用量。");
        }
        return worker.commands.usage(option);
      }
      throw new WorkerManagerError("unknown_command", "不支持这个斜杠命令。");
    });

    if (typeof result.fullAccessEnabled === "boolean") {
      this.#recordFullAccess(threadId, result.fullAccessEnabled);
    }
    if (command === "plan" && argument) {
      const queued = this.enqueueMessage(
        projectId,
        threadId,
        `${clientMessageId}:message`,
        argument,
      );
      return { ...result, taskId: queued.taskId, accepted: true, sentText: argument };
    }
    return result;
  }

  async toggleFullAccess(
    projectId: string,
    threadId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.#withIdleWorker(projectId, threadId, (worker) =>
      worker.commands.toggleFullAccess());
    if (typeof result.fullAccessEnabled === "boolean") {
      this.#recordFullAccess(threadId, result.fullAccessEnabled);
    }
    return result;
  }

  answerApproval(
    approvalId: string,
    decision: "approve_once" | "decline",
  ): { answered: true } {
    for (const active of this.#workers.values()) {
      if (active.worker.approvals.answer(approvalId, decision)) {
        return { answered: true };
      }
    }
    throw new WorkerManagerError(
      "approval_not_found",
      "这个审批已经处理过，或不属于仍在运行的任务。",
    );
  }

  activeTask(threadId: string): WorkerTask | null {
    return this.#store.pendingForThread(threadId);
  }

  attachSession(clientId: string, threadId: string): void {
    this.detachSession(clientId);
    this.#clientSessions.set(clientId, threadId);
    const provisional = this.#provisionalWorkers.get(threadId);
    if (provisional?.closeTimer) clearTimeout(provisional.closeTimer);
    if (provisional) provisional.closeTimer = null;
  }

  detachSession(clientId: string): void {
    const threadId = this.#clientSessions.get(clientId);
    if (!threadId) return;
    this.#clientSessions.delete(clientId);
    const provisional = this.#provisionalWorkers.get(threadId);
    if (!provisional || this.#sessionAttached(threadId) || provisional.closeTimer) return;
    provisional.closeTimer = setTimeout(() => {
      provisional.closeTimer = null;
      if (!this.#sessionAttached(threadId)) void this.#closeProvisional(threadId);
    }, this.#offlineGraceMs);
    provisional.closeTimer.unref();
  }

  projectBusy(projectId: string): boolean {
    return this.#store.pendingForProject(projectId) !== null;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
    if (this.#queueRetryTimer) clearTimeout(this.#queueRetryTimer);
    await this.#scheduleTail.catch(() => {});
    await Promise.all([...this.#workers.values()].map(async (active) => {
      this.#clearStartTimer(active);
      active.interruptionReason = "backend_stopping";
      active.worker.approvals.cancelThread(active.worker.threadId);
      active.worker.interactions.cancelThread(active.worker.threadId);
      await active.worker.turns.interruptActiveTurn().catch(() => false);
      await active.worker.close().catch(() => {});
      this.#locks.release(active.task.projectId, active.ownerId);
    }));
    await Promise.all([...this.#provisionalWorkers.values()].map(async (provisional) => {
      if (provisional.closeTimer) clearTimeout(provisional.closeTimer);
      await provisional.worker.close().catch(() => {});
    }));
    this.#workers.clear();
    this.#provisionalWorkers.clear();
    this.#listeners.clear();
  }

  #enqueue(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    kind: WorkerTaskKind,
    payload: string,
  ): { accepted: true; taskId: string; status: WorkerTask["status"]; duplicate: boolean } {
    if (this.#closed) throw new WorkerManagerError("worker_manager_closed", "后端正在停止。");
    const createdAtMs = this.#now();
    const permissionMode: WorkerPermissionMode = this.#knownFullAccess(threadId)
      ? "full_access"
      : "manual";
    const result = this.#store.enqueue({
      id: randomUUID(),
      clientMessageId,
      projectId,
      threadId,
      kind,
      payload,
      permissionMode,
      createdAtMs,
    });
    if (!result.duplicate) {
      const stored = this.#store.appendEvent(result.task.id, threadId, {
        type: "task.queued",
        sessionId: threadId,
        taskId: result.task.id,
        status: "queued",
        ...(kind === "message" ? { text: payload } : { command: kind }),
      }, createdAtMs);
      this.#emit(stored, "session");
      this.#schedule();
    }
    return {
      accepted: true,
      taskId: result.task.id,
      status: result.task.status,
      duplicate: result.duplicate,
    };
  }

  #managedOpen(opened: OpenedSession, fullAccessEnabled: boolean): ManagedSessionOpen {
    fullAccessEnabled = this.#recordFullAccess(opened.session.id, fullAccessEnabled);
    const pending = this.#store.pendingForThread(opened.session.id);
    const replayTask = pending ?? terminalReplayTask(this.#store.latestForThread(opened.session.id));
    return {
      opened,
      activeTaskId: pending?.id ?? null,
      controlsActiveTask: pending !== null,
      fullAccessEnabled,
      replayEvents: replayTask ? this.#store.eventsForTask(replayTask.id) : [],
    };
  }

  async #withTransientWorker<Result>(
    projectId: string,
    threadId: string | undefined,
    operation: (worker: SessionWorker) => Promise<Result> | Result,
  ): Promise<Result> {
    if (threadId) {
      return this.#serializeThreadOperation(threadId, () =>
        this.#withTransientWorkerUnlocked(projectId, threadId, operation));
    }
    return this.#withTransientWorkerUnlocked(projectId, threadId, operation);
  }

  async #withTransientWorkerUnlocked<Result>(
    projectId: string,
    threadId: string | undefined,
    operation: (worker: SessionWorker) => Promise<Result> | Result,
  ): Promise<Result> {
    if (this.#closed) throw new WorkerManagerError("worker_manager_closed", "后端正在停止。");
    if (threadId && this.#workers.has(threadId)) {
      throw new WorkerManagerError("task_already_running", "这个会话已有任务正在运行。");
    }
    const provisional = threadId ? this.#provisionalWorkers.get(threadId) : null;
    if (provisional) return await operation(provisional.worker);
    if (this.#workerCount() >= this.#maxWorkers) {
      throw new WorkerManagerError("worker_capacity", "活动 Worker 已达到上限，请稍后再试。");
    }
    this.#transientWorkers += 1;
    let worker: SessionWorker | null = null;
    try {
      if (!await this.#hasAvailableMemory()) {
        throw new WorkerManagerError("worker_memory_low", "VPS 可用内存不足，暂时不能打开新 Worker。");
      }
      worker = await this.#createWorker(projectId, threadId);
      await this.#reconcileFullAccess(worker, threadId ? this.#knownFullAccess(threadId) : undefined);
      return await operation(worker);
    } finally {
      await worker?.close().catch(() => {});
      this.#transientWorkers -= 1;
      this.#schedule();
    }
  }

  async #serializeThreadOperation<Result>(
    threadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#threadOperationTails.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => {}, () => {});
    this.#threadOperationTails.set(threadId, tail);
    try {
      return await current;
    } finally {
      if (this.#threadOperationTails.get(threadId) === tail) {
        this.#threadOperationTails.delete(threadId);
      }
      this.#schedule();
    }
  }

  #withIdleWorker<Result>(
    projectId: string,
    threadId: string,
    operation: (worker: SessionWorker) => Promise<Result> | Result,
  ): Promise<Result> {
    if (this.#store.pendingForThread(threadId)) {
      throw new WorkerManagerError(
        "task_already_running",
        "这个会话有已接受或正在执行的任务。",
      );
    }
    return this.#withTransientWorker(projectId, threadId, operation);
  }

  #schedule(): void {
    if (this.#closed) return;
    const scheduled = this.#scheduleTail.then(() => this.#drainQueue());
    this.#scheduleTail = scheduled.catch((error: unknown) => {
      console.error(`Worker 调度失败：${errorMessage(error)}`);
    });
  }

  async #drainQueue(): Promise<void> {
    if (this.#closed) return;
    let capacityBlocked = false;
    for (const task of this.#store.queued()) {
      if (this.#threadOperationTails.has(task.threadId)) continue;
      const provisional = this.#provisionalWorkers.has(task.threadId);
      if (this.#workerCount() - (provisional ? 1 : 0) >= this.#maxWorkers) {
        capacityBlocked = true;
        break;
      }
      if (this.#workers.has(task.threadId)) continue;
      const ownerId = `worker:${task.threadId}`;
      if (!this.#locks.acquire(task.projectId, ownerId, task.threadId)) continue;
      if (!provisional && !await this.#hasAvailableMemory()) {
        this.#locks.release(task.projectId, ownerId);
        capacityBlocked = true;
        break;
      }
      await this.#startQueuedTask(task, ownerId);
    }
    if (capacityBlocked || this.#store.queued().length > 0) this.#armQueueRetry();
  }

  async #startQueuedTask(task: WorkerTask, ownerId: string): Promise<void> {
    let worker: SessionWorker | null = null;
    let workerReserved = false;
    try {
      const provisional = this.#provisionalWorkers.get(task.threadId);
      if (provisional?.closeTimer) clearTimeout(provisional.closeTimer);
      if (provisional) this.#provisionalWorkers.delete(task.threadId);
      if (provisional) {
        worker = provisional.worker;
      } else {
        this.#workerReservations += 1;
        workerReserved = true;
        worker = await this.#createWorker(task.projectId, task.threadId);
      }
      this.#sessionSnapshots.set(task.threadId, worker.opened);
      const permissionMode = task.permissionMode;
      await this.#reconcileFullAccess(worker, permissionMode === "full_access");
      const active: ActiveWorker = {
        task: this.#store.markRunning(task.id, null, permissionMode, this.#now()),
        worker,
        ownerId,
        finishing: false,
        interruptionReason: null,
        startTimer: null,
      };
      this.#workers.set(task.threadId, active);
      if (workerReserved) {
        this.#workerReservations -= 1;
        workerReserved = false;
      }
      active.startTimer = setTimeout(() => {
        if (!active.worker.turns.activeTurnId && !active.finishing) {
          void this.#finishWithoutTurn(active);
        }
      }, TASK_START_TIMEOUT_MS);
      active.startTimer.unref();

      const nativeTurnId = task.kind === "message"
        ? await worker.turns.startTextTurn(task.payload)
        : task.kind === "compact"
        ? await worker.commands.compact()
        : await worker.commands.review();
      if (nativeTurnId && this.#workers.get(task.threadId) === active) {
        this.#store.setNativeTurnId(task.id, nativeTurnId, this.#now());
      }
    } catch (error) {
      if (workerReserved) this.#workerReservations -= 1;
      if (worker && this.#workers.get(task.threadId)?.worker === worker) {
        await this.#failActive(this.#workers.get(task.threadId)!, error);
      } else {
        const event = this.#store.finish(task.id, "failed", {
          type: "task.completed",
          sessionId: task.threadId,
          taskId: task.id,
          status: "failed",
          error: error instanceof WorkerManagerError && error.code === "permission_restore_failed"
            ? error.message
            : "Worker 无法启动，请查看服务日志。",
        }, this.#now(), { error: errorMessage(error) });
        this.#emit(event, "session");
        await worker?.close().catch(() => {});
        this.#locks.release(task.projectId, ownerId);
      }
    }
  }

  async #createWorker(projectId: string, threadId?: string): Promise<SessionWorker> {
    return this.#workerFactory({
      projectId,
      projects: this.#projects,
      trash: this.#trash,
      ...(threadId ? { threadId } : {}),
      ...(this.#codexBinary ? { codexBinary: this.#codexBinary } : {}),
      ...(this.#workingDirectory ? { workingDirectory: this.#workingDirectory } : {}),
      onStreamEvent: (event) => this.#handleStreamEvent(event),
      onApprovalEvent: (event) => this.#handleApprovalEvent(event),
      onInteractionEvent: (event) => this.#handleInteractionEvent(event),
      onUnexpectedExit: (exitedThreadId, error) => {
        const active = this.#workers.get(exitedThreadId);
        if (active) void this.#failActive(active, error);
      },
    });
  }

  #handleStreamEvent(event: CodexStreamEvent): void {
    const active = this.#workers.get(event.threadId);
    if (!active || active.finishing) return;
    if (event.type === "turn_started") {
      this.#clearStartTimer(active);
      this.#store.setNativeTurnId(active.task.id, event.turnId, this.#now());
    }

    const browserEvent = {
      ...toBrowserStreamEvent(event),
      taskId: active.task.id,
    };
    if (event.type === "turn_completed") {
      active.finishing = true;
      const status = event.status === "interrupted"
        ? "interrupted"
        : event.status === "failed"
        ? "failed"
        : "completed";
      const stored = this.#store.finish(active.task.id, status, {
        ...browserEvent,
        interruptionReason: active.interruptionReason,
      }, this.#now(), {
        error: event.error,
        interruptionReason: active.interruptionReason,
      });
      this.#emit(stored, "session");
      void this.#cleanupActive(active);
      return;
    }
    const stored = this.#store.appendEvent(
      active.task.id,
      active.task.threadId,
      browserEvent,
      this.#now(),
    );
    this.#emit(stored, "session");
  }

  #handleApprovalEvent(event: ApprovalEvent): void {
    if (event.type === "approval_requested") {
      const active = this.#workers.get(event.approval.threadId);
      if (!active || active.finishing || event.approval.turnId !== active.worker.turns.activeTurnId) {
        return;
      }
      this.#store.markWaiting(active.task.id, this.#now());
      const stored = this.#store.appendEvent(active.task.id, active.task.threadId, {
        type: "approval.requested",
        sessionId: active.task.threadId,
        taskId: active.task.id,
        approval: publicApproval(event.approval),
      }, this.#now());

      if (this.#authenticatedClients.size > 0) {
        this.#emit(stored, "all");
        return;
      }
      if (active.worker.fullAccessEnabled) {
        active.worker.approvals.answer(event.approval.id, "approve_once");
        return;
      }
      if (this.#offlineGraceExpired()) void this.#interruptForOfflineApproval(active);
      return;
    }

    for (const active of this.#workers.values()) {
      const events = this.#store.eventsForTask(active.task.id);
      const requested = events.find((stored) => {
        const approval = asObject(stored.event.approval);
        return stored.event.type === "approval.requested" && approval?.id === event.approvalId;
      });
      if (!requested) continue;
      if (
        active.worker.approvals.pendingForThread(active.task.threadId).length === 0 &&
        active.worker.interactions.pendingForThread(active.task.threadId).length === 0
      ) {
        this.#store.markRunningAgain(active.task.id, this.#now());
      }
      const stored = this.#store.appendEvent(active.task.id, active.task.threadId, {
        type: "approval.resolved",
        sessionId: active.task.threadId,
        taskId: active.task.id,
        approvalId: event.approvalId,
        resolution: event.resolution,
      }, this.#now());
      this.#emit(stored, "all");
      return;
    }
  }

  #handleInteractionEvent(event: WorkerInteractionEvent): void {
    if (event.type === "interaction_requested") {
      const active = this.#workers.get(event.interaction.threadId);
      if (!active || active.finishing) return;
      this.#store.markWaiting(active.task.id, this.#now());
      const stored = this.#store.appendEvent(active.task.id, active.task.threadId, {
        type: "interaction.requested",
        sessionId: active.task.threadId,
        taskId: active.task.id,
        interaction: publicInteraction(event.interaction),
      }, this.#now());
      if (this.#authenticatedClients.size > 0) {
        this.#emit(stored, "all");
      } else if (this.#offlineGraceExpired()) {
        void this.#interruptForOfflineInteraction(active);
      }
      return;
    }

    for (const active of this.#workers.values()) {
      if (!this.#storedInteractionEvent(active.task.id, event.interactionId)) continue;
      if (
        active.worker.interactions.pendingForThread(active.task.threadId).length === 0 &&
        active.worker.approvals.pendingForThread(active.task.threadId).length === 0
      ) {
        this.#store.markRunningAgain(active.task.id, this.#now());
      }
      const stored = this.#store.appendEvent(active.task.id, active.task.threadId, {
        type: "interaction.resolved",
        sessionId: active.task.threadId,
        taskId: active.task.id,
        interactionId: event.interactionId,
        resolution: event.resolution,
      }, this.#now());
      this.#emit(stored, "all");
      return;
    }
  }

  async #handleOfflineGraceExpired(): Promise<void> {
    if (this.#authenticatedClients.size > 0) return;
    for (const active of this.#workers.values()) {
      if (active.worker.interactions.pendingForThread(active.task.threadId).length > 0) {
        await this.#interruptForOfflineInteraction(active);
        continue;
      }
      const pending = active.worker.approvals.pendingForThread(active.task.threadId);
      if (pending.length === 0) continue;
      if (active.worker.fullAccessEnabled) {
        for (const approval of pending) {
          active.worker.approvals.answer(approval.id, "approve_once");
        }
      } else {
        await this.#interruptForOfflineApproval(active);
      }
    }
  }

  async #interruptForOfflineApproval(active: ActiveWorker): Promise<void> {
    if (active.finishing) return;
    active.interruptionReason = "no_client_for_permission";
    active.worker.approvals.cancelThread(active.task.threadId);
    await active.worker.turns.interruptActiveTurn().catch(() => false);
  }

  async #interruptForOfflineInteraction(active: ActiveWorker): Promise<void> {
    if (active.finishing) return;
    active.interruptionReason = "no_client_for_user_input";
    active.worker.interactions.cancelThread(active.task.threadId);
    active.worker.approvals.cancelThread(active.task.threadId);
    await active.worker.turns.interruptActiveTurn().catch(() => false);
  }

  #offlineGraceExpired(): boolean {
    return this.#offlineSinceMs !== null && this.#now() - this.#offlineSinceMs >= this.#offlineGraceMs;
  }

  #armOfflineGrace(): void {
    this.#offlineSinceMs = this.#now();
    if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
    this.#offlineTimer = setTimeout(() => {
      this.#offlineTimer = null;
      void this.#handleOfflineGraceExpired();
    }, this.#offlineGraceMs);
    this.#offlineTimer.unref();
  }

  #storedApprovalEvent(taskId: string, approvalId: string): StoredWorkerEvent | null {
    return this.#store.eventsForTask(taskId).find((stored) => {
      const approval = asObject(stored.event.approval);
      return stored.event.type === "approval.requested" && approval?.id === approvalId;
    }) ?? null;
  }

  #storedInteractionEvent(taskId: string, interactionId: string): StoredWorkerEvent | null {
    return this.#store.eventsForTask(taskId).find((stored) => {
      const interaction = asObject(stored.event.interaction);
      return stored.event.type === "interaction.requested" && interaction?.id === interactionId;
    }) ?? null;
  }

  async #finishWithoutTurn(active: ActiveWorker): Promise<void> {
    if (active.finishing || this.#workers.get(active.task.threadId) !== active) return;
    active.finishing = true;
    const stored = this.#store.finish(active.task.id, "completed", {
      type: "task.completed",
      sessionId: active.task.threadId,
      taskId: active.task.id,
      status: "completed",
      error: null,
    }, this.#now());
    this.#emit(stored, "session");
    await this.#cleanupActive(active);
  }

  async #failActive(active: ActiveWorker, error: unknown): Promise<void> {
    if (active.finishing) return;
    active.finishing = true;
    console.error(`会话 Worker ${active.task.threadId} 失败：${errorMessage(error)}`);
    const stored = this.#store.finish(active.task.id, "failed", {
      type: "task.completed",
      sessionId: active.task.threadId,
      taskId: active.task.id,
      status: "failed",
      error: "会话 Worker 异常结束，请查看服务日志。",
    }, this.#now(), { error: errorMessage(error) });
    this.#emit(stored, "session");
    await this.#cleanupActive(active);
  }

  async #cleanupActive(active: ActiveWorker): Promise<void> {
    this.#clearStartTimer(active);
    if (this.#workers.get(active.task.threadId) === active) {
      this.#workers.delete(active.task.threadId);
    }
    try {
      await active.worker.close();
    } catch (error) {
      console.error(`关闭会话 Worker 失败：${errorMessage(error)}`);
    } finally {
      this.#locks.release(active.task.projectId, active.ownerId);
      this.#schedule();
    }
  }

  #clearStartTimer(active: ActiveWorker): void {
    if (active.startTimer) clearTimeout(active.startTimer);
    active.startTimer = null;
  }

  #emit(stored: StoredWorkerEvent, audience: WorkerManagerEvent["audience"]): void {
    const event: WorkerManagerEvent = { ...stored, audience };
    for (const listener of this.#listeners) listener(event);
  }

  #armQueueRetry(): void {
    if (this.#closed || this.#queueRetryTimer) return;
    this.#queueRetryTimer = setTimeout(() => {
      this.#queueRetryTimer = null;
      this.#schedule();
    }, this.#queueRetryMs);
    this.#queueRetryTimer.unref();
  }

  #knownFullAccess(threadId: string): boolean | undefined {
    if (this.#sessionFullAccess.has(threadId)) {
      return this.#sessionFullAccess.get(threadId);
    }
    const persisted = this.#store.sessionFullAccess(threadId);
    if (persisted !== null) {
      this.#sessionFullAccess.set(threadId, persisted);
    }
    return persisted ?? undefined;
  }

  #recordFullAccess(threadId: string, enabled: boolean): boolean {
    this.#sessionFullAccess.set(threadId, enabled);
    this.#store.setSessionFullAccess(threadId, enabled, this.#now());
    return enabled;
  }

  async #reconcileFullAccess(
    worker: SessionWorker,
    desired: boolean | undefined,
  ): Promise<boolean> {
    let enabled = worker.fullAccessEnabled;
    if (desired !== undefined && enabled !== desired) {
      const result = await worker.commands.toggleFullAccess().catch(() => {
        throw new WorkerManagerError(
          "permission_restore_failed",
          "无法恢复会话权限，任务没有启动。",
        );
      });
      if (typeof result.fullAccessEnabled !== "boolean") {
        throw new WorkerManagerError(
          "permission_restore_failed",
          "Worker 没有确认恢复后的 Full access 状态，任务没有启动。",
        );
      }
      enabled = result.fullAccessEnabled;
      if (enabled !== desired) {
        throw new WorkerManagerError(
          "permission_restore_failed",
          `无法把会话权限恢复为${desired ? " Full access" : "普通权限"}，任务没有启动。`,
        );
      }
    }
    return this.#recordFullAccess(worker.threadId, enabled);
  }

  #workerCount(): number {
    return this.#workers.size + this.#provisionalWorkers.size + this.#transientWorkers +
      this.#workerReservations;
  }

  #sessionAttached(threadId: string): boolean {
    return [...this.#clientSessions.values()].includes(threadId);
  }

  async #closeProvisional(threadId: string): Promise<void> {
    const provisional = this.#provisionalWorkers.get(threadId);
    if (!provisional) return;
    this.#provisionalWorkers.delete(threadId);
    await provisional.worker.close().catch((error: unknown) => {
      console.error(`关闭空会话 Worker 失败：${errorMessage(error)}`);
    });
    this.#sessionSnapshots.delete(threadId);
    this.#sessionFullAccess.delete(threadId);
    this.#schedule();
  }

  async #hasAvailableMemory(): Promise<boolean> {
    return await this.#availableMemory() >= this.#minAvailableMemoryBytes;
  }
}

function publicApproval(approval: ApprovalRequest): Record<string, unknown> {
  return {
    id: approval.id,
    kind: approval.kind,
    reason: approval.reason,
    startedAtMs: approval.startedAtMs,
    ...(approval.kind === "command" ? { network: approval.network } : {}),
  };
}

function publicInteraction(interaction: WorkerInteractionRequest): Record<string, unknown> {
  return structuredClone(interaction) as unknown as Record<string, unknown>;
}

async function readAvailableMemory(): Promise<number> {
  try {
    const source = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(source);
    if (match?.[1]) return Number(match[1]) * 1_024;
  } catch {
    // 非 Linux 环境由调用者注入；这里保守返回 0，避免内存未知时启动新 Worker。
  }
  return 0;
}

function terminalReplayTask(task: WorkerTask | null): WorkerTask | null {
  return task && task.status === "interrupted" && task.interruptionReason
    ? task
    : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
