import { isCommandName, type CommandName } from "../commands/catalog.ts";

export type BrowserSessionView = "active" | "archived" | "trash";
export type BrowserSessionMutationAction =
  | "archive"
  | "unarchive"
  | "trash-active"
  | "trash-archived"
  | "restore-trash"
  | "delete-trash";

/**
 * WebSocket 帧上限。它必须明显大于单条消息正文的上限，否则超长正文会在 ws 层
 * 被直接关闭连接，浏览器拿不到可读的错误，用户写的内容也就白丢了。
 */
export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;

/** 单条发给 Codex 的消息正文上限（UTF-8 字节）。 */
export const MAX_MESSAGE_TEXT_BYTES = 1_048_576;

/** 正文字符数上限，用于在计算字节数之前先挡掉明显过长的输入。 */
const MAX_MESSAGE_TEXT_LENGTH = 524_288;

export type BrowserRequest =
  | { type: "auth"; requestId: string; token: string }
  | { type: "projects.list"; requestId: string }
  | {
    type: "sessions.list";
    requestId: string;
    projectId: string;
    cursor: string | null;
    view: BrowserSessionView;
    searchTerm: string | null;
  }
  | {
    type: "sessions.mutate";
    requestId: string;
    projectId: string;
    sessionIds: string[];
    action: BrowserSessionMutationAction;
  }
  | { type: "session.start"; requestId: string; projectId: string }
  | {
    type: "session.resume";
    requestId: string;
    projectId: string;
    sessionId: string;
  }
  | { type: "session.metrics"; requestId: string }
  | { type: "history.older"; requestId: string }
  | { type: "commands.list"; requestId: string }
  | {
    type: "command.options";
    requestId: string;
    command: CommandName;
  }
  | {
    type: "command.run";
    requestId: string;
    command: CommandName;
    option: string | null;
    argument: string | null;
  }
  | { type: "permissions.full-access.toggle"; requestId: string }
  | {
    type: "attachment.ticket.create";
    requestId: string;
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }
  | {
    type: "message.send";
    requestId: string;
    clientMessageId: string;
    text: string;
    attachmentIds: string[];
  }
  | { type: "task.stop"; requestId: string }
  | {
    type: "approval.answer";
    requestId: string;
    approvalId: string;
    decision: "approve_once" | "decline";
  }
  | {
    type: "interaction.answer";
    requestId: string;
    interactionId: string;
    action: "submit" | "cancel";
    answers: Record<string, string[]>;
  };

export type BrowserResponse =
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | {
    type: "response";
    requestId: string;
    ok: false;
    error: { code: string; message: string };
  };

export type BrowserProtocolError = {
  type: "error";
  requestId: string | null;
  error: { code: string; message: string };
};

export type BrowserEvent = {
  type: "event";
  event: Record<string, unknown> & { type: string };
};

export type BrowserMessage = BrowserResponse | BrowserProtocolError | BrowserEvent;

export class ProtocolError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.requestId = requestId;
  }
}

export function parseBrowserRequest(source: string): BrowserRequest {
  if (Buffer.byteLength(source, "utf8") > MAX_BROWSER_MESSAGE_BYTES) {
    throw new ProtocolError("message_too_large", "消息太大。上限是 2 MiB。");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProtocolError("invalid_json", "消息不是有效的 JSON。");
  }
  if (!isObject(value)) {
    throw new ProtocolError("invalid_message", "消息必须是 JSON 对象。");
  }

  const requestId = readBoundedString(value.requestId, 128);
  if (!requestId) {
    throw new ProtocolError("invalid_request_id", "请求 ID 不能为空。");
  }
  if (typeof value.type !== "string") {
    throw new ProtocolError("invalid_message", "消息缺少类型。", requestId);
  }

  switch (value.type) {
    case "auth":
      return {
        type: "auth",
        requestId,
        token: requireString(value.token, "访问令牌", requestId, 4_096),
      };
    case "session.metrics":
      return { type: "session.metrics", requestId };
    case "projects.list":
      return { type: "projects.list", requestId };
    case "sessions.list":
      return {
        type: "sessions.list",
        requestId,
        projectId: requireString(value.projectId, "项目 ID", requestId, 1_024),
        cursor: value.cursor === undefined || value.cursor === null
          ? null
          : requireString(value.cursor, "分页标记", requestId, 4_096),
        view: readSessionView(value.view, requestId),
        searchTerm: readOptionalString(value.searchTerm, "搜索文字", requestId, 256),
      };
    case "sessions.mutate":
      return {
        type: "sessions.mutate",
        requestId,
        projectId: requireString(value.projectId, "项目 ID", requestId, 1_024),
        sessionIds: requireStringArray(value.sessionIds, "会话 ID", requestId, 100, 1_024),
        action: requireSessionMutationAction(value.action, requestId),
      };
    case "session.start":
      return {
        type: "session.start",
        requestId,
        projectId: requireString(value.projectId, "项目 ID", requestId, 1_024),
      };
    case "session.resume":
      return {
        type: "session.resume",
        requestId,
        projectId: requireString(value.projectId, "项目 ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "会话 ID", requestId, 1_024),
      };
    case "history.older":
      return { type: "history.older", requestId };
    case "commands.list":
      return { type: "commands.list", requestId };
    case "command.options":
      return {
        type: "command.options",
        requestId,
        command: requireCommand(value.command, requestId),
      };
    case "command.run":
      return {
        type: "command.run",
        requestId,
        command: requireCommand(value.command, requestId),
        option: readOptionalString(value.option, "命令选项", requestId, 256),
        argument: readOptionalString(value.argument, "命令参数", requestId, 2_048),
      };
    case "permissions.full-access.toggle":
      return { type: "permissions.full-access.toggle", requestId };
    case "attachment.ticket.create":
      return {
        type: "attachment.ticket.create",
        requestId,
        originalName: requireString(value.originalName, "文件名", requestId, 1_024),
        declaredMime: readOptionalString(value.declaredMime, "MIME", requestId, 255) ??
          "application/octet-stream",
        expectedSize: requireNonnegativeInteger(value.expectedSize, "文件大小", requestId),
      };
    case "message.send": {
      const attachmentIds = readOptionalStringArray(
        value.attachmentIds,
        "附件 ID",
        requestId,
        100,
        128,
      );
      const text = requireMessageText(value.text, requestId, attachmentIds.length > 0);
      return {
        type: "message.send",
        requestId,
        // 旧前端缓存升级期间可能暂时不带该字段；requestId 仍是单次连接内唯一值。
        // 新前端会传持久 UUID，才能在断线重试时获得跨连接幂等性。
        clientMessageId: value.clientMessageId === undefined
          ? requestId
          : requireString(value.clientMessageId, "客户端消息 ID", requestId, 128),
        text,
        attachmentIds,
      };
    }
    case "task.stop":
      return { type: "task.stop", requestId };
    case "approval.answer": {
      const decision = value.decision;
      if (decision !== "approve_once" && decision !== "decline") {
        throw new ProtocolError("invalid_decision", "审批选择无法识别。", requestId);
      }
      return {
        type: "approval.answer",
        requestId,
        approvalId: requireString(value.approvalId, "审批 ID", requestId, 256),
        decision,
      };
    }
    case "interaction.answer": {
      const action = value.action;
      if (action !== "submit" && action !== "cancel") {
        throw new ProtocolError("invalid_action", "交互操作无法识别。", requestId);
      }
      return {
        type: "interaction.answer",
        requestId,
        interactionId: requireString(value.interactionId, "交互 ID", requestId, 256),
        action,
        answers: action === "cancel" ? {} : requireAnswers(value.answers, requestId),
      };
    }
    default:
      throw new ProtocolError("unknown_message_type", "不支持这种消息类型。", requestId);
  }
}

function readSessionView(value: unknown, requestId: string): BrowserSessionView {
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "archived" || value === "trash") return value;
  throw new ProtocolError("invalid_field", "会话列表类型无法识别。", requestId);
}

function requireSessionMutationAction(
  value: unknown,
  requestId: string,
): BrowserSessionMutationAction {
  if (
    value === "archive" || value === "unarchive" ||
    value === "trash-active" || value === "trash-archived" ||
    value === "restore-trash" || value === "delete-trash"
  ) {
    return value;
  }
  throw new ProtocolError("invalid_field", "会话整理操作无法识别。", requestId);
}

function requireStringArray(
  value: unknown,
  label: string,
  requestId: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new ProtocolError(
      "invalid_field",
      `${label}列表不能为空，且一次最多 ${maxItems} 项。`,
      requestId,
    );
  }
  const result = value.map((item) => requireString(item, label, requestId, maxItemLength));
  return [...new Set(result)];
}

function requireCommand(value: unknown, requestId: string): CommandName {
  if (typeof value !== "string" || !isCommandName(value)) {
    throw new ProtocolError("unknown_command", "不支持这个斜杠命令。", requestId);
  }
  return value;
}

function readOptionalString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, label, requestId, maxLength);
}

function requireMessageText(value: unknown, requestId: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new ProtocolError("invalid_field", "消息格式无效或过长。", requestId);
  }
  const text = value;
  if (!allowEmpty && !text.trim()) {
    throw new ProtocolError("invalid_field", "消息和附件不能同时为空。", requestId);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_TEXT_BYTES) {
    throw new ProtocolError(
      "message_too_large",
      "消息太长。请拆成几条再发送。",
      requestId,
    );
  }
  return text;
}

function readOptionalStringArray(
  value: unknown,
  label: string,
  requestId: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ProtocolError("invalid_field", `${label}列表一次最多 ${maxItems} 项。`, requestId);
  }
  const result = value.map((item) => requireString(item, label, requestId, maxItemLength));
  return [...new Set(result)];
}

function requireNonnegativeInteger(
  value: unknown,
  label: string,
  requestId: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError("invalid_field", `${label}必须是非负整数。`, requestId);
  }
  return value;
}

function requireAnswers(value: unknown, requestId: string): Record<string, string[]> {
  if (!isObject(value) || Object.keys(value).length > 50) {
    throw new ProtocolError("invalid_field", "回答格式无法识别。", requestId);
  }
  const result: Record<string, string[]> = {};
  for (const [questionId, answer] of Object.entries(value)) {
    if (!readBoundedString(questionId, 128) || !Array.isArray(answer) || answer.length > 50) {
      throw new ProtocolError("invalid_field", "回答格式无法识别。", requestId);
    }
    result[questionId] = answer.map((entry) =>
      requireString(entry, "回答", requestId, 4_096));
  }
  return result;
}

function requireString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string {
  const result = readBoundedString(value, maxLength);
  if (!result) {
    throw new ProtocolError("invalid_field", `${label}不能为空或过长。`, requestId);
  }
  return result;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
