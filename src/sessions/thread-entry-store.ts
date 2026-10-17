import { isObject } from "../shared/json.ts";
import { readJsonIfPresent, writeJsonAtomically } from "../workers/atomic-json.ts";

/** Trash entries and pinned entries are both small lists keyed by thread. */
export type ThreadScopedEntry = {
  threadId: string;
};

type EntryFile<Entry extends ThreadScopedEntry> = {
  version: 1;
  entries: Entry[];
};

/** Subclasses define their error label, entry cloning, and entry validation. */
export type ThreadEntryStoreShape<Entry extends ThreadScopedEntry> = {
  label: string;
  clone: (entry: Entry) => Entry;
  isEntry: (value: unknown) => value is Entry;
};

/**
 * Codex retains the real session; this persists only the list, without copying titles or conversation content.
 *
 * Persistence uses shared `writeJsonAtomically` and serializes writes. Memory changes first and rolls
 * back on failure, so external readers always see the persisted version.
 */
export abstract class ThreadEntryStore<Entry extends ThreadScopedEntry> {
  readonly #filePath: string;
  readonly #shape: ThreadEntryStoreShape<Entry>;
  readonly #entries = new Map<string, Entry>();
  #writeQueue: Promise<void> = Promise.resolve();

  protected constructor(filePath: string, shape: ThreadEntryStoreShape<Entry>) {
    this.#filePath = filePath;
    this.#shape = shape;
  }

  get(threadId: string): Entry | null {
    const entry = this.#entries.get(threadId);
    return entry ? this.#shape.clone(entry) : null;
  }

  has(threadId: string): boolean {
    return this.#entries.has(threadId);
  }

  list(): Entry[] {
    return [...this.#entries.values()].map(this.#shape.clone);
  }

  async put(entry: Entry): Promise<void> {
    const previous = this.#entries.get(entry.threadId);
    this.#entries.set(entry.threadId, this.#shape.clone(entry));
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

  /** Called once after a subclass `open()` creates the instance. A missing file means an empty list. */
  protected async load(): Promise<void> {
    const value = await readJsonIfPresent(this.#filePath);
    if (value === null) return;
    if (!this.#isEntryFile(value)) {
      throw new Error(`${this.#shape.label}格式不正确：${this.#filePath}`);
    }
    for (const entry of value.entries) {
      this.#entries.set(entry.threadId, this.#shape.clone(entry));
    }
  }

  #isEntryFile(value: unknown): value is EntryFile<Entry> {
    return isObject(value) &&
      value.version === 1 &&
      Array.isArray(value.entries) &&
      value.entries.every(this.#shape.isEntry) &&
      new Set(value.entries.map((entry) => entry.threadId)).size === value.entries.length;
  }

  #persist(): Promise<void> {
    const snapshot: EntryFile<Entry> = {
      version: 1,
      entries: [...this.#entries.values()].map(this.#shape.clone),
    };
    const operation = this.#writeQueue.then(() =>
      writeJsonAtomically(this.#filePath, snapshot)
    );
    this.#writeQueue = operation.catch(() => {});
    return operation;
  }
}
