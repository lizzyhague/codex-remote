import type { TurnStatus } from "../generated/v2/TurnStatus.ts";
import type { TurnStartParams } from "../generated/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "../generated/v2/TurnStartResponse.ts";
import type { TurnInterruptParams } from "../generated/v2/TurnInterruptParams.ts";
import type { TurnInterruptResponse } from "../generated/v2/TurnInterruptResponse.ts";

import type { AppServerMessageListener, JsonObject } from "./client.ts";

export interface AppServerTransport {
  request<Result = unknown>(method: string, params: unknown): Promise<Result>;
  onNotification(listener: AppServerMessageListener): () => void;
}

export type CodexStreamEvent =
  | { type: "turn_started"; threadId: string; turnId: string }
  | {
    type: "user_message_started";
    threadId: string;
    turnId: string;
    itemId: string;
    text: string;
  }
  | {
    type: "assistant_text_delta";
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }
  | {
    type: "command_output_delta";
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }
  | {
    type: "command_started";
    threadId: string;
    turnId: string;
    itemId: string;
    command: string;
  }
  | {
    type: "assistant_text_completed";
    threadId: string;
    turnId: string;
    itemId: string;
    text: string;
  }
  | {
    type: "command_completed";
    threadId: string;
    turnId: string;
    itemId: string;
    command: string;
    status: string;
    output: string | null;
    exitCode: number | null;
    durationMs: number | null;
  }
  | {
    type: "file_change_completed";
    threadId: string;
    turnId: string;
    itemId: string;
    status: string;
    changedFiles: number;
  }
  | {
    type: "turn_completed";
    threadId: string;
    turnId: string;
    status: TurnStatus;
    error: string | null;
  }
  | {
    type: "turn_error";
    threadId: string;
    turnId: string;
    message: string;
    willRetry: boolean;
  };

/**
 * 管理一个 Codex 会话中的当前任务，并把 app-server 通知缩成前端需要的事件。
 * 它不负责 WebSocket，也不会把 app-server 的原始协议暴露给浏览器。
 */
export class CodexTurnSession {
  readonly #transport: AppServerTransport;
  readonly #threadId: string;
  readonly #listeners = new Set<(event: CodexStreamEvent) => void>();
  readonly #unsubscribe: () => void;
  #activeTurnId: string | null;
  #starting = false;
  #completedBeforeStartResponse = new Set<string>();
  #interruptPromise: Promise<boolean> | null = null;
  #interruptRequestedFor: string | null = null;

  constructor(
    transport: AppServerTransport,
    threadId: string,
    activeTurnId: string | null = null,
  ) {
    if (!threadId) {
      throw new Error("Codex 会话 ID 不能为空。");
    }

    this.#transport = transport;
    this.#threadId = threadId;
    this.#activeTurnId = activeTurnId;
    this.#unsubscribe = transport.onNotification((message) => {
      this.#handleNotification(message);
    });
  }

  get threadId(): string {
    return this.#threadId;
  }

  get activeTurnId(): string | null {
    return this.#activeTurnId;
  }

  onEvent(listener: (event: CodexStreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startTextTurn(text: string): Promise<string> {
    if (this.#activeTurnId || this.#starting) {
      throw new Error("这个会话已有任务正在运行。");
    }
    if (!text.trim()) {
      throw new Error("消息不能为空。");
    }

    const params: TurnStartParams = {
      threadId: this.#threadId,
      input: [{ type: "text", text, text_elements: [] }],
    };
    this.#starting = true;
    try {
      const response = await this.#transport.request<TurnStartResponse>(
        "turn/start",
        params,
      );
      const turnId = readTurnStartId(response);

      if (this.#activeTurnId && this.#activeTurnId !== turnId) {
        throw new Error("Codex 返回的任务 ID 与启动通知不一致。");
      }
      if (!this.#completedBeforeStartResponse.delete(turnId)) {
        this.#activeTurnId = turnId;
      }
      return turnId;
    } finally {
      this.#starting = false;
      this.#completedBeforeStartResponse.clear();
    }
  }

  interruptActiveTurn(): Promise<boolean> {
    if (this.#interruptPromise) {
      return this.#interruptPromise;
    }

    const turnId = this.#activeTurnId;
    if (!turnId) {
      return Promise.resolve(false);
    }
    if (this.#interruptRequestedFor === turnId) {
      return Promise.resolve(true);
    }

    const params: TurnInterruptParams = {
      threadId: this.#threadId,
      turnId,
    };
    this.#interruptRequestedFor = turnId;
    this.#interruptPromise = this.#transport
      .request<TurnInterruptResponse>("turn/interrupt", params)
      .then(() => true)
      .catch((error: unknown) => {
        this.#interruptRequestedFor = null;
        throw error;
      })
      .finally(() => {
        this.#interruptPromise = null;
      });
    return this.#interruptPromise;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #handleNotification(message: JsonObject): void {
    const params = asObject(message.params);
    if (!params || params.threadId !== this.#threadId) {
      return;
    }

    const method = message.method;
    if (method === "item/started") {
      const item = asObject(params.item);
      if (
        item?.type === "userMessage" &&
        typeof item.id === "string" &&
        Array.isArray(item.content) &&
        typeof params.turnId === "string"
      ) {
        const text = item.content
          .map(asObject)
          .filter((part): part is JsonObject => part?.type === "text")
          .map((part) => typeof part.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\n");
        if (text) {
          this.#emit({
            type: "user_message_started",
            threadId: this.#threadId,
            turnId: params.turnId,
            itemId: item.id,
            text,
          });
        }
        return;
      }
      if (
        item?.type === "commandExecution" &&
        typeof item.id === "string" &&
        typeof item.command === "string" &&
        typeof params.turnId === "string"
      ) {
        this.#emit({
          type: "command_started",
          threadId: this.#threadId,
          turnId: params.turnId,
          itemId: item.id,
          command: item.command,
        });
      }
      return;
    }

    if (method === "item/completed") {
      this.#handleCompletedItem(params);
      return;
    }

    if (method === "turn/started") {
      const turn = asObject(params.turn);
      if (!turn || typeof turn.id !== "string") {
        return;
      }
      this.#activeTurnId = turn.id;
      this.#interruptRequestedFor = null;
      this.#emit({
        type: "turn_started",
        threadId: this.#threadId,
        turnId: turn.id,
      });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = readDelta(params);
      if (delta) {
        this.#emit({ type: "assistant_text_delta", ...delta });
      }
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const delta = readDelta(params);
      if (delta) {
        this.#emit({ type: "command_output_delta", ...delta });
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = asObject(params.turn);
      if (!turn || typeof turn.id !== "string" || !isTurnStatus(turn.status)) {
        return;
      }
      if (this.#activeTurnId === turn.id) {
        this.#activeTurnId = null;
        this.#interruptRequestedFor = null;
      }
      if (this.#starting) {
        this.#completedBeforeStartResponse.add(turn.id);
      }
      const error = asObject(turn.error);
      this.#emit({
        type: "turn_completed",
        threadId: this.#threadId,
        turnId: turn.id,
        status: turn.status,
        error: error && typeof error.message === "string" ? error.message : null,
      });
      return;
    }

    if (method === "error" && typeof params.turnId === "string") {
      const error = asObject(params.error);
      if (!error || typeof error.message !== "string") {
        return;
      }
      this.#emit({
        type: "turn_error",
        threadId: this.#threadId,
        turnId: params.turnId,
        message: error.message,
        willRetry: params.willRetry === true,
      });
    }
  }

  #emit(event: CodexStreamEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #handleCompletedItem(params: JsonObject): void {
    const item = asObject(params.item);
    if (!item || typeof item.id !== "string" || typeof params.turnId !== "string") {
      return;
    }
    const common = {
      threadId: this.#threadId,
      turnId: params.turnId,
      itemId: item.id,
    };

    if (item.type === "agentMessage" && typeof item.text === "string") {
      this.#emit({ type: "assistant_text_completed", ...common, text: item.text });
      return;
    }
    if (item.type === "exitedReviewMode" && typeof item.review === "string") {
      this.#emit({ type: "assistant_text_completed", ...common, text: item.review });
      return;
    }
    if (
      item.type === "commandExecution" &&
      typeof item.command === "string" &&
      typeof item.status === "string"
    ) {
      this.#emit({
        type: "command_completed",
        ...common,
        command: item.command,
        status: item.status,
        output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
      });
      return;
    }
    if (
      item.type === "fileChange" &&
      typeof item.status === "string" &&
      Array.isArray(item.changes)
    ) {
      this.#emit({
        type: "file_change_completed",
        ...common,
        status: item.status,
        changedFiles: item.changes.length,
      });
    }
  }
}

function readTurnStartId(value: unknown): string {
  const response = asObject(value);
  const turn = response && asObject(response.turn);
  if (!turn || typeof turn.id !== "string") {
    throw new Error("Codex 返回了无法识别的任务启动结果。");
  }
  return turn.id;
}

function readDelta(params: JsonObject): {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
} | null {
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.delta !== "string"
  ) {
    return null;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    delta: params.delta,
  };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function isTurnStatus(value: unknown): value is TurnStatus {
  return value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "inProgress";
}
