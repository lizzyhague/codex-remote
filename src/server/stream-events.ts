import type { CodexStreamEvent } from "../app-server/turn-session.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import { redactPublicTextDeep } from "../attachments/path-redaction.ts";
import { publicTurnErrorMessage } from "./public-output.ts";

export function toBrowserStreamEvent(
  event: CodexStreamEvent,
): Record<string, unknown> & { type: string } {
  const { threadId: sessionId, turnId: nativeTurnId, ...rest } = event;
  const type = event.type === "turn_started"
    ? "task.started"
    : event.type === "user_message_started"
    ? "message.user"
    : event.type === "assistant_text_delta"
    ? "message.delta"
    : event.type === "assistant_text_completed"
    ? "message.completed"
    : event.type === "tool_started"
    ? "tool.started"
    : event.type === "tool_output_delta"
    ? "tool.output.delta"
    : event.type === "tool_completed"
    ? "tool.completed"
    : event.type === "turn_completed"
    ? "task.completed"
    : "task.error";
  const { type: _internalType, ...payload } = rest;
  const projectedPayload = event.type === "turn_completed"
    ? {
      ...payload,
      error: publicTurnErrorMessage(
        event.error,
        `未向浏览器透传的实时 turn ${event.turnId} 完成错误`,
      ),
    }
    : event.type === "turn_error"
    ? {
      ...payload,
      message: publicTurnErrorMessage(
        event.message,
        `未向浏览器透传的实时 turn ${event.turnId} 错误通知`,
      ),
    }
    : payload;
  return { type, sessionId, taskId: nativeTurnId, nativeTurnId, ...projectedPayload };
}

/** 所有浏览器事件使用同一份显示副本，隐藏宿主绝对路径但保留其他文字。 */
export function redactBrowserStreamEvent<T extends Record<string, unknown>>(
  event: T,
  mappings: readonly AttachmentDisplayMapping[],
): T {
  return redactPublicTextDeep(event, mappings);
}
