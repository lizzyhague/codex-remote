import path from "node:path";

import {
  ensurePrivateDirectory,
  readJsonIfPresent,
  removeFileDurably,
  writeJsonAtomically,
} from "./atomic-json.ts";
import { isObject } from "../shared/json.ts";

export type IndexedAttachment = {
  id: string;
  originalName: string;
  path: string;
};

export type IndexedMessageAttachments = {
  messageId: string;
  attachments: readonly IndexedAttachment[];
};

const INDEX_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * 会话附件显示索引：只保存 id / 原名 / 真实路径，给页面转换用。
 * 不进入浏览器 DTO、公开事件或通用日志。
 *
 * 同一会话的读写都排在一条链上。`remove()` 一经调用就给会话立下删除屏障：之后开始
 * 执行的登记、重建和读取都不再碰文件，永久删除完成后索引不会被迟到的写入重建。
 * 屏障只在进程内；进程重启后迟到的操作也随之消失。
 */
export class AttachmentDisplayIndex {
  readonly #directory: string;
  readonly #loaded = new Map<string, Map<string, IndexedAttachment[]>>();
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #removed = new Set<string>();

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
    await this.#update(sessionId, [{ messageId, attachments }]);
  }

  /**
   * 按历史重建会话索引：加载与全部登记是链上的一次操作，删除不能插在两条登记之间。
   * 返回操作完成时的映射；会话已删除时返回空数组且不写文件。
   */
  async rebuild(
    sessionId: string,
    entries: readonly IndexedMessageAttachments[],
  ): Promise<IndexedAttachment[]> {
    return flatten(await this.#update(sessionId, entries));
  }

  async mappingsFor(sessionId: string): Promise<IndexedAttachment[]> {
    return flatten(await this.#load(sessionId));
  }

  /** 已加载会话的同步视图；未加载或已删除时返回空数组。 */
  peek(sessionId: string): IndexedAttachment[] {
    if (this.#removed.has(sessionId)) return [];
    return flatten(this.#loaded.get(sessionId));
  }

  /** 删除会话索引并立下删除屏障；失败可重试，屏障不会撤销。 */
  async remove(sessionId: string): Promise<void> {
    this.#filePath(sessionId);
    this.#removed.add(sessionId);
    await this.#enqueue(sessionId, async () => {
      this.#loaded.delete(sessionId);
      await removeFileDurably(this.#filePath(sessionId));
    });
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#chains.values()].map((chain) => chain.catch(() => undefined)));
  }

  async #load(sessionId: string): Promise<Map<string, IndexedAttachment[]> | undefined> {
    if (this.#removed.has(sessionId)) return undefined;
    const cached = this.#loaded.get(sessionId);
    if (cached) return cached;
    return this.#enqueue(sessionId, () => this.#loadInChain(sessionId));
  }

  /** 只在会话链内调用。 */
  async #loadInChain(sessionId: string): Promise<Map<string, IndexedAttachment[]> | undefined> {
    if (this.#removed.has(sessionId)) return undefined;
    const existing = this.#loaded.get(sessionId);
    if (existing) return existing;
    const messages = parseMessages(await readJsonIfPresent(this.#filePath(sessionId)));
    this.#loaded.set(sessionId, messages);
    return messages;
  }

  async #update(
    sessionId: string,
    entries: readonly IndexedMessageAttachments[],
  ): Promise<Map<string, IndexedAttachment[]> | undefined> {
    const updates = entries.map((entry) => ({
      messageId: entry.messageId,
      records: entry.attachments.map(cloneAttachment),
    }));
    return this.#enqueue(sessionId, async () => {
      const current = await this.#loadInChain(sessionId);
      if (!current) return undefined;
      // 写成功后才替换缓存；写失败时缓存仍与磁盘一致，下次同样的登记会重试写入。
      const next = new Map(current);
      let changed = false;
      for (const { messageId, records } of updates) {
        const existing = next.get(messageId);
        if (existing && sameRecords(existing, records)) continue;
        next.set(messageId, records);
        changed = true;
      }
      if (!changed) return current;
      await writeJsonAtomically(this.#filePath(sessionId), {
        version: INDEX_VERSION,
        messages: Object.fromEntries(next),
      });
      this.#loaded.set(sessionId, next);
      return next;
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

