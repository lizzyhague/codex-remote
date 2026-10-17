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

export type DirectoryAppServerOptions =
  & Omit<AppServerClientOptions, "onNotification" | "onServerRequest">
  & {
    /** Test-double injection point; production always uses the real stdio app-server. */
    clientFactory?: AppServerProcessFactory;
  };

/**
 * Directory App Server child process. Session listing, resumption, and account limits use this
 * shared process. Turns run in per-session Workers, so this process never loads writable rollouts.
 */
export class DirectoryAppServer {
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
  /** The spawned process, initialized or not; close() uses it to interrupt a stuck initialize. */
  #started: AppServerProcess | null = null;
  #current: AppServerProcess | null = null;
  #closed = false;

  constructor(options: DirectoryAppServerOptions = {}) {
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
    // The caller receives failure from this result; #ready serves later request() calls and must not reject unhandled.
    this.#ready.catch(() => {});
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

  /** Resolves only when the child exits unexpectedly; an explicit close() does not trigger it. */
  whenExited(): Promise<void> {
    return this.#unexpectedExit;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    // Do not await #ready: initialization may never return. Closing the child rejects the pending initialize.
    const client = this.#started;
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
    this.#started = client;
    this.#current = client;
    // close() first sets #closed, while startup failure first clears #current; neither is an unexpected exit.
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
