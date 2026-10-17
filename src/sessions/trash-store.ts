import { homedir } from "node:os";
import path from "node:path";

import { isObject } from "../shared/json.ts";
import {
  ThreadEntryStore,
  type ThreadEntryStoreShape,
} from "./thread-entry-store.ts";

export type TrashOrigin = "active" | "archived";
/**
 * The entry's current phase. `trashing`, `restoring`, and `deleting` are transitional records
 * persisted before Codex side effects. Once written, they only move forward; after a failure or
 * interruption, the next organization or cleanup pass resumes the work.
 *
 * - `trashing`: an active session is moving to trash; `thread/archive` may still be pending. It becomes `trashed` when done.
 * - `restoring`: an active-source session is being restored; `thread/unarchive` may still be pending. The entry is removed when done.
 * - `deleting`: permanent deletion is in progress; the entry is removed only after all associated data is cleaned up.
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
    // Older trash.json files have no state; migrate them to regular trash entries when loading.
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
    // Transitional states exist only for active sources: moving archived sources changes only this list and has no Codex side effects.
    (value.origin === "active" || (value.state !== "trashing" && value.state !== "restoring")),
};

/** Sessions in trash, when they entered it, and where they should be restored. */
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
