import type { JsonObject } from "../app-server/client.ts";
import {
  asObject,
  type BrokerBaseResolution,
  ServerRequestBroker,
  type ServerRequestTransport,
} from "../app-server/server-request-broker.ts";

export type ApprovalTransport = ServerRequestTransport;

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
  }
  | ApprovalBase & {
    kind: "permissions";
    permissions: JsonObject;
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

/**
 * 把 app-server 的双向 JSON-RPC 审批请求翻译成前端协议。
 * 第一版只允许"本次允许"与"拒绝"，不会创建长期授权规则。
 */
export class ApprovalBroker extends ServerRequestBroker<
  ApprovalRequest,
  ApprovalEvent,
  "approved" | "declined"
> {
  constructor(transport: ApprovalTransport) {
    super(transport);
  }

  answer(approvalId: string, answer: ApprovalAnswer): boolean {
    return this.respond(
      approvalId,
      (approval) => approvalResponse(approval, answer),
      answer === "approve_once" ? "approved" : "declined",
    );
  }

  /** 浏览器断线或任务停止时，取消该会话仍在等待的审批。 */
  cancelThread(threadId: string): number {
    return this.cancelWhere((approval) => approval.threadId === threadId);
  }

  cancelAll(): number {
    return this.cancelWhere(() => true);
  }

  protected override parse(
    method: string,
    params: JsonObject,
  ): Omit<ApprovalRequest, "id"> | null {
    return method === "item/commandExecution/requestApproval"
      ? readCommandApproval(params)
      : method === "item/fileChange/requestApproval"
      ? readFileChangeApproval(params)
      : method === "item/permissions/requestApproval"
      ? readPermissionsApproval(params)
      : null;
  }

  protected override cancelResponse(approval: ApprovalRequest): JsonObject {
    return approval.kind === "permissions"
      ? { permissions: {}, scope: "turn" }
      : { decision: "cancel" };
  }

  protected override requestedEvent(approval: ApprovalRequest): ApprovalEvent {
    return { type: "approval_requested", approval };
  }

  protected override resolvedEvent(
    approvalId: string,
    resolution: "approved" | "declined" | BrokerBaseResolution,
  ): ApprovalEvent {
    return { type: "approval_resolved", approvalId, resolution };
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

function readPermissionsApproval(
  params: JsonObject,
): Omit<Extract<ApprovalRequest, { kind: "permissions" }>, "id"> | null {
  const base = readApprovalBase(params);
  const permissions = asObject(params.permissions);
  return base && permissions
    ? { ...base, kind: "permissions", permissions: structuredClone(permissions) }
    : null;
}

function approvalResponse(
  approval: ApprovalRequest,
  answer: ApprovalAnswer,
): JsonObject {
  if (approval.kind !== "permissions") {
    return { decision: answer === "approve_once" ? "accept" : "decline" };
  }
  if (answer !== "approve_once") {
    return { permissions: {}, scope: "turn" };
  }
  const granted: JsonObject = {};
  if (approval.permissions.network !== null && approval.permissions.network !== undefined) {
    granted.network = approval.permissions.network;
  }
  if (
    approval.permissions.fileSystem !== null &&
    approval.permissions.fileSystem !== undefined
  ) {
    granted.fileSystem = approval.permissions.fileSystem;
  }
  return { permissions: granted, scope: "turn" };
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
