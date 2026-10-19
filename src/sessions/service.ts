import { realpath } from "node:fs/promises";

import type { Thread } from "../generated/v2/Thread.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { ThreadHistoryMode } from "../generated/v2/ThreadHistoryMode.ts";
import type { ThreadArchiveParams } from "../generated/v2/ThreadArchiveParams.ts";
import type { ThreadArchiveResponse } from "../generated/v2/ThreadArchiveResponse.ts";
import type { ThreadListParams } from "../generated/v2/ThreadListParams.ts";
import type { ThreadListResponse } from "../generated/v2/ThreadListResponse.ts";
import type { ThreadReadParams } from "../generated/v2/ThreadReadParams.ts";
import type { ThreadReadResponse } from "../generated/v2/ThreadReadResponse.ts";
import type { ThreadResumeParams } from "../generated/v2/ThreadResumeParams.ts";
import type { ThreadResumeResponse } from "../generated/v2/ThreadResumeResponse.ts";
import type { ThreadStartParams } from "../generated/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "../generated/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListParams } from "../generated/v2/ThreadTurnsListParams.ts";
import type { ThreadTurnsListResponse } from "../generated/v2/ThreadTurnsListResponse.ts";
import type { ThreadSetNameParams } from "../generated/v2/ThreadSetNameParams.ts";
import type { ThreadSetNameResponse } from "../generated/v2/ThreadSetNameResponse.ts";
import type { ThreadUnarchiveParams } from "../generated/v2/ThreadUnarchiveParams.ts";
import type { ThreadUnarchiveResponse } from "../generated/v2/ThreadUnarchiveResponse.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import { AppServerRpcError } from "../app-server/client.ts";
import {
  TrashStore,
  type TrashEntry,
  type TrashOrigin,
} from "./trash-store.ts";
import { MarkStore } from "./mark-store.ts";
import {
  type DeletedSessionArtifacts,
  SessionDeletionCoordinator,
} from "./deletion-coordinator.ts";
import type { ApplicationSettingsStore } from "../settings/store.ts";
import { permissionSettings } from "../app-server/permissions.ts";
import { isObject } from "../shared/json.ts";
import { isPublicError, PublicError } from "../shared/public-error.ts";

const PAGE_SIZE = 50;
const REPLY_LOOKUP_PAGE_SIZE = 20;
const REPLY_LOOKUP_CONCURRENCY = 8;
const REPLY_LOOKUP_CACHE_SIZE = 500;

/** Maximum app-server pages fetched per browser request, preventing unbounded scans when whole pages are filtered out. */
const MAX_LIST_PAGES_PER_REQUEST = 10;

/** Maximum trash entries read per request, preventing a search miss from scanning the entire trash. */
const MAX_TRASH_READS_PER_REQUEST = 200;
const VISIBLE_SOURCE_KINDS = ["cli", "vscode", "appServer"] as const;
const CODEX_REMOTE_ORIGINATOR = "codex_remote";
export const TRASH_RETENTION_SECONDS = 30 * 24 * 60 * 60;

class SessionOperationError extends PublicError {
  constructor(message: string) {
    super(message);
    this.name = "SessionOperationError";
  }
}

export const CODEX_REMOTE_DEVELOPER_INSTRUCTIONS = [
  "Codex Remote is a remote-use platform made of a browser PWA and a local backend. It connects Codex to a web page through the Codex App Server, so the user can use Codex from a phone or a computer. You are talking with the user through Codex Remote. The user sends messages from the web page and sees the Codex Remote browser interface, not the Codex CLI terminal interface.",
  "The backend service `codex-remote` hosts this conversation and is part of the current session's runtime. Modifying, restarting or stopping the service's process, configuration or network connection may interrupt the current session. Before any operation that touches Codex Remote itself, explain the impact first. Do the operations and checks you can do yourself; use a delayed restart when needed. If the user must restart the service outside the current session, give only the minimal command needed.",
  "Markdown documents and images that need to be shown to the user fall into two categories. Permanent files go in their proper locations inside the current project. Temporary previews used only for comparison, selection or experimentation always go in ~/preview, whatever the project, and are not added to Git; the user deletes them after viewing. Do not put these files in ~/.codex or /tmp. In your reply, provide a Markdown link whose target is /view?path= followed by the URL-encoded absolute path.",
].join("\n\n");

export function composeDeveloperInstructions(custom = ""): string {
  return custom.trim()
    ? `${CODEX_REMOTE_DEVELOPER_INSTRUCTIONS}\n\n${custom}`
    : CODEX_REMOTE_DEVELOPER_INSTRUCTIONS;
}

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

/** Browser-visible session summary; deliberately excludes absolute host paths. */
export type SessionSummary = {
  id: string;
  sessionId: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  lastReplyAt: number | null;
  state: SessionState;
  projectId: string;
  marked: boolean;
  deletedAt: number | null;
  purgeAt: number | null;
};

export type SessionPage = {
  sessions: SessionSummary[];
  /** Cross-project pinned entries in “Recent sessions”; excluded from pagination. Empty for archive and trash views. */
  marked: SessionSummary[];
  nextCursor: string | null;
};

export type SessionMutationResult = {
  succeeded: string[];
  failed: Array<{ sessionId: string; message: string }>;
};

export type TrashCleanupResult = {
  /** Interrupted trash or restore operations advanced to a terminal state. */
  settled: number;
  deleted: number;
  failed: Array<{ sessionId: string; message: string }>;
};

export type SessionChangeEvent = {
  projectId: string;
  sessionIds: string[];
  change: "archive" | "unarchive" | "trash" | "restore" | "delete" | "mark" | "unmark" | "rename";
};

export type OpenedSession = {
  session: SessionSummary;
  turns: Thread["turns"];
  activeTurnId: string | null;
  runtime: SessionRuntime;
  /** Notice that global defaults could not be used for creation; present only when `start()` falls back. */
  settingsNotice?: string;
};

/** Current session runtime settings stored only on the backend; cwd cannot leak through the browser history API. */
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
 * Translates a project ID selected by the browser into app-server session requests.
 * Every path comes from ProjectCatalog; a cwd supplied directly by the browser is never accepted.
 */
export class CodexSessionService {
  readonly #transport: AppServerRequester;
  readonly #projects: ProjectCatalog;
  readonly #trash: TrashStore;
  readonly #marks: MarkStore | null;
  readonly #settings: ApplicationSettingsStore | null;
  readonly #deletions: SessionDeletionCoordinator;
  readonly #now: () => number;
  readonly #changeListeners = new Set<(event: SessionChangeEvent) => void>();
  readonly #replyLookups = new Map<
    string,
    { updatedAt: number; result: Promise<number | null> }
  >();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    transport: AppServerRequester,
    projects: ProjectCatalog,
    trash: TrashStore,
    options: {
      now?: () => number;
      marks?: MarkStore;
      settings?: ApplicationSettingsStore;
      deletedSessionArtifacts?: DeletedSessionArtifacts;
    } = {},
  ) {
    this.#transport = transport;
    this.#projects = projects;
    this.#trash = trash;
    this.#marks = options.marks ?? null;
    this.#settings = options.settings ?? null;
    this.#deletions = new SessionDeletionCoordinator(transport, trash, {
      ...(options.marks ? { marks: options.marks } : {}),
      ...(options.deletedSessionArtifacts
        ? { artifacts: options.deletedSessionArtifacts }
        : {}),
    });
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  #developerInstructions(): string {
    return composeDeveloperInstructions(this.#settings?.get().developerInstructions ?? "");
  }

  isMarked(threadId: string): boolean {
    return this.#marks?.has(threadId) ?? false;
  }

  onChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  async list(projectId: string, options: SessionListOptions = {}): Promise<SessionPage> {
    const view = options.view ?? "active";
    const searchTerm = options.searchTerm?.trim() ?? "";
    if (view === "trash") {
      // resolve() validates the project allowlist and prevents stale project IDs from leaking summaries through the list API.
      const project = await this.#projects.resolve(projectId);
      const page = await this.#listTrash(
        projectId,
        project.path,
        options.cursor ?? null,
        searchTerm,
      );
      return { ...page, marked: [] };
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
    const markedIds = new Set(
      view === "active" ? this.#marks?.list().map((entry) => entry.threadId) ?? [] : [],
    );

    // The archive view excludes trash entries. If an entire page is filtered out, continue scanning to avoid
    // showing the browser an intermediate “empty list that can still load more” state. Page count must be bounded or a
    // project full of trash entries could make one browser request issue unlimited RPCs.
    for (let page = 0; page < MAX_LIST_PAGES_PER_REQUEST; page += 1) {
      const response = await this.#transport.request<ThreadListResponse>(
        "thread/list",
        params,
      );
      assertThreadListResponse(response);

      const sessions: SessionSummary[] = [];
      for (const thread of response.data) {
        // app-server already filters by cwd; check again here to enforce the allowlist boundary.
        if (
          isCodexRemoteThread(thread) &&
          !this.#trash.has(thread.id) &&
          !markedIds.has(thread.id) &&
          await threadBelongsToProject(thread, project.path)
        ) {
          sessions.push(toSessionSummary(thread, projectId, false));
        }
      }
      if (sessions.length > 0 || response.nextCursor === null) {
        const marked = view === "active" ? await this.#listMarked(searchTerm) : [];
        await this.#populateLastReplyTimes([...sessions, ...marked]);
        return {
          sessions,
          marked,
          nextCursor: response.nextCursor,
        };
      }
      params.cursor = response.nextCursor;
    }
    // Reaching here means several consecutive pages were filtered empty. Return the cursor so the browser can continue with “Load more”.
    const marked = view === "active" ? await this.#listMarked(searchTerm) : [];
    await this.#populateLastReplyTimes(marked);
    return {
      sessions: [],
      marked,
      nextCursor: params.cursor ?? null,
    };
  }

  async start(projectId: string): Promise<OpenedSession> {
    const project = await this.#projects.resolve(projectId);
    const settings = this.#settings?.get();
    const params: ThreadStartParams = {
      cwd: project.path,
      ephemeral: false,
      serviceName: "codex_remote",
      developerInstructions: this.#developerInstructions(),
      ...(settings?.defaultModel ? { model: settings.defaultModel } : {}),
      ...(settings?.defaultReasoningEffort
        ? { config: { model_reasoning_effort: settings.defaultReasoningEffort } }
        : {}),
    };
    let settingsNotice: string | null = null;
    let response: ThreadStartResponse;
    if (settings?.defaultPermissions) {
      // Generated types predate the `permissions` field; testing with 0.159.2 confirms that thread/start accepts it.
      const withPermissions = {
        ...params,
        ...permissionSettings(settings.defaultPermissions),
      } as ThreadStartParams;
      try {
        response = await this.#transport.request<ThreadStartResponse>(
          "thread/start",
          withPermissions,
        );
      } catch (error) {
        if (!isUnknownPermissionProfileError(error)) throw error;
        console.warn(
          `默认权限方案不可用，改用 Codex 默认权限新建会话：${settings.defaultPermissions}：` +
            (error instanceof Error ? error.message : String(error)),
        );
        settingsNotice = "设置里的默认权限当前不可用，这次新会话改用了 Codex 默认权限。";
        response = await this.#transport.request<ThreadStartResponse>("thread/start", params);
      }
    } else {
      response = await this.#transport.request<ThreadStartResponse>("thread/start", params);
    }
    assertOpenedThreadResponse(response);
    await assertThreadBelongsToProject(response.thread, project.path);
    const opened = toOpenedSession(response, projectId, this.isMarked(response.thread.id));
    return settingsNotice ? { ...opened, settingsNotice } : opened;
  }

  async resume(projectId: string, threadId: string): Promise<OpenedSession> {
    if (!threadId.trim()) {
      throw new SessionOperationError("Codex 会话 ID 不能为空。");
    }
    if (this.#trash.has(threadId)) {
      throw new SessionOperationError("这个会话在回收站中，请先恢复后再打开。");
    }

    const project = await this.#projects.resolve(projectId);
    const readParams: ThreadReadParams = { threadId, includeTurns: false };
    const stored = await this.#transport.request<ThreadReadResponse>(
      "thread/read",
      readParams,
    );
    assertOpenedThreadResponse(stored);
    if (stored.thread.id !== threadId) {
      throw new Error("Codex returned the wrong session.");
    }
    await assertThreadBelongsToProject(stored.thread, project.path);

    const resumeParams: ThreadResumeParams = {
      threadId,
      cwd: project.path,
      developerInstructions: this.#developerInstructions(),
    };
    const response = await this.#transport.request<ThreadResumeResponse>(
      "thread/resume",
      resumeParams,
    );
    assertOpenedThreadResponse(response);
    if (response.thread.id !== threadId) {
      throw new Error("Codex returned the wrong session.");
    }
    await assertThreadBelongsToProject(response.thread, project.path);
    return toOpenedSession(response, projectId, this.isMarked(threadId));
  }

  setMarked(projectId: string, threadId: string, marked: boolean): Promise<SessionSummary> {
    return this.#serializeMutation(async () => {
      if (!this.#marks) {
        throw new SessionOperationError("当前后端没有启用会话钉住。");
      }
      if (!threadId.trim()) {
        throw new SessionOperationError("Codex 会话 ID 不能为空。");
      }
      if (!marked) {
        await this.#marks.remove(threadId);
        this.#emitChange({ projectId, sessionIds: [threadId], change: "unmark" });
        return this.#markedSummary(projectId, threadId, false);
      }
      const project = await this.#projects.resolve(projectId);
      const thread = await this.#readOwnedThread(project.path, threadId);
      if (this.#trash.has(threadId)) {
        throw new SessionOperationError("回收站里的会话不能钉住，请先恢复。");
      }
      await this.#marks.put({ threadId, projectId });
      this.#emitChange({ projectId, sessionIds: [threadId], change: "mark" });
      return toSessionSummary(thread, projectId, true);
    });
  }

  rename(projectId: string, threadId: string, title: string): Promise<SessionSummary> {
    return this.#serializeMutation(async () => {
      const trimmed = title.trim();
      if (!trimmed) {
        throw new SessionOperationError("会话名称不能为空。");
      }
      if (trimmed.length > 160 || trimmed.includes("\n")) {
        throw new SessionOperationError("会话名称请控制在 160 个字以内，并且不要换行。");
      }
      const project = await this.#projects.resolve(projectId);
      const thread = await this.#readOwnedThread(project.path, threadId);
      const params: ThreadSetNameParams = { threadId, name: trimmed };
      await this.#transport.request<ThreadSetNameResponse>("thread/name/set", params);
      this.#emitChange({ projectId, sessionIds: [threadId], change: "rename" });
      return toSessionSummary(
        { ...thread, name: trimmed },
        projectId,
        this.#marks?.has(threadId) ?? false,
      );
    });
  }

  archive(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "archive", async (projectPath, threadId) => {
      if (this.#trash.has(threadId)) {
        throw new SessionOperationError("这个会话已经在回收站中。");
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
        throw new SessionOperationError("这个会话在回收站中，请从回收站恢复。");
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
      const existing = this.#trash.get(threadId);
      if (existing?.state === "trashed" || existing?.state === "deleting") return;
      const thread = await this.#readOwnedThread(projectPath, threadId);
      assertThreadCanBeManaged(thread);
      if ((existing?.origin ?? origin) === "archived") {
        await this.#trash.put({
          threadId,
          projectId,
          deletedAt: this.#now(),
          origin: "archived",
          state: "trashed",
        });
        return;
      }
      // Codex and this list are separate authorities. Persist the `trashing` credential before archiving;
      // if any step fails or exits, the entry remains for this path or periodic cleanup to advance, without rollback.
      const pending: TrashEntry = existing?.state === "trashing"
        ? existing
        : { threadId, projectId, deletedAt: this.#now(), origin: "active", state: "trashing" };
      if (existing?.state !== "trashing") await this.#trash.put(pending);
      await this.#finishTrashing(pending);
    });
  }

  restoreTrash(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "restore", async (projectPath, threadId) => {
      const entry = this.#trash.get(threadId);
      if (!entry || entry.projectId !== projectId) {
        throw new SessionOperationError("这个会话不在当前项目的回收站中。");
      }
      if (entry.state === "deleting") {
        throw new SessionOperationError("这个会话正在永久删除，不能恢复。");
      }
      const thread = await this.#readOwnedThread(projectPath, threadId);
      assertThreadCanBeManaged(thread);
      if (entry.origin === "archived") {
        await this.#trash.remove(threadId);
        return;
      }
      const pending: TrashEntry = entry.state === "restoring"
        ? entry
        : { ...entry, state: "restoring" };
      if (entry.state !== "restoring") await this.#trash.put(pending);
      await this.#finishRestoring(pending);
    });
  }

  deleteTrash(projectId: string, threadIds: string[]): Promise<SessionMutationResult> {
    return this.#mutateMany(projectId, threadIds, "delete", async (_projectPath, threadId) => {
      const entry = this.#trash.get(threadId);
      if (!entry || entry.projectId !== projectId) {
        throw new SessionOperationError("只能永久删除回收站里的会话。");
      }
      await this.#deletions.delete(entry);
    });
  }

  /**
   * Entry point for startup and daily cleanup: first advances unfinished trash and restore operations to
   * terminal states, then permanently deletes `deleting` entries and expired trash entries. Transitional
   * entries that fail to advance remain for the next run and are not deleted as expired.
   */
  async purgeExpired(): Promise<TrashCleanupResult> {
    const result: TrashCleanupResult = { settled: 0, deleted: 0, failed: [] };
    const unsettledIds = this.#trash.list()
      .filter((entry) => entry.state === "trashing" || entry.state === "restoring")
      .map((entry) => entry.threadId);
    for (const threadId of unsettledIds) {
      await this.#serializeMutation(async () => {
        const entry = this.#trash.get(threadId);
        if (!entry || (entry.state !== "trashing" && entry.state !== "restoring")) return;
        try {
          if (entry.state === "trashing") await this.#finishTrashing(entry);
          else await this.#finishRestoring(entry);
          result.settled += 1;
          this.#emitChange({
            projectId: entry.projectId,
            sessionIds: [entry.threadId],
            change: entry.state === "trashing" ? "trash" : "restore",
          });
        } catch (error) {
          result.failed.push({
            sessionId: entry.threadId,
            message: describeFailure(error),
          });
        }
      });
    }

    const threshold = this.#now() - TRASH_RETENTION_SECONDS;
    const expiredIds = this.#trash.list()
      .filter((entry) =>
        entry.state === "deleting" ||
        (entry.state === "trashed" && entry.deletedAt <= threshold)
      )
      .map((entry) => entry.threadId);
    for (const threadId of expiredIds) {
      await this.#serializeMutation(async () => {
        const entry = this.#trash.get(threadId);
        const currentThreshold = this.#now() - TRASH_RETENTION_SECONDS;
        if (
          !entry ||
          (entry.state !== "deleting" &&
            (entry.state !== "trashed" || entry.deletedAt > currentThreshold))
        ) return;
        try {
          await this.#deletions.delete(entry);
          result.deleted += 1;
          this.#emitChange({
            projectId: entry.projectId,
            sessionIds: [entry.threadId],
            change: "delete",
          });
        } catch (error) {
          result.failed.push({
            sessionId: entry.threadId,
            message: describeFailure(error),
          });
        }
      });
    }
    return result;
  }

  /**
   * `trashing` → `trashed`. When the session is already absent from Codex's active list, `thread/archive`
   * returns the exact `no rollout found` error for that thread, which is treated as evidence of prior success.
   */
  async #finishTrashing(entry: TrashEntry): Promise<void> {
    const params: ThreadArchiveParams = { threadId: entry.threadId };
    await this.#requestUnlessAlreadyDone(
      "thread/archive",
      params,
      `no rollout found for thread id ${entry.threadId}`,
    );
    await this.#trash.put({ ...entry, state: "trashed" });
  }

  /**
   * `restoring` → remove entry. When the session is already absent from the Codex archive,
   * `thread/unarchive` returns the exact `no archived rollout found` error for that thread, which is treated
   * as evidence of prior success.
   */
  async #finishRestoring(entry: TrashEntry): Promise<void> {
    const params: ThreadUnarchiveParams = { threadId: entry.threadId };
    await this.#requestUnlessAlreadyDone(
      "thread/unarchive",
      params,
      `no archived rollout found for thread id ${entry.threadId}`,
    );
    await this.#trash.remove(entry.threadId);
  }

  async #requestUnlessAlreadyDone(
    method: string,
    params: unknown,
    alreadyDoneMessage: string,
  ): Promise<void> {
    try {
      await this.#transport.request(method, params);
    } catch (error) {
      if (!isInvalidRequest(error, alreadyDoneMessage)) throw error;
    }
  }

  async #listTrash(
    projectId: string,
    projectPath: string,
    cursor: string | null,
    searchTerm: string,
  ): Promise<SessionPage> {
    const offset = parseTrashCursor(cursor);
    const query = searchTerm.toLocaleLowerCase();
    // Include unfinished trash and restore operations here. They appear in neither active nor archived lists,
    // making trash the only place where they remain visible and can be restored again.
    const entries = this.#trash.list(projectId)
      .filter((entry) => entry.state !== "deleting")
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
        if (!isCodexRemoteThread(thread)) continue;
        const summary = toSessionSummary(thread, projectId, this.#marks?.has(thread.id) ?? false);
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
        // Another Codex client may have deleted the session directly. Retain the entry for automatic cleanup
        // to retry, but do not let one stale entry block the entire trash list.
      }
    }
    return {
      sessions,
      marked: [],
      nextCursor: index < entries.length ? `trash:${index}` : null,
    };
  }

  async #listMarked(searchTerm: string): Promise<SessionSummary[]> {
    if (!this.#marks) return [];
    const query = searchTerm.toLocaleLowerCase();
    const entries = this.#marks.list();
    const notActiveIds = await this.#marksNotConfirmedActive(entries);
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (this.#trash.has(entry.threadId) || notActiveIds.has(entry.threadId)) continue;
      try {
        const params: ThreadReadParams = { threadId: entry.threadId, includeTurns: false };
        const response = await this.#transport.request<ThreadReadResponse>("thread/read", params);
        assertOpenedThreadResponse(response);
        if (response.thread.id !== entry.threadId || !isCodexRemoteThread(response.thread)) continue;
        const summary = toSessionSummary(response.thread, entry.projectId, true);
        if (
          query &&
          !summary.title.toLocaleLowerCase().includes(query) &&
          !summary.preview.toLocaleLowerCase().includes(query)
        ) {
          continue;
        }
        summaries.push(summary);
      } catch {
        // Another client may have deleted the session; retain the pinned entry for now and omit it from the list.
      }
    }
    summaries.sort((left, right) =>
      right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
    );
    return summaries;
  }

  /**
   * Determines which pinned sessions cannot appear in “Recent”: archived sessions and those whose state
   * cannot be confirmed within the page limit.
   *
   * Search the archived list first; a session is confirmed active only after that list is exhausted without
   * finding it. If the archived list exceeds the limit, perform a bounded check for the remaining sessions in
   * the active list. Only sessions found there count as active; exclude all others as unknown rather than
   * assuming they are active because the scan reached its limit.
   */
  async #marksNotConfirmedActive(
    entries: Array<{ threadId: string; projectId: string }>,
  ): Promise<Set<string>> {
    const excluded = new Set<string>();
    const byProject = new Map<string, string[]>();
    for (const entry of entries) {
      const ids = byProject.get(entry.projectId) ?? [];
      ids.push(entry.threadId);
      byProject.set(entry.projectId, ids);
    }
    for (const [projectId, threadIds] of byProject) {
      let projectPath: string;
      try {
        projectPath = (await this.#projects.resolve(projectId)).path;
      } catch {
        continue;
      }
      const unresolved = new Set(threadIds);
      const archived = await this.#findInThreadList(projectPath, true, unresolved);
      for (const threadId of archived.found) excluded.add(threadId);
      if (unresolved.size === 0 || archived.exhausted) continue;
      await this.#findInThreadList(projectPath, false, unresolved);
      for (const threadId of unresolved) excluded.add(threadId);
    }
    return excluded;
  }

  /**
   * Searches a project's archived or active list for threads in `wanted`, reading at most
   * `MAX_LIST_PAGES_PER_REQUEST` pages. Found threads are removed from `wanted`; `exhausted` indicates the
   * entire list was read, so any missing thread is known not to be in that list.
   */
  async #findInThreadList(
    projectPath: string,
    archived: boolean,
    wanted: Set<string>,
  ): Promise<{ found: string[]; exhausted: boolean }> {
    const found: string[] = [];
    const params: ThreadListParams = {
      cursor: null,
      limit: PAGE_SIZE,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: [...VISIBLE_SOURCE_KINDS],
      cwd: projectPath,
      archived,
    };
    for (let page = 0; page < MAX_LIST_PAGES_PER_REQUEST && wanted.size > 0; page += 1) {
      const response = await this.#transport.request<ThreadListResponse>("thread/list", params);
      assertThreadListResponse(response);
      for (const thread of response.data) {
        if (wanted.delete(thread.id)) found.push(thread.id);
      }
      if (response.nextCursor === null) return { found, exhausted: true };
      params.cursor = response.nextCursor;
    }
    return { found, exhausted: false };
  }

  async #markedSummary(
    projectId: string,
    threadId: string,
    marked: boolean,
  ): Promise<SessionSummary> {
    try {
      const params: ThreadReadParams = { threadId, includeTurns: false };
      const response = await this.#transport.request<ThreadReadResponse>("thread/read", params);
      assertOpenedThreadResponse(response);
      if (response.thread.id === threadId) {
        return toSessionSummary(response.thread, projectId, marked);
      }
    } catch {
      // The project or thread may already be gone when unpinning; still return the state to the page.
    }
    return {
      id: threadId,
      sessionId: threadId,
      title: "新会话",
      preview: "",
      createdAt: 0,
      updatedAt: 0,
      lastReplyAt: null,
      state: "not_loaded",
      projectId,
      marked,
      deletedAt: null,
      purgeAt: null,
    };
  }

  async #populateLastReplyTimes(sessions: SessionSummary[]): Promise<void> {
    let nextIndex = 0;
    const populate = async () => {
      while (nextIndex < sessions.length) {
        const session = sessions[nextIndex++];
        if (!session) continue;
        try {
          session.lastReplyAt = await this.#lastReplyAt(session.id, session.updatedAt);
        } catch {
          // Reply time is supplemental list information; a read failure must not remove the entire session list.
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(REPLY_LOOKUP_CONCURRENCY, sessions.length) },
        populate,
      ),
    );
  }

  #lastReplyAt(threadId: string, updatedAt: number): Promise<number | null> {
    const cached = this.#replyLookups.get(threadId);
    if (cached?.updatedAt === updatedAt) return cached.result;

    const result = this.#readLastReplyAt(threadId).catch((error) => {
      if (this.#replyLookups.get(threadId)?.result === result) {
        this.#replyLookups.delete(threadId);
      }
      throw error;
    });
    this.#replyLookups.delete(threadId);
    this.#replyLookups.set(threadId, { updatedAt, result });
    while (this.#replyLookups.size > REPLY_LOOKUP_CACHE_SIZE) {
      const oldest = this.#replyLookups.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#replyLookups.delete(oldest);
    }
    return result;
  }

  async #readLastReplyAt(threadId: string): Promise<number | null> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();

    while (true) {
      const params: ThreadTurnsListParams = {
        threadId,
        cursor,
        limit: REPLY_LOOKUP_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "summary",
      };
      const response = await this.#transport.request<ThreadTurnsListResponse>(
        "thread/turns/list",
        params,
      );
      if (!response || !Array.isArray(response.data)) {
        throw new Error("Codex returned an unrecognized turn list.");
      }

      const lastReplyAt = replyTimeFromTurns(response.data);
      if (lastReplyAt !== null) return lastReplyAt;
      if (response.nextCursor === null) return null;
      if (
        typeof response.nextCursor !== "string" ||
        seenCursors.has(response.nextCursor)
      ) {
        throw new Error("Codex returned an unrecognized turn cursor.");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
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
          result.failed.push({ sessionId: threadId, message: describeFailure(error) });
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
        // A notification failure on one browser connection must not interrupt an already completed organization operation.
      }
    }
  }

  #serializeMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(() => {}, () => {});
    return result;
  }

  async #readOwnedThread(projectPath: string, threadId: string): Promise<Thread> {
    if (!threadId.trim()) throw new SessionOperationError("Codex 会话 ID 不能为空。");
    const params: ThreadReadParams = { threadId, includeTurns: false };
    const response = await this.#transport.request<ThreadReadResponse>("thread/read", params);
    assertOpenedThreadResponse(response);
    if (response.thread.id !== threadId) {
      throw new Error("Codex returned the wrong session.");
    }
    await assertThreadBelongsToProject(response.thread, projectPath);
    return response.thread;
  }
}

/**
 * When Codex rejects an unknown permission profile, it returns only generic -32600 and an explanatory sentence,
 * with no structured field to inspect. Match the wording observed in 0.159.2:
 * `failed to load configuration: default_permissions refers to unknown built-in profile`.
 * Unrecognized errors are rethrown unchanged rather than falling back to defaults.
 */
export function isUnknownPermissionProfileError(error: unknown): boolean {
  return error instanceof AppServerRpcError &&
    /default_permissions refers to unknown/u.test(error.message);
}

function toOpenedSession(
  response: ThreadStartResponse | ThreadResumeResponse,
  projectId: string,
  marked: boolean,
): OpenedSession {
  const thread = response.thread;
  const experimental = response as typeof response & {
    activePermissionProfile?: { id: string; extends: string | null } | null;
  };
  return {
    session: toSessionSummary(thread, projectId, marked),
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

function isCodexRemoteThread(thread: Thread): boolean {
  return thread.originator === CODEX_REMOTE_ORIGINATOR;
}

function toSessionSummary(thread: Thread, projectId: string, marked: boolean): SessionSummary {
  const preview = thread.preview.trim();
  const name = thread.name?.trim();
  return {
    id: thread.id,
    sessionId: thread.sessionId,
    title: name || preview || "新会话",
    preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastReplyAt: replyTimeFromTurns(thread.turns),
    state: thread.status.type === "notLoaded"
      ? "not_loaded"
      : thread.status.type === "systemError"
      ? "error"
      : thread.status.type,
    projectId,
    marked,
    deletedAt: null,
    purgeAt: null,
  };
}

function replyTimeFromTurns(turns: Turn[]): number | null {
  let lastReplyAt: number | null = null;
  for (const turn of turns) {
    if (
      typeof turn.completedAt === "number" &&
      Array.isArray(turn.items) &&
      turn.items.some((item) => item.type === "agentMessage")
    ) {
      lastReplyAt = Math.max(lastReplyAt ?? 0, turn.completedAt);
    }
  }
  return lastReplyAt;
}

function assertThreadCanBeManaged(thread: Thread): void {
  if (thread.status.type === "active") {
    throw new SessionOperationError("这个会话仍有任务正在运行，暂时不能整理。");
  }
}

function parseTrashCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^trash:(\d+)$/u.exec(cursor);
  const offset = match?.[1] === undefined ? NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SessionOperationError("回收站分页标记无法识别。");
  }
  return offset;
}

/**
 * Successful session-organization DTOs also cross the browser's public boundary. Preserve messages only for
 * explicit business errors; original text from App Server, the file system, and unknown exceptions goes only to service logs.
 */
function describeFailure(error: unknown): string {
  if (isPublicError(error)) return error.message;
  console.error(`Session mutation error withheld from the browser: ${privateErrorMessage(error)}`);
  return "会话整理失败，请查看服务日志。";
}

function privateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInvalidRequest(error: unknown, message: string): boolean {
  return error instanceof AppServerRpcError &&
    error.code === -32600 &&
    error.message === message;
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
    throw new SessionOperationError("这个会话不属于所选项目。");
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
    throw new Error("Codex returned an unrecognized session list.");
  }
}

function assertOpenedThreadResponse(
  value: unknown,
): asserts value is ThreadStartResponse | ThreadResumeResponse | ThreadReadResponse {
  if (!isObject(value) || !isThread(value.thread)) {
    throw new Error("Codex returned unrecognized session data.");
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
