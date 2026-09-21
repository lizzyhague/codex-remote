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
  type ApplicationSettings,
  type ApplicationSettingsStore,
} from "../settings/store.ts";

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
  readonly #services: BrowserConnectionServices;
  readonly #unsubscribeSessionChanges: () => void;
  readonly #unsubscribeWorkerEvents: () => void;
  readonly #unsubscribeSettings: () => void;
  #authenticated = true;
  #disconnected = false;
  #queue: Promise<void> = Promise.resolve();
  #disconnectPromise: Promise<void> | null = null;
  #projectId: string | null = null;
  #sessionId: string | null = null;
  #olderTurns: Turn[] = [];

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
    this.#unsubscribeSettings = services.settings?.onChange((settings) => {
      this.#handleSettingsChange(settings);
    }) ?? (() => {});
    services.workers.clientAuthenticated(this.#id);
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

  disconnect(): Promise<void> {
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

    try {
      const data = await this.#dispatch(request);
      this.#send({ type: "response", requestId: request.requestId, ok: true, data });
    } catch (error) {
      const code = error instanceof BrowserRequestError || error instanceof WorkerManagerError ||
          error instanceof SharedUploadError || error instanceof ApplicationSettingsError
        ? error.code
        : "request_failed";
      this.#sendFailure(request.requestId, code, publicErrorMessage(error));
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
      case "session.start":
        return await this.#openSession(
          request.projectId,
          await this.#services.workers.startSession(request.projectId),
        );
      case "session.resume":
        return await this.#openSession(
          request.projectId,
          await this.#services.workers.resumeSession(request.projectId, request.sessionId),
        );
      case "settings.get":
        return this.#requireSettings().get();
      case "settings.update":
        return this.#requireSettings().update(request.developerInstructions);
      case "session.metrics": {
        const { sessionId } = this.#requireSession();
        return {
          sessionId,
          metrics: await this.#services.workers.metrics.read(
            sessionId,
            this.#services.turnTransport,
          ),
        };
      }
      case "history.older":
        return this.#loadOlderHistory();
      case "commands.list":
        return { commands: COMMAND_CATALOG };
      case "command.options": {
        const { projectId, sessionId } = this.#requireSession();
        return this.#services.workers.commandOptions(projectId, sessionId, request.command);
      }
      case "command.run":
        return this.#runCommand(request);
      case "permissions.full-access.toggle": {
        const { projectId, sessionId } = this.#requireSession();
        this.#assertCanChangeSettings();
        return this.#services.workers.toggleFullAccess(projectId, sessionId);
      }
      case "attachment.ticket.create": {
        if (!this.#services.uploads) {
          throw new BrowserRequestError("uploads_unavailable", "当前后端没有启用附件服务。");
        }
        const { projectId, sessionId } = this.#requireSession();
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
        const { projectId, sessionId } = this.#requireSession();
        return this.#services.workers.enqueueMessageWithAttachments(
          projectId,
          sessionId,
          request.clientMessageId,
          request.text,
          request.attachmentIds,
        );
      }
      case "task.stop":
        return this.#services.workers.stopTask(this.#requireSession().sessionId);
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

      const openSessionId = this.#sessionId;
      const removesOpenSession = request.action === "archive" ||
        request.action === "trash-active" || request.action === "trash-archived" ||
        request.action === "delete-trash";
      if (
        removesOpenSession && openSessionId &&
        result.succeeded.includes(openSessionId)
      ) {
        this.#detachSession();
      }
      return result;
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

  async #openSession(projectId: string, managed: ManagedSessionOpen): Promise<unknown> {
    this.#detachSession();
    this.#projectId = projectId;
    this.#sessionId = managed.opened.session.id;
    this.#services.workers.attachSession(this.#id, this.#sessionId);
    const mappings = await this.#services.workers.syncAttachmentMappings?.(
      managed.opened.session.id,
      managed.opened.turns,
    ) ?? [];
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
      fullAccessEnabled: managed.fullAccessEnabled,
      ...(managed.notice ? { notice: managed.notice } : {}),
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

  #loadOlderHistory(): { tasks: ReturnType<typeof toBrowserTasks>; hasOlder: boolean } {
    this.#requireSession();
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
    const { projectId, sessionId } = this.#requireSession();
    const result = await this.#services.workers.runCommand(
      projectId,
      sessionId,
      `${this.#id}:${request.requestId}`,
      request.command,
      request.option,
      request.argument,
    );
    if (!Array.isArray(result.turns)) return result;
    const turns = result.turns as Turn[];
    const visibleStart = Math.max(0, turns.length - HISTORY_PAGE_SIZE);
    this.#olderTurns = turns.slice(0, visibleStart);
    const { turns: _turns, ...rest } = result;
    return {
      ...rest,
      tasks: toBrowserTasks(turns.slice(visibleStart), this.#historyMappings()),
      hasOlder: this.#olderTurns.length > 0,
    };
  }

  #handleSettingsChange(settings: ApplicationSettings): void {
    if (!this.#authenticated) return;
    this.#send({
      type: "event",
      event: {
        type: "settings.updated",
        developerInstructions: settings.developerInstructions,
      },
    });
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
    const closesCurrent = currentSessionId !== null &&
      event.sessionIds.includes(currentSessionId) &&
      (event.change === "archive" || event.change === "trash" ||
        event.change === "delete");
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
    if (stored.audience === "session" && stored.threadId !== this.#sessionId) return;
    this.#send({
      type: "event",
      event: { ...stored.event, sequence: stored.sequence },
    });
  }

  async #handleDisconnect(): Promise<void> {
    this.#unsubscribeSessionChanges();
    this.#unsubscribeWorkerEvents();
    this.#unsubscribeSettings();
    await this.#queue;
    this.#services.workers.clientDisconnected(this.#id);
    this.#detachSession();
  }

  /**
   * 模型、权限和工作模式都是写在 thread 上的设置，运行中的任务会立刻受影响。
   * 没有这道检查，一台并没有拿到任务控制权的设备也能在别人的任务跑到一半时
   * 把沙箱放开到“完全访问”。
   */
  #assertCanChangeSettings(): void {
    const { sessionId } = this.#requireSession();
    if (this.#services.workers.activeTask(sessionId)) {
      throw new BrowserRequestError(
        "task_already_running",
        "这个会话有任务正在运行，请先等它结束或停止它，再修改会话设置。",
      );
    }
  }

  #requireSession(): { projectId: string; sessionId: string } {
    if (!this.#projectId || !this.#sessionId) {
      throw new BrowserRequestError("session_not_open", "请先新建或恢复一个会话。");
    }
    return { projectId: this.#projectId, sessionId: this.#sessionId };
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

/**
 * 发给浏览器的错误文字。本仓库自己写的提示会原样保留，但操作系统和
 * app-server 抛出的错误常常带着主机上的绝对路径，那些只应该留在服务端日志里。
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
