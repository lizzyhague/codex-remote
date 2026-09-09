import path from "node:path";
import { rm } from "node:fs/promises";

import {
  ensurePrivateDirectory,
  readJsonIfPresent,
  writeJsonAtomically,
} from "./atomic-json.ts";

export type IndexedAttachment = {
  id: string;
  originalName: string;
  path: string;
};

const INDEX_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * 会话附件显示索引：只保存 id / 原名 / 真实路径，给页面转换用。
 * 不进入浏览器 DTO、公开事件或通用日志。
 */
export class AttachmentDisplayIndex {
  readonly #directory: string;
  readonly #loaded = new Map<string, Map<string, IndexedAttachment[]>>();
  readonly #chains = new Map<string, Promise<unknown>>();

  private constructor(directory: string) {
    this.#directory = directory;
  }

  static async open(dataDirectory: string): Promise<AttachmentDisplayIndex> {
    const directory = path.join(dataDirectory, "attachment-index");
    await ensurePrivateDirectory(directory);
    return new AttachmentDisplayIndex(directory);
  }

  async register(
    sessionId: string,
    messageId: string,
    attachments: readonly IndexedAttachment[],
  ): Promise<void> {
    const records = attachments.map(cloneAttachment);
    await this.#write(sessionId, (messages) => {
      const existing = messages.get(messageId);
      if (existing && sameRecords(existing, records)) return;
      messages.set(messageId, records);
    });
  }

  async mappingsFor(sessionId: string): Promise<IndexedAttachment[]> {
    return flatten(await this.#load(sessionId));
  }

  /** 已加载会话的同步视图；未加载时返回空数组。 */
  peek(sessionId: string): IndexedAttachment[] {
    return flatten(this.#loaded.get(sessionId));
  }

  async remove(sessionId: string): Promise<void> {
    await this.#enqueue(sessionId, async () => {
      this.#loaded.delete(sessionId);
      await rm(this.#filePath(sessionId), { force: true });
    });
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#chains.values()].map((chain) => chain.catch(() => undefined)));
  }

  async #load(sessionId: string): Promise<Map<string, IndexedAttachment[]>> {
    const cached = this.#loaded.get(sessionId);
    if (cached) return cached;
    return this.#enqueue(sessionId, async () => {
      const existing = this.#loaded.get(sessionId);
      if (existing) return existing;
      const raw = await readJsonIfPresent(this.#filePath(sessionId));
      const messages = parseMessages(raw);
      const raced = this.#loaded.get(sessionId);
      if (raced) return raced;
      this.#loaded.set(sessionId, messages);
      return messages;
    });
  }

  async #write(
    sessionId: string,
    mutate: (messages: Map<string, IndexedAttachment[]>) => void,
  ): Promise<void> {
    await this.#enqueue(sessionId, async () => {
      let messages = this.#loaded.get(sessionId);
      if (!messages) {
        const raw = await readJsonIfPresent(this.#filePath(sessionId));
        messages = parseMessages(raw);
        const existing = this.#loaded.get(sessionId);
        messages = existing ?? messages;
        this.#loaded.set(sessionId, messages);
      }
      mutate(messages);
      await writeJsonAtomically(this.#filePath(sessionId), {
        version: INDEX_VERSION,
        messages: Object.fromEntries(messages),
      });
    });
  }

  #enqueue<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve();
    const task = previous.then(run, run);
    this.#chains.set(sessionId, task.catch(() => undefined));
    return task;
  }

  #filePath(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("会话 ID 不是合法的附件索引键。");
    return path.join(this.#directory, `${sessionId}.json`);
  }
}

function parseMessages(raw: unknown): Map<string, IndexedAttachment[]> {
  const messages = new Map<string, IndexedAttachment[]>();
  if (!isObject(raw) || !isObject(raw.messages)) return messages;
  for (const [messageId, value] of Object.entries(raw.messages)) {
    if (!Array.isArray(value)) continue;
    const records = value.flatMap((entry) => parseAttachment(entry));
    if (records.length === 0) continue;
    messages.set(messageId, records);
  }
  return messages;
}

function parseAttachment(value: unknown): IndexedAttachment[] {
  if (!isObject(value)) return [];
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.originalName !== "string" ||
    typeof value.path !== "string" || !value.path
  ) return [];
  return [{ id: value.id, originalName: value.originalName, path: value.path }];
}

function flatten(messages: Map<string, IndexedAttachment[]> | undefined): IndexedAttachment[] {
  if (!messages) return [];
  return [...messages.values()].flat().map(cloneAttachment);
}

function cloneAttachment(attachment: IndexedAttachment): IndexedAttachment {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    path: attachment.path,
  };
}

function sameRecords(
  left: readonly IndexedAttachment[],
  right: readonly IndexedAttachment[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
