import { isObject } from "../shared/json.ts";
import { readJsonIfPresent, writeJsonAtomically } from "../workers/atomic-json.ts";

/** 回收站登记和钉住名单都是按 thread 记的小名单。 */
export type ThreadScopedEntry = {
  threadId: string;
};

type EntryFile<Entry extends ThreadScopedEntry> = {
  version: 1;
  entries: Entry[];
};

/** 子类要说清楚的三件事：错误里怎么称呼自己、条目怎么复制、什么样的值算条目。 */
export type ThreadEntryStoreShape<Entry extends ThreadScopedEntry> = {
  label: string;
  clone: (entry: Entry) => Entry;
  isEntry: (value: unknown) => value is Entry;
};

/**
 * Codex 仍保存真实会话；这里只持久化名单本身，不复制标题或对话内容。
 *
 * 落盘走共享的 `writeJsonAtomically`（临时文件 → fsync → rename），写入排队串行。
 * 内存先改、落盘失败再回滚，所以外部读到的始终是已经落盘的那一份。
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

  /** 子类的 `open()` 建好实例后调用一次。文件不存在就是空名单。 */
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
