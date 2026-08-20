import { randomUUID } from "node:crypto";

import type { RequestId } from "../generated/RequestId.ts";
import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";

export interface ApprovalTransport {
  onServerRequest(listener: AppServerMessageListener): () => void;
  onNotification(listener: AppServerMessageListener): () => void;
  respondToServerRequest(id: RequestId, result: unknown): void;
}

type ApprovalBase = {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  startedAtMs: number;
};

export type ApprovalRequest =
  | ApprovalBase & {
    kind: "command";
    command: string | null;
    network: { host: string; protocol: string } | null;
  }
  | ApprovalBase & {
    kind: "file_change";
  };

export type ApprovalAnswer = "approve_once" | "decline";
export type ApprovalResolution = "approved" | "declined" | "cancelled" | "cleared";

export type ApprovalEvent =
  | { type: "approval_requested"; approval: ApprovalRequest }
  | {
    type: "approval_resolved";
    approvalId: string;
    resolution: ApprovalResolution;
  };

type PendingApproval = {
  requestId: RequestId;
  approval: ApprovalRequest;
};

/**
 * 把 app-server 的双向 JSON-RPC 审批请求翻译成前端协议。
 * 第一版只允许“本次允许”与“拒绝”，不会创建长期授权规则。
 */
export class ApprovalBroker {
  readonly #transport: ApprovalTransport;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #approvalIdByRequestId = new Map<RequestId, string>();
  readonly #listeners = new Set<(event: ApprovalEvent) => void>();
  readonly #unsubscribeServerRequests: () => void;
  readonly #unsubscribeNotifications: () => void;

  constructor(transport: ApprovalTransport) {
    this.#transport = transport;
    this.#unsubscribeServerRequests = transport.onServerRequest((message) => {
      this.#handleServerRequest(message);
    });
    this.#unsubscribeNotifications = transport.onNotification((message) => {
      this.#handleNotification(message);
    });
  }

  onEvent(listener: (event: ApprovalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pendingForThread(threadId: string): ApprovalRequest[] {
    return [...this.#pending.values()]
      .map((pending) => pending.approval)
      .filter((approval) => approval.threadId === threadId);
  }

  answer(approvalId: string, answer: ApprovalAnswer): boolean {
    const pending = this.#pending.get(approvalId);
    if (!pending) {
      return false;
    }

    const decision = answer === "approve_once" ? "accept" : "decline";
    this.#transport.respondToServerRequest(pending.requestId, { decision });
    this.#removePending(
      approvalId,
      answer === "approve_once" ? "approved" : "declined",
    );
    return true;
  }

  /** 浏览器断线或任务停止时，取消该任务仍在等待的审批。 */
  cancelTurn(threadId: string, turnId: string): number {
    return this.#cancelWhere((approval) =>
      approval.threadId === threadId && approval.turnId === turnId
    );
  }

  cancelThread(threadId: string): number {
    return this.#cancelWhere((approval) => approval.threadId === threadId);
  }

  cancelAll(): number {
    return this.#cancelWhere(() => true);
  }

  dispose(): void {
    this.#unsubscribeServerRequests();
    this.#unsubscribeNotifications();
    this.#listeners.clear();
  }

  #cancelWhere(predicate: (approval: ApprovalRequest) => boolean): number {
    const matches = [...this.#pending.entries()].filter(([, pending]) =>
      predicate(pending.approval)
    );

    for (const [approvalId, pending] of matches) {
      this.#transport.respondToServerRequest(pending.requestId, {
        decision: "cancel",
      });
      this.#removePending(approvalId, "cancelled");
    }
    return matches.length;
  }

  #handleServerRequest(message: JsonObject): void {
    const requestId = readRequestId(message.id);
    const params = asObject(message.params);
    if (requestId === null || !params || this.#approvalIdByRequestId.has(requestId)) {
      return;
    }

    const approval = message.method === "item/commandExecution/requestApproval"
      ? readCommandApproval(params)
      : message.method === "item/fileChange/requestApproval"
      ? readFileChangeApproval(params)
      : null;
    if (!approval) {
      return;
    }

    const approvalId = randomUUID();
    const browserApproval = { ...approval, id: approvalId };
    this.#pending.set(approvalId, {
      requestId,
      approval: browserApproval,
    });
    this.#approvalIdByRequestId.set(requestId, approvalId);
    this.#emit({ type: "approval_requested", approval: browserApproval });
  }

  #handleNotification(message: JsonObject): void {
    if (message.method !== "serverRequest/resolved") {
      return;
    }
    const params = asObject(message.params);
    const requestId = readRequestId(params?.requestId);
    if (requestId === null) {
      return;
    }
    const approvalId = this.#approvalIdByRequestId.get(requestId);
    if (approvalId) {
      this.#removePending(approvalId, "cleared");
    }
  }

  #removePending(approvalId: string, resolution: ApprovalResolution): void {
    const pending = this.#pending.get(approvalId);
    if (!pending) {
      return;
    }
    this.#pending.delete(approvalId);
    this.#approvalIdByRequestId.delete(pending.requestId);
    this.#emit({ type: "approval_resolved", approvalId, resolution });
  }

  #emit(event: ApprovalEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

function readCommandApproval(
  params: JsonObject,
): Omit<Extract<ApprovalRequest, { kind: "command" }>, "id"> | null {
  const base = readApprovalBase(params);
  if (!base) {
    return null;
  }
  const networkContext = asObject(params.networkApprovalContext);
  const network = networkContext &&
      typeof networkContext.host === "string" &&
      typeof networkContext.protocol === "string"
    ? { host: networkContext.host, protocol: networkContext.protocol }
    : null;

  return {
    ...base,
    kind: "command",
    command: typeof params.command === "string" ? params.command : null,
    network,
  };
}

function readFileChangeApproval(
  params: JsonObject,
): Omit<Extract<ApprovalRequest, { kind: "file_change" }>, "id"> | null {
  const base = readApprovalBase(params);
  return base ? { ...base, kind: "file_change" } : null;
}

function readApprovalBase(params: JsonObject): Omit<ApprovalBase, "id"> | null {
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string" ||
    typeof params.startedAtMs !== "number"
  ) {
    return null;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    reason: typeof params.reason === "string" ? params.reason : null,
    startedAtMs: params.startedAtMs,
  };
}

function readRequestId(value: unknown): RequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
