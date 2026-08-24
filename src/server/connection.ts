import { timingSafeEqual } from "node:crypto";

import type { CodexStreamEvent, AppServerTransport } from "../app-server/turn-session.ts";
import { CodexTurnSession } from "../app-server/turn-session.ts";
import type { ApprovalEvent, ApprovalRequest } from "../approvals/broker.ts";
import { ApprovalBroker } from "../approvals/broker.ts";
import { COMMAND_CATALOG } from "../commands/catalog.ts";
import { CommandRunner } from "../commands/runner.ts";
import type { ProjectSummary } from "../projects/catalog.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type {
  OpenedSession,
  SessionChangeEvent,
  SessionListOptions,
  SessionMutationResult,
  SessionPage,
} from "../sessions/service.ts";
import {
  parseBrowserRequest,
  ProtocolError,
  type BrowserMessage,
  type BrowserRequest,
} from "./protocol.ts";
import {
  toBrowserOpenedSession,
  toBrowserSessionPage,
  toBrowserTasks,
} from "./history.ts";
import { ProjectTaskLocks } from "./project-locks.ts";

const HISTORY_PAGE_SIZE = 20;

/**
 * 有些命令（例如 `/compact`）的响应里没有 turn ID，只能等 `turn/started` 通知
 * 才知道任务真的开始了。如果通知始终不来，项目锁必须自己放开，否则整个项目
 * 会一直显示“正在执行任务”，直到这个浏览器断开为止。
 */
const TASK_CLAIM_TIMEOUT_MS = 10_000;

export interface BrowserSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type BrowserDisconnectResult = {
  /** 这个连接是否曾让 app-server 加载过可写 thread。 */
  usedThreadWriter: boolean;
};

export interface ProjectsApi {
  list(): Promise<ProjectSummary[]>;
}

export interface SessionsApi {
  list(projectId: string, options?: SessionListOptions): Promise<SessionPage>;
  start(projectId: string): Promise<OpenedSession>;
  resume(projectId: string, sessionId: string): Promise<OpenedSession>;
  archive(projectId: string, sessionIds: string[]): Promise<SessionMutationResult>;
  unarchive(projectId: string, sessionIds: string[]): Promise<SessionMutationResult>;
  moveToTrash(
    projectId: string,
    sessionIds: string[],
    origin: "active" | "archived",
  ): Promise<SessionMutationResult>;
  restoreTrash(projectId: string, sessionIds: string[]): Promise<SessionMutationResult>;
  onChange?(listener: (event: SessionChangeEvent) => void): () => void;
}

export type BrowserConnectionOptions = {
  taskClaimTimeoutMs?: number;
};

export type BrowserConnectionServices = {
  projects: ProjectsApi;
  sessions: SessionsApi;
  turnTransport: AppServerTransport;
  approvals: ApprovalBroker;
  locks: ProjectTaskLocks;
};

export class BrowserRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserRequestError";
    this.code = code;
  }
}

/** 一个浏览器 WebSocket 的状态机。所有收到的请求按顺序处理，避免竞态。 */
export class BrowserConnection {
  readonly #id: string;
  readonly #socket: BrowserSocket;
  readonly #expectedToken: string;
  readonly #services: BrowserConnectionServices;
  readonly #approvalIds = new Set<string>();
  readonly #unsubscribeApprovals: () => void;
  readonly #unsubscribeSessionChanges: () => void;
  readonly #completionWaiters = new Map<string, () => void>();
  #authenticated = false;
  #disconnected = false;
  #queue: Promise<void> = Promise.resolve();
  #disconnectPromise: Promise<BrowserDisconnectResult> | null = null;
  #usedThreadWriter = false;
  #projectId: string | null = null;
  #turnSession: CodexTurnSession | null = null;
  #commandRunner: CommandRunner | null = null;
  #unsubscribeTurnEvents: (() => void) | null = null;
  #ownedTaskId: string | null = null;
  #taskClaimTimer: NodeJS.Timeout | null = null;
  #olderTurns: Turn[] = [];
  readonly #taskClaimTimeoutMs: number;

  constructor(
    id: string,
    socket: BrowserSocket,
    expectedToken: string,
    services: BrowserConnectionServices,
    options: BrowserConnectionOptions = {},
  ) {
    if (!expectedToken) {
      throw new Error("WebSocket 访问令牌不能为空。");
    }
    this.#taskClaimTimeoutMs = options.taskClaimTimeoutMs ?? TASK_CLAIM_TIMEOUT_MS;
    this.#id = id;
    this.#socket = socket;
    this.#expectedToken = expectedToken;
    this.#services = services;
    this.#unsubscribeApprovals = services.approvals.onEvent((event) => {
      this.#handleApprovalEvent(event);
    });
    this.#unsubscribeSessionChanges = services.sessions.onChange?.((event) => {
      this.#handleSessionChange(event);
    }) ?? (() => {});
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  receiveText(source: string): void {
    if (this.#disconnected) {
      return;
    }
    this.#queue = this.#queue.then(() => this.#process(source)).catch((error: unknown) => {
      this.#send({
        type: "error",
        requestId: null,
        error: { code: "internal_error", message: publicErrorMessage(error) },
      });
    });
  }

  whenIdle(): Promise<void> {
    return this.#queue;
  }

  disconnect(): Promise<BrowserDisconnectResult> {
    if (this.#disconnectPromise) {
      return this.#disconnectPromise;
    }
    this.#disconnected = true;
    this.#disconnectPromise = this.#handleDisconnect();
    return this.#disconnectPromise;
  }

  async #process(source: string): Promise<void> {
    let request: BrowserRequest;
    try {
      request = parseBrowserRequest(source);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#send({
          type: "error",
          requestId: error.requestId,
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    }

    if (request.type === "auth") {
      this.#handleAuth(request);
      return;
    }
    if (!this.#authenticated) {
      this.#sendFailure(request.requestId, "not_authenticated", "请先验证访问令牌。");
      this.#socket.close(1008, "Authentication required");
      return;
    }

    try {
      const data = await this.#dispatch(request);
      this.#send({ type: "response", requestId: request.requestId, ok: true, data });
    } catch (error) {
      const code = error instanceof BrowserRequestError ? error.code : "request_failed";
      this.#sendFailure(request.requestId, code, publicErrorMessage(error));
    }
  }

  #handleAuth(request: Extract<BrowserRequest, { type: "auth" }>): void {
    if (this.#authenticated) {
      this.#sendFailure(request.requestId, "already_authenticated", "连接已经验证过了。");
      return;
    }
    if (!tokensEqual(request.token, this.#expectedToken)) {
      this.#sendFailure(request.requestId, "invalid_token", "访问令牌不正确。");
      this.#socket.close(1008, "Invalid token");
      return;
    }
    this.#authenticated = true;
    this.#send({
      type: "response",
      requestId: request.requestId,
      ok: true,
      data: { authenticated: true },
    });
  }

  async #dispatch(request: Exclude<BrowserRequest, { type: "auth" }>): Promise<unknown> {
    switch (request.type) {
      case "projects.list":
        return { projects: await this.#services.projects.list() };
      case "sessions.list":
        return toBrowserSessionPage(
          await this.#services.sessions.list(request.projectId, {
            cursor: request.cursor,
            view: request.view,
            searchTerm: request.searchTerm,
          }),
        );
      case "sessions.mutate":
        return this.#mutateSessions(request);
      case "session.start":
        this.#assertCanSwitchSession();
        return this.#openSession(
          request.projectId,
          await this.#services.sessions.start(request.projectId),
        );
      case "session.resume":
        this.#assertCanSwitchSession();
        return this.#openSession(
          request.projectId,
          await this.#services.sessions.resume(request.projectId, request.sessionId),
        );
      case "history.older":
        return this.#loadOlderHistory();
      case "commands.list":
        return { commands: COMMAND_CATALOG };
      case "command.options":
        return this.#requireCommandRunner().options(request.command);
      case "command.run":
        return this.#runCommand(request);
      case "permissions.full-access.toggle":
        this.#assertCanChangeSettings();
        return this.#requireCommandRunner().toggleFullAccess();
      case "message.send":
        return this.#sendMessage(request.text);
      case "task.stop":
        return this.#stopTask();
      case "approval.answer":
        return this.#answerApproval(request.approvalId, request.decision);
    }
  }

  async #mutateSessions(
    request: Extract<BrowserRequest, { type: "sessions.mutate" }>,
  ): Promise<SessionMutationResult> {
    if (!this.#services.locks.acquire(
      request.projectId,
      this.#id,
      request.sessionIds[0]!,
    )) {
      throw new BrowserRequestError(
        "project_busy",
        "这个项目正在执行任务，暂时不能整理会话。",
      );
    }
    try {
      const result = request.action === "archive"
        ? await this.#services.sessions.archive(request.projectId, request.sessionIds)
        : request.action === "unarchive"
        ? await this.#services.sessions.unarchive(request.projectId, request.sessionIds)
        : request.action === "trash-active"
        ? await this.#services.sessions.moveToTrash(
          request.projectId,
          request.sessionIds,
          "active",
        )
        : request.action === "trash-archived"
        ? await this.#services.sessions.moveToTrash(
          request.projectId,
          request.sessionIds,
          "archived",
        )
        : await this.#services.sessions.restoreTrash(request.projectId, request.sessionIds);

      const openSessionId = this.#turnSession?.threadId;
      const removesOpenSession = request.action === "archive" ||
        request.action === "trash-active" || request.action === "trash-archived";
      if (
        removesOpenSession && openSessionId &&
        result.succeeded.includes(openSessionId)
      ) {
        this.#disposeTurnSession();
      }
      return result;
    } finally {
      this.#services.locks.release(request.projectId, this.#id);
    }
  }

  #openSession(projectId: string, opened: OpenedSession): unknown {
    this.#assertCanSwitchSession();
    this.#disposeTurnSession();
    this.#usedThreadWriter = true;
    this.#projectId = projectId;
    const turnSession = new CodexTurnSession(
      this.#services.turnTransport,
      opened.session.id,
      opened.activeTurnId,
    );
    this.#turnSession = turnSession;
    const commandRunner = new CommandRunner(
      this.#services.turnTransport,
      opened.session.id,
      opened.runtime,
    );
    this.#commandRunner = commandRunner;
    this.#unsubscribeTurnEvents = turnSession.onEvent((event) => {
      this.#handleStreamEvent(event);
    });

    let controlsActiveTask = false;
    if (opened.activeTurnId) {
      controlsActiveTask = this.#services.locks.acquire(
        projectId,
        this.#id,
        opened.session.id,
      );
      if (controlsActiveTask) {
        this.#claimTask(projectId, opened.activeTurnId);
      }
    }

    for (const approval of this.#services.approvals.pendingForThread(opened.session.id)) {
      this.#deliverApproval(approval);
    }

    const visibleStart = Math.max(0, opened.turns.length - HISTORY_PAGE_SIZE);
    this.#olderTurns = opened.turns.slice(0, visibleStart);
    const visibleTurns = opened.turns.slice(visibleStart);
    return {
      ...toBrowserOpenedSession(opened, visibleTurns, this.#olderTurns.length > 0),
      controlsActiveTask,
      fullAccessEnabled: commandRunner.fullAccessEnabled(),
    };
  }

  #loadOlderHistory(): { tasks: ReturnType<typeof toBrowserTasks>; hasOlder: boolean } {
    this.#requireOpenSession();
    const start = Math.max(0, this.#olderTurns.length - HISTORY_PAGE_SIZE);
    const turns = this.#olderTurns.slice(start);
    this.#olderTurns.length = start;
    return {
      tasks: toBrowserTasks(turns),
      hasOlder: this.#olderTurns.length > 0,
    };
  }

  async #runCommand(
    request: Extract<BrowserRequest, { type: "command.run" }>,
  ): Promise<unknown> {
    const runner = this.#requireCommandRunner();
    switch (request.command) {
      case "compact":
        return this.#startCommandTask(
          "正在压缩会话",
          () => runner.compact(),
        );
      case "review":
        return this.#startCommandTask(
          "正在检查未提交的改动",
          () => runner.review(),
        );
      case "rewind":
        return this.#rewindOneTurn(runner);
      case "model":
        if (!request.option) {
          throw new BrowserRequestError("command_option_required", "请先选择一个模型。");
        }
        this.#assertCanChangeSettings();
        return runner.setModel(request.option, request.argument);
      case "permissions":
        if (!request.option) {
          throw new BrowserRequestError("command_option_required", "请先选择一种权限。");
        }
        this.#assertCanChangeSettings();
        return runner.setPermissions(request.option);
      case "plan": {
        this.#assertCanChangeSettings();
        const result = await runner.togglePlan();
        if (!request.argument) return result;
        const task = await this.#sendMessage(request.argument);
        return { ...result, taskId: task.taskId, sentText: request.argument };
      }
      case "rename":
        if (!request.argument) {
          throw new BrowserRequestError(
            "command_argument_required",
            "请在 /rename 后面写一个会话名称。",
          );
        }
        return runner.rename(request.argument);
      case "status":
        return runner.status();
      case "usage":
        if (!request.option) {
          throw new BrowserRequestError("command_option_required", "请先选择要查看的用量。");
        }
        return runner.usage(request.option);
    }
  }

  async #rewindOneTurn(runner: CommandRunner): Promise<unknown> {
    const turnSession = this.#requireOpenSession();
    const projectId = this.#projectId!;
    if (turnSession.activeTurnId) {
      throw new BrowserRequestError("task_already_running", "请先等待当前任务结束再回退。");
    }
    if (!this.#services.locks.acquire(projectId, this.#id, turnSession.threadId)) {
      throw new BrowserRequestError("project_busy", "这个项目正在由另一个设备使用，暂时不能回退。");
    }

    try {
      const turns = await runner.rewind();
      const visibleStart = Math.max(0, turns.length - HISTORY_PAGE_SIZE);
      this.#olderTurns = turns.slice(0, visibleStart);
      return {
        kind: "rewind",
        title: "已回退一轮",
        lines: [
          "最近一轮已从当前会话的对话上下文中移除。",
          "这一轮已经造成的文件改动仍然保留。",
        ],
        tasks: toBrowserTasks(turns.slice(visibleStart)),
        hasOlder: this.#olderTurns.length > 0,
      };
    } finally {
      if (!this.#ownedTaskId) {
        this.#releaseProjectLock();
      }
    }
  }

  async #startCommandTask(
    title: string,
    starter: () => Promise<string | null>,
  ): Promise<unknown> {
    const turnSession = this.#requireOpenSession();
    const projectId = this.#projectId!;
    if (turnSession.activeTurnId) {
      throw new BrowserRequestError("task_already_running", "这个会话已有任务正在运行。");
    }
    if (!this.#services.locks.acquire(projectId, this.#id, turnSession.threadId)) {
      throw new BrowserRequestError("project_busy", "这个项目已有另一个任务正在运行。");
    }

    try {
      const taskId = await starter();
      this.#claimStartedTask(projectId, turnSession, taskId);
      return {
        kind: "task",
        title,
        lines: ["任务已经交给 Codex，结果会继续显示在对话里。"],
        taskId,
      };
    } catch (error) {
      this.#releaseProjectLock();
      throw error;
    }
  }
  async #sendMessage(text: string): Promise<{ taskId: string }> {
    const turnSession = this.#requireOpenSession();
    const projectId = this.#projectId!;
    if (turnSession.activeTurnId) {
      throw new BrowserRequestError("task_already_running", "这个会话已有任务正在运行。");
    }
    if (!this.#services.locks.acquire(projectId, this.#id, turnSession.threadId)) {
      throw new BrowserRequestError("project_busy", "这个项目已有另一个任务正在运行。");
    }

    try {
      const taskId = await turnSession.startTextTurn(text);
      this.#claimStartedTask(projectId, turnSession, taskId);
      return { taskId };
    } catch (error) {
      this.#releaseProjectLock();
      throw error;
    }
  }

  /**
   * 记录本连接刚刚启动的任务。有些调用拿不到 turn ID，或者 `turn/started`
   * 通知比响应更晚到达；这两种情况都先挂一个兜底计时器，避免项目锁被永久占住。
   */
  #claimStartedTask(
    projectId: string,
    turnSession: CodexTurnSession,
    taskId: string | null,
  ): void {
    const activeTurnId = turnSession.activeTurnId;
    if (activeTurnId && (taskId === null || taskId === activeTurnId)) {
      this.#claimTask(projectId, activeTurnId);
      return;
    }
    this.#armTaskClaimTimeout(projectId);
  }

  #claimTask(projectId: string, taskId: string): void {
    this.#clearTaskClaimTimeout();
    this.#ownedTaskId = taskId;
    this.#services.locks.setTaskId(projectId, this.#id, taskId);
  }

  #armTaskClaimTimeout(projectId: string): void {
    this.#clearTaskClaimTimeout();
    const timer = setTimeout(() => {
      this.#taskClaimTimer = null;
      if (this.#ownedTaskId || this.#turnSession?.activeTurnId) {
        return;
      }
      if (!this.#services.locks.release(projectId, this.#id)) {
        return;
      }
      // 浏览器已经按“任务开始”更新了界面，这里要告诉它后端不再认为有任务在跑。
      this.#send({
        type: "event",
        event: {
          type: "task.completed",
          sessionId: this.#turnSession?.threadId ?? null,
          taskId: null,
          status: "completed",
          error: null,
        },
      });
    }, this.#taskClaimTimeoutMs);
    timer.unref();
    this.#taskClaimTimer = timer;
  }

  #clearTaskClaimTimeout(): void {
    if (this.#taskClaimTimer) {
      clearTimeout(this.#taskClaimTimer);
      this.#taskClaimTimer = null;
    }
  }

  /** 释放本连接持有的项目锁，并清掉与它绑定的全部任务状态。 */
  #releaseProjectLock(): void {
    this.#clearTaskClaimTimeout();
    this.#ownedTaskId = null;
    if (this.#projectId) {
      this.#services.locks.release(this.#projectId, this.#id);
    }
  }

  async #stopTask(): Promise<{ requested: boolean }> {
    const turnSession = this.#requireOpenSession();
    const projectId = this.#projectId!;
    const taskId = turnSession.activeTurnId;
    if (!taskId) {
      return { requested: false };
    }
    if (!this.#services.locks.owns(projectId, this.#id)) {
      throw new BrowserRequestError("task_controlled_elsewhere", "这个任务由另一个连接控制。");
    }

    this.#cancelApprovals(turnSession.threadId, taskId);
    return { requested: await turnSession.interruptActiveTurn() };
  }

  #answerApproval(
    approvalId: string,
    decision: "approve_once" | "decline",
  ): { answered: true } {
    if (!this.#approvalIds.has(approvalId)) {
      throw new BrowserRequestError("approval_not_found", "这个审批已失效或不属于当前会话。");
    }
    if (!this.#services.approvals.answer(approvalId, decision)) {
      throw new BrowserRequestError("approval_not_found", "这个审批已经处理过了。");
    }
    return { answered: true };
  }

  #handleStreamEvent(event: CodexStreamEvent): void {
    if (event.type === "turn_started" && this.#projectId &&
      this.#services.locks.owns(this.#projectId, this.#id)) {
      this.#claimTask(this.#projectId, event.turnId);
    }

    const browserEvent = toBrowserStreamEvent(event);
    if (event.type === "turn_started") {
      browserEvent.controlsActiveTask = Boolean(
        this.#projectId && this.#services.locks.owns(this.#projectId, this.#id),
      );
    }
    this.#send({ type: "event", event: browserEvent });

    if (event.type === "turn_completed") {
      this.#completionWaiters.get(event.turnId)?.();
      this.#completionWaiters.delete(event.turnId);
      if (this.#ownedTaskId === event.turnId) {
        this.#releaseProjectLock();
      } else if (this.#taskClaimTimer && !this.#ownedTaskId) {
        // 任务在启动响应回来之前就结束了。既然它已经完结，就不用再等兜底计时器。
        this.#releaseProjectLock();
      }
    }
  }

  #handleApprovalEvent(event: ApprovalEvent): void {
    if (event.type === "approval_requested") {
      if (event.approval.threadId === this.#turnSession?.threadId) {
        this.#deliverApproval(event.approval);
      }
      return;
    }
    if (this.#approvalIds.delete(event.approvalId)) {
      this.#send({
        type: "event",
        event: {
          type: "approval.resolved",
          approvalId: event.approvalId,
          resolution: event.resolution,
        },
      });
    }
  }

  #handleSessionChange(event: SessionChangeEvent): void {
    if (!this.#authenticated) return;
    const currentSessionId = this.#turnSession?.threadId ?? null;
    const closesCurrent = currentSessionId !== null &&
      event.sessionIds.includes(currentSessionId) &&
      (event.change === "archive" || event.change === "trash" ||
        event.change === "delete");
    if (closesCurrent) this.#disposeTurnSession();
    this.#send({
      type: "event",
      event: {
        type: "sessions.changed",
        projectId: event.projectId,
        sessionIds: event.sessionIds,
        change: event.change,
        closedSessionId: closesCurrent ? currentSessionId : null,
      },
    });
  }

  #deliverApproval(approval: ApprovalRequest): void {
    if (this.#approvalIds.has(approval.id)) {
      return;
    }
    this.#approvalIds.add(approval.id);
    // 浏览器只需要审批说明，不应接收可能很长或含敏感参数的原始命令。
    const safe = approval.kind === "command"
      ? {
        id: approval.id,
        kind: approval.kind,
        reason: approval.reason,
        startedAtMs: approval.startedAtMs,
        network: approval.network,
      }
      : {
        id: approval.id,
        kind: approval.kind,
        reason: approval.reason,
        startedAtMs: approval.startedAtMs,
      };
    this.#send({
      type: "event",
      event: { type: "approval.requested", approval: safe },
    });
  }

  async #handleDisconnect(): Promise<BrowserDisconnectResult> {
    this.#unsubscribeApprovals();
    this.#unsubscribeSessionChanges();
    await this.#queue;
    const turnSession = this.#turnSession;
    const projectId = this.#projectId;
    const taskId = turnSession?.activeTurnId ?? null;

    if (
      turnSession && projectId &&
      this.#services.locks.owns(projectId, this.#id)
    ) {
      try {
        if (taskId) {
          const completed = this.#waitForCompletion(taskId, 2_000);
          this.#cancelApprovals(turnSession.threadId, taskId);
          await turnSession.interruptActiveTurn();
          await completed;
        }
      } catch {
        // 连接已经消失；无论 app-server 是否也在关闭，都要释放本地项目锁。
      }
    }

    this.#disposeTurnSession();
    return { usedThreadWriter: this.#usedThreadWriter };
  }

  #waitForCompletion(taskId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#completionWaiters.delete(taskId);
        resolve();
      }, timeoutMs);
      this.#completionWaiters.set(taskId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #cancelApprovals(threadId: string, taskId: string): void {
    try {
      this.#services.approvals.cancelTurn(threadId, taskId);
    } catch {
      // app-server 可能正好退出；停止任务仍应继续尝试。
    }
  }

  /**
   * 模型、权限和工作模式都是写在 thread 上的设置，运行中的任务会立刻受影响。
   * 没有这道检查，一台并没有拿到任务控制权的设备也能在别人的任务跑到一半时
   * 把沙箱放开到“完全访问”。
   */
  #assertCanChangeSettings(): void {
    const turnSession = this.#requireOpenSession();
    if (turnSession.activeTurnId) {
      throw new BrowserRequestError(
        "task_already_running",
        "这个会话有任务正在运行，请先等它结束或停止它，再修改会话设置。",
      );
    }
  }

  #assertCanSwitchSession(): void {
    if (
      this.#projectId && this.#turnSession?.activeTurnId &&
      this.#services.locks.owns(this.#projectId, this.#id)
    ) {
      throw new BrowserRequestError("task_already_running", "请先停止当前任务，再切换会话。");
    }
  }

  #requireOpenSession(): CodexTurnSession {
    if (!this.#turnSession || !this.#projectId) {
      throw new BrowserRequestError("session_not_open", "请先新建或恢复一个会话。");
    }
    return this.#turnSession;
  }
  #requireCommandRunner(): CommandRunner {
    this.#requireOpenSession();
    if (!this.#commandRunner) {
      throw new BrowserRequestError("session_not_open", "请先新建或恢复一个会话。");
    }
    return this.#commandRunner;
  }

  #disposeTurnSession(): void {
    // 先放锁再清 #projectId：关掉会话之后就再也收不到 turn/completed 通知了，
    // 这里不放开的话，这个项目会一直被判定为“有任务在运行”。
    this.#releaseProjectLock();
    this.#unsubscribeTurnEvents?.();
    this.#unsubscribeTurnEvents = null;
    this.#commandRunner?.dispose();
    this.#commandRunner = null;
    this.#turnSession?.dispose();
    this.#turnSession = null;
    this.#projectId = null;
    this.#olderTurns = [];
    this.#approvalIds.clear();
  }

  #sendFailure(requestId: string, code: string, message: string): void {
    this.#send({
      type: "response",
      requestId,
      ok: false,
      error: { code, message },
    });
  }

  #send(message: BrowserMessage): void {
    if (!this.#disconnected) {
      this.#socket.send(JSON.stringify(message));
    }
  }
}

function toBrowserStreamEvent(event: CodexStreamEvent): Record<string, unknown> & { type: string } {
  const { threadId: sessionId, turnId: taskId, ...rest } = event;
  const type = event.type === "turn_started"
    ? "task.started"
    : event.type === "user_message_started"
    ? "message.user"
    : event.type === "assistant_text_delta"
    ? "message.delta"
    : event.type === "assistant_text_completed"
    ? "message.completed"
    : event.type === "tool_started"
    ? "tool.started"
    : event.type === "tool_output_delta"
    ? "tool.output.delta"
    : event.type === "tool_completed"
    ? "tool.completed"
    : event.type === "turn_completed"
    ? "task.completed"
    : "task.error";
  const { type: _internalType, ...payload } = rest;
  return { type, sessionId, taskId, ...payload };
}

function tokensEqual(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 发给浏览器的错误文字。本仓库自己写的提示会原样保留，但操作系统和
 * app-server 抛出的错误常常带着 VPS 上的绝对路径，那些只应该留在服务端日志里。
 */
export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "请求失败。";
  }
  if (isSystemError(error)) {
    console.error(`未向浏览器透传的系统错误：${error.message}`);
    return "服务器无法访问本地文件，请查看服务日志。";
  }
  return redactPaths(error.message);
}

function isSystemError(error: Error): boolean {
  const candidate = error as NodeJS.ErrnoException;
  return typeof candidate.code === "string" && typeof candidate.syscall === "string";
}

/** 兜底遮盖仍然可能出现在错误文字里的绝对路径。 */
function redactPaths(message: string): string {
  return message.replace(/(?:\/[\w.@+-]+){2,}\/?/g, "<路径>");
}
