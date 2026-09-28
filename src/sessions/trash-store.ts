import { homedir } from "node:os";
import path from "node:path";

import { isObject } from "../shared/json.ts";
import {
  ThreadEntryStore,
  type ThreadEntryStoreShape,
} from "./thread-entry-store.ts";

export type TrashOrigin = "active" | "archived";
/**
 * 条目所处阶段。`trashing` / `restoring` / `deleting` 都是先于 Codex 副作用落盘的
 * 过渡凭据：一旦写下就只向前推进，中途失败或退出后由下一次整理或清理续做。
 *
 * - `trashing`：active 会话移入回收站，`thread/archive` 可能尚未完成；完成后变 `trashed`。
 * - `restoring`：active 来源的会话恢复中，`thread/unarchive` 可能尚未完成；完成后删条目。
 * - `deleting`：永久删除中；所有附属数据清理完后才移除条目。
 */
export type TrashState = "trashing" | "trashed" | "restoring" | "deleting";

const TRASH_STATES: ReadonlySet<unknown> = new Set<TrashState>([
  "trashing",
  "trashed",
  "restoring",
  "deleting",
]);

export type TrashEntry = {
  threadId: string;
  projectId: string;
  deletedAt: number;
  origin: TrashOrigin;
  state: TrashState;
};

export function resolveTrashStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_REMOTE_STATE_FILE?.trim();
  if (configured) return path.resolve(configured);
  const stateHome = environment.XDG_STATE_HOME?.trim() ||
    path.join(homedir(), ".local", "state");
  return path.join(stateHome, "codex-remote", "trash.json");
}

const SHAPE: ThreadEntryStoreShape<TrashEntry> = {
  label: "回收站状态文件",
  clone: (entry) => ({
    threadId: entry.threadId,
    projectId: entry.projectId,
    deletedAt: entry.deletedAt,
    origin: entry.origin,
    // 旧版 trash.json 没有 state；读入内存时迁移成普通回收站条目。
    state: entry.state ?? "trashed",
  }),
  isEntry: (value): value is TrashEntry =>
    isObject(value) &&
    typeof value.threadId === "string" && value.threadId.length > 0 &&
    typeof value.projectId === "string" && value.projectId.length > 0 &&
    typeof value.deletedAt === "number" && Number.isFinite(value.deletedAt) &&
    value.deletedAt >= 0 &&
    (value.origin === "active" || value.origin === "archived") &&
    (value.state === undefined || TRASH_STATES.has(value.state)) &&
    // 过渡阶段只为 active 来源存在：archived 来源进出回收站只改这份名单，没有 Codex 副作用。
    (value.origin === "active" || (value.state !== "trashing" && value.state !== "restoring")),
};

/** 回收站里有哪些会话、什么时候进来的、恢复时该放回哪。 */
export class TrashStore extends ThreadEntryStore<TrashEntry> {
  static async open(filePath: string): Promise<TrashStore> {
    const store = new TrashStore(path.resolve(filePath), SHAPE);
    await store.load();
    return store;
  }

  override list(projectId?: string): TrashEntry[] {
    const entries = super.list();
    if (projectId === undefined) return entries;
    return entries.filter((entry) => entry.projectId === projectId);
  }
}
