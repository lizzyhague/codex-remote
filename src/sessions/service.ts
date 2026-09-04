import { realpath } from "node:fs/promises";

import type { Thread } from "../generated/v2/Thread.ts";
import type { ThreadHistoryMode } from "../generated/v2/ThreadHistoryMode.ts";
import type { ThreadArchiveParams } from "../generated/v2/ThreadArchiveParams.ts";
import type { ThreadArchiveResponse } from "../generated/v2/ThreadArchiveResponse.ts";
import type { ThreadDeleteParams } from "../generated/v2/ThreadDeleteParams.ts";
import type { ThreadDeleteResponse } from "../generated/v2/ThreadDeleteResponse.ts";
import type { ThreadListParams } from "../generated/v2/ThreadListParams.ts";
import type { ThreadListResponse } from "../generated/v2/ThreadListResponse.ts";
import type { ThreadReadParams } from "../generated/v2/ThreadReadParams.ts";
import type { ThreadReadResponse } from "../generated/v2/ThreadReadResponse.ts";
import type { ThreadResumeParams } from "../generated/v2/ThreadResumeParams.ts";
import type { ThreadResumeResponse } from "../generated/v2/ThreadResumeResponse.ts";
import type { ThreadStartParams } from "../generated/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "../generated/v2/ThreadStartResponse.ts";
import type { ThreadUnarchiveParams } from "../generated/v2/ThreadUnarchiveParams.ts";
import type { ThreadUnarchiveResponse } from "../generated/v2/ThreadUnarchiveResponse.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import {
  TrashStore,
  type TrashOrigin,
} from "./trash-store.ts";

const PAGE_SIZE = 50;

/** 一次浏览器请求最多向 app-server 翻多少页，避免整页被过滤时无限翻下去。 */
const MAX_LIST_PAGES_PER_REQUEST = 10;

/** 一次回收站请求最多读取多少条登记，避免搜索不命中时读遍整个回收站。 */
const MAX_TRASH_READS_PER_REQUEST = 200;
const VISIBLE_SOURCE_KINDS = ["cli", "vscode", "appServer"] as const;
export const TRASH_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const CODEX_REMOTE_DEVELOPER_INSTRUCTIONS = [
  "This conversation is running through a custom client built on Codex App Server. The active session depends on the codex-remote backend and its Tailscale network path. When modifying the codex-remote project itself, treat the codex-remote backend serving this session and its network path as part of the live execution environment. Plan restarts, shutdowns, deployments, and network changes in an orderly sequence so the current work can finish and the client can reconnect cleanly—for example, use a delayed restart when appropriate.",
  "If any step involving the codex-remote project must be performed by the user outside the active session, provide a complete runbook before disrupting the connection. Include every shell command in execution order, identify the host and working directory for each command, state exactly when to connect over SSH, include verification checkpoints, and explain how to reconnect and continue afterward. Do not defer essential instructions until after the session may become unavailable.",
].join("\n\n");

export interface AppServerRequester {
  request<Result = unknown>(method: string, params: unknown): Promise<Result>;
}

export type SessionState = "not_loaded" | "idle" | "active" | "error";
export type SessionView = "active" | "archived" | "trash";

export type SessionListOptions = {
  cursor?: string | null;
  view?: SessionView;
  searchTerm?: string | null;
};

/** 浏览器可见的会话摘要；有意不包含主机上的绝对路径。 */
export type SessionSummary = {
  id: string;
  sessionId: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  state: SessionState;
  deletedAt: number | null;
  purgeAt: number | null;
};

export type SessionPage = {
  sessions: SessionSummary[];
  nextCursor: string | null;
};

export type SessionMutationResult = {
  succeeded: string[];
  failed: Array<{ sessionId: string; message: string }>;
};

export type TrashCleanupResult = {
  deleted: number;
  failed: Array<{ sessionId: string; message: string }>;
};

export type SessionChangeEvent = {
  projectId: string;
  sessionIds: string[];
  change: "archive" | "unarchive" | "trash" | "restore" | "delete";
};

export type OpenedSession = {
  session: SessionSummary;
  turns: Thread["turns"];
  activeTurnId: string | null;
  runtime: SessionRuntime;
};

/** 只在后端保存的当前会话运行设置；cwd 不会通过浏览器历史接口泄露。 */
export type SessionRuntime = {
  cwd: string;
  historyMode: ThreadHistoryMode;
  model: string;
  reasoningEffort: string | null;
  approvalPolicy: unknown;
  sandboxPolicy: unknown;
  activePermissionProfile: { id: string; extends: string | null } | null;
};

/**
 * 把“浏览器选择的项目 ID”翻译成 app-server 的会话请求。
 * 所有路径都来自 ProjectCatalog，绝不接受浏览器直接提供 cwd。
 */
export class CodexSessionService {
  readonly #transport: AppServerRequester;
  readonly #projects: ProjectCatalog;
  readonly #trash: TrashStore;
  readonly #now: () => number;
  readonly #changeListeners = new Set<(event: SessionChangeEvent) => void>();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    transport: AppServerRequester,
    projects: ProjectCatalog,
    trash: TrashStore,
    options: { now?: () => number } = {},
  ) {
    this.#transport = transport;
    this.#projects = projects;
    this.#trash = trash;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  onChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  async list(projectId: string, options: SessionListOptions = {}): Promise<SessionPage> {
    const view = options.view ?? "active";
    const searchTerm = options.searchTerm?.trim() ?? "";
    if (view === "trash") {
      // resolve() 既验证项目白名单，也避免旧项目 ID 借列表接口泄露摘要。
      const project = await this.#projects.resolve(projectId);
      return this.#listTrash(
        projectId,
        project.path,
        options.cursor ?? null,
        searchTerm,
      );
    }

    const project = await this.#projects.resolve(projectId);
    const params: ThreadListParams = {
      cursor: options.cursor ?? null,
      limit: PAGE_SIZE,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: [...VISIBLE_SOURCE_KINDS],
      cwd: project.path,
      archived: view === "archived",
      ...(searchTerm ? { searchTerm } : {}),
    };

    // 归档页需要排除回收站条目。若一整页都被过滤，继续向后找，避免
    // 浏览器看到一个“空列表但还能加载更多”的中间状态。翻页次数要有上限，
    // 否则一个装满回收站条目的项目会让一次浏览器请求打出无限多次 RPC。
    for (let page = 0; page < MAX_LIST_PAGES_PER_REQUEST; page += 1) {
      const response = await this.#transport.request<ThreadListResponse>(
        "thread/list",
        params,
      );
      assertThreadListResponse(response);

      const sessions: SessionSummary[] = [];
      for (const thread of response.data) {
        // app-server 本身会按 cwd 过滤；这里再检查一次，守住白名单边界。
        if (
          !this.#trash.has(thread.id) &&
          await threadBelongsToProject(thread, project.path)
        ) {
          sessions.push(toSessionSummary(thread));
        }
      }
      if (sessions.length > 0 || response.nextCursor === null) {
        return { sessions, nextCursor: response.nextCursor };
      }
      params.cursor = response.nextCursor;
    }
    // 到这里说明连续多页都被过滤空了。交回游标，让浏览器用“加载更多”继续。
    return { sessions: [], nextCursor: params.cursor ?? null };
  }

  async start(projectId: string): Promise<OpenedSession> {
    const project = await this.#projects.resolve(projectId);
    const params: ThreadStartParams = {
      cwd: project.path,
      ephemeral: false,
      serviceName: "codex_remote",
      developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
    };
    const response = await this.#transport.request<ThreadStartResponse>(
      "thread/start",
      params,
    );
    assertOpenedThreadResponse(response);
    await assertThreadBelongsToProject(response.thread, project.path);
    return toOpenedSession(response);
  }

  async resume(projectId: string, threadId: string): Promise<OpenedSession> {
    if (!threadId.trim()) {
      throw new Error("Codex 会话 ID 不能为空。");
    }
    if (this.#trash.has(threadId)) {
      throw new Error("这个会话在回收站中，请先恢复后再打开。");
    }

    const project = await this.#projects.resolve(projectId);
    const readParams: ThreadReadParams = { threadId, includeTurns: false };
    const stored = await this.#transport.request<ThreadReadResponse>(
      "thread/read",
      readParams,
    );
    assertOpenedThreadResponse(stored);
    if (stored.thread.id !== threadId) {
      throw new Error("Codex 返回了错误的会话。");
    }
    await assertThreadBelongsToProject(stored.thread, project.path);

    const resumeParams: ThreadResumeParams = {
      threadId,
      cwd: project.path,
      developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
    };
    const response = await this.#transport.request<ThreadResumeResponse>(
      "thread/resume",
      resumeParams,
    );
    assertOpenedThreadResponse(response);
    if (response.thread.id !== threadId) {
      throw new Error("Codex 返回了错误的会话。");
    }
    await assertThreadBelongsToProject(response.thread, project.path);
    return toOpenedSession(response);
  }

  archive(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "archive", async (projectPath, threadId) => {
      if (this.#trash.has(threadId)) {
        throw new Error("这个会话已经在回收站中。");
      }
      const thread = await this.#readOwnedThread(projectPath, threadId);
      assertThreadCanBeManaged(thread);
      const params: ThreadArchiveParams = { threadId };
      await this.#transport.request<ThreadArchiveResponse>("thread/archive", params);
    });
  }

  unarchive(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "unarchive", async (projectPath, threadId) => {
      if (this.#trash.has(threadId)) {
        throw new Error("这个会话在回收站中，请从回收站恢复。");
      }
      const thread = await this.#readOwnedThread(projectPath, threadId);
      assertThreadCanBeManaged(thread);
      const params: ThreadUnarchiveParams = { threadId };
      await this.#transport.request<ThreadUnarchiveResponse>("thread/unarchive", params);
    });
  }

  moveToTrash(
    projectId: string,
    threadIds: string[],
    origin: TrashOrigin,
  ): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "trash", async (projectPath, threadId) => {
      if (this.#trash.has(threadId)) return;
      const thread = await this.#readOwnedThread(projectPath, threadId);
      assertThreadCanBeManaged(thread);
      let archivedHere = false;
      if (origin === "active") {
        const params: ThreadArchiveParams = { threadId };
        await this.#transport.request<ThreadArchiveResponse>("thread/archive", params);
        archivedHere = true;
      }
      try {
        await this.#trash.put({
          threadId,
          projectId,
          deletedAt: this.#now(),
          origin,
        });
      } catch (error) {
        if (archivedHere) {
          const params: ThreadUnarchiveParams = { threadId };
          await this.#transport.request<ThreadUnarchiveResponse>("thread/unarchive", params)
            .catch(() => {});
        }
        throw error;
      }
    });
  }

  restoreTrash(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "restore", async (projectPath, threadId) => {
      const entry = this.#trash.get(threadId);
      if (!entry || entry.projectId !== projectId) {
        throw new Error("这个会话不在当前项目的回收站中。");
      }
      const thread = await this.#readOwnedThread(projectPath, threadId);
      assertThreadCanBeManaged(thread);
      let unarchivedHere = false;
      if (entry.origin === "active") {
        const params: ThreadUnarchiveParams = { threadId };
        await this.#transport.request<ThreadUnarchiveResponse>("thread/unarchive", params);
        unarchivedHere = true;
      }
      try {
        await this.#trash.remove(threadId);
      } catch (error) {
        if (unarchivedHere) {
          const params: ThreadArchiveParams = { threadId };
          await this.#transport.request<ThreadArchiveResponse>("thread/archive", params)
            .catch(() => {});
        }
        throw error;
      }
    });
  }

  deleteTrash(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "delete", async (_projectPath, threadId) => {
      const entry = this.#trash.get(threadId);
      if (!entry || entry.projectId !== projectId) {
        throw new Error("只能永久删除回收站里的会话。");
      }
      const params: ThreadDeleteParams = { threadId };
      await this.#transport.request<ThreadDeleteResponse>("thread/delete", params);
      await this.#trash.remove(threadId);
    });
  }

  purgeExpired(): Promise<TrashCleanupResult> {
    return this.#serializeMutation(async () => {
      const threshold = this.#now() - TRASH_RETENTION_SECONDS;
      const expired = this.#trash.list().filter((entry) => entry.deletedAt <= threshold);
      const result: TrashCleanupResult = { deleted: 0, failed: [] };
      for (const entry of expired) {
        try {
          const params: ThreadDeleteParams = { threadId: entry.threadId };
          await this.#transport.request<ThreadDeleteResponse>("thread/delete", params);
          await this.#trash.remove(entry.threadId);
          result.deleted += 1;
          this.#emitChange({
            projectId: entry.projectId,
            sessionIds: [entry.threadId],
            change: "delete",
          });
        } catch (error) {
          result.failed.push({
            sessionId: entry.threadId,
            message: errorMessage(error),
          });
        }
      }
      return result;
    });
  }

  async #listTrash(
    projectId: string,
    projectPath: string,
    cursor: string | null,
    searchTerm: string,
  ): Promise<SessionPage> {
    const offset = parseTrashCursor(cursor);
    const query = searchTerm.toLocaleLowerCase();
    const entries = this.#trash.list(projectId)
      .sort((left, right) => right.deletedAt - left.deletedAt);
    const sessions: SessionSummary[] = [];
    let index = offset;
    let reads = 0;
    while (
      index < entries.length && sessions.length < PAGE_SIZE &&
      reads < MAX_TRASH_READS_PER_REQUEST
    ) {
      const entry = entries[index++]!;
      reads += 1;
      try {
        const thread = await this.#readOwnedThread(projectPath, entry.threadId);
        const summary = toSessionSummary(thread);
        if (
          query &&
          !summary.title.toLocaleLowerCase().includes(query) &&
          !summary.preview.toLocaleLowerCase().includes(query)
        ) {
          continue;
        }
        sessions.push({
          ...summary,
          state: summary.state === "active" ? "idle" : summary.state,
          deletedAt: entry.deletedAt,
          purgeAt: entry.deletedAt + TRASH_RETENTION_SECONDS,
        });
      } catch {
        // 会话可能被 Codex 的其他客户端直接删除；保留登记供自动清理重试，
        // 但不要让一个陈旧条目阻断整个回收站列表。
      }
    }
    return {
      sessions,
      nextCursor: index < entries.length ? `trash:${index}` : null,
    };
  }

  async #mutateMany(
    projectId: string,
    threadIds: string[],
    change: SessionChangeEvent["change"],
    operation: (projectPath: string, threadId: string) => Promise<void>,
  ): Promise<SessionMutationResult> {
    return this.#serializeMutation(async () => {
      const project = await this.#projects.resolve(projectId);
      const result: SessionMutationResult = { succeeded: [], failed: [] };
      for (const threadId of [...new Set(threadIds)]) {
        try {
          await operation(project.path, threadId);
          result.succeeded.push(threadId);
        } catch (error) {
          result.failed.push({ sessionId: threadId, message: errorMessage(error) });
        }
      }
      if (result.succeeded.length > 0) {
        this.#emitChange({ projectId, sessionIds: result.succeeded, change });
      }
      return result;
    });
  }

  #emitChange(event: SessionChangeEvent): void {
    for (const listener of this.#changeListeners) {
      try {
        listener(event);
      } catch {
        // 一个浏览器连接的通知失败不应中断已经完成的会话整理操作。
      }
    }
  }

  #serializeMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(() => {}, () => {});
    return result;
  }

  async #readOwnedThread(projectPath: string, threadId: string): Promise<Thread> {
    if (!threadId.trim()) throw new Error("Codex 会话 ID 不能为空。");
    const params: ThreadReadParams = { threadId, includeTurns: false };
    const response = await this.#transport.request<ThreadReadResponse>("thread/read", params);
    assertOpenedThreadResponse(response);
    if (response.thread.id !== threadId) {
      throw new Error("Codex 返回了错误的会话。");
    }
    await assertThreadBelongsToProject(response.thread, projectPath);
    return response.thread;
  }
}

function toOpenedSession(
  response: ThreadStartResponse | ThreadResumeResponse,
): OpenedSession {
  const thread = response.thread;
  const experimental = response as typeof response & {
    activePermissionProfile?: { id: string; extends: string | null } | null;
  };
  return {
    session: toSessionSummary(thread),
    turns: thread.turns,
    activeTurnId: findActiveTurnId(thread),
    runtime: {
      cwd: response.cwd,
      historyMode: thread.historyMode,
      model: response.model,
      reasoningEffort: response.reasoningEffort,
      approvalPolicy: response.approvalPolicy,
      sandboxPolicy: response.sandbox,
      activePermissionProfile: experimental.activePermissionProfile ?? null,
    },
  };
}

function toSessionSummary(thread: Thread): SessionSummary {
  const preview = thread.preview.trim();
  const name = thread.name?.trim();
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    title: name || preview || "新会话",
    preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    state: thread.status.type === "notLoaded"
      ? "not_loaded"
      : thread.status.type === "systemError"
      ? "error"
      : thread.status.type,
    deletedAt: null,
    purgeAt: null,
  };
}

function assertThreadCanBeManaged(thread: Thread): void {
  if (thread.status.type === "active") {
    throw new Error("这个会话仍有任务正在运行，暂时不能整理。");
  }
}

function parseTrashCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^trash:(\d+)$/u.exec(cursor);
  const offset = match?.[1] === undefined ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("回收站分页标记无法识别。");
  }
  return offset;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败。";
}

function findActiveTurnId(thread: Thread): string | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn?.status === "inProgress") {
      return turn.id;
    }
  }
  return null;
}

async function assertThreadBelongsToProject(
  thread: Thread,
  projectPath: string,
): Promise<void> {
  if (!await threadBelongsToProject(thread, projectPath)) {
    throw new Error("这个会话不属于所选项目。");
  }
}

async function threadBelongsToProject(
  thread: Thread,
  projectPath: string,
): Promise<boolean> {
  try {
    return await realpath(thread.cwd) === projectPath;
  } catch {
    return false;
  }
}

function assertThreadListResponse(value: unknown): asserts value is ThreadListResponse {
  if (
    !isObject(value) ||
    !Array.isArray(value.data) ||
    !(value.nextCursor === null || typeof value.nextCursor === "string") ||
    !value.data.every(isThread)
  ) {
    throw new Error("Codex 返回了无法识别的会话列表。");
  }
}

function assertOpenedThreadResponse(
  value: unknown,
): asserts value is ThreadStartResponse | ThreadResumeResponse | ThreadReadResponse {
  if (!isObject(value) || !isThread(value.thread)) {
    throw new Error("Codex 返回了无法识别的会话数据。");
  }
}

function isThread(value: unknown): value is Thread {
  if (!isObject(value) || !isObject(value.status)) {
    return false;
  }
  const status = value.status.type;
  return typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.preview === "string" &&
    (value.name === null || typeof value.name === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.turns) &&
    (status === "notLoaded" || status === "idle" || status === "active" || status === "systemError");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
