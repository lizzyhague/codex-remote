import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PublicAttachment } from "../shared-upload/types.ts";

export type WorkerTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_permission"
  | "completed"
  | "interrupted"
  | "failed";

export type WorkerTaskKind = "message" | "compact" | "review";
export type WorkerPermissionMode = "manual" | "full_access";

export type WorkerTask = {
  id: string;
  clientMessageId: string;
  projectId: string;
  threadId: string;
  kind: WorkerTaskKind;
  payload: string;
  attachments: PublicAttachment[];
  status: WorkerTaskStatus;
  nativeTurnId: string | null;
  permissionMode: WorkerPermissionMode;
  createdAtMs: number;
  updatedAtMs: number;
  error: string | null;
  interruptionReason: string | null;
};

export type StoredWorkerEvent = {
  sequence: number;
  taskId: string;
  threadId: string;
  createdAtMs: number;
  event: Record<string, unknown> & { type: string };
};

export function resolveWorkerStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_REMOTE_WORK_STATE_FILE?.trim();
  if (configured) return path.resolve(configured);
  const stateHome = environment.XDG_STATE_HOME?.trim() ||
    path.join(homedir(), ".local", "state");
  return path.join(stateHome, "codex-remote", "work.sqlite");
}

/**
 * 已接受消息、任务状态与流事件的持久化日志。
 *
 * SQLite 事务保证 `accepted` 前消息已经落盘，也让 clientMessageId 的幂等约束
 * 在进程重启后仍然成立。事件正文只保存已经过后端脱敏的浏览器事件。
 */
export class WorkerStateStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  static async open(filePath: string): Promise<WorkerStateStore> {
    const absolute = path.resolve(filePath);
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(absolute);
    await chmod(absolute, 0o600);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS worker_tasks (
        id TEXT PRIMARY KEY,
        client_message_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        native_turn_id TEXT,
        permission_mode TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        error TEXT,
        interruption_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS worker_tasks_queue
        ON worker_tasks(status, created_at_ms);
      CREATE INDEX IF NOT EXISTS worker_tasks_thread
        ON worker_tasks(thread_id, created_at_ms);
      CREATE TABLE IF NOT EXISTS worker_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES worker_tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS worker_events_thread
        ON worker_events(thread_id, sequence);
      CREATE TABLE IF NOT EXISTS worker_session_settings (
        thread_id TEXT PRIMARY KEY,
        full_access_enabled INTEGER NOT NULL
          CHECK (full_access_enabled IN (0, 1)),
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    const taskColumns = database.prepare("PRAGMA table_info(worker_tasks)").all()
      .map((row) => String(asRow(row).name));
    if (!taskColumns.includes("attachments_json")) {
      database.exec("ALTER TABLE worker_tasks ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
    }
    return new WorkerStateStore(database);
  }

  sessionFullAccess(threadId: string): boolean | null {
    const row = this.#database.prepare(`
      SELECT full_access_enabled FROM worker_session_settings WHERE thread_id = ?
    `).get(threadId);
    if (!row) return null;
    return Number(asRow(row).full_access_enabled) === 1;
  }

  setSessionFullAccess(threadId: string, enabled: boolean, nowMs: number): void {
    this.#database.prepare(`
      INSERT INTO worker_session_settings (
        thread_id, full_access_enabled, updated_at_ms
      ) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        full_access_enabled = excluded.full_access_enabled,
        updated_at_ms = excluded.updated_at_ms
    `).run(threadId, enabled ? 1 : 0, nowMs);
  }

  enqueue(task: Omit<WorkerTask, "status" | "nativeTurnId" | "updatedAtMs" | "error" | "interruptionReason" | "attachments"> & {
    attachments?: PublicAttachment[];
  }): {
    task: WorkerTask;
    duplicate: boolean;
  } {
    const existing = this.findByClientMessageId(task.clientMessageId);
    if (existing) {
      if (
        existing.projectId !== task.projectId || existing.threadId !== task.threadId ||
        existing.kind !== task.kind || existing.payload !== task.payload ||
        JSON.stringify(existing.attachments) !== JSON.stringify(task.attachments ?? [])
      ) {
        throw new Error("clientMessageId 已被另一条消息使用。");
      }
      return { task: existing, duplicate: true };
    }

    this.#database.prepare(`
      INSERT INTO worker_tasks (
        id, client_message_id, project_id, thread_id, kind, payload, attachments_json, status,
        native_turn_id, permission_mode, created_at_ms, updated_at_ms, error,
        interruption_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, NULL, NULL)
    `).run(
      task.id,
      task.clientMessageId,
      task.projectId,
      task.threadId,
      task.kind,
      task.payload,
      JSON.stringify(task.attachments ?? []),
      task.permissionMode,
      task.createdAtMs,
      task.createdAtMs,
    );
    return { task: this.require(task.id), duplicate: false };
  }

  require(taskId: string): WorkerTask {
    const row = this.#database.prepare(
      "SELECT * FROM worker_tasks WHERE id = ?",
    ).get(taskId);
    const task = row ? readTaskRow(row) : null;
    if (!task) throw new Error(`找不到 Worker 任务：${taskId}`);
    return task;
  }

  findByClientMessageId(clientMessageId: string): WorkerTask | null {
    const row = this.#database.prepare(
      "SELECT * FROM worker_tasks WHERE client_message_id = ?",
    ).get(clientMessageId);
    return row ? readTaskRow(row) : null;
  }

  queued(): WorkerTask[] {
    return this.#database.prepare(
      "SELECT * FROM worker_tasks WHERE status = 'queued' ORDER BY created_at_ms, id",
    ).all().map(readTaskRow);
  }

  activeForThread(threadId: string): WorkerTask | null {
    const row = this.#database.prepare(`
      SELECT * FROM worker_tasks
      WHERE thread_id = ? AND status IN ('running', 'waiting_for_permission')
      ORDER BY created_at_ms DESC LIMIT 1
    `).get(threadId);
    return row ? readTaskRow(row) : null;
  }

  pendingForThread(threadId: string): WorkerTask | null {
    const row = this.#database.prepare(`
      SELECT * FROM worker_tasks
      WHERE thread_id = ? AND status IN ('queued', 'running', 'waiting_for_permission')
      ORDER BY created_at_ms LIMIT 1
    `).get(threadId);
    return row ? readTaskRow(row) : null;
  }

  pendingForProject(projectId: string): WorkerTask | null {
    const row = this.#database.prepare(`
      SELECT * FROM worker_tasks
      WHERE project_id = ? AND status IN ('queued', 'running', 'waiting_for_permission')
      ORDER BY created_at_ms LIMIT 1
    `).get(projectId);
    return row ? readTaskRow(row) : null;
  }

  latestForThread(threadId: string): WorkerTask | null {
    const row = this.#database.prepare(`
      SELECT * FROM worker_tasks WHERE thread_id = ?
      ORDER BY created_at_ms DESC LIMIT 1
    `).get(threadId);
    return row ? readTaskRow(row) : null;
  }

  markRunning(
    taskId: string,
    nativeTurnId: string | null,
    permissionMode: WorkerPermissionMode,
    nowMs: number,
  ): WorkerTask {
    this.#database.prepare(`
      UPDATE worker_tasks
      SET status = 'running', native_turn_id = ?, permission_mode = ?,
          updated_at_ms = ?, error = NULL, interruption_reason = NULL
      WHERE id = ? AND status = 'queued'
    `).run(nativeTurnId, permissionMode, nowMs, taskId);
    return this.require(taskId);
  }

  setNativeTurnId(taskId: string, nativeTurnId: string, nowMs: number): void {
    this.#database.prepare(`
      UPDATE worker_tasks SET native_turn_id = ?, updated_at_ms = ?
      WHERE id = ? AND status IN ('running', 'waiting_for_permission')
    `).run(nativeTurnId, nowMs, taskId);
  }

  markWaiting(taskId: string, nowMs: number): void {
    this.#database.prepare(`
      UPDATE worker_tasks SET status = 'waiting_for_permission', updated_at_ms = ?
      WHERE id = ? AND status = 'running'
    `).run(nowMs, taskId);
  }

  markRunningAgain(taskId: string, nowMs: number): void {
    this.#database.prepare(`
      UPDATE worker_tasks SET status = 'running', updated_at_ms = ?
      WHERE id = ? AND status = 'waiting_for_permission'
    `).run(nowMs, taskId);
  }

  appendEvent(
    taskId: string,
    threadId: string,
    event: Record<string, unknown> & { type: string },
    nowMs: number,
  ): StoredWorkerEvent {
    const result = this.#database.prepare(`
      INSERT INTO worker_events (task_id, thread_id, created_at_ms, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(taskId, threadId, nowMs, JSON.stringify(event));
    return {
      sequence: Number(result.lastInsertRowid),
      taskId,
      threadId,
      createdAtMs: nowMs,
      event: structuredClone(event),
    };
  }

  finish(
    taskId: string,
    status: Extract<WorkerTaskStatus, "completed" | "interrupted" | "failed">,
    event: Record<string, unknown> & { type: string },
    nowMs: number,
    options: { error?: string | null; interruptionReason?: string | null } = {},
  ): StoredWorkerEvent {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        UPDATE worker_tasks
        SET status = ?, updated_at_ms = ?, error = ?, interruption_reason = ?
        WHERE id = ? AND status IN ('queued', 'running', 'waiting_for_permission')
      `).run(
        status,
        nowMs,
        options.error ?? null,
        options.interruptionReason ?? null,
        taskId,
      );
      const stored = this.appendEvent(taskId, this.require(taskId).threadId, event, nowMs);
      this.#database.exec("COMMIT");
      return stored;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  eventsForTask(taskId: string): StoredWorkerEvent[] {
    return this.#database.prepare(`
      SELECT sequence, task_id, thread_id, created_at_ms, payload_json
      FROM worker_events WHERE task_id = ? ORDER BY sequence
    `).all(taskId).map(readEventRow);
  }

  recoverInterrupted(nowMs: number): WorkerTask[] {
    const active = this.#database.prepare(`
      SELECT * FROM worker_tasks
      WHERE status IN ('running', 'waiting_for_permission')
      ORDER BY created_at_ms
    `).all().map(readTaskRow);
    for (const task of active) {
      this.finish(task.id, "interrupted", {
        type: "task.completed",
        sessionId: task.threadId,
        taskId: task.id,
        status: "interrupted",
        error: "后端重启时任务仍在执行，已标记为中断。",
        interruptionReason: "backend_restarted",
      }, nowMs, {
        interruptionReason: "backend_restarted",
      });
    }
    return active;
  }

  close(): void {
    this.#database.close();
  }

}

function readTaskRow(value: unknown): WorkerTask {
  const row = asRow(value);
  return {
    id: String(row.id),
    clientMessageId: String(row.client_message_id),
    projectId: String(row.project_id),
    threadId: String(row.thread_id),
    kind: readKind(row.kind),
    payload: String(row.payload),
    attachments: readAttachments(row.attachments_json),
    status: readStatus(row.status),
    nativeTurnId: nullableString(row.native_turn_id),
    permissionMode: row.permission_mode === "full_access" ? "full_access" : "manual",
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    error: nullableString(row.error),
    interruptionReason: nullableString(row.interruption_reason),
  };
}

function readAttachments(value: unknown): PublicAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === "string" ? value : "[]");
  } catch {
    throw new Error("Worker 状态库包含无效附件数据。");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) =>
    typeof entry !== "object" || entry === null || Array.isArray(entry) ||
    typeof (entry as Record<string, unknown>).id !== "string" ||
    "path" in (entry as Record<string, unknown>)
  )) {
    throw new Error("Worker 状态库包含无效附件数据。");
  }
  return parsed as PublicAttachment[];
}

function readEventRow(value: unknown): StoredWorkerEvent {
  const row = asRow(value);
  const parsed: unknown = JSON.parse(String(row.payload_json));
  if (!isEvent(parsed)) throw new Error("Worker 事件日志包含无效数据。");
  return {
    sequence: Number(row.sequence),
    taskId: String(row.task_id),
    threadId: String(row.thread_id),
    createdAtMs: Number(row.created_at_ms),
    event: parsed,
  };
}

function readKind(value: unknown): WorkerTaskKind {
  if (value === "message" || value === "compact" || value === "review") return value;
  throw new Error("Worker 任务类型无法识别。");
}

function readStatus(value: unknown): WorkerTaskStatus {
  if (
    value === "queued" || value === "running" || value === "waiting_for_permission" ||
    value === "completed" || value === "interrupted" || value === "failed"
  ) return value;
  throw new Error("Worker 任务状态无法识别。");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Worker 状态库返回了无效行。");
  }
  return value as Record<string, unknown>;
}

function isEvent(value: unknown): value is Record<string, unknown> & { type: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string";
}
