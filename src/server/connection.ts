import type { AppServerTransport } from "../app-server/turn-session.ts";
import { COMMAND_CATALOG } from "../commands/catalog.ts";
import type { ProjectSummary } from "../projects/catalog.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { SharedUploadClient } from "../shared-upload/client.ts";
import { SharedUploadError } from "../shared-upload/types.ts";
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
import {
  SessionWorkerManager,
  WorkerManagerError,
  type ManagedSessionOpen,
  type WorkerManagerEvent,
} from "../workers/manager.ts";
import {
  ApplicationSettingsError,
  type ApplicationSettingsStore,
} from "../settings/store.ts";
import { isPublicError, PublicError } from "../shared/public-error.ts";
import { redactHostPaths } from "../attachments/path-redaction.ts";
import { listModels } from "../app-server/models.ts";
import { listPermissionOptions } from "../app-server/permissions.ts";

const HISTORY_PAGE_SIZE = 20;

export interface BrowserSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ProjectsApi {
  list(): Promise<ProjectSummary[]>;
}

export interface SessionsApi {
  isMarked(sessionId: string): boolean;
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
  deleteTrash(projectId: string, sessionIds: string[]): Promise<SessionMutationResult>;
  setMarked(projectId: string, sessionId: string, marked: boolean): Promise<OpenedSession["session"]>;
  rename(projectId: string, sessionId: string, title: string): Promise<OpenedSession["session"]>;
  onChange?(listener: (event: SessionChangeEvent) => void): () => void;
}

export type BrowserConnectionServices = {
  projects: ProjectsApi;
  sessions: SessionsApi;
  /**
   * 目录 App Server。会话和任务属于 Worker，这个连接只用它读账号额度，
   * 这样查询用量不需要先开一个 Worker。
   */
  turnTransport: AppServerTransport;
  locks: ProjectTaskLocks;
  workers: SessionWorkerManager;
  uploads?: Pick<SharedUploadClient, "createTicket">;
  settings?: ApplicationSettingsStore;
};

export class BrowserRequestError extends PublicError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserRequestError";
    this.code = code;
  }
}

/**
 * 一个浏览器 WebSocket 的状态机。会改变会话或设置的请求按顺序处理，避免竞态；
 * 独立的模型目录读取并行执行，不能挡住设置保存。
 */
export class BrowserConnection {
  readonly #id: string;
  readonly #socket: BrowserSocket;
  readonly #services: BrowserConnectionServices;
  readonly #unsubscribeSessionChanges: () => void;
  readonly #unsubscribeWorkerEvents: () => void;
  #authenticated = true;
  #disconnected = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #backgroundRequests = new Set<Promise<void>>();
  #disconnectPromise: Promise<void> | null = null;
  #projectId: string | null = null;
  #sessionId: string | null = null;
  #olderTurns: Turn[] = [];
  /**
   * 连接内打开会话的代次。每次新的打开意图都会领一个号；detach、切换项目、
   * 断线或打开目标被归档/回收/删除都会让号作废。打开流程每次真实等待之后、
   * 挂载和返回成功之前都要核对，作废了就明确失败。
   */
  #openGeneration = 0;
  /** 正在打开的目标；新建会话在 Worker 返回之前还没有编号。 */
  #pendingOpen: { generation: number; sessionId: string | null } | null = null;
  /** 打开会话期间扣住的事件；响应发出之后再按正常规则转发。 */
  #deferredEvents: WorkerManagerEvent[] | null = null;

  constructor(
    id: string,
    socket: BrowserSocket,
    services: BrowserConnectionServices,
  ) {
    this.#id = id;
    this.#socket = socket;
    this.#services = services;
    this.#unsubscribeSessionChanges = services.sessions.onChange?.((event) => {
      this.#handleSessionChange(event);
    }) ?? (() => {});
    this.#unsubscribeWorkerEvents = services.workers.onEvent((event) => {
      this.#handleWorkerEvent(event);
    });
    services.workers.clientAuthenticated(this.#id);
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  receiveText(source: string): void {
    if (this.#disconnected) {
      return;
    }
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
      this.#send({
        type: "error",
        requestId: null,
        error: { code: "internal_error", message: publicErrorMessage(error) },
      });
      return;
    }

    if (request.type === "settings.models" || request.type === "settings.permissions") {
      const operation = this.#process(request, false).catch((error: unknown) => {
        this.#send({
          type: "error",
          requestId: null,
          error: { code: "internal_error", message: publicErrorMessage(error) },
        });
      });
      this.#backgroundRequests.add(operation);
      void operation.finally(() => this.#backgroundRequests.delete(operation));
      return;
    }

    this.#queue = this.#queue.then(() => this.#process(request)).catch((error: unknown) => {
      this.#send({
        type: "error",
        requestId: null,
        error: { code: "internal_error", message: publicErrorMessage(error) },
      });
    });
  }

  async whenIdle(): Promise<void> {
    await this.#queue;
    await Promise.all([...this.#backgroundRequests]);
  }

  disconnect(): Promise<void> {
    if (this.#disconnectPromise) {
      return this.#disconnectPromise;
    }
    this.#disconnected = true;
    this.#authenticated = false;
    this.#disconnectPromise = this.#handleDisconnect();
    return this.#disconnectPromise;
  }

  async #process(request: BrowserRequest, flushDeferredEvents = true): Promise<void> {
    try {
      const data = await this.#dispatch(request);
      this.#send({ type: "response", requestId: request.requestId, ok: true, data });
    } catch (error) {
      const code = error instanceof BrowserRequestError || error instanceof WorkerManagerError ||
          error instanceof SharedUploadError || error instanceof ApplicationSettingsError
        ? error.code
        : "request_failed";
      this.#sendFailure(request.requestId, code, publicErrorMessage(error));
    } finally {
      if (flushDeferredEvents) this.#flushDeferredEvents();
    }
  }

  async #dispatch(request: BrowserRequest): Promise<unknown> {
    switch (request.type) {
      case "projects.list":
        return { projects: await this.#services.projects.list() };
      case "sessions.list":
        return this.#listSessions(request);
      case "sessions.mutate":
        return this.#mutateSessions(request);
      case "session.mark": {
        const session = await this.#services.sessions.setMarked(
          request.projectId,
          request.sessionId,
          request.marked,
        );
        const { sessionId: _engineSessionId, ...summary } = session;
        return { session: summary };
      }
      case "session.rename": {
        const session = await this.#services.sessions.rename(
          request.projectId,
          request.sessionId,
          request.title,
        );
        const { sessionId: _engineSessionId, ...summary } = session;
        return { session: summary };
      }
      case "session.start": {
        const generation = this.#beginOpen(null);
        try {
          return await this.#openSession(
            generation,
            request.projectId,
            await this.#services.workers.startSession(request.projectId),
          );
        } finally {
          this.#endOpen(generation);
        }
      }
      case "session.resume": {
        const generation = this.#beginOpen(request.sessionId);
        try {
          return await this.#openSession(
            generation,
            request.projectId,
            await this.#services.workers.resumeSession(request.projectId, request.sessionId),
            request.acceptLoadingStates === true,
          );
        } finally {
          this.#endOpen(generation);
        }
      }
      case "settings.get":
        return this.#requireSettings().get();
      case "settings.models":
        this.#requireSettings();
        return listModels(this.#services.turnTransport);
      case "settings.permissions":
        this.#requireSettings();
        return listPermissionOptions(this.#services.turnTransport);
      case "settings.update": {
        const { type: _type, requestId: _requestId, ...patch } = request;
        return this.#requireSettings().update(patch);
      }
      case "session.metrics": {
        const { sessionId } = this.#requireSessionTarget(request);
        return {
          sessionId,
          metrics: await this.#services.workers.metrics.read(
            sessionId,
            this.#services.turnTransport,
          ),
        };
      }
      case "history.older":
        return this.#loadOlderHistory(request);
      case "commands.list":
        return { commands: COMMAND_CATALOG };
      case "command.options": {
        const { projectId, sessionId } = this.#requireSessionTarget(request);
        return this.#services.workers.commandOptions(projectId, sessionId, request.command);
      }
      case "command.run":
        return this.#runCommand(request);
      case "attachment.ticket.create": {
        const { projectId, sessionId } = this.#requireSessionTarget(request);
        if (!this.#services.uploads) {
          throw new BrowserRequestError("uploads_unavailable", "当前后端没有启用附件服务。");
        }
        return this.#services.uploads.createTicket({
          caller: "codex",
          projectId,
          sessionId,
          originalName: request.originalName,
          declaredMime: request.declaredMime,
          expectedSize: request.expectedSize,
        });
      }
      case "message.send": {
        const { projectId, sessionId } = this.#requireSessionTarget(request);
        return this.#services.workers.enqueueMessageWithAttachments(
          projectId,
          sessionId,
          request.clientMessageId,
          request.text,
          request.attachmentIds,
        );
      }
      case "task.stop":
        return this.#services.workers.stopTask(this.#requireSessionTarget(request).sessionId);
      case "approval.answer":
        return this.#services.workers.answerApproval(request.approvalId, request.decision);
      case "interaction.answer":
        return this.#services.workers.answerInteraction(
          request.interactionId,
          request.action,
          request.answers,
        );
    }
  }

  async #mutateSessions(
    request: Extract<BrowserRequest, { type: "sessions.mutate" }>,
  ): Promise<SessionMutationResult> {
    if (this.#services.workers.projectBusy(request.projectId)) {
      throw new BrowserRequestError(
        "project_busy",
        "这个项目有已接受或正在执行的任务，暂时不能整理会话。",
      );
    }
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
        : request.action === "delete-trash"
        ? await this.#services.sessions.deleteTrash(request.projectId, request.sessionIds)
        : await this.#services.sessions.restoreTrash(request.projectId, request.sessionIds);

      const publicResult = {
        succeeded: result.succeeded,
        failed: result.failed.map((failure) => {
          if (redactHostPaths(failure.message) === failure.message) return failure;
          console.error(`未向浏览器透传的会话整理失败文字：${failure.message}`);
          return {
            sessionId: failure.sessionId,
            message: "会话整理失败，请查看服务日志。",
          };
        }),
      };
      const openSessionId = this.#sessionId;
      const removesOpenSession = request.action === "archive" ||
        request.action === "trash-active" || request.action === "trash-archived" ||
        request.action === "delete-trash";
      if (
        removesOpenSession && openSessionId &&
        result.succeeded.includes(openSessionId)
      ) {
        this.#invalidateOpen();
        this.#detachSession();
      }
      return publicResult;
    } finally {
      this.#services.locks.release(request.projectId, this.#id);
    }
  }

  async #listSessions(
    request: Extract<BrowserRequest, { type: "sessions.list" }>,
  ): Promise<ReturnType<typeof toBrowserSessionPage>> {
    if (this.#projectId && this.#projectId !== request.projectId) {
      // 前端切换项目时没有单独的 detach 请求；第一次加载新项目列表就是释放
      // 旧空会话临时 Worker 的明确边界。已经接受的后台任务不受 detach 影响。
      this.#invalidateOpen();
      this.#detachSession();
    }
    const page = await this.#services.sessions.list(request.projectId, {
      cursor: request.cursor,
      view: request.view,
      searchTerm: request.searchTerm,
    });
    page.sessions = page.sessions.map((session) =>
      this.#services.workers.activeTask(session.id)
        ? { ...session, state: "active" }
        : session);
    return toBrowserSessionPage(page);
  }

  async #openSession(
    generation: number,
    projectId: string,
    managed: ManagedSessionOpen,
    acceptLoadingStates = true,
  ): Promise<unknown> {
    // Worker 的启动或恢复可能比 WebSocket 活得更久。断线后这个结果已经没有
    // 接收者，不能再让完成得较晚的请求把死连接挂回会话。
    if (this.#disconnected) return managed;
    // 等 Worker 的这段时间里，目标可能已被另一台设备移走。
    this.#requireOpenCurrent(generation);
    if (managed.loadState !== "ready") {
      if (managed.projectId !== projectId) {
        throw new WorkerManagerError("session_project_mismatch", "这个会话不属于所选项目。");
      }
      if (!acceptLoadingStates) {
        throw new WorkerManagerError(
          "worker_starting",
          "这个会话的后台 Worker 正在启动，请稍后重新打开。",
        );
      }
      this.#deferredEvents = [];
      this.#detachSession();
      this.#projectId = managed.projectId;
      this.#sessionId = managed.sessionId;
      this.#services.workers.attachSession(this.#id, managed.projectId, managed.sessionId);
      this.#olderTurns = [];
      const { projectId: _projectId, ...browserManaged } = managed;
      return browserManaged;
    }
    const openedProjectId = managed.opened.session.projectId;
    if (openedProjectId !== projectId) {
      throw new WorkerManagerError("session_project_mismatch", "这个会话不属于所选项目。");
    }
    // 这一句之后新会话的事件就会往这条连接上发，而“会话已打开”的响应还要等
    // 下面那次附件同步才发得出去。页面此时还不知道自己被切过去了，收到的增量
    // 无处安放，随后又会被首屏渲染清掉。扣住它们，等响应发完再补。
    this.#deferredEvents = [];
    this.#detachSession();
    this.#projectId = openedProjectId;
    this.#sessionId = managed.opened.session.id;
    this.#services.workers.attachSession(this.#id, openedProjectId, this.#sessionId);
    const mappings = await this.#services.workers.syncAttachmentMappings?.(
      managed.opened.session.id,
      managed.opened.turns,
    ) ?? [];
    // 附件同步期间另一台设备可能已经把它归档或移入回收站，连接随之 detach；
    // 这时不能再回一个与后端状态矛盾的“已打开”。作废时若仍挂着这次打开的会话，
    // 一并放开，保证失败响应之后连接确实没有当前会话。
    if (generation !== this.#openGeneration && this.#sessionId === managed.opened.session.id) {
      this.#detachSession();
    }
    this.#requireOpenCurrent(generation);
    const visibleStart = Math.max(0, managed.opened.turns.length - HISTORY_PAGE_SIZE);
    this.#olderTurns = managed.opened.turns.slice(0, visibleStart);
    const visibleTurns = managed.opened.turns.slice(visibleStart);
    return {
      ...this.#browserOpenedSession(
        { ...managed.opened, activeTurnId: managed.activeTaskId },
        visibleTurns,
        mappings,
      ),
      activeTaskId: managed.activeTaskId,
      controlsActiveTask: managed.controlsActiveTask,
      ...(managed.notice ? { notice: managed.notice } : {}),
      ...(managed.settingsNotice ? { settingsNotice: managed.settingsNotice } : {}),
      replayEvents: managed.replayEvents.map((stored) => ({
        ...stored.event,
        sequence: stored.sequence,
      })),
    };
  }

  #browserOpenedSession(
    opened: OpenedSession,
    visibleTurns: OpenedSession["turns"],
    mappings: ReturnType<SessionWorkerManager["peekAttachmentMappings"]> = [],
  ) {
    const result = toBrowserOpenedSession(
      opened,
      visibleTurns,
      this.#olderTurns.length > 0,
      mappings,
    );
    // Worker 快照可能早于最近一次钉住操作；发回页面前使用共享名单的当前值。
    result.session.marked = this.#services.sessions.isMarked(opened.session.id);
    return result;
  }

  #historyMappings(): ReturnType<SessionWorkerManager["peekAttachmentMappings"]> {
    if (!this.#sessionId) return [];
    return this.#services.workers.peekAttachmentMappings?.(this.#sessionId) ?? [];
  }

  #loadOlderHistory(
    request: Extract<BrowserRequest, { type: "history.older" }>,
  ): { tasks: ReturnType<typeof toBrowserTasks>; hasOlder: boolean } {
    this.#requireSessionTarget(request);
    const start = Math.max(0, this.#olderTurns.length - HISTORY_PAGE_SIZE);
    const turns = this.#olderTurns.slice(start);
    this.#olderTurns.length = start;
    return {
      tasks: toBrowserTasks(turns, this.#historyMappings()),
      hasOlder: this.#olderTurns.length > 0,
    };
  }

  async #runCommand(
    request: Extract<BrowserRequest, { type: "command.run" }>,
  ): Promise<unknown> {
    const { projectId, sessionId } = this.#requireSessionTarget(request);
    return this.#services.workers.runCommand(
      projectId,
      sessionId,
      `${this.#id}:${request.requestId}`,
      request.command,
      request.option,
      request.argument,
      request.targetTurnId,
    );
  }

  #requireSettings(): ApplicationSettingsStore {
    if (!this.#services.settings) {
      throw new BrowserRequestError("settings_unavailable", "当前后端没有启用应用设置。");
    }
    return this.#services.settings;
  }

  #handleSessionChange(event: SessionChangeEvent): void {
    if (!this.#authenticated) return;
    const currentSessionId = this.#sessionId;
    const removes = event.change === "archive" || event.change === "trash" ||
      event.change === "delete";
    const closesCurrent = removes && currentSessionId !== null &&
      event.sessionIds.includes(currentSessionId);
    const pendingSessionId = this.#pendingOpen?.sessionId ?? null;
    // 还没挂载的打开目标也要作废：恢复请求可能还在等 Worker。
    if (
      closesCurrent ||
      (removes && pendingSessionId !== null && event.sessionIds.includes(pendingSessionId))
    ) {
      this.#invalidateOpen();
    }
    if (closesCurrent) this.#detachSession();
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

  #handleWorkerEvent(stored: WorkerManagerEvent): void {
    if (!this.#authenticated) return;
    if (this.#deferredEvents) {
      this.#deferredEvents.push(stored);
      return;
    }
    this.#forwardWorkerEvent(stored);
  }

  #forwardWorkerEvent(stored: WorkerManagerEvent): void {
    if (stored.audience === "session" && stored.threadId !== this.#sessionId) return;
    this.#send({
      type: "event",
      event: { ...stored.event, sequence: stored.sequence },
    });
  }

  /** 扣住期间攒下的事件按原顺序补发；此时会话编号已经是新的了。 */
  #flushDeferredEvents(): void {
    const deferred = this.#deferredEvents;
    if (!deferred) return;
    this.#deferredEvents = null;
    for (const stored of deferred) this.#forwardWorkerEvent(stored);
  }

  async #handleDisconnect(): Promise<void> {
    this.#unsubscribeSessionChanges();
    this.#unsubscribeWorkerEvents();
    // 在线状态属于 WebSocket 生命周期，不能被某个没有返回的业务请求扣住。
    // 已经收到的请求仍可在队列里完成，但 #openSession 不会让它重新挂载。
    this.#services.workers.clientDisconnected(this.#id);
    this.#invalidateOpen();
    this.#detachSession();
  }

  #beginOpen(sessionId: string | null): number {
    const generation = ++this.#openGeneration;
    this.#pendingOpen = { generation, sessionId };
    return generation;
  }

  #endOpen(generation: number): void {
    if (this.#pendingOpen?.generation === generation) this.#pendingOpen = null;
  }

  #invalidateOpen(): void {
    this.#openGeneration += 1;
    this.#pendingOpen = null;
  }

  #requireOpenCurrent(generation: number): void {
    if (generation === this.#openGeneration) return;
    throw new BrowserRequestError(
      "session_open_cancelled",
      "会话在打开过程中已被关闭或移走，请重新选择。",
    );
  }

  #requireSession(): { projectId: string; sessionId: string } {
    if (!this.#projectId || !this.#sessionId) {
      throw new BrowserRequestError("session_not_open", "请先新建或恢复一个会话。");
    }
    return { projectId: this.#projectId, sessionId: this.#sessionId };
  }

  #requireSessionTarget(
    target: { projectId: string; sessionId: string },
  ): { projectId: string; sessionId: string } {
    const current = this.#requireSession();
    if (
      target.projectId !== current.projectId ||
      target.sessionId !== current.sessionId
    ) {
      throw new BrowserRequestError(
        "session_target_mismatch",
        "请求的会话已经不是当前打开的会话。请重新打开原会话后重试。",
      );
    }
    return current;
  }

  /** 放开这个连接对当前会话的占用。已经接受的后台任务不受影响。 */
  #detachSession(): void {
    this.#services.workers.detachSession(this.#id);
    this.#sessionId = null;
    this.#projectId = null;
    this.#olderTurns = [];
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

/** 只有明确标成 PublicError 的业务提示才能原样发给浏览器。 */
export function publicErrorMessage(error: unknown): string {
  if (isPublicError(error)) {
    if (redactHostPaths(error.message) === error.message) return error.message;
    console.error(`公开业务错误意外含有宿主路径：${error.message}`);
    return "请求失败，请查看服务日志。";
  }
  if (isSystemError(error)) {
    console.error(`未向浏览器透传的系统错误：${error.message}`);
    return "服务器无法访问本地文件，请查看服务日志。";
  }
  console.error(`未向浏览器透传的请求错误：${privateErrorMessage(error)}`);
  return "请求失败，请查看服务日志。";
}

function isSystemError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const candidate = error as NodeJS.ErrnoException;
  return typeof candidate.code === "string" && typeof candidate.syscall === "string";
}

function privateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
