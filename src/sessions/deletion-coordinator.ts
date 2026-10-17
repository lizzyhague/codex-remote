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
 * The sole orchestration entry point for permanent deletion.
 *
 * `deleting` is persisted before any irreversible operation, and the trash entry is removed last.
 * After an interruption, the caller only needs to pass the same entry again. All local cleanup is
 * idempotent, and Codex's exact “不存在” response is treated as a prior successful deletion.
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
