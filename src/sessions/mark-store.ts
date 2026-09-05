import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveTrashStatePath } from "./trash-store.ts";

export type MarkEntry = {
  threadId: string;
  projectId: string;
};

type MarkFile = {
  version: 1;
  entries: MarkEntry[];
};

export function resolveMarkStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_REMOTE_MARKS_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(resolveTrashStatePath(environment)), "marks.json");
}

/**
 * Codex 仍保存真实会话；这里只持久化钉住名单，不复制标题或对话内容。
 */
export class MarkStore {
  readonly #filePath: string;
  readonly #entries = new Map<string, MarkEntry>();
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.#filePath = filePath;
  }

  static async open(filePath: string): Promise<MarkStore> {
    const store = new MarkStore(path.resolve(filePath));
    await store.#load();
    return store;
  }

  get(threadId: string): MarkEntry | null {
    const entry = this.#entries.get(threadId);
    return entry ? cloneEntry(entry) : null;
  }

  has(threadId: string): boolean {
    return this.#entries.has(threadId);
  }

  list(): MarkEntry[] {
    return [...this.#entries.values()].map(cloneEntry);
  }

  async put(entry: MarkEntry): Promise<void> {
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
    } catch (error) {
      this.#entries.set(threadId, previous);
      throw error;
    }
    return true;
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
      throw new Error(`钉住状态文件不是有效 JSON：${this.#filePath}`);
    }
    if (!isMarkFile(value)) {
      throw new Error(`钉住状态文件格式不正确：${this.#filePath}`);
    }
    for (const entry of value.entries) {
      this.#entries.set(entry.threadId, cloneEntry(entry));
    }
  }

  #persist(): Promise<void> {
    const snapshot: MarkFile = {
      version: 1,
      entries: [...this.#entries.values()].map(cloneEntry),
    };
    const operation = this.#writeQueue.then(() => this.#writeSnapshot(snapshot));
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }

  async #writeSnapshot(snapshot: MarkFile): Promise<void> {
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

function cloneEntry(entry: MarkEntry): MarkEntry {
  return {
    threadId: entry.threadId,
    projectId: entry.projectId,
  };
}

function isMarkFile(value: unknown): value is MarkFile {
  return isObject(value) &&
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.every(isMarkEntry) &&
    new Set(value.entries.map((entry) => entry.threadId)).size === value.entries.length;
}

function isMarkEntry(value: unknown): value is MarkEntry {
  return isObject(value) &&
    typeof value.threadId === "string" && value.threadId.length > 0 &&
    typeof value.projectId === "string" && value.projectId.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
