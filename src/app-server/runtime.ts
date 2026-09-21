import type { InitializeParams } from "../generated/InitializeParams.ts";
import type { InitializeResponse } from "../generated/InitializeResponse.ts";
import type { RequestId } from "../generated/RequestId.ts";

import {
  AppServerClient,
  type AppServerClientOptions,
  type AppServerMessageListener,
  type JsonObject,
} from "./client.ts";

interface AppServerProcess {
  initialize(params: InitializeParams): Promise<InitializeResponse>;
  request<Result = unknown>(method: string, params: unknown): Promise<Result>;
  respondToServerRequest(id: RequestId, result: unknown): void;
  whenExited(): Promise<void>;
  close(): Promise<void>;
}

type AppServerProcessFactory = (options: AppServerClientOptions) => AppServerProcess;

export type RestartableAppServerOptions =
  & Omit<AppServerClientOptions, "onNotification" | "onServerRequest">
  & {
    /** 测试替身入口；生产环境始终使用真实的 stdio app-server。 */
    clientFactory?: AppServerProcessFactory;
  };

/**
 * 目录 App Server 子进程。会话列表、恢复和账号额度走这一个共享进程；turn 属于
 * 每个会话自己的 Worker，不在这里执行，因此它不会加载可写的 rollout。
 */
export class RestartableAppServer {
  readonly #clientOptions: Omit<
    AppServerClientOptions,
    "onNotification" | "onServerRequest"
  >;
  readonly #clientFactory: AppServerProcessFactory;
  readonly #notificationListeners = new Set<AppServerMessageListener>();
  readonly #serverRequestListeners = new Set<AppServerMessageListener>();
  readonly #unexpectedExit: Promise<void>;
  #resolveUnexpectedExit!: () => void;
  #unexpectedExitResolved = false;
  #ready: Promise<AppServerProcess> | null = null;
  #current: AppServerProcess | null = null;
  #closed = false;

  constructor(options: RestartableAppServerOptions = {}) {
    const { clientFactory, ...clientOptions } = options;
    this.#clientOptions = clientOptions;
    this.#clientFactory = clientFactory ?? ((spawnOptions) =>
      new AppServerClient(spawnOptions));
    this.#unexpectedExit = new Promise((resolve) => {
      this.#resolveUnexpectedExit = resolve;
    });
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    if (this.#closed) {
      throw new Error("codex app-server 运行时已经关闭。");
    }
    if (this.#ready) {
      throw new Error("codex app-server 运行时已经初始化。");
    }

    const started = this.#startClient(params);
    this.#ready = started.then(({ client }) => client);
    const { response } = await started;
    return response;
  }

  async request<Result = unknown>(method: string, params: unknown): Promise<Result> {
    if (this.#closed) {
      throw new Error("codex app-server 运行时已经关闭。");
    }
    const client = await this.#requireReady();
    return client.request<Result>(method, params);
  }

  onNotification(listener: AppServerMessageListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: AppServerMessageListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  respondToServerRequest(id: RequestId, result: unknown): void {
    if (this.#closed || !this.#current) {
      throw new Error("codex app-server 当前不可用。");
    }
    this.#current.respondToServerRequest(id, result);
  }

  /** 只在子进程意外退出时完成；主动 close() 不触发。 */
  whenExited(): Promise<void> {
    return this.#unexpectedExit;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const ready = this.#ready;
    if (!ready) return;
    const client = await ready.catch(() => null);
    if (!client) return;
    if (this.#current === client) this.#current = null;
    await client.close();
  }

  async #startClient(
    params: InitializeParams,
  ): Promise<{ client: AppServerProcess; response: InitializeResponse }> {
    const client = this.#clientFactory({
      ...this.#clientOptions,
      onNotification: (message) => this.#emit(this.#notificationListeners, message),
      onServerRequest: (message) => this.#emit(this.#serverRequestListeners, message),
    });
    this.#current = client;
    // close() 先把 #closed 置位，启动失败时先把 #current 清空，两种情况都不算意外退出。
    void client.whenExited().then(() => {
      if (this.#closed || this.#current !== client) return;
      this.#markUnexpectedExit();
    });

    try {
      const response = await client.initialize(params);
      return { client, response };
    } catch (error) {
      if (this.#current === client) this.#current = null;
      await client.close().catch(() => {});
      throw error;
    }
  }

  #requireReady(): Promise<AppServerProcess> {
    return this.#ready ?? Promise.reject(
      new Error("codex app-server 运行时尚未初始化。"),
    );
  }

  #emit(listeners: Set<AppServerMessageListener>, message: JsonObject): void {
    for (const listener of listeners) listener(message);
  }

  #markUnexpectedExit(): void {
    if (this.#closed || this.#unexpectedExitResolved) return;
    this.#unexpectedExitResolved = true;
    this.#resolveUnexpectedExit();
  }
}
