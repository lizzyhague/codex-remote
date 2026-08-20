import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { ClientNotification } from "../generated/ClientNotification.ts";
import type { InitializeParams } from "../generated/InitializeParams.ts";
import type { InitializeResponse } from "../generated/InitializeResponse.ts";
import type { RequestId } from "../generated/RequestId.ts";

export type JsonObject = Record<string, unknown>;
export type AppServerMessageListener = (message: JsonObject) => void;

/** 非 JSONL 噪音只记录前几条，避免子进程刷屏时把日志撑爆。 */
const MAX_LOGGED_UNEXPECTED_LINES = 20;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type RpcErrorPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type AppServerClientOptions = {
  codexBinary?: string;
  workingDirectory?: string;
  onNotification?: AppServerMessageListener;
  onServerRequest?: AppServerMessageListener;
};

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(payload: RpcErrorPayload) {
    super(payload.message);
    this.name = "AppServerRpcError";
    this.code = payload.code;
    this.data = payload.data;
  }
}

/**
 * 持有一个 codex app-server 子进程，并把 JSONL 请求与响应配对。
 * 浏览器协议不会直接接触这个类；后续由 Codex 适配器做翻译。
 */
export class AppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #notificationListeners = new Set<AppServerMessageListener>();
  readonly #serverRequestListeners = new Set<AppServerMessageListener>();
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #nextRequestId = 1;
  #closed = false;
  #stderrTail = "";
  #unexpectedLines = 0;

  constructor(options: AppServerClientOptions = {}) {
    if (options.onNotification) {
      this.#notificationListeners.add(options.onNotification);
    }
    if (options.onServerRequest) {
      this.#serverRequestListeners.add(options.onServerRequest);
    }
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    this.#child = spawn(
      options.codexBinary ?? process.env.CODEX_BIN ?? "codex",
      ["app-server", "--stdio"],
      {
        cwd: options.workingDirectory,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-16_384);
    });

    // 子进程退出时 stdin 会变成断开的管道。没有这个监听器，正在进行的写入
    // 会抛出未捕获的流错误，把整个网页后端一起带走。
    this.#child.stdin.on("error", (error: Error) => this.#fail(error));

    this.#child.once("error", (error) => {
      this.#fail(error);
      this.#resolveExit();
    });
    this.#child.once("exit", (code, signal) => {
      const detail = code === 0
        ? "codex app-server 已退出。"
        : `codex app-server 异常退出（code=${String(code)}, signal=${String(signal)}）。`;
      this.#fail(new Error(this.#stderrTail.trim() || detail));
      this.#resolveExit();
    });
    // spawn 失败时只有 error/close，没有 exit；close 兜底避免 whenExited() 永不落地。
    this.#child.once("close", () => this.#resolveExit());
  }

  /** 子进程结束后落地。调用方据此决定是否让整个服务退出，交给 systemd 重启。 */
  whenExited(): Promise<void> {
    return this.#exitPromise;
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    const result = await this.request("initialize", params);
    if (!isInitializeResponse(result)) {
      throw new Error("codex app-server 返回了无法识别的初始化结果。");
    }

    this.notify({ method: "initialized" });
    return result;
  }

  request<Result = unknown>(method: string, params: unknown): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new Error("codex app-server 连接已经关闭。"));
    }

    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    const response = new Promise<Result>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
      });
    });

    try {
      this.#write({ method, id, params });
    } catch (error) {
      this.#pending.delete(id);
      return Promise.reject(asError(error));
    }

    return response;
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
    if (this.#closed) {
      throw new Error("codex app-server 连接已经关闭。");
    }
    this.#write({ id, result });
  }

  notify(notification: ClientNotification): void {
    if (this.#closed) {
      throw new Error("codex app-server 连接已经关闭。");
    }
    this.#write(notification);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#child.stdin.end();
    }

    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 3_000);
      }),
    ]).finally(() => clearTimeout(timer));

    if (!exited) {
      this.#child.kill("SIGTERM");
      await this.#exitPromise;
    }
  }

  #write(message: object): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Codex 偶尔会把告警写到 stdout。跳过这一行即可，不要因为一行噪音
      // 就永久断开一个仍然健康的子进程。
      this.#warnUnexpectedLine(line);
      return;
    }

    if (!isJsonObject(message)) {
      this.#warnUnexpectedLine(line);
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      this.#handleResponse(message);
      return;
    }

    if (typeof message.method === "string" && "id" in message) {
      for (const listener of this.#serverRequestListeners) {
        listener(message);
      }
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.#notificationListeners) {
        listener(message);
      }
    }
  }

  #handleResponse(message: JsonObject): void {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      this.#fail(new Error("codex app-server 响应缺少有效请求 ID。"));
      return;
    }

    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);

    if ("error" in message) {
      pending.reject(new AppServerRpcError(normalizeRpcError(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  #warnUnexpectedLine(line: string): void {
    this.#unexpectedLines += 1;
    if (this.#unexpectedLines <= MAX_LOGGED_UNEXPECTED_LINES) {
      console.warn(`忽略 codex app-server 的非 JSONL 输出：${line.slice(0, 200)}`);
    }
  }

  #fail(error: Error): void {
    if (!this.#closed) {
      this.#closed = true;
    }
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitializeResponse(value: unknown): value is InitializeResponse {
  return isJsonObject(value) &&
    typeof value.userAgent === "string" &&
    typeof value.codexHome === "string" &&
    typeof value.platformFamily === "string" &&
    typeof value.platformOs === "string";
}

function normalizeRpcError(value: unknown): RpcErrorPayload {
  if (!isJsonObject(value)) {
    return { code: -1, message: "codex app-server 返回了未知错误。" };
  }

  return {
    code: typeof value.code === "number" ? value.code : -1,
    message: typeof value.message === "string" ? value.message : "codex app-server 返回了未知错误。",
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
