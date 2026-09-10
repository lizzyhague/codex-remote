import type { TurnStatus } from "../generated/v2/TurnStatus.ts";
import type { TurnStartParams } from "../generated/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "../generated/v2/TurnStartResponse.ts";
import type { TurnInterruptParams } from "../generated/v2/TurnInterruptParams.ts";
import type { TurnInterruptResponse } from "../generated/v2/TurnInterruptResponse.ts";
import type { UserInput } from "../generated/v2/UserInput.ts";

import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import {
  formatPrivateAttachmentPathsBlock,
  isPrivateAttachmentPathsText,
  stripPrivateAttachmentPaths,
} from "../attachments/private-paths.ts";
import type { AppServerMessageListener, JsonObject } from "./client.ts";
import {
  publicRawToolView,
  publicToolView,
  type PublicToolView,
} from "./tool-view.ts";

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
    type: "tool_output_delta";
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }
  | {
    type: "tool_started";
    threadId: string;
    turnId: string;
    itemId: string;
    tool: PublicToolView;
  }
  | {
    type: "assistant_text_completed";
    threadId: string;
    turnId: string;
    itemId: string;
    text: string;
  }
  | {
    type: "tool_completed";
    threadId: string;
    turnId: string;
    itemId: string;
    tool: PublicToolView;
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

export type CodexTurnAttachment = {
  id: string;
  originalName: string;
  kind: "image" | "file";
  path: string;
  detectedMime: string;
  size: number;
};

export const PRIVATE_ATTACHMENT_INPUT_PREFIX =
  "[CODEX_REMOTE_PRIVATE_ATTACHMENT_CONTENT_V1]";
const MAX_TURN_INPUT_CHARS = 1_048_576;

export class CodexAttachmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAttachmentError";
    this.code = code;
  }
}

export class CodexTurnCancelledError extends Error {
  constructor() {
    super("任务在启动前已取消。");
    this.name = "CodexTurnCancelledError";
  }
}

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
  #rawExecTools = new Map<string, { turnId: string; tool: PublicToolView }>();
  #interruptPromise: Promise<boolean> | null = null;
  #interruptRequestedFor: string | null = null;
  #pendingInterrupt = false;
  #startingInterrupt: {
    promise: Promise<boolean>;
    resolve: (value: boolean) => void;
    reject: (error: unknown) => void;
  } | null = null;
  #submittedUserText: string | null = null;
  #attachmentMappings: AttachmentDisplayMapping[] = [];

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

  setAttachmentMappings(mappings: readonly AttachmentDisplayMapping[]): void {
    this.#attachmentMappings = [...mappings];
  }

  async startTextTurn(text: string, attachments: CodexTurnAttachment[] = []): Promise<string> {
    if (this.#activeTurnId || this.#starting) {
      throw new Error("这个会话已有任务正在运行。");
    }
    if (!text.trim() && attachments.length === 0) {
      throw new Error("消息和附件不能同时为空。");
    }

    validateCodexTurnAttachments(attachments, text);
    this.#starting = true;
    try {
      if (this.#pendingInterrupt) {
        this.#resolveStartingInterrupt(true);
        throw new CodexTurnCancelledError();
      }
      const displayText = attachmentDisplayText(text, attachments);
      const input: UserInput[] = [
        { type: "text", text: displayText, text_elements: [] },
      ];
      if (attachments.length > 0) {
        input.push({
          type: "text",
          text: formatPrivateAttachmentPathsBlock(attachments.map((attachment) => ({
            id: attachment.id,
            originalName: attachment.originalName,
            path: attachment.path,
            mimeType: attachment.detectedMime,
            size: attachment.size,
          }))),
          text_elements: [],
        });
      }
      const params: TurnStartParams = {
        threadId: this.#threadId,
        input,
      };
      if (this.#pendingInterrupt) {
        this.#resolveStartingInterrupt(true);
        throw new CodexTurnCancelledError();
      }
      this.#submittedUserText = displayText;
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
      if (this.#pendingInterrupt) {
        if (this.#activeTurnId) {
          await this.#sendInterrupt(this.#activeTurnId);
        } else {
          this.#resolveStartingInterrupt(true);
        }
      }
      return turnId;
    } catch (error) {
      if (this.#pendingInterrupt && !(error instanceof CodexTurnCancelledError)) {
        this.#rejectStartingInterrupt(error);
      }
      throw error;
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
    if (turnId) {
      return this.#sendInterrupt(turnId);
    }
    if (this.#starting) {
      this.#pendingInterrupt = true;
      const pending = this.#ensureStartingInterrupt();
      this.#interruptPromise = pending.promise.finally(() => {
        this.#interruptPromise = null;
      });
      return this.#interruptPromise;
    }
    return Promise.resolve(false);
  }

  #sendInterrupt(turnId: string): Promise<boolean> {
    if (this.#interruptRequestedFor === turnId) {
      this.#resolveStartingInterrupt(true);
      return Promise.resolve(true);
    }

    const params: TurnInterruptParams = {
      threadId: this.#threadId,
      turnId,
    };
    this.#interruptRequestedFor = turnId;
    this.#interruptPromise = this.#transport
      .request<TurnInterruptResponse>("turn/interrupt", params)
      .then(() => {
        this.#resolveStartingInterrupt(true);
        return true;
      })
      .catch((error: unknown) => {
        this.#interruptRequestedFor = null;
        this.#rejectStartingInterrupt(error);
        throw error;
      })
      .finally(() => {
        this.#interruptPromise = null;
      });
    return this.#interruptPromise;
  }

  #ensureStartingInterrupt(): {
    promise: Promise<boolean>;
    resolve: (value: boolean) => void;
    reject: (error: unknown) => void;
  } {
    if (this.#startingInterrupt) return this.#startingInterrupt;
    let resolve!: (value: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#startingInterrupt = { promise, resolve, reject };
    return this.#startingInterrupt;
  }

  #resolveStartingInterrupt(value: boolean): void {
    this.#pendingInterrupt = false;
    this.#startingInterrupt?.resolve(value);
    this.#startingInterrupt = null;
  }

  #rejectStartingInterrupt(error: unknown): void {
    this.#pendingInterrupt = false;
    this.#startingInterrupt?.reject(error);
    this.#startingInterrupt = null;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#listeners.clear();
    this.#rawExecTools.clear();
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
        const receivedText = item.content
          .map(asObject)
          .filter((part): part is JsonObject =>
            part?.type === "text" &&
            (typeof part.text !== "string" || !isPrivateAttachmentInputText(part.text)))
          .map((part) => typeof part.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\n");
        const text = stripPrivateAttachmentInputs(this.#submittedUserText ?? receivedText);
        this.#submittedUserText = null;
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
      if (item && typeof item.id === "string" && typeof params.turnId === "string") {
        const tool = publicToolView(item, "inProgress", this.#attachmentMappings);
        if (!tool) return;
        this.#emit({
          type: "tool_started",
          threadId: this.#threadId,
          turnId: params.turnId,
          itemId: item.id,
          tool,
        });
      }
      return;
    }

    if (method === "item/completed") {
      this.#handleCompletedItem(params);
      return;
    }

    if (method === "rawResponseItem/completed") {
      this.#handleRawResponseItem(params);
      return;
    }

    if (method === "turn/started") {
      const turn = asObject(params.turn);
      if (!turn || typeof turn.id !== "string") {
        return;
      }
      this.#activeTurnId = turn.id;
      this.#emit({
        type: "turn_started",
        threadId: this.#threadId,
        turnId: turn.id,
      });
      if (this.#pendingInterrupt) {
        void this.#sendInterrupt(turn.id).catch(() => {});
      }
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
        this.#emit({ type: "tool_output_delta", ...delta });
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
      if (this.#pendingInterrupt) {
        this.#resolveStartingInterrupt(true);
      }
      if (this.#starting) {
        this.#completedBeforeStartResponse.add(turn.id);
      }
      for (const [callId, pending] of this.#rawExecTools) {
        if (pending.turnId === turn.id) this.#rawExecTools.delete(callId);
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
    const tool = publicToolView(item, "completed", this.#attachmentMappings);
    if (tool) this.#emit({ type: "tool_completed", ...common, tool });
  }

  #handleRawResponseItem(params: JsonObject): void {
    if (typeof params.turnId !== "string") return;
    const item = asObject(params.item);
    if (!item) return;

    if (item.type === "custom_tool_call") {
      const event = publicRawToolView(item, null, this.#attachmentMappings);
      if (!event || event.phase !== "started" || this.#rawExecTools.has(event.callId)) return;
      this.#rawExecTools.set(event.callId, { turnId: params.turnId, tool: event.tool });
      this.#emit({
        type: "tool_started",
        threadId: this.#threadId,
        turnId: params.turnId,
        itemId: rawExecItemId(event.callId),
        tool: event.tool,
      });
      return;
    }

    if (item.type !== "custom_tool_call_output") return;
    const callId = typeof item.call_id === "string" ? item.call_id : null;
    if (!callId) return;
    const pending = this.#rawExecTools.get(callId);
    if (!pending || pending.turnId !== params.turnId) return;
    const event = publicRawToolView(item, pending.tool, this.#attachmentMappings);
    if (!event || event.phase !== "completed") return;
    this.#rawExecTools.delete(callId);
    this.#emit({
      type: "tool_completed",
      threadId: this.#threadId,
      turnId: params.turnId,
      itemId: rawExecItemId(callId),
      tool: event.tool,
    });
  }
}

export function validateCodexTurnAttachments(
  attachments: CodexTurnAttachment[],
  baseText = "",
): void {
  const missing = attachments.find((attachment) => !attachment.path);
  if (missing) {
    throw new CodexAttachmentError(
      "attachment_unreadable",
      `Codex 无法读取附件：${missing.originalName}。`,
    );
  }
  const displayText = attachmentDisplayText(baseText, attachments);
  const privateBlock = attachments.length === 0
    ? ""
    : formatPrivateAttachmentPathsBlock(attachments.map((attachment) => ({
      id: attachment.id,
      originalName: attachment.originalName,
      path: attachment.path,
      mimeType: attachment.detectedMime,
      size: attachment.size,
    })));
  const inputChars = displayText.length + (privateBlock ? privateBlock.length + 1 : 0);
  if (inputChars > MAX_TURN_INPUT_CHARS) {
    throw new CodexAttachmentError(
      "attachment_context_too_large",
      "消息正文和附件说明合计超过 Codex 单轮输入上限，请缩短正文或减少附件。",
    );
  }
}

export function isPrivateAttachmentInputText(text: string): boolean {
  if (text.startsWith(PRIVATE_ATTACHMENT_INPUT_PREFIX)) return true;
  return isPrivateAttachmentPathsText(text) &&
    stripPrivateAttachmentPaths(text).trim() === "";
}

/** 去掉新旧两种内部附件说明，保留用户可见正文。 */
export function stripPrivateAttachmentInputs(text: string): string {
  return stripLegacyPrivateAttachmentContent(stripPrivateAttachmentPaths(text));
}

function stripLegacyPrivateAttachmentContent(text: string): string {
  const start = indexOfWholeLine(text, PRIVATE_ATTACHMENT_INPUT_PREFIX);
  if (start < 0) return text;
  return text.slice(0, start).replace(/\n+$/u, "");
}

function indexOfWholeLine(text: string, marker: string): number {
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(marker, index);
    if (found < 0) return -1;
    const atLineStart = found === 0 || text[found - 1] === "\n";
    const after = found + marker.length;
    const atLineEnd = after === text.length || text[after] === "\n" ||
      text.startsWith("\r\n", after);
    if (atLineStart && atLineEnd) return found;
    index = found + marker.length;
  }
  return -1;
}

function attachmentDisplayText(text: string, attachments: CodexTurnAttachment[]): string {
  const trimmed = text.trim();
  if (attachments.length === 0) return text;
  const lines = attachments.map((attachment) =>
    `[附件：${attachment.originalName} · ${attachment.id}]`);
  return trimmed ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
}

function rawExecItemId(callId: string): string {
  return `raw-exec:${callId}`;
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
