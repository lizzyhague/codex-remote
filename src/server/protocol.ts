import type { LocalText } from "../shared/local-text.ts";
import { isCommandName, type CommandName } from "../commands/catalog.ts";
import {
  MAX_DEVELOPER_INSTRUCTIONS_LENGTH,
  MAX_MODEL_ID_LENGTH,
  MAX_PERMISSION_PROFILE_LENGTH,
  MAX_REASONING_EFFORT_LENGTH,
} from "../settings/store.ts";
import { isObject } from "../shared/json.ts";

export type BrowserSessionView = "active" | "archived" | "trash";
export type BrowserSessionMutationAction =
  | "archive"
  | "unarchive"
  | "trash-active"
  | "trash-archived"
  | "restore-trash"
  | "delete-trash";

/**
 * WebSocket frame limit. It must substantially exceed the message-body limit; otherwise ws would
 * disconnect on an oversized body before the browser receives a readable error, losing the user's text.
 */
export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;

/** Maximum body size for one message sent to Codex, in UTF-8 bytes. */
export const MAX_MESSAGE_TEXT_BYTES = 1_048_576;

/** Character limit used to reject clearly oversized bodies before calculating their byte length. */
const MAX_MESSAGE_TEXT_LENGTH = 524_288;

type BrowserSessionTarget = {
  projectId: string;
  sessionId: string;
};

export type BrowserRequest =
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
    acceptLoadingStates?: true;
  }
  | {
    type: "session.mark";
    requestId: string;
    projectId: string;
    sessionId: string;
    marked: boolean;
  }
  | {
    type: "session.rename";
    requestId: string;
    projectId: string;
    sessionId: string;
    title: string;
  }
  | ({ type: "session.metrics"; requestId: string } & BrowserSessionTarget)
  | { type: "settings.get"; requestId: string }
  | { type: "settings.models"; requestId: string }
  | { type: "settings.permissions"; requestId: string }
  | {
    type: "settings.update";
    requestId: string;
    developerInstructions?: string;
    defaultModel?: string | null;
    defaultReasoningEffort?: string | null;
    defaultPermissions?: string | null;
  }
  | ({ type: "history.older"; requestId: string } & BrowserSessionTarget)
  | { type: "commands.list"; requestId: string }
  | ({
    type: "command.options";
    requestId: string;
    command: CommandName;
  } & BrowserSessionTarget)
  | ({
    type: "command.run";
    requestId: string;
    command: CommandName;
    option: string | null;
    argument: string | null;
    targetTurnId: string | null;
  } & BrowserSessionTarget)
  | ({
    type: "attachment.ticket.create";
    requestId: string;
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  } & BrowserSessionTarget)
  | ({
    type: "message.send";
    requestId: string;
    clientMessageId: string;
    text: string;
    attachmentIds: string[];
  } & BrowserSessionTarget)
  | ({ type: "task.stop"; requestId: string } & BrowserSessionTarget)
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
    error: { code: string; message: string; text?: LocalText };
  };

export type BrowserProtocolError = {
  type: "error";
  requestId: string | null;
  error: { code: string; message: string; text?: LocalText };
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
    throw new ProtocolError("message_too_large", "The message is too large; the limit is 2 MiB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProtocolError("invalid_json", "The message is not valid JSON.");
  }
  if (!isObject(value)) {
    throw new ProtocolError("invalid_message", "The message must be a JSON object.");
  }

  const requestId = readBoundedString(value.requestId, 128);
  if (!requestId) {
    throw new ProtocolError("invalid_request_id", "The request ID must not be empty.");
  }
  if (typeof value.type !== "string") {
    throw new ProtocolError("invalid_message", "The message has no type.", requestId);
  }

  switch (value.type) {
    case "session.metrics":
      return { type: "session.metrics", requestId, ...requireSessionTarget(value, requestId) };
    case "settings.get":
      return { type: "settings.get", requestId };
    case "settings.models":
      return { type: "settings.models", requestId };
    case "settings.permissions":
      return { type: "settings.permissions", requestId };
    case "settings.update": {
      const update: Extract<BrowserRequest, { type: "settings.update" }> = {
        type: "settings.update",
        requestId,
      };
      if (Object.hasOwn(value, "developerInstructions")) {
        update.developerInstructions = requireDeveloperInstructions(
          value.developerInstructions,
          requestId,
        );
      }
      const hasModel = Object.hasOwn(value, "defaultModel");
      const hasEffort = Object.hasOwn(value, "defaultReasoningEffort");
      if (hasModel !== hasEffort) {
        throw new ProtocolError(
          "invalid_field",
          "The default model and default reasoning effort must be saved together.",
          requestId,
        );
      }
      if (hasModel && hasEffort) {
        update.defaultModel = requireNullableString(
          value.defaultModel,
          "Default model",
          requestId,
          MAX_MODEL_ID_LENGTH,
        );
        update.defaultReasoningEffort = requireNullableString(
          value.defaultReasoningEffort,
          "Default reasoning effort",
          requestId,
          MAX_REASONING_EFFORT_LENGTH,
        );
        if (update.defaultModel === null && update.defaultReasoningEffort !== null) {
          throw new ProtocolError(
            "invalid_field",
            "When the model follows the Codex default, the reasoning effort must follow it too.",
            requestId,
          );
        }
      }
      if (Object.hasOwn(value, "defaultPermissions")) {
        update.defaultPermissions = requireNullableString(
          value.defaultPermissions,
          "Default permissions",
          requestId,
          MAX_PERMISSION_PROFILE_LENGTH,
        );
      }
      return update;
    }
    case "projects.list":
      return { type: "projects.list", requestId };
    case "sessions.list":
      return {
        type: "sessions.list",
        requestId,
        projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
        cursor: value.cursor === undefined || value.cursor === null
          ? null
          : requireString(value.cursor, "Cursor", requestId, 4_096),
        view: readSessionView(value.view, requestId),
        searchTerm: readOptionalString(value.searchTerm, "Search text", requestId, 256),
      };
    case "sessions.mutate":
      return {
        type: "sessions.mutate",
        requestId,
        projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
        sessionIds: requireStringArray(value.sessionIds, "Session ID", requestId, 1_000, 1_024),
        action: requireSessionMutationAction(value.action, requestId),
      };
    case "session.start":
      return {
        type: "session.start",
        requestId,
        projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
      };
    case "session.resume":
      return {
        type: "session.resume",
        requestId,
        projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "Session ID", requestId, 1_024),
        ...(value.acceptLoadingStates === true ? { acceptLoadingStates: true as const } : {}),
      };
    case "session.mark":
      return {
        type: "session.mark",
        requestId,
        projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "Session ID", requestId, 1_024),
        marked: requireBoolean(value.marked, "Pinned", requestId),
      };
    case "session.rename":
      return {
        type: "session.rename",
        requestId,
        projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "Session ID", requestId, 1_024),
        title: requireString(value.title, "Session name", requestId, 160),
      };
    case "history.older":
      return { type: "history.older", requestId, ...requireSessionTarget(value, requestId) };
    case "commands.list":
      return { type: "commands.list", requestId };
    case "command.options":
      return {
        type: "command.options",
        requestId,
        ...requireSessionTarget(value, requestId),
        command: requireCommand(value.command, requestId),
      };
    case "command.run":
      return {
        type: "command.run",
        requestId,
        ...requireSessionTarget(value, requestId),
        command: requireCommand(value.command, requestId),
        option: readOptionalString(value.option, "Command option", requestId, 256),
        argument: readOptionalString(value.argument, "Command argument", requestId, 2_048),
        targetTurnId: readOptionalString(value.targetTurnId, "Target turn", requestId, 1_024),
      };
    case "attachment.ticket.create":
      return {
        type: "attachment.ticket.create",
        requestId,
        ...requireSessionTarget(value, requestId),
        originalName: requireString(value.originalName, "File name", requestId, 1_024),
        declaredMime: readOptionalString(value.declaredMime, "MIME", requestId, 255) ??
          "application/octet-stream",
        expectedSize: requireNonnegativeInteger(value.expectedSize, "File size", requestId),
      };
    case "message.send": {
      const attachmentIds = readOptionalStringArray(
        value.attachmentIds,
        "Attachment ID",
        requestId,
        100,
        128,
      );
      const text = requireMessageText(value.text, requestId, attachmentIds.length > 0);
      return {
        type: "message.send",
        requestId,
        ...requireSessionTarget(value, requestId),
        // An old cached frontend may omit this field briefly during upgrades; requestId remains unique per connection.
        // New frontends send a persistent UUID to provide cross-connection idempotency for reconnect retries.
        clientMessageId: value.clientMessageId === undefined
          ? requestId
          : requireString(value.clientMessageId, "Client message ID", requestId, 128),
        text,
        attachmentIds,
      };
    }
    case "task.stop":
      return { type: "task.stop", requestId, ...requireSessionTarget(value, requestId) };
    case "approval.answer": {
      const decision = value.decision;
      if (decision !== "approve_once" && decision !== "decline") {
        throw new ProtocolError("invalid_decision", "Unknown approval decision.", requestId);
      }
      return {
        type: "approval.answer",
        requestId,
        approvalId: requireString(value.approvalId, "Approval ID", requestId, 256),
        decision,
      };
    }
    case "interaction.answer": {
      const action = value.action;
      if (action !== "submit" && action !== "cancel") {
        throw new ProtocolError("invalid_action", "Unknown interaction action.", requestId);
      }
      return {
        type: "interaction.answer",
        requestId,
        interactionId: requireString(value.interactionId, "Interaction ID", requestId, 256),
        action,
        answers: action === "cancel" ? {} : requireAnswers(value.answers, requestId),
      };
    }
    default:
      throw new ProtocolError("unknown_message_type", "Unsupported message type.", requestId);
  }
}

function requireSessionTarget(
  value: Record<string, unknown>,
  requestId: string,
): BrowserSessionTarget {
  return {
    projectId: requireString(value.projectId, "Project ID", requestId, 1_024),
    sessionId: requireString(value.sessionId, "Session ID", requestId, 1_024),
  };
}

function readSessionView(value: unknown, requestId: string): BrowserSessionView {
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "archived" || value === "trash") return value;
  throw new ProtocolError("invalid_field", "Unknown session list view.", requestId);
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
  throw new ProtocolError("invalid_field", "Unknown session mutation.", requestId);
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
      `${label} list must not be empty and may hold at most ${maxItems} items.`,
      requestId,
    );
  }
  const result = value.map((item) => requireString(item, label, requestId, maxItemLength));
  return [...new Set(result)];
}

function requireCommand(value: unknown, requestId: string): CommandName {
  if (typeof value !== "string" || !isCommandName(value)) {
    throw new ProtocolError("unknown_command", "Unsupported slash command.", requestId);
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
    throw new ProtocolError("invalid_field", "The message text is invalid or too long.", requestId);
  }
  const text = value;
  if (!allowEmpty && !text.trim()) {
    throw new ProtocolError("invalid_field", "The message text and attachments cannot both be empty.", requestId);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_TEXT_BYTES) {
    throw new ProtocolError(
      "message_too_large",
      "The message is too long; split it into several messages.",
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
    throw new ProtocolError("invalid_field", `${label} list may hold at most ${maxItems} items.`, requestId);
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
    throw new ProtocolError("invalid_field", `${label} must be a non-negative integer.`, requestId);
  }
  return value;
}

function requireAnswers(value: unknown, requestId: string): Record<string, string[]> {
  if (!isObject(value) || Object.keys(value).length > 50) {
    throw new ProtocolError("invalid_field", "Unrecognized answer format.", requestId);
  }
  const result: Record<string, string[]> = {};
  for (const [questionId, answer] of Object.entries(value)) {
    if (!readBoundedString(questionId, 128) || !Array.isArray(answer) || answer.length > 50) {
      throw new ProtocolError("invalid_field", "Unrecognized answer format.", requestId);
    }
    result[questionId] = answer.map((entry) =>
      requireString(entry, "Answer", requestId, 4_096));
  }
  return result;
}

function requireDeveloperInstructions(value: unknown, requestId: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError("invalid_field", "Additional developer instructions must be a string.", requestId);
  }
  if (value.length > MAX_DEVELOPER_INSTRUCTIONS_LENGTH) {
    throw new ProtocolError(
      "invalid_field",
      `Additional developer instructions are too long; the limit is ${MAX_DEVELOPER_INSTRUCTIONS_LENGTH} characters.`,
      requestId,
    );
  }
  return value;
}

function requireNullableString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return requireString(value, label, requestId, maxLength);
}

function requireBoolean(value: unknown, label: string, requestId: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolError("invalid_field", `${label} must be a boolean.`, requestId);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string {
  const result = readBoundedString(value, maxLength);
  if (!result) {
    throw new ProtocolError("invalid_field", `${label} must not be empty or too long.`, requestId);
  }
  return result;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}
