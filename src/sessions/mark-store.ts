import path from "node:path";

import { isObject } from "../shared/json.ts";
import {
  ThreadEntryStore,
  type ThreadEntryStoreShape,
} from "./thread-entry-store.ts";
import { resolveTrashStatePath } from "./trash-store.ts";

export type MarkEntry = {
  threadId: string;
  projectId: string;
};

export function resolveMarkStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_REMOTE_MARKS_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(resolveTrashStatePath(environment)), "marks.json");
}

const SHAPE: ThreadEntryStoreShape<MarkEntry> = {
  label: "钉住状态文件",
  clone: (entry) => ({
    threadId: entry.threadId,
    projectId: entry.projectId,
  }),
  isEntry: (value): value is MarkEntry =>
    isObject(value) &&
    typeof value.threadId === "string" && value.threadId.length > 0 &&
    typeof value.projectId === "string" && value.projectId.length > 0,
};

/** 用户钉住的会话名单。 */
export class MarkStore extends ThreadEntryStore<MarkEntry> {
  static async open(filePath: string): Promise<MarkStore> {
    const store = new MarkStore(path.resolve(filePath), SHAPE);
    await store.load();
    return store;
  }
}
