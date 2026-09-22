import { randomUUID } from "node:crypto";

import type { RequestId } from "../generated/RequestId.ts";
import type { AppServerMessageListener, JsonObject } from "./client.ts";

export interface ServerRequestTransport {
  onServerRequest(listener: AppServerMessageListener): () => void;
  onNotification(listener: AppServerMessageListener): () => void;
  respondToServerRequest(id: RequestId, result: unknown): void;
}

/** 待答项至少要能说出自己属于哪个会话，取消和列举都按会话走。 */
export type BrokeredRequest = {
  id: string;
  threadId: string;
};

/** 不论哪种待答项，取消和"被 Codex 自己收回"这两种结局都一样。 */
export type BrokerBaseResolution = "cancelled" | "cleared";

type Pending<Item> = {
  requestId: RequestId;
  item: Item;
};

/**
 * app-server 反过来向后端提问时的待答请求簿。
 *
 * 审批和交互都要把请求存住、发给浏览器、等回答、再把结果送回 app-server，还要处理
 * Codex 自己撤回请求的通知。这里放的是这套骨架；子类只负责解析请求和组装回复。
 */
export abstract class ServerRequestBroker<
  Item extends BrokeredRequest,
  Event,
  Resolution extends string,
> {
  readonly #transport: ServerRequestTransport;
  readonly #pending = new Map<string, Pending<Item>>();
  readonly #idByRequestId = new Map<RequestId, string>();
  readonly #listeners = new Set<(event: Event) => void>();
  readonly #unsubscribeRequests: () => void;
  readonly #unsubscribeNotifications: () => void;

  protected constructor(transport: ServerRequestTransport) {
    this.#transport = transport;
    this.#unsubscribeRequests = transport.onServerRequest((message) => {
      this.#handleRequest(message);
    });
    this.#unsubscribeNotifications = transport.onNotification((message) => {
      this.#handleNotification(message);
    });
  }

  /** 认得这个方法就返回待答项（不含 id），认不得就返回 null。 */
  protected abstract parse(method: string, params: JsonObject): Omit<Item, "id"> | null;

  /** 取消一个还没回答的请求时，回给 app-server 的内容。 */
  protected abstract cancelResponse(item: Item): JsonObject;

  protected abstract requestedEvent(item: Item): Event;

  protected abstract resolvedEvent(
    id: string,
    resolution: Resolution | BrokerBaseResolution,
  ): Event;

  onEvent(listener: (event: Event) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pendingForThread(threadId: string): Item[] {
    return [...this.#pending.values()]
      .map((pending) => pending.item)
      .filter((item) => item.threadId === threadId);
  }

  dispose(): void {
    this.#unsubscribeRequests();
    this.#unsubscribeNotifications();
    this.#listeners.clear();
  }

  /** 子类的 `answer()` 用：回复 app-server 并按自己的结局把待答项摘掉。 */
  protected respond(
    id: string,
    toResponse: (item: Item) => JsonObject,
    resolution: Resolution | BrokerBaseResolution,
  ): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    this.#transport.respondToServerRequest(pending.requestId, toResponse(pending.item));
    this.#remove(id, resolution);
    return true;
  }

  /** 取消所有满足条件的待答项，返回取消了几个。 */
  protected cancelWhere(predicate: (item: Item) => boolean): number {
    const matches = [...this.#pending.entries()].filter(([, pending]) =>
      predicate(pending.item)
    );
    for (const [id, pending] of matches) {
      this.#transport.respondToServerRequest(
        pending.requestId,
        this.cancelResponse(pending.item),
      );
      this.#remove(id, "cancelled");
    }
    return matches.length;
  }

  #handleRequest(message: JsonObject): void {
    const requestId = readRequestId(message.id);
    const params = asObject(message.params);
    if (
      requestId === null || !params || typeof message.method !== "string" ||
      this.#idByRequestId.has(requestId)
    ) {
      return;
    }
    const parsed = this.parse(message.method, params);
    if (!parsed) return;
    const item = { ...parsed, id: randomUUID() } as Item;
    this.#pending.set(item.id, { requestId, item });
    this.#idByRequestId.set(requestId, item.id);
    this.#emit(this.requestedEvent(item));
  }

  /** app-server 自己收回了请求，这时不需要再回复。 */
  #handleNotification(message: JsonObject): void {
    if (message.method !== "serverRequest/resolved") return;
    const params = asObject(message.params);
    const requestId = readRequestId(params?.requestId);
    if (requestId === null) return;
    const id = this.#idByRequestId.get(requestId);
    if (id) this.#remove(id, "cleared");
  }

  #remove(id: string, resolution: Resolution | BrokerBaseResolution): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    this.#idByRequestId.delete(pending.requestId);
    this.#emit(this.resolvedEvent(id, resolution));
  }

  #emit(event: Event): void {
    for (const listener of this.#listeners) listener(event);
  }
}

export function readRequestId(value: unknown): RequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
