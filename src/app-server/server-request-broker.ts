import { randomUUID } from "node:crypto";

import type { RequestId } from "../generated/RequestId.ts";
import { asObject } from "../shared/json.ts";
import type { AppServerMessageListener, JsonObject } from "./client.ts";

export interface ServerRequestTransport {
  onServerRequest(listener: AppServerMessageListener): () => void;
  onNotification(listener: AppServerMessageListener): () => void;
  respondToServerRequest(id: RequestId, result: unknown): void;
}

/** Every pending request identifies its session; cancellation and listing are session-scoped. */
export type BrokeredRequest = {
  id: string;
  threadId: string;
};

/** All pending request types share the same cancelled and withdrawn-by-Codex outcomes. */
export type BrokerBaseResolution = "cancelled" | "cleared";

type Pending<Item> = {
  requestId: RequestId;
  item: Item;
};

/**
 * Registry of pending requests initiated by app-server toward the backend.
 *
 * Approvals and interactions both store a request, send it to the browser, await an answer, return
 * the result to app-server, and handle Codex withdrawing it. This class provides that framework;
 * subclasses only parse requests and assemble replies.
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

  /** Return a pending request without its ID for recognized methods, or null otherwise. */
  protected abstract parse(method: string, params: JsonObject): Omit<Item, "id"> | null;

  /** Build the app-server reply used when an unanswered request is cancelled. */
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

  /** Used by subclass `answer()` methods to reply to app-server and remove the resolved request. */
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

  /** Cancel all matching pending requests and return the number cancelled. */
  protected cancelWhere(predicate: (item: Item) => boolean): number {
    const matches = [...this.#pending.entries()].filter(([, pending]) =>
      predicate(pending.item)
    );
    let firstError: unknown = null;
    for (const [id, pending] of matches) {
      try {
        this.#transport.respondToServerRequest(
          pending.requestId,
          this.cancelResponse(pending.item),
        );
      } catch (error) {
        firstError ??= error;
      } finally {
        // A reply may fail after the Worker exits, but the browser request must still be finalized.
        this.#remove(id, "cancelled");
      }
    }
    if (firstError) throw firstError;
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

  /** app-server withdrew the request itself, so no reply is needed. */
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
