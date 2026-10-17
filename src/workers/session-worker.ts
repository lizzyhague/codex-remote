import { AppServerClient } from "../app-server/client.ts";
import { codexRemoteInitializeParams } from "../app-server/initialize.ts";
import {
  CodexTurnSession,
  type CodexStreamEvent,
} from "../app-server/turn-session.ts";
import {
  ApprovalBroker,
  type ApprovalEvent,
} from "../approvals/broker.ts";
import { CommandRunner } from "../commands/runner.ts";
import type { ProjectCatalog } from "../projects/catalog.ts";
import {
  CodexSessionService,
  type OpenedSession,
} from "../sessions/service.ts";
import type { TrashStore } from "../sessions/trash-store.ts";
import {
  InteractionBroker,
  type WorkerInteractionEvent,
} from "./interaction-broker.ts";
import type { ApplicationSettingsStore } from "../settings/store.ts";

export type SessionWorkerOptions = {
  projectId: string;
  threadId?: string;
  /** Covers only Worker creation, initialization, and session resume; stops listening after creation. */
  startupSignal?: AbortSignal;
  projects: ProjectCatalog;
  trash: TrashStore;
  codexBinary?: string;
  workingDirectory?: string;
  onMetricsNotification?: (message: import("../app-server/client.ts").JsonObject) => void;
  onStreamEvent?: (event: CodexStreamEvent) => void;
  onApprovalEvent?: (event: ApprovalEvent) => void;
  onInteractionEvent?: (event: WorkerInteractionEvent) => void;
  /** Passes the instance so callers can verify ownership and ignore a stale instance's late exit. */
  onUnexpectedExit?: (worker: SessionWorker, error: Error) => void;
  settings?: ApplicationSettingsStore;
};

export class SessionWorkerStartCancelledError extends Error {
  constructor() {
    super("会话 Worker 启动已取消。");
    this.name = "SessionWorkerStartCancelledError";
  }
}

/**
 * An independent codex app-server process for one session.
 *
 * The Node manager retains queues and event logs; this object holds only the session's writer,
 * command adapter, and approval requests. Closing it releases this writer without affecting other sessions.
 */
export class SessionWorker {
  readonly client: AppServerClient;
  readonly opened: OpenedSession;
  readonly turns: CodexTurnSession;
  readonly commands: CommandRunner;
  readonly approvals: ApprovalBroker;
  readonly interactions: InteractionBroker;
  readonly #unsubscribeStream: () => void;
  readonly #unsubscribeApprovals: () => void;
  readonly #unsubscribeInteractions: () => void;
  #closing: Promise<void> | null = null;
  #exited = false;

  private constructor(
    client: AppServerClient,
    opened: OpenedSession,
    approvals: ApprovalBroker,
    interactions: InteractionBroker,
    onStreamEvent: (event: CodexStreamEvent) => void,
    onApprovalEvent: (event: ApprovalEvent) => void,
    onInteractionEvent: (event: WorkerInteractionEvent) => void,
  ) {
    this.client = client;
    this.opened = opened;
    this.approvals = approvals;
    this.interactions = interactions;
    this.turns = new CodexTurnSession(client, opened.session.id, opened.activeTurnId);
    this.commands = new CommandRunner(client, opened.session.id, opened.runtime);
    this.#unsubscribeStream = this.turns.onEvent(onStreamEvent);
    this.#unsubscribeApprovals = approvals.onEvent(onApprovalEvent);
    this.#unsubscribeInteractions = interactions.onEvent(onInteractionEvent);
  }

  static async create(options: SessionWorkerOptions): Promise<SessionWorker> {
    if (options.startupSignal?.aborted) {
      throw new SessionWorkerStartCancelledError();
    }
    const client = new AppServerClient({
      ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      processGroup: true,
      onNotification: options.onMetricsNotification ?? (() => {}),
    });
    const cancelStartup = () => {
      void client.close().catch(() => {});
    };
    options.startupSignal?.addEventListener("abort", cancelStartup, { once: true });
    try {
      await client.initialize(codexRemoteInitializeParams());
      throwIfStartupCancelled(options.startupSignal);
      const sessions = new CodexSessionService(client, options.projects, options.trash, {
        ...(options.settings ? { settings: options.settings } : {}),
      });
      const opened = options.threadId
        ? await sessions.resume(options.projectId, options.threadId)
        : await sessions.start(options.projectId);
      throwIfStartupCancelled(options.startupSignal);
      const approvals = new ApprovalBroker(client);
      const interactions = new InteractionBroker(client);
      const worker = new SessionWorker(
        client,
        opened,
        approvals,
        interactions,
        options.onStreamEvent ?? (() => {}),
        options.onApprovalEvent ?? (() => {}),
        options.onInteractionEvent ?? (() => {}),
      );
      void client.whenExited().then(() => {
        worker.#exited = true;
        if (!worker.#closing) {
          options.onUnexpectedExit?.(
            worker,
            new Error("会话 Worker 的 codex app-server 已退出。"),
          );
        }
      });
      return worker;
    } catch (error) {
      await client.close().catch(() => {});
      if (options.startupSignal?.aborted) {
        throw new SessionWorkerStartCancelledError();
      }
      throw error;
    } finally {
      options.startupSignal?.removeEventListener("abort", cancelStartup);
    }
  }

  get threadId(): string {
    return this.opened.session.id;
  }

  get fullAccessEnabled(): boolean {
    return this.commands.fullAccessEnabled();
  }

  /** The child has exited. The callback arrives later, so check this before publishing the Worker. */
  get exited(): boolean {
    return this.#exited;
  }

  /** Concurrent calls return one Promise, and all callers wait for the process group to close. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#unsubscribeStream();
    this.commands.dispose();
    this.turns.dispose();
    let cancellationError: unknown = null;
    try {
      // The Manager still subscribes to the broker; settle pending prompts first so every browser can close its card.
      try {
        this.approvals.cancelAll();
      } catch (error) {
        cancellationError = error;
      }
      try {
        this.interactions.cancelThread(this.threadId);
      } catch (error) {
        cancellationError ??= error;
      }
    } finally {
      this.#unsubscribeApprovals();
      this.#unsubscribeInteractions();
      this.approvals.dispose();
      this.interactions.dispose();
      await this.client.close();
    }
    if (cancellationError) throw cancellationError;
  }
}

function throwIfStartupCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SessionWorkerStartCancelledError();
}
