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

export type SessionWorkerOptions = {
  projectId: string;
  threadId?: string;
  projects: ProjectCatalog;
  trash: TrashStore;
  codexBinary?: string;
  workingDirectory?: string;
  onStreamEvent?: (event: CodexStreamEvent) => void;
  onApprovalEvent?: (event: ApprovalEvent) => void;
  onInteractionEvent?: (event: WorkerInteractionEvent) => void;
  onUnexpectedExit?: (threadId: string, error: Error) => void;
};

/**
 * 一个会话对应的独立 codex app-server 进程。
 *
 * Node 主管理器保留队列和事件日志；这个对象只持有当前会话的 writer、命令适配器
 * 与审批请求。关闭它就会释放该会话的 writer，而不会影响其他活动会话。
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
  #closing = false;

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
    let worker: SessionWorker | null = null;
    const client = new AppServerClient({
      ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}),
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      processGroup: true,
    });
    try {
      await client.initialize(codexRemoteInitializeParams());
      const sessions = new CodexSessionService(client, options.projects, options.trash);
      const opened = options.threadId
        ? await sessions.resume(options.projectId, options.threadId)
        : await sessions.start(options.projectId);
      const approvals = new ApprovalBroker(client);
      const interactions = new InteractionBroker(client);
      worker = new SessionWorker(
        client,
        opened,
        approvals,
        interactions,
        options.onStreamEvent ?? (() => {}),
        options.onApprovalEvent ?? (() => {}),
        options.onInteractionEvent ?? (() => {}),
      );
      void client.whenExited().then(() => {
        if (worker && !worker.#closing) {
          options.onUnexpectedExit?.(
            worker.threadId,
            new Error("会话 Worker 的 codex app-server 已退出。"),
          );
        }
      });
      return worker;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  get threadId(): string {
    return this.opened.session.id;
  }

  get fullAccessEnabled(): boolean {
    return this.commands.fullAccessEnabled();
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#unsubscribeStream();
    this.#unsubscribeApprovals();
    this.#unsubscribeInteractions();
    this.commands.dispose();
    this.turns.dispose();
    try {
      this.approvals.cancelAll();
      this.interactions.cancelThread(this.threadId);
    } finally {
      this.approvals.dispose();
      this.interactions.dispose();
      await this.client.close();
    }
  }
}
