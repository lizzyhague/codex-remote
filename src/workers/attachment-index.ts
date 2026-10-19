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
 * Session attachment display index: stores only id, original name, and real path for page conversion.
 * It never enters browser DTOs, public events, or general logs.
 *
 * Reads and writes for a session share one chain. Calling `remove()` establishes a deletion barrier:
 * later registrations, rebuilds, and reads no longer touch the file, so late writes cannot recreate it.
 * The barrier is process-local; late operations disappear on process restart as well.
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
   * Rebuild from history as one chained load-and-register operation, preventing deletion between entries.
   * Return the completed mapping; if deleted, return an empty array without writing.
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

  /** Synchronous view of a loaded session; empty when unloaded or deleted. */
  peek(sessionId: string): IndexedAttachment[] {
    if (this.#removed.has(sessionId)) return [];
    return flatten(this.#loaded.get(sessionId));
  }

  /** Delete the index and establish a deletion barrier; failures are retryable and the barrier remains. */
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

  /** Called only within the session chain. */
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
      // Replace the cache only after a successful write; on failure it still matches disk and registration retries next time.
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
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("The session ID is not a valid attachment index key.");
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

