import { AppServerRpcError } from "../app-server/client.ts";
import type { MarkStore } from "./mark-store.ts";
import type { TrashEntry, TrashStore } from "./trash-store.ts";

export interface DeletedSessionArtifacts {
  forgetSession(threadId: string): Promise<void>;
}

export interface ThreadDeleteRequester {
  request<Result = unknown>(method: string, params: unknown): Promise<Result>;
}

/**
 * 永久删除的唯一编排入口。
 *
 * `deleting` 先于任何不可逆操作落盘，回收站条目最后才删除。中途退出后，调用方
 * 只需再次传入同一条目；所有本地清理都是幂等的，Codex 的精确“不存在”响应也
 * 视为此前已经删除成功。
 */
export class SessionDeletionCoordinator {
  readonly #transport: ThreadDeleteRequester;
  readonly #trash: TrashStore;
  readonly #marks: MarkStore | null;
  readonly #artifacts: DeletedSessionArtifacts | null;

  constructor(
    transport: ThreadDeleteRequester,
    trash: TrashStore,
    options: {
      marks?: MarkStore;
      artifacts?: DeletedSessionArtifacts;
    } = {},
  ) {
    this.#transport = transport;
    this.#trash = trash;
    this.#marks = options.marks ?? null;
    this.#artifacts = options.artifacts ?? null;
  }

  async delete(entry: TrashEntry): Promise<void> {
    const pending = entry.state === "deleting" ? entry : { ...entry, state: "deleting" as const };
    if (entry.state !== "deleting") {
      await this.#trash.put(pending);
    }

    try {
      await this.#transport.request("thread/delete", { threadId: pending.threadId });
    } catch (error) {
      if (!isAlreadyDeleted(error, pending.threadId)) throw error;
    }

    await this.#artifacts?.forgetSession(pending.threadId);
    await this.#marks?.remove(pending.threadId);
    await this.#trash.remove(pending.threadId);
  }
}

function isAlreadyDeleted(error: unknown, threadId: string): boolean {
  return error instanceof AppServerRpcError &&
    error.code === -32600 &&
    error.message === `no rollout found for thread id ${threadId}`;
}
