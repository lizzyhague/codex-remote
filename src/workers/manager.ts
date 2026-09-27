import { SessionMetricsStore } from "../sessions/metrics.ts";
import { randomUUID } from "node:crypto";

import {
  CodexAttachmentError,
  CodexTurnCancelledError,
  stripPrivateAttachmentInputs,
  type CodexStreamEvent,
  validateCodexTurnAttachments,
} from "../app-server/turn-session.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import {
  AttachmentPathStreamRedactor,
  redactKnownAttachmentPaths,
  redactKnownAttachmentPathsDeep,
} from "../attachments/path-redaction.ts";
import { collectHistoryAttachmentRecords } from "../server/history.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import { AttachmentDisplayIndex } from "./attachment-index.ts";
import type { ApprovalEvent, ApprovalRequest } from "../approvals/broker.ts";
import type { CommandName } from "../commands/catalog.ts";
import type { CommandOptions } from "../commands/runner.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import type { OpenedSession } from "../sessions/service.ts";
import type { TrashStore } from "../sessions/trash-store.ts";
import {
  memoryDegradedMessage,
  memoryLowMessage,
  readAvailableMemory,
  type MemoryReading,
} from "../platform/system-resources.ts";
import type { SharedUploadClient } from "../shared-upload/client.ts";
import type {
  AttachmentLease,
  PublicAttachment,
  ResolvedAttachment,
} from "../shared-upload/types.ts";
import { ProjectTaskLocks } from "../server/project-locks.ts";
import { redactBrowserStreamEvent, toBrowserStreamEvent } from "../server/stream-events.ts";
import { SessionWorker, type SessionWorkerOptions } from "./session-worker.ts";
import type { ApplicationSettingsStore } from "../settings/store.ts";
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
import { asObject } from "../shared/json.ts";

const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_MIN_AVAILABLE_MEMORY_BYTES = 1_073_741_824;
const DEFAULT_OFFLINE_GRACE_MS = 10_000;
const DEFAULT_QUEUE_RETRY_MS = 5_000;
const DEFAULT_WORKER_START_TIMEOUT_MS = 120_000;
const DEFAULT_TASK_START_TIMEOUT_MS = 10_000;
const ATTACHMENT_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1_000;
const ATTACHMENT_LEASE_RENEW_MARGIN_MS = 60_000;
const SESSION_PROJECT_MISMATCH_MESSAGE = "这个会话不属于所选项目。";

export class WorkerManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkerManagerError";
    this.code = code;
  }
}

export type ManagedSessionReady = {
  loadState: "ready";
  opened: OpenedSession;
  /** 会话已经打开，但有需要转给浏览器的说明（目前只有内存读数降级）。 */
  notice?: string;
  activeTaskId: string | null;
  controlsActiveTask: boolean;
  replayEvents: StoredWorkerEvent[];
};

export type ManagedSessionLoading = {
  loadState: "queued" | "starting";
  /** 后端内部用来维持连接挂载身份；发送浏览器前会移除。 */
  projectId: string;
  sessionId: string;
  activeTaskId: string;
  controlsActiveTask: true;
};

export type ManagedSessionOpen = ManagedSessionReady | ManagedSessionLoading;

export type WorkerManagerEvent = StoredWorkerEvent & {
  /** 待答请求发给所有已认证客户端；其他事件只发给正在查看该会话的客户端。 */
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
  /** Worker 初始化和会话恢复的等待上限；默认两分钟。 */
  workerStartTimeoutMs?: number;
  /** 请求已发出后等待 native turn ID 的上限；默认十秒。 */
  taskStartTimeoutMs?: number;
  now?: () => number;
  workerFactory?: WorkerFactory;
  availableMemory?: () => Promise<MemoryReading>;
  uploads?: Pick<
    SharedUploadClient,
    "createLease" | "renewLease" | "releaseLease"
  >;
  attachmentIndex?: AttachmentDisplayIndex;
  settings?: ApplicationSettingsStore;
};

export type PreparedTaskAttachments = {
  taskId: string;
  lease: AttachmentLease;
};

type ActiveWorker = {
  task: WorkerTask;
  worker: SessionWorker;
  ownerId: string;
  finishing: boolean;
  cleaned: boolean;
  interruptionReason: string | null;
  startTimer: NodeJS.Timeout | null;
  /** 压缩指令已经发给 Codex；从这一刻起这个任务不再接受停止。 */
  compactIssued: boolean;
};

type LaunchingTask = {
  task: WorkerTask;
  ownerId: string;
  worker: SessionWorker | null;
  cancelRequested: boolean;
  settled: boolean;
};

type ProvisionalWorker = {
  worker: SessionWorker;
  closeTimer: NodeJS.Timeout | null;
};

type WorkerOperation = {
  worker: SessionWorker | null;
  ownsWorker: boolean;
  countsCapacity: boolean;
  closeRequested: boolean;
  done: Promise<void>;
  resolveDone: () => void;
};

/**
 * 后端级会话主管理器。浏览器连接只负责 attach/detach；任务、writer、审批与
 * 事件日志都属于这里，因此页面断开不会销毁正在运行的 turn。
 */
export class SessionWorkerManager {
  readonly metrics = new SessionMetricsStore();
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
  readonly #workerStartTimeoutMs: number;
  readonly #taskStartTimeoutMs: number;
  readonly #now: () => number;
  readonly #workerFactory: WorkerFactory;
  readonly #availableMemory: () => Promise<MemoryReading>;
  readonly #uploads: SessionWorkerManagerOptions["uploads"];
  readonly #attachmentIndex: AttachmentDisplayIndex | null;
  readonly #settings: ApplicationSettingsStore | undefined;
  readonly #pathRedactors = new Map<string, AttachmentPathStreamRedactor>();
  readonly #listeners = new Set<(event: WorkerManagerEvent) => void>();
  readonly #workers = new Map<string, ActiveWorker>();
  readonly #launching = new Map<string, LaunchingTask>();
  readonly #provisionalWorkers = new Map<string, ProvisionalWorker>();
  readonly #authenticatedClients = new Set<string>();
  readonly #clientSessions = new Map<string, string>();
  /** 用户最后确认的会话设置；任务自己的 effective 权限固化在 WorkerTask。 */
  readonly #sessionDesiredFullAccess = new Map<string, boolean>();
  readonly #threadOperationTails = new Map<string, Promise<void>>();
  readonly #attachmentLeases = new Map<string, AttachmentLease>();
  readonly #workerStartControllers = new Set<AbortController>();
  readonly #workerOperations = new Set<WorkerOperation>();
  /** 已离开可查 map、仍在异步收尾的 Worker 关闭与清理；总关闭必须等它们真正结束。 */
  readonly #closingWork = new Set<Promise<void>>();
  #workerReservations = 0;
  #offlineSinceMs: number | null = null;
  #offlineTimer: NodeJS.Timeout | null = null;
  #queueRetryTimer: NodeJS.Timeout | null = null;
  #attachmentLeaseTimer: NodeJS.Timeout | null = null;
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
    this.#workerStartTimeoutMs = positiveInteger(
      options.workerStartTimeoutMs,
      DEFAULT_WORKER_START_TIMEOUT_MS,
    );
    this.#taskStartTimeoutMs = positiveInteger(
      options.taskStartTimeoutMs,
      DEFAULT_TASK_START_TIMEOUT_MS,
    );
    this.#now = options.now ?? Date.now;
    this.#workerFactory = options.workerFactory ?? SessionWorker.create;
    this.#availableMemory = options.availableMemory ?? readAvailableMemory;
    this.#uploads = options.uploads;
    this.#attachmentIndex = options.attachmentIndex ?? null;
    this.#settings = options.settings;
    this.#store.recoverInterrupted(this.#now());
  }

  peekAttachmentMappings(threadId: string): AttachmentDisplayMapping[] {
    return this.#attachmentIndex?.peek(threadId) ?? [];
  }

  async syncAttachmentMappings(
    threadId: string,
    turns: Turn[] = [],
  ): Promise<AttachmentDisplayMapping[]> {
    if (!this.#attachmentIndex) return [];
    await this.#attachmentIndex.mappingsFor(threadId);
    for (const entry of collectHistoryAttachmentRecords(turns)) {
      await this.#attachmentIndex.register(threadId, entry.messageId, entry.attachments);
    }
    const mappings = this.#attachmentIndex.peek(threadId);
    this.#applyAttachmentMappings(threadId, mappings);
    return mappings;
  }

  /** 会话被永久删除后，清掉后端为它留的附件显示索引和工作状态记录。 */
  async forgetSession(threadId: string): Promise<void> {
    const { keptActive } = this.#store.forgetThread(threadId);
    if (keptActive > 0) {
      throw new Error(`会话仍有 ${keptActive} 个任务在进行，工作记录没有删除。`);
    }
    this.#clearPathRedactors(threadId);
    this.#sessionDesiredFullAccess.delete(threadId);
    await this.#attachmentIndex?.remove(threadId);
  }

  onEvent(listener: (event: WorkerManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#authenticatedClients.size === 0) this.#armOfflineGrace();
    this.#attachmentLeaseTimer = setInterval(() => {
      void this.#renewAttachmentLeases();
    }, ATTACHMENT_LEASE_RENEW_INTERVAL_MS);
    this.#attachmentLeaseTimer.unref();
    this.#schedule();
  }

  async prepareMessageAttachments(
    projectId: string,
    threadId: string,
    attachmentIds: string[],
    text = "",
  ): Promise<PreparedTaskAttachments | null> {
    this.#assertKnownThreadProject(projectId, threadId);
    if (attachmentIds.length === 0) return null;
    if (!this.#uploads) {
      throw new WorkerManagerError("uploads_unavailable", "当前后端没有启用附件服务。");
    }
    const taskId = randomUUID();
    let lease: AttachmentLease | null = null;
    try {
      lease = await this.#uploads.createLease(
        { caller: "codex", projectId, sessionId: threadId },
        taskId,
        attachmentIds,
      );
      validateCodexTurnAttachments(lease.attachments, text);
      return { taskId, lease };
    } catch (error) {
      if (lease) await this.#uploads.releaseLease(lease.leaseId, lease.ownerId).catch(() => {});
      throw uploadManagerError(error);
    }
  }

  async enqueueMessageWithAttachments(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    text: string,
    attachmentIds: string[],
  ): Promise<{ accepted: true; taskId: string; status: WorkerTask["status"]; duplicate: boolean }> {
    const existing = this.#store.findByClientMessageId(clientMessageId);
    if (existing) {
      const existingIds = existing.attachments.map((attachment) => attachment.id);
      if (
        existing.projectId !== projectId || existing.threadId !== threadId ||
        existing.kind !== "message" || existing.payload !== text ||
        JSON.stringify(existingIds) !== JSON.stringify(attachmentIds)
      ) {
        throw new WorkerManagerError(
          "message_id_conflict",
          "客户端消息 ID 已被另一条消息使用。",
        );
      }
      return {
        accepted: true,
        taskId: existing.id,
        status: existing.status,
        duplicate: true,
      };
    }
    this.#assertProjectAccepts(projectId, threadId);
    const prepared = await this.prepareMessageAttachments(projectId, threadId, attachmentIds, text);
    try {
      const queued = await this.enqueueMessage(
        projectId,
        threadId,
        clientMessageId,
        text,
        prepared,
      );
      if (!queued.duplicate) {
        await this.#registerPreparedAttachments(threadId, clientMessageId, prepared).catch(
          (error: unknown) => {
            console.error(`登记附件显示映射失败：${errorMessage(error)}`);
          },
        );
      }
      return queued;
    } catch (error) {
      if (prepared) {
        await this.#releaseAttachmentLease(prepared.taskId, prepared.lease).catch(() => {});
      }
      throw error;
    }
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

  async startSession(projectId: string): Promise<ManagedSessionReady> {
    this.#assertOpen();
    if (this.#workerCount() >= this.#maxWorkers) {
      throw new WorkerManagerError("worker_capacity", "活动 Worker 已达到上限，请稍后再试。");
    }
    const operation = this.#beginWorkerOperation(true);
    try {
      const gate = await this.#memoryGate();
      if (gate.blocked) {
        throw new WorkerManagerError(
          "worker_memory_low",
          memoryLowMessage("暂时不能新建会话。", gate.blocked, this.#minAvailableMemoryBytes),
        );
      }
      const worker = await this.#createWorker(projectId);
      operation.worker = worker;
      operation.ownsWorker = true;
      this.#assertOpen();
      // 退出回调早于登记时找不到任何角色；发布前在这里拦下，由 operation 关闭。
      this.#assertWorkerAlive(worker);
      this.#recordDesiredFullAccess(worker.threadId, worker.fullAccessEnabled);
      this.#provisionalWorkers.set(worker.threadId, { worker, closeTimer: null });
      operation.worker = null;
      operation.ownsWorker = false;
      operation.countsCapacity = false;
      // Worker 创建完成到浏览器 attach 之间也可能断线。先按无人持有处理；
      // 正常的 attach 会在同一轮微任务中取消这个计时器。
      this.#armProvisionalClose(worker.threadId);
      return {
        loadState: "ready",
        opened: worker.opened,
        activeTaskId: null,
        controlsActiveTask: false,
        replayEvents: [],
        ...(gate.notice ? { notice: gate.notice } : {}),
      };
    } finally {
      await this.#finishWorkerOperation(operation);
    }
  }

  async resumeSession(projectId: string, threadId: string): Promise<ManagedSessionOpen> {
    this.#assertOpen();
    this.#assertKnownThreadProject(projectId, threadId);
    const active = this.#workers.get(threadId);
    if (active) {
      return this.#managedOpen(active.worker.opened, active.worker.fullAccessEnabled);
    }
    const provisional = this.#provisionalWorkers.get(threadId);
    if (provisional) {
      return this.#managedOpen(provisional.worker.opened, provisional.worker.fullAccessEnabled);
    }
    const pending = this.#store.pendingForThread(threadId);
    if (pending) {
      return {
        loadState: this.#launching.has(threadId) ? "starting" : "queued",
        projectId: pending.projectId,
        sessionId: threadId,
        activeTaskId: pending.id,
        controlsActiveTask: true,
      };
    }
    return this.#withTransientWorker(projectId, threadId, async (worker, notice) => {
      this.metrics.seed(threadId, worker.opened.turns);
      return {
        ...this.#managedOpen(worker.opened, worker.fullAccessEnabled),
        ...(notice ? { notice } : {}),
      };
    });
  }

  enqueueMessage(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    text: string,
    preparedAttachments: PreparedTaskAttachments | null = null,
  ): Promise<{
    accepted: true;
    taskId: string;
    status: WorkerTask["status"];
    duplicate: boolean;
  }> {
    return this.#enqueue(
      projectId,
      threadId,
      clientMessageId,
      "message",
      text,
      preparedAttachments,
    );
  }

  enqueueCommandTask(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    kind: Extract<WorkerTaskKind, "compact">,
  ): Promise<{
    accepted: true;
    taskId: string;
    status: WorkerTask["status"];
    duplicate: boolean;
  }> {
    return this.#enqueue(projectId, threadId, clientMessageId, kind, "");
  }

  async stopTask(threadId: string): Promise<{ requested: boolean; reason?: string }> {
    if (this.#workers.get(threadId)?.compactIssued) {
      return { requested: false, reason: "compact_started" };
    }

    const launching = this.#launching.get(threadId);
    if (launching) {
      launching.cancelRequested = true;
      const active = this.#workers.get(threadId);
      if (active) active.interruptionReason = "user_requested";
      const worker = active?.worker ?? launching.worker;
      if (worker) {
        worker.approvals.cancelThread(threadId);
        worker.interactions.cancelThread(threadId);
        const requested = await worker.turns.interruptActiveTurn();
        if (requested) return { requested: true };
      }
      return { requested: true };
    }

    const active = this.#workers.get(threadId);
    if (active) {
      active.interruptionReason = "user_requested";
      active.worker.approvals.cancelThread(threadId);
      active.worker.interactions.cancelThread(threadId);
      return { requested: await active.worker.turns.interruptActiveTurn() };
    }

    const pending = this.#store.pendingForThread(threadId);
    if (pending?.status === "queued") {
      const stored = this.#store.tryFinish(
        pending.id,
        ["queued"],
        "interrupted",
        this.#interruptedEvent(pending),
        this.#now(),
        { interruptionReason: "user_requested" },
      );
      if (stored) {
        this.#emit(stored, "session");
        await this.#releaseTaskAttachmentLease(pending.id);
        this.#schedule();
        return { requested: true };
      }
      if (this.#launching.has(threadId) || this.#workers.has(threadId)) {
        return this.stopTask(threadId);
      }
    }
    return { requested: false };
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
    targetTurnId: string | null,
  ): Promise<Record<string, unknown>> {
    if (command === "compact") {
      const queued = await this.enqueueCommandTask(
        projectId,
        threadId,
        clientMessageId,
        command,
      );
      return {
        kind: "task",
        title: "正在压缩会话",
        lines: ["任务已由后端接收，可以关闭页面。"],
        ...queued,
      };
    }

    if (command === "rewind") {
      if (!targetTurnId) {
        throw new WorkerManagerError(
          "rewind_target_required",
          "页面没有提供要回退的轮次，请重新载入会话后再试。",
        );
      }
      return this.#withIdleWorker(projectId, threadId, async (worker) => {
        const outcome = await worker.commands.rewind(targetTurnId);
        if (outcome === "stale") {
          return {
            kind: "rewind",
            outcome,
            targetTurnId,
            title: "没有执行回退",
            lines: ["会话在确认后已经发生变化；为避免删除另一轮，后端没有修改历史。"],
          };
        }
        return {
          kind: "rewind",
          outcome,
          targetTurnId,
          title: "已回退一轮",
          lines: [
            outcome === "already_reverted"
              ? "目标轮次已经不在当前会话中；没有再次回退。"
              : "指定的一轮已从当前会话的对话上下文中移除。",
            "这一轮已经造成的文件改动仍然保留。",
          ],
        };
      });
    }

    return this.#withIdleWorker(projectId, threadId, async (worker) => {
      let result;
      if (command === "model") {
        if (!option) throw new WorkerManagerError("command_option_required", "请先选择一个模型。");
        result = await worker.commands.setModel(option, argument);
      } else if (command === "permissions") {
        if (!option) throw new WorkerManagerError("command_option_required", "请先选择一种权限。");
        result = await worker.commands.setPermissions(option);
      } else if (command === "rename") {
        if (!argument) {
          throw new WorkerManagerError(
            "command_argument_required",
            "请在 /rename 后面写一个会话名称。",
          );
        }
        result = await worker.commands.rename(argument);
      } else {
        throw new WorkerManagerError("unknown_command", "不支持这个斜杠命令。");
      }

      this.#assertOpen();
      if (typeof result.fullAccessEnabled === "boolean") {
        this.#recordDesiredFullAccess(threadId, result.fullAccessEnabled);
        const browserResult: Record<string, unknown> = { ...result };
        delete browserResult.fullAccessEnabled;
        return browserResult;
      }
      return result;
    });
  }

  answerApproval(
    approvalId: string,
    decision: "approve_once" | "decline",
  ): { answered: true } {
    for (const active of this.#workers.values()) {
      const approval = active.worker.approvals
        .pendingForThread(active.task.threadId)
        .find((candidate) => candidate.id === approvalId);
      if (!approval) continue;
      if (decision === "approve_once" && !approvalCanBeShownSafely(approval)) {
        throw new WorkerManagerError(
          "approval_scope_unavailable",
          "这项审批的完整范围无法在网页中安全显示，只能拒绝。",
        );
      }
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

  attachSession(clientId: string, projectId: string, threadId: string): void {
    this.#assertKnownThreadProject(projectId, threadId);
    this.detachSession(clientId);
    // WebSocket 断开时在线登记会立即删除；较晚完成的请求不能重新占住会话。
    if (!this.#authenticatedClients.has(clientId)) return;
    this.#clientSessions.set(clientId, threadId);
    const provisional = this.#provisionalWorkers.get(threadId);
    if (provisional?.closeTimer) clearTimeout(provisional.closeTimer);
    if (provisional) provisional.closeTimer = null;
  }

  detachSession(clientId: string): void {
    const threadId = this.#clientSessions.get(clientId);
    if (!threadId) return;
    this.#clientSessions.delete(clientId);
    this.#armProvisionalClose(threadId);
  }

  #armProvisionalClose(threadId: string): void {
    const provisional = this.#provisionalWorkers.get(threadId);
    if (!provisional || this.#sessionAttached(threadId) || provisional.closeTimer) return;
    provisional.closeTimer = setTimeout(() => {
      provisional.closeTimer = null;
      if (!this.#sessionAttached(threadId)) {
        void this.#closeProvisional(threadId, provisional.worker);
      }
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
    if (this.#attachmentLeaseTimer) clearInterval(this.#attachmentLeaseTimer);
    for (const controller of this.#workerStartControllers) controller.abort();
    for (const launching of this.#launching.values()) {
      launching.cancelRequested = true;
    }
    const operations = [...this.#workerOperations];
    const operationWorkers = new Set(
      operations.flatMap((operation) => operation.worker ? [operation.worker] : []),
    );
    await Promise.all(operations.map((operation) =>
      this.#closeOperationWorker(operation)
    ));
    await Promise.all([
      this.#scheduleTail.catch(() => {}),
      ...operations.map((operation) => operation.done),
      ...this.#threadOperationTails.values(),
    ]);
    await Promise.all([...this.#workers.values()].map(async (active) => {
      this.#clearStartTimer(active);
      active.interruptionReason = "backend_stopping";
      active.worker.approvals.cancelThread(active.worker.threadId);
      active.worker.interactions.cancelThread(active.worker.threadId);
      await active.worker.turns.interruptActiveTurn().catch(() => false);
      await this.#closeWorker(active.worker).catch(() => {});
      this.#locks.release(active.task.projectId, active.ownerId);
    }));
    await Promise.all([...this.#provisionalWorkers.values()].map(async (provisional) => {
      if (provisional.closeTimer) clearTimeout(provisional.closeTimer);
      if (!operationWorkers.has(provisional.worker)) {
        await this.#closeWorker(provisional.worker).catch(() => {});
      }
    }));
    // 终态清理、空会话回收和意外退出的收尾可能已离开可查 map；它们只在这里仍有持有者。
    while (this.#closingWork.size > 0) {
      await Promise.all(this.#closingWork);
    }
    this.#workers.clear();
    this.#launching.clear();
    this.#provisionalWorkers.clear();
    await Promise.all([...this.#attachmentLeases.entries()].map(([taskId, lease]) =>
      this.#releaseAttachmentLease(taskId, lease)
    ));
    this.#pathRedactors.clear();
    await this.#attachmentIndex?.drain();
    this.#listeners.clear();
  }

  #enqueue(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    kind: WorkerTaskKind,
    payload: string,
    preparedAttachments: PreparedTaskAttachments | null = null,
  ): Promise<{
    accepted: true;
    taskId: string;
    status: WorkerTask["status"];
    duplicate: boolean;
  }> {
    return this.#serializeThreadOperation(threadId, async () =>
      this.#enqueueUnlocked(
        projectId,
        threadId,
        clientMessageId,
        kind,
        payload,
        preparedAttachments,
      ));
  }

  #enqueueUnlocked(
    projectId: string,
    threadId: string,
    clientMessageId: string,
    kind: WorkerTaskKind,
    payload: string,
    preparedAttachments: PreparedTaskAttachments | null = null,
  ): { accepted: true; taskId: string; status: WorkerTask["status"]; duplicate: boolean } {
    if (this.#closed) throw new WorkerManagerError("worker_manager_closed", "后端正在停止。");
    this.#assertKnownThreadProject(projectId, threadId);
    const createdAtMs = this.#now();
    const permissionMode: WorkerPermissionMode = this.#knownDesiredFullAccess(threadId)
      ? "full_access"
      : "manual";
    let result;
    try {
      result = this.#store.admit({
        id: preparedAttachments?.taskId ?? randomUUID(),
        clientMessageId,
        projectId,
        threadId,
        kind,
        payload,
        attachments: preparedAttachments?.lease.attachments.map(publicAttachment) ?? [],
        permissionMode,
        createdAtMs,
      });
    } catch (error) {
      if (preparedAttachments) {
        void this.#releaseAttachmentLease(preparedAttachments.taskId, preparedAttachments.lease);
      }
      throw error;
    }
    if (result.outcome === "task_already_running" || result.outcome === "project_busy") {
      if (preparedAttachments) {
        void this.#releaseAttachmentLease(preparedAttachments.taskId, preparedAttachments.lease);
      }
      throw new WorkerManagerError(
        result.outcome,
        result.outcome === "task_already_running"
          ? "这个会话已有任务正在运行。"
          : "这个项目已有另一个任务正在运行。",
      );
    }
    if (preparedAttachments) {
      if (result.outcome === "duplicate") {
        void this.#releaseAttachmentLease(preparedAttachments.taskId, preparedAttachments.lease);
      } else {
        this.#attachmentLeases.set(result.task.id, preparedAttachments.lease);
      }
    }
    if (result.outcome === "accepted") {
      const stored = this.#store.appendEvent(result.task.id, threadId, {
        type: "task.queued",
        sessionId: threadId,
        taskId: result.task.id,
        status: "queued",
        ...(kind === "message"
          ? { text: payload, attachments: result.task.attachments }
          : { command: kind }),
      }, createdAtMs);
      this.#emit(stored, "session");
      this.#schedule();
    }
    return {
      accepted: true,
      taskId: result.task.id,
      status: result.task.status,
      duplicate: result.outcome === "duplicate",
    };
  }

  #managedOpen(opened: OpenedSession, fullAccessEnabled: boolean): ManagedSessionReady {
    this.#initializeDesiredFullAccess(opened.session.id, fullAccessEnabled);
    const pending = this.#store.pendingForThread(opened.session.id);
    const replayTask = pending ?? terminalReplayTask(this.#store.latestForThread(opened.session.id));
    return {
      loadState: "ready",
      opened,
      activeTaskId: pending?.id ?? null,
      controlsActiveTask: pending !== null,
      replayEvents: replayTask ? this.#store.eventsForTask(replayTask.id) : [],
    };
  }

  async #withTransientWorker<Result>(
    projectId: string,
    threadId: string | undefined,
    operation: (worker: SessionWorker, notice: string | null) => Promise<Result> | Result,
  ): Promise<Result> {
    this.#assertOpen();
    if (threadId) {
      return this.#serializeThreadOperation(threadId, () =>
        this.#withTransientWorkerUnlocked(projectId, threadId, operation));
    }
    return this.#withTransientWorkerUnlocked(projectId, threadId, operation);
  }

  async #withTransientWorkerUnlocked<Result>(
    projectId: string,
    threadId: string | undefined,
    operation: (worker: SessionWorker, notice: string | null) => Promise<Result> | Result,
  ): Promise<Result> {
    this.#assertOpen();
    if (threadId) this.#assertKnownThreadProject(projectId, threadId);
    if (threadId && this.#workers.has(threadId)) {
      throw new WorkerManagerError("task_already_running", "这个会话已有任务正在运行。");
    }
    const provisional = threadId ? this.#provisionalWorkers.get(threadId) : null;
    if (provisional) {
      const scope = this.#beginWorkerOperation(false);
      scope.worker = provisional.worker;
      try {
        const result = await operation(provisional.worker, null);
        this.#assertOpen();
        return result;
      } finally {
        await this.#finishWorkerOperation(scope);
      }
    }
    if (this.#workerCount() >= this.#maxWorkers) {
      throw new WorkerManagerError("worker_capacity", "活动 Worker 已达到上限，请稍后再试。");
    }
    const scope = this.#beginWorkerOperation(true);
    try {
      const gate = await this.#memoryGate();
      if (gate.blocked) {
        throw new WorkerManagerError(
          "worker_memory_low",
          memoryLowMessage("暂时不能打开新 Worker。", gate.blocked, this.#minAvailableMemoryBytes),
        );
      }
      const worker = await this.#createWorker(projectId, threadId);
      scope.worker = worker;
      scope.ownsWorker = true;
      this.#assertOpen();
      await this.#reconcileFullAccess(
        worker,
        threadId ? this.#knownDesiredFullAccess(threadId) : undefined,
      );
      const result = await operation(worker, gate.notice);
      this.#assertOpen();
      return result;
    } finally {
      await this.#finishWorkerOperation(scope);
    }
  }

  #beginWorkerOperation(countsCapacity: boolean): WorkerOperation {
    this.#assertOpen();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const operation: WorkerOperation = {
      worker: null,
      ownsWorker: false,
      countsCapacity,
      closeRequested: false,
      done,
      resolveDone,
    };
    this.#workerOperations.add(operation);
    return operation;
  }

  async #finishWorkerOperation(operation: WorkerOperation): Promise<void> {
    if (operation.ownsWorker) await this.#closeOperationWorker(operation);
    if (this.#workerOperations.delete(operation)) operation.resolveDone();
    this.#schedule();
  }

  async #closeOperationWorker(operation: WorkerOperation): Promise<void> {
    if (!operation.worker || operation.closeRequested) return;
    operation.closeRequested = true;
    await this.#closeWorker(operation.worker).catch(() => {});
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkerManagerError("worker_manager_closed", "后端正在停止。");
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
    return this.#serializeThreadOperation(threadId, () => {
      this.#assertKnownThreadProject(projectId, threadId);
      if (this.#store.pendingForThread(threadId)) {
        throw new WorkerManagerError(
          "task_already_running",
          "这个会话有已接受或正在执行的任务。",
        );
      }
      return this.#withTransientWorkerUnlocked(projectId, threadId, operation);
    });
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
      if (this.#launching.has(task.threadId)) continue;
      if (this.#workers.has(task.threadId)) continue;
      const provisional = this.#provisionalWorkers.has(task.threadId);
      if (this.#workerCount() - (provisional ? 1 : 0) >= this.#maxWorkers) {
        capacityBlocked = true;
        break;
      }
      const ownerId = `worker:${task.threadId}`;
      if (!this.#locks.acquire(task.projectId, ownerId, task.threadId)) continue;
      const launching = this.#beginLaunch(task, ownerId);
      try {
        if (!provisional && (await this.#memoryGate()).blocked) {
          if (launching.cancelRequested) {
            await this.#abandonLaunch(launching);
          } else {
            this.#locks.release(task.projectId, ownerId);
          }
          capacityBlocked = true;
          break;
        }
        if (launching.cancelRequested) {
          await this.#abandonLaunch(launching);
          continue;
        }
        const starting = this.#store.appendEvent(task.id, task.threadId, {
          type: "task.starting",
          sessionId: task.threadId,
          taskId: task.id,
          status: "queued",
        }, this.#now());
        this.#emit(starting, "session");
        await this.#startQueuedTask(launching);
      } finally {
        this.#endLaunch(launching);
      }
    }
    if (capacityBlocked || this.#store.queued().length > 0) this.#armQueueRetry();
  }

  async #startQueuedTask(launching: LaunchingTask): Promise<void> {
    const task = launching.task;
    const ownerId = launching.ownerId;
    let worker: SessionWorker | null = null;
    let workerReserved = false;
    try {
      if (!this.#locks.matches(task.projectId, ownerId, task.threadId)) {
        throw new WorkerManagerError(
          "project_lock_mismatch",
          "任务的项目锁身份不一致，Worker 没有启动。",
        );
      }
      if (launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }
      const attachments = await this.#ensureTaskAttachments(task);
      if (launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }
      await this.#registerTaskAttachments(task.threadId, task.clientMessageId, attachments);
      if (launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }
      const provisional = this.#provisionalWorkers.get(task.threadId);
      if (provisional) {
        this.#assertWorkerIdentity(task.projectId, task.threadId, provisional.worker);
      }
      if (provisional?.closeTimer) clearTimeout(provisional.closeTimer);
      if (provisional) this.#provisionalWorkers.delete(task.threadId);
      if (provisional) {
        worker = provisional.worker;
      } else {
        this.#workerReservations += 1;
        workerReserved = true;
        worker = await this.#createWorker(task.projectId, task.threadId);
      }
      launching.worker = worker;
      if (workerReserved) {
        this.#workerReservations -= 1;
        workerReserved = false;
      }
      if (launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }
      const permissionMode = task.permissionMode;
      await this.#reconcileFullAccess(worker, permissionMode === "full_access");
      if (launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }
      this.#assertWorkerAlive(worker);
      const marked = this.#store.tryMarkRunning(task.id, null, permissionMode, this.#now());
      if (!marked) {
        await this.#abandonLaunch(launching);
        return;
      }
      const active: ActiveWorker = {
        task: marked,
        worker,
        ownerId,
        finishing: false,
        cleaned: false,
        interruptionReason: launching.cancelRequested ? "user_requested" : null,
        startTimer: null,
        compactIssued: false,
      };
      this.#workers.set(task.threadId, active);
      this.#applyAttachmentMappings(task.threadId, this.peekAttachmentMappings(task.threadId));
      active.startTimer = setTimeout(() => {
        if (!active.worker.turns.activeTurnId && !active.finishing) {
          void this.#finishWithoutTurn(active);
        }
      }, this.#taskStartTimeoutMs);
      active.startTimer.unref();

      if (launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }

      let startPromise: Promise<string | null>;
      if (task.kind === "message") {
        startPromise = worker.turns.startTextTurn(task.payload, attachments);
      } else {
        // 打断一轮压缩会给会话上下文留下什么，Codex 没有给出保证，所以指令一旦
        // 发出就不再停。标记必须在请求之前落下，中间不能有 await，否则会出现
        // “指令已发但仍被当成可取消”的缝。
        active.compactIssued = true;
        startPromise = worker.commands.compact();
      }
      if (task.kind === "message" && launching.cancelRequested) {
        active.interruptionReason = "user_requested";
        active.worker.approvals.cancelThread(task.threadId);
        active.worker.interactions.cancelThread(task.threadId);
        await worker.turns.interruptActiveTurn().catch(() => false);
      }
      const nativeTurnId = await startPromise;
      if (launching.cancelRequested && !worker.turns.activeTurnId) {
        await this.#abandonLaunch(launching);
        return;
      }
      if (nativeTurnId && this.#workers.get(task.threadId) === active) {
        this.#store.setNativeTurnId(task.id, nativeTurnId, this.#now());
      }
    } catch (error) {
      if (workerReserved) this.#workerReservations -= 1;
      if (error instanceof CodexTurnCancelledError || launching.cancelRequested) {
        await this.#abandonLaunch(launching);
        return;
      }
      const active = this.#workers.get(task.threadId);
      if (worker && active?.worker === worker) {
        await this.#failActive(active, error);
      } else {
        const event = this.#store.tryFinish(task.id, [
          "queued",
          "running",
          "waiting_for_permission",
        ], "failed", {
          type: "task.completed",
          sessionId: task.threadId,
          taskId: task.id,
          status: "failed",
          error: (error instanceof WorkerManagerError && (
            error.code === "permission_restore_failed" || error.code === "worker_start_timeout"
          )) ||
              error instanceof CodexAttachmentError
            ? error.message
            : "Worker 无法启动，请查看服务日志。",
        }, this.#now(), { error: errorMessage(error) });
        if (event) this.#emit(event, "session");
        if (worker) await this.#closeWorker(worker).catch(() => {});
        this.#locks.release(task.projectId, ownerId);
        await this.#releaseTaskAttachmentLease(task.id);
      }
    }
  }

  async #createWorker(projectId: string, threadId?: string): Promise<SessionWorker> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#workerStartTimeoutMs);
    timer.unref();
    this.#workerStartControllers.add(controller);
    try {
      const worker = await this.#workerFactory({
        projectId,
        projects: this.#projects,
        trash: this.#trash,
        startupSignal: controller.signal,
        ...(threadId ? { threadId } : {}),
        ...(this.#codexBinary ? { codexBinary: this.#codexBinary } : {}),
        ...(this.#workingDirectory ? { workingDirectory: this.#workingDirectory } : {}),
        ...(this.#settings ? { settings: this.#settings } : {}),
        onMetricsNotification: (message) => this.metrics.observe(message),
        onStreamEvent: (event) => this.#handleStreamEvent(event),
        onApprovalEvent: (event) => this.#handleApprovalEvent(event),
        onInteractionEvent: (event) => this.#handleInteractionEvent(event),
        onUnexpectedExit: (exited, error) => this.#handleUnexpectedExit(exited, error),
      });
      try {
        this.#assertWorkerIdentity(projectId, threadId ?? worker.threadId, worker);
      } catch (error) {
        await this.#closeWorker(worker).catch(() => {});
        throw error;
      }
      return worker;
    } catch (error) {
      if (timedOut) {
        throw new WorkerManagerError(
          "worker_start_timeout",
          "Codex Worker 启动超时，任务没有开始。请重试。",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.#workerStartControllers.delete(controller);
    }
  }

  #handleStreamEvent(event: CodexStreamEvent): void {
    const active = this.#workers.get(event.threadId);
    if (!active || active.finishing) return;
    if (event.type === "turn_started") {
      this.#clearStartTimer(active);
      this.#store.setNativeTurnId(active.task.id, event.turnId, this.#now());
    }

    const browserEvent = this.#browserStreamEvent(active, event);
    if (!browserEvent) return;
    if (event.type === "turn_completed") {
      active.finishing = true;
      this.#cancelPendingRequests(active);
      const status = event.status === "interrupted"
        ? "interrupted"
        : event.status === "failed"
        ? "failed"
        : "completed";
      const stored = this.#store.tryFinish(active.task.id, [
        "queued",
        "running",
        "waiting_for_permission",
      ], status, {
        ...browserEvent,
        interruptionReason: active.interruptionReason,
      }, this.#now(), {
        error: event.error,
        interruptionReason: active.interruptionReason,
      });
      if (stored) this.#emit(stored, "session");
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
        sourceSession: publicSourceSession(active),
        approval: publicApproval(event.approval, this.peekAttachmentMappings(active.task.threadId)),
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
        sourceSession: publicSourceSession(active),
        interaction: publicInteraction(
          event.interaction,
          this.peekAttachmentMappings(active.task.threadId),
        ),
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
    for (const active of this.#workers.values()) {
      // 每一路开始前都要重新确认没人在线：处理上一路时有真实的等待，客户端
      // 可能已经重连上来了，后面这些轮次不该再按“没人接”处理。
      if (this.#authenticatedClients.size > 0) return;
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
    this.#cancelPendingRequests(active);
    const status = active.interruptionReason === "user_requested"
      ? "interrupted"
      : active.task.kind === "message"
      ? "failed"
      : "completed";
    const error = status === "failed"
      ? "Codex 没有开始处理这条消息，请重试。"
      : null;
    const stored = this.#store.tryFinish(active.task.id, [
      "queued",
      "running",
      "waiting_for_permission",
    ], status, {
      type: "task.completed",
      sessionId: active.task.threadId,
      taskId: active.task.id,
      status,
      error,
      interruptionReason: active.interruptionReason,
    }, this.#now(), {
      error,
      interruptionReason: active.interruptionReason,
    });
    if (stored) this.#emit(stored, "session");
    await this.#cleanupActive(active);
  }

  async #failActive(active: ActiveWorker, error: unknown): Promise<void> {
    if (active.finishing) return;
    active.finishing = true;
    console.error(`会话 Worker ${active.task.threadId} 失败：${errorMessage(error)}`);
    this.#cancelPendingRequests(active);
    const stored = this.#store.tryFinish(active.task.id, [
      "queued",
      "running",
      "waiting_for_permission",
    ], "failed", {
      type: "task.completed",
      sessionId: active.task.threadId,
      taskId: active.task.id,
      status: "failed",
      error: "会话 Worker 异常结束，请查看服务日志。",
    }, this.#now(), { error: errorMessage(error) });
    if (stored) this.#emit(stored, "session");
    await this.#cleanupActive(active);
  }

  async #cleanupActive(active: ActiveWorker): Promise<void> {
    this.#clearStartTimer(active);
    if (active.cleaned) return;
    active.cleaned = true;
    await this.#holdClosing((async () => {
      try {
        await this.#closeWorker(active.worker);
      } catch (error) {
        console.error(`关闭会话 Worker 失败：${errorMessage(error)}`);
      } finally {
        // close() 会同步取消 broker 中的待答项。保留 active 映射到这里，Manager
        // 才能把对应 resolved 事件广播给所有设备。
        if (this.#workers.get(active.task.threadId) === active) {
          this.#workers.delete(active.task.threadId);
        }
        await this.#releaseTaskAttachmentLease(active.task.id);
        this.#locks.release(active.task.projectId, active.ownerId);
        this.#schedule();
      }
    })());
  }

  #cancelPendingRequests(active: ActiveWorker): void {
    try {
      active.worker.approvals.cancelThread(active.task.threadId);
    } catch (error) {
      console.error(`取消会话审批失败：${errorMessage(error)}`);
    }
    try {
      active.worker.interactions.cancelThread(active.task.threadId);
    } catch (error) {
      console.error(`取消会话交互失败：${errorMessage(error)}`);
    }
  }

  #assertProjectAccepts(projectId: string, threadId: string): void {
    const pending = this.#store.pendingForProject(projectId);
    if (!pending) return;
    if (pending.threadId === threadId) {
      throw new WorkerManagerError("task_already_running", "这个会话已有任务正在运行。");
    }
    throw new WorkerManagerError("project_busy", "这个项目已有另一个任务正在运行。");
  }

  #assertKnownThreadProject(projectId: string, threadId: string): void {
    const active = this.#workers.get(threadId);
    const launching = this.#launching.get(threadId);
    const provisional = this.#provisionalWorkers.get(threadId);
    const pending = this.#store.pendingForThread(threadId);
    const knownProjectIds = [
      active?.task.projectId,
      active?.worker.opened.session.projectId,
      launching?.task.projectId,
      launching?.worker?.opened.session.projectId,
      provisional?.worker.opened.session.projectId,
      pending?.projectId,
    ].filter((candidate): candidate is string => typeof candidate === "string");
    if (knownProjectIds.some((candidate) => candidate !== projectId)) {
      throw new WorkerManagerError("session_project_mismatch", SESSION_PROJECT_MISMATCH_MESSAGE);
    }
  }

  #assertWorkerIdentity(
    projectId: string,
    threadId: string,
    worker: SessionWorker,
  ): void {
    if (
      worker.opened.session.projectId !== projectId ||
      worker.opened.session.id !== threadId ||
      worker.threadId !== threadId
    ) {
      throw new WorkerManagerError("session_project_mismatch", SESSION_PROJECT_MISMATCH_MESSAGE);
    }
  }

  #beginLaunch(task: WorkerTask, ownerId: string): LaunchingTask {
    const launching: LaunchingTask = {
      task,
      ownerId,
      worker: null,
      cancelRequested: false,
      settled: false,
    };
    this.#launching.set(task.threadId, launching);
    return launching;
  }

  #endLaunch(launching: LaunchingTask): void {
    if (this.#launching.get(launching.task.threadId) === launching) {
      this.#launching.delete(launching.task.threadId);
    }
  }

  async #abandonLaunch(launching: LaunchingTask): Promise<void> {
    if (launching.settled) return;
    launching.settled = true;
    const task = launching.task;
    const active = this.#workers.get(task.threadId);
    if (active && active.ownerId === launching.ownerId) {
      if (!active.finishing) {
        active.interruptionReason = "user_requested";
        active.finishing = true;
        this.#cancelPendingRequests(active);
        const stored = this.#store.tryFinish(
          task.id,
          ["queued", "running", "waiting_for_permission"],
          "interrupted",
          this.#interruptedEvent(task),
          this.#now(),
          { interruptionReason: "user_requested" },
        );
        if (stored) this.#emit(stored, "session");
        await this.#cleanupActive(active);
      }
      return;
    }
    const stored = this.#store.tryFinish(
      task.id,
      ["queued", "running", "waiting_for_permission"],
      "interrupted",
      this.#interruptedEvent(task),
      this.#now(),
      { interruptionReason: "user_requested" },
    );
    if (stored) this.#emit(stored, "session");
    if (launching.worker) {
      await this.#closeWorker(launching.worker).catch((error: unknown) => {
        console.error(`关闭启动中的会话 Worker 失败：${errorMessage(error)}`);
      });
    }
    this.#locks.release(task.projectId, launching.ownerId);
    await this.#releaseTaskAttachmentLease(task.id);
    this.#schedule();
  }

  #interruptedEvent(task: WorkerTask): Record<string, unknown> & { type: string } {
    return {
      type: "task.completed",
      sessionId: task.threadId,
      taskId: task.id,
      status: "interrupted",
      error: null,
      interruptionReason: "user_requested",
    };
  }

  #clearStartTimer(active: ActiveWorker): void {
    if (active.startTimer) clearTimeout(active.startTimer);
    active.startTimer = null;
  }

  async #ensureTaskAttachments(task: WorkerTask): Promise<ResolvedAttachment[]> {
    if (task.attachments.length === 0) return [];
    if (!this.#uploads) {
      throw new WorkerManagerError("uploads_unavailable", "附件服务没有启用，任务无法启动。");
    }
    const existing = this.#attachmentLeases.get(task.id);
    if (existing && existing.expiresAtMs > this.#now() + ATTACHMENT_LEASE_RENEW_MARGIN_MS) {
      return existing.attachments;
    }
    if (existing) {
      try {
        const renewed = await this.#uploads.renewLease(existing.leaseId, existing.ownerId);
        existing.expiresAtMs = renewed.expiresAtMs;
        return existing.attachments;
      } catch {
        this.#attachmentLeases.delete(task.id);
      }
    }
    try {
      const lease = await this.#uploads.createLease(
        { caller: "codex", projectId: task.projectId, sessionId: task.threadId },
        task.id,
        task.attachments.map((attachment) => attachment.id),
      );
      this.#attachmentLeases.set(task.id, lease);
      return lease.attachments;
    } catch (error) {
      throw uploadManagerError(error);
    }
  }

  async #renewAttachmentLeases(): Promise<void> {
    if (!this.#uploads || this.#closed) return;
    for (const [taskId, lease] of this.#attachmentLeases) {
      try {
        const renewed = await this.#uploads.renewLease(lease.leaseId, lease.ownerId);
        lease.expiresAtMs = renewed.expiresAtMs;
      } catch (error) {
        console.error(`附件租约 ${taskId} 续期失败：${errorMessage(error)}`);
      }
    }
  }

  async #releaseTaskAttachmentLease(taskId: string): Promise<void> {
    const lease = this.#attachmentLeases.get(taskId);
    if (!lease) return;
    await this.#releaseAttachmentLease(taskId, lease);
  }

  async #releaseAttachmentLease(taskId: string, lease: AttachmentLease): Promise<void> {
    if (this.#attachmentLeases.get(taskId) === lease) {
      this.#attachmentLeases.delete(taskId);
    }
    await this.#uploads?.releaseLease(lease.leaseId, lease.ownerId).catch((error: unknown) => {
      console.error(`释放附件租约 ${taskId} 失败：${errorMessage(error)}`);
    });
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

  #knownDesiredFullAccess(threadId: string): boolean | undefined {
    if (this.#sessionDesiredFullAccess.has(threadId)) {
      return this.#sessionDesiredFullAccess.get(threadId);
    }
    const persisted = this.#store.sessionDesiredFullAccess(threadId);
    if (persisted !== null) {
      this.#sessionDesiredFullAccess.set(threadId, persisted);
    }
    return persisted ?? undefined;
  }

  #recordDesiredFullAccess(threadId: string, enabled: boolean): boolean {
    this.#sessionDesiredFullAccess.set(threadId, enabled);
    this.#store.setSessionDesiredFullAccess(threadId, enabled, this.#now());
    return enabled;
  }

  #initializeDesiredFullAccess(threadId: string, enabled: boolean): boolean {
    const known = this.#knownDesiredFullAccess(threadId);
    return known ?? this.#recordDesiredFullAccess(threadId, enabled);
  }

  async #reconcileFullAccess(
    worker: SessionWorker,
    target: boolean | undefined,
  ): Promise<boolean> {
    let enabled = worker.fullAccessEnabled;
    if (target !== undefined && enabled !== target) {
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
      if (enabled !== target) {
        throw new WorkerManagerError(
          "permission_restore_failed",
          `无法把会话权限恢复为${target ? " Full access" : "普通权限"}，任务没有启动。`,
        );
      }
    }
    this.#assertOpen();
    // 这里只恢复已经接受任务的 effective 权限。它可能是旧快照，不能反写并
    // 覆盖用户后来确认的会话 desired setting。
    return enabled;
  }

  #workerCount(): number {
    const operationWorkers = [...this.#workerOperations].filter((operation) =>
      operation.countsCapacity
    ).length;
    return this.#workers.size + this.#provisionalWorkers.size + operationWorkers +
      this.#workerReservations;
  }

  #sessionAttached(threadId: string): boolean {
    return [...this.#clientSessions.values()].includes(threadId);
  }

  /** 所有 Worker 关闭都经过这里登记，删 map 后的收尾仍由 Manager 持有到结束。 */
  #closeWorker(worker: SessionWorker): Promise<void> {
    return this.#holdClosing(worker.close());
  }

  #holdClosing(work: Promise<void>): Promise<void> {
    const held = work.then(() => {}, () => {});
    this.#closingWork.add(held);
    void held.then(() => this.#closingWork.delete(held));
    return work;
  }

  /** 意外退出只作用于该实例此刻仍担任的角色；其余阶段由当时的所有者在 RPC 失败或发布前处理。 */
  #handleUnexpectedExit(worker: SessionWorker, error: Error): void {
    const threadId = worker.threadId;
    const active = this.#workers.get(threadId);
    if (active?.worker === worker) {
      void this.#failActive(active, error);
      return;
    }
    if (this.#provisionalWorkers.get(threadId)?.worker === worker) {
      console.error(`空会话 Worker ${threadId} 意外退出：${errorMessage(error)}`);
      void this.#closeProvisional(threadId, worker);
    }
  }

  #assertWorkerAlive(worker: SessionWorker): void {
    if (worker.exited) {
      throw new WorkerManagerError(
        "worker_exited",
        "会话 Worker 启动后已退出，请重试。",
      );
    }
  }

  async #closeProvisional(threadId: string, worker: SessionWorker): Promise<void> {
    const provisional = this.#provisionalWorkers.get(threadId);
    if (provisional?.worker !== worker) return;
    if (provisional.closeTimer) clearTimeout(provisional.closeTimer);
    this.#provisionalWorkers.delete(threadId);
    await this.#holdClosing((async () => {
      await this.#closeWorker(worker).catch((error: unknown) => {
        console.error(`关闭空会话 Worker 失败：${errorMessage(error)}`);
      });
      this.#sessionDesiredFullAccess.delete(threadId);
      this.#schedule();
    })());
  }

  async #registerPreparedAttachments(
    threadId: string,
    messageId: string,
    prepared: PreparedTaskAttachments | null,
  ): Promise<void> {
    await this.#registerTaskAttachments(
      threadId,
      messageId,
      prepared?.lease.attachments ?? [],
    );
  }

  async #registerTaskAttachments(
    threadId: string,
    messageId: string,
    attachments: readonly ResolvedAttachment[],
  ): Promise<void> {
    if (!this.#attachmentIndex || attachments.length === 0) return;
    await this.#attachmentIndex.register(
      threadId,
      messageId,
      attachments.map((attachment) => ({
        id: attachment.id,
        originalName: attachment.originalName,
        path: attachment.path,
      })),
    );
    this.#applyAttachmentMappings(threadId, this.#attachmentIndex.peek(threadId));
  }

  #applyAttachmentMappings(threadId: string, mappings: readonly AttachmentDisplayMapping[]): void {
    const active = this.#workers.get(threadId);
    active?.worker.turns.setAttachmentMappings(mappings);
    for (const [key, redactor] of this.#pathRedactors) {
      if (key.startsWith(`${threadId}:`)) redactor.setMappings(mappings);
    }
  }

  #browserStreamEvent(
    active: ActiveWorker,
    event: CodexStreamEvent,
  ): (Record<string, unknown> & { type: string }) | null {
    const mappings = this.peekAttachmentMappings(active.task.threadId);
    const converted: Record<string, unknown> & { type: string } = {
      ...toBrowserStreamEvent(event),
      taskId: active.task.id,
      ...(event.type === "user_message_started" && active.task.attachments.length > 0
        ? { attachments: active.task.attachments }
        : {}),
    };
    if (event.type === "user_message_started" && typeof converted.text === "string") {
      converted.text = stripPrivateAttachmentInputs(converted.text);
    }
    if (event.type === "assistant_text_delta" || event.type === "tool_output_delta") {
      const itemId = typeof converted.itemId === "string" ? converted.itemId : event.itemId;
      const kind = event.type === "assistant_text_delta" ? "assistant" : "tool";
      const delta = this.#pathRedactor(active.task.threadId, itemId, kind, mappings)
        .push(typeof converted.delta === "string" ? converted.delta : "");
      if (!delta) return null;
      converted.delta = delta;
      return converted;
    }
    if (event.type === "assistant_text_completed") {
      this.#pathRedactor(active.task.threadId, event.itemId, "assistant", mappings).flush();
    }
    if (event.type === "tool_completed") {
      this.#pathRedactor(active.task.threadId, event.itemId, "tool", mappings).flush();
    }
    if (event.type === "turn_completed" || event.type === "turn_error") {
      this.#clearPathRedactors(active.task.threadId);
    }
    return redactBrowserStreamEvent(converted, mappings);
  }

  #pathRedactor(
    threadId: string,
    itemId: string,
    kind: "assistant" | "tool",
    mappings: readonly AttachmentDisplayMapping[],
  ): AttachmentPathStreamRedactor {
    const key = `${threadId}:${kind}:${itemId}`;
    const existing = this.#pathRedactors.get(key);
    if (existing) return existing;
    const created = new AttachmentPathStreamRedactor(mappings);
    this.#pathRedactors.set(key, created);
    return created;
  }

  #clearPathRedactors(threadId: string): void {
    for (const key of this.#pathRedactors.keys()) {
      if (key.startsWith(`${threadId}:`)) this.#pathRedactors.delete(key);
    }
  }

  /**
   * 启动 Worker 前的内存判断。`blocked` 是拦截用的可信读数，`notice` 是降级放行时
   * 要转给浏览器的说明；两者不会同时出现。
   */
  async #memoryGate(): Promise<{ blocked: MemoryReading | null; notice: string | null }> {
    const reading = await this.#availableMemory();
    if (reading.degradedReason) {
      return {
        blocked: null,
        notice: memoryDegradedMessage(reading, this.#minAvailableMemoryBytes),
      };
    }
    const blocked = reading.availableBytes >= this.#minAvailableMemoryBytes ? null : reading;
    return { blocked, notice: null };
  }
}

function publicApproval(
  approval: ApprovalRequest,
  mappings: readonly AttachmentDisplayMapping[] = [],
): Record<string, unknown> {
  const base = {
    id: approval.id,
    kind: approval.kind,
    reason: publicApprovalText(approval.reason, mappings),
    startedAtMs: approval.startedAtMs,
  };
  if (approval.kind === "command") {
    return {
      ...base,
      commandSummary: publicCommandSummary(approval.command, mappings),
      network: approval.network,
      canApprove: approvalCanBeShownSafely(approval),
    };
  }
  if (approval.kind === "permissions") {
    const summary = publicPermissionSummary(approval.permissions, mappings);
    return {
      ...base,
      permissionSummary: summary.lines,
      canApprove: summary.complete,
    };
  }
  return { ...base, canApprove: true };
}

function publicSourceSession(active: ActiveWorker): { id: string; title: string } {
  return {
    id: active.task.threadId,
    title: active.worker.opened.session.title,
  };
}

function approvalCanBeShownSafely(approval: ApprovalRequest): boolean {
  if (approval.kind === "command") {
    return publicCommandSummary(approval.command, []).length > 0 || approval.network !== null;
  }
  if (approval.kind === "permissions") {
    return publicPermissionSummary(approval.permissions, []).complete;
  }
  return true;
}

function publicApprovalText(
  value: string | null,
  mappings: readonly AttachmentDisplayMapping[],
): string | null {
  if (!value) return null;
  const summary = redactPathBearingTokens(redactKnownAttachmentPaths(value, mappings));
  return clipPublicSummary(summary);
}

function publicCommandSummary(
  value: string | null,
  mappings: readonly AttachmentDisplayMapping[],
): string {
  if (!value?.trim()) return "";
  const summary = redactPathBearingTokens(redactKnownAttachmentPaths(value.trim(), mappings));
  return clipPublicSummary(summary);
}

function redactPathBearingTokens(value: string): string {
  return value.split(/(\s+)/u).map((token) => {
    if (!token || /^\s+$/u.test(token)) return token;
    if (token.includes("/") || token.includes("\\")) return "‹主机路径›";
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(token);
    if (assignment) return `${assignment[1]}=‹值已隐藏›`;
    return token;
  }).join("");
}

function publicPermissionSummary(
  permissions: Record<string, unknown>,
  mappings: readonly AttachmentDisplayMapping[],
): { lines: string[]; complete: boolean } {
  const lines: string[] = [];
  let complete = Object.keys(permissions).every((key) =>
    key === "network" || key === "fileSystem"
  );

  if (permissions.network !== null && permissions.network !== undefined) {
    const network = asObject(permissions.network);
    if (!network || !Object.keys(network).every((key) => key === "enabled")) {
      complete = false;
    } else if (network.enabled === true) {
      lines.push("网络：允许额外网络访问");
    } else if (network.enabled === false) {
      lines.push("网络：不增加网络访问");
    } else {
      complete = false;
    }
  }

  if (permissions.fileSystem !== null && permissions.fileSystem !== undefined) {
    const fileSystem = asObject(permissions.fileSystem);
    if (!fileSystem || !Object.keys(fileSystem).every((key) =>
      key === "read" || key === "write" || key === "entries" || key === "globScanMaxDepth"
    )) {
      complete = false;
    } else {
      if (
        fileSystem.globScanMaxDepth !== null &&
        fileSystem.globScanMaxDepth !== undefined &&
        (
          typeof fileSystem.globScanMaxDepth !== "number" ||
          !Number.isSafeInteger(fileSystem.globScanMaxDepth) ||
          fileSystem.globScanMaxDepth < 0
        )
      ) {
        complete = false;
      }
      for (const [key, label] of [["read", "读取"], ["write", "写入"]] as const) {
        const values = fileSystem[key];
        if (values === null || values === undefined) continue;
        if (!Array.isArray(values)) {
          complete = false;
          continue;
        }
        for (const value of values) {
          if (typeof value !== "string") {
            complete = false;
            continue;
          }
          lines.push(`${label}：${publicPathScope(value, mappings)}`);
        }
      }
      if (fileSystem.entries !== null && fileSystem.entries !== undefined) {
        if (!Array.isArray(fileSystem.entries)) {
          complete = false;
        } else {
          for (const rawEntry of fileSystem.entries) {
            const entry = asObject(rawEntry);
            const access = entry?.access;
            const scope = entry ? publicFileSystemEntryScope(entry.path, mappings) : null;
            if (
              !entry || (access !== "read" && access !== "write" && access !== "deny") ||
              scope === null || !Object.keys(entry).every((key) => key === "path" || key === "access")
            ) {
              complete = false;
              continue;
            }
            const label = access === "read" ? "读取" : access === "write" ? "写入" : "禁止";
            lines.push(`${label}：${scope}`);
          }
        }
      }
    }
  }

  if (lines.length === 0) complete = false;
  if (lines.length > 20) complete = false;
  return {
    lines: lines.slice(0, 20).concat(lines.length > 20 ? [`另有 ${lines.length - 20} 项范围`] : []),
    complete,
  };
}

function publicFileSystemEntryScope(
  value: unknown,
  mappings: readonly AttachmentDisplayMapping[],
): string | null {
  const path = asObject(value);
  if (!path || typeof path.type !== "string") return null;
  if (
    path.type === "path" && typeof path.path === "string" &&
    Object.keys(path).every((key) => key === "type" || key === "path")
  ) {
    return publicPathScope(path.path, mappings);
  }
  if (
    path.type === "glob_pattern" && typeof path.pattern === "string" &&
    Object.keys(path).every((key) => key === "type" || key === "pattern")
  ) {
    return `匹配 ${publicPathScope(path.pattern, mappings)}`;
  }
  if (
    path.type !== "special" ||
    !Object.keys(path).every((key) => key === "type" || key === "value")
  ) return null;
  const special = asObject(path.value);
  if (!special || typeof special.kind !== "string") return null;
  if (
    special.kind === "root" && Object.keys(special).every((key) => key === "kind")
  ) return "文件系统根目录";
  if (
    special.kind === "minimal" && Object.keys(special).every((key) => key === "kind")
  ) return "最小系统范围";
  if (
    (special.kind === "tmpdir" || special.kind === "slash_tmp") &&
    Object.keys(special).every((key) => key === "kind")
  ) return "临时目录";
  if (special.kind === "project_roots") {
    if (!Object.keys(special).every((key) => key === "kind" || key === "subpath")) return null;
    return typeof special.subpath === "string" && special.subpath
      ? `项目目录/${publicPathScope(special.subpath, mappings)}`
      : "项目目录";
  }
  // unknown 携带的宿主路径可以安全隐藏，但隐藏后无法让用户判断授权范围。
  if (special.kind === "unknown") return null;
  return null;
}

function publicPathScope(
  value: string,
  mappings: readonly AttachmentDisplayMapping[],
): string {
  const attachment = redactKnownAttachmentPaths(value, mappings);
  if (attachment !== value) return attachment;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!normalized) return "文件系统根目录";
  const name = normalized.split("/").at(-1)?.trim();
  return name ? `…/${clipPublicSummary(name, 80)}` : "主机路径（完整路径已隐藏）";
}

function clipPublicSummary(value: string, limit = 240): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function publicInteraction(
  interaction: WorkerInteractionRequest,
  mappings: readonly AttachmentDisplayMapping[] = [],
): Record<string, unknown> {
  return redactKnownAttachmentPathsDeep(
    structuredClone(interaction) as unknown as Record<string, unknown>,
    mappings,
  );
}

function publicAttachment(attachment: ResolvedAttachment): PublicAttachment {
  const { path: _path, ...publicValue } = attachment;
  return publicValue;
}

function uploadManagerError(error: unknown): WorkerManagerError {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "attachment_failed";
  return new WorkerManagerError(code, errorMessage(error));
}

function terminalReplayTask(task: WorkerTask | null): WorkerTask | null {
  if (!task) return null;
  if (task.status === "interrupted" && task.interruptionReason) return task;
  if (task.status === "failed" && task.nativeTurnId === null) return task;
  return null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}

/** 写日志用：非 Error 也保留原值，便于查清到底抛了什么。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
