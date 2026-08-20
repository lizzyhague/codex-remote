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
 * 在不结束 HTTP 服务的前提下管理可重建的 app-server 子进程。
 *
 * app-server 会独占已加载会话的 rollout writer，而且 thread/unsubscribe 在最后一个
 * 订阅者离开后仍有 30 分钟的卸载宽限期。最后一个网页客户端离开时重建子进程，
 * 才能立即把 writer 交还给本机 Codex CLI。监听器挂在这一层，因此重建后不需要
 * 重新创建 SessionService、ApprovalBroker 或 HTTP 服务。
 */
export class RestartableAppServer {
  readonly #clientOptions: Omit<
    AppServerClientOptions,
    "onNotification" | "onServerRequest"
  >;
  readonly #clientFactory: AppServerProcessFactory;
  readonly #notificationListeners = new Set<AppServerMessageListener>();
  readonly #serverRequestListeners = new Set<AppServerMessageListener>();
  readonly #expectedExits = new WeakSet<AppServerProcess>();
  readonly #unexpectedExit: Promise<void>;
  #resolveUnexpectedExit!: () => void;
  #unexpectedExitResolved = false;
  #initializeParams: InitializeParams | null = null;
  #ready: Promise<AppServerProcess> | null = null;
  #current: AppServerProcess | null = null;
  #transitionTail: Promise<void> = Promise.resolve();
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

    this.#initializeParams = params;
    const started = this.#startClient(params);
    this.#ready = started.then(({ client }) => client);
    const { response } = await started;
    return response;
  }

  async request<Result = unknown>(method: string, params: unknown): Promise<Result> {
    if (this.#closed) {
      throw new Error("codex app-server 运行时已经关闭。");
    }
    // releaseWriters() 会同步排进 transitionTail；恰好重连的浏览器在这里等待新
    // 子进程完成 initialize，而不会把请求写进正在退出的旧 stdin。
    await this.#transitionTail;
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

  /** 只在所有网页连接完成清理后调用；关闭旧进程会立即释放所有 rollout writer。 */
  releaseWriters(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error("codex app-server 运行时已经关闭。"));
    }
    const transition = this.#transitionTail.then(() => this.#restart());
    // 后续重建仍可排队；本次调用者拿到原始 promise，能够观察失败。
    this.#transitionTail = transition.catch(() => {});
    void transition.catch(() => this.#markUnexpectedExit());
    return transition;
  }

  /** 只在子进程意外退出时完成；主动 releaseWriters/close 不触发。 */
  whenExited(): Promise<void> {
    return this.#unexpectedExit;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transitionTail;

    const ready = this.#ready;
    if (!ready) return;
    const client = await ready.catch(() => null);
    if (!client) return;
    this.#expectedExits.add(client);
    if (this.#current === client) this.#current = null;
    await client.close();
  }

  async #restart(): Promise<void> {
    const oldClient = await this.#requireReady();
    this.#expectedExits.add(oldClient);

    const replacement = (async () => {
      await oldClient.close();
      if (this.#current === oldClient) this.#current = null;
      if (this.#closed) {
        throw new Error("codex app-server 运行时已经关闭。");
      }
      const params = this.#initializeParams;
      if (!params) {
        throw new Error("codex app-server 运行时尚未初始化。");
      }
      const { client } = await this.#startClient(params);
      return client;
    })();

    // 在等待旧进程退出前先发布 replacement promise，让并发请求不会再拿到旧进程。
    this.#ready = replacement;
    await replacement;
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
    void client.whenExited().then(() => {
      if (
        this.#closed || this.#expectedExits.has(client) ||
        this.#current !== client
      ) {
        return;
      }
      this.#markUnexpectedExit();
    });

    try {
      const response = await client.initialize(params);
      return { client, response };
    } catch (error) {
      this.#expectedExits.add(client);
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
