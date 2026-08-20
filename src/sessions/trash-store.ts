import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type TrashOrigin = "active" | "archived";

export type TrashEntry = {
  threadId: string;
  projectId: string;
  deletedAt: number;
  origin: TrashOrigin;
};

type TrashFile = {
  version: 1;
  entries: TrashEntry[];
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

/**
 * Codex 仍保存真实会话；这里只持久化回收站状态，不复制标题或对话内容。
 */
export class TrashStore {
  readonly #filePath: string;
  readonly #entries = new Map<string, TrashEntry>();
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.#filePath = filePath;
  }

  static async open(filePath: string): Promise<TrashStore> {
    const store = new TrashStore(path.resolve(filePath));
    await store.#load();
    return store;
  }

  get(threadId: string): TrashEntry | null {
    const entry = this.#entries.get(threadId);
    return entry ? cloneEntry(entry) : null;
  }

  has(threadId: string): boolean {
    return this.#entries.has(threadId);
  }

  list(projectId?: string): TrashEntry[] {
    return [...this.#entries.values()]
      .filter((entry) => projectId === undefined || entry.projectId === projectId)
      .map(cloneEntry);
  }

  async put(entry: TrashEntry): Promise<void> {
    const previous = this.#entries.get(entry.threadId);
    this.#entries.set(entry.threadId, cloneEntry(entry));
    try {
      await this.#persist();
    } catch (error) {
      if (previous) this.#entries.set(entry.threadId, previous);
      else this.#entries.delete(entry.threadId);
      throw error;
    }
  }

  async remove(threadId: string): Promise<boolean> {
    const previous = this.#entries.get(threadId);
    if (!previous) return false;
    this.#entries.delete(threadId);
    try {
      await this.#persist();
      return true;
    } catch (error) {
      this.#entries.set(threadId, previous);
      throw error;
    }
  }

  async #load(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error(`回收站状态文件不是有效 JSON：${this.#filePath}`);
    }
    if (!isTrashFile(value)) {
      throw new Error(`回收站状态文件格式不正确：${this.#filePath}`);
    }
    for (const entry of value.entries) {
      this.#entries.set(entry.threadId, cloneEntry(entry));
    }
  }

  #persist(): Promise<void> {
    const snapshot: TrashFile = {
      version: 1,
      entries: [...this.#entries.values()].map(cloneEntry),
    };
    const operation = this.#writeQueue.then(() => this.#writeSnapshot(snapshot));
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }

  async #writeSnapshot(snapshot: TrashFile): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function cloneEntry(entry: TrashEntry): TrashEntry {
  return {
    threadId: entry.threadId,
    projectId: entry.projectId,
    deletedAt: entry.deletedAt,
    origin: entry.origin,
  };
}

function isTrashFile(value: unknown): value is TrashFile {
  return isObject(value) &&
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.every(isTrashEntry) &&
    new Set(value.entries.map((entry) => entry.threadId)).size === value.entries.length;
}

function isTrashEntry(value: unknown): value is TrashEntry {
  return isObject(value) &&
    typeof value.threadId === "string" && value.threadId.length > 0 &&
    typeof value.projectId === "string" && value.projectId.length > 0 &&
    typeof value.deletedAt === "number" && Number.isFinite(value.deletedAt) &&
    value.deletedAt >= 0 &&
    (value.origin === "active" || value.origin === "archived");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
