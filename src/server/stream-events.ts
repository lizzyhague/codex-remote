import type { CodexStreamEvent } from "../app-server/turn-session.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import { redactKnownAttachmentPathsDeep } from "../attachments/path-redaction.ts";

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
  return { type, sessionId, taskId: nativeTurnId, nativeTurnId, ...payload };
}

/** 把已知附件路径从即将发给浏览器的事件副本里换掉。 */
export function redactBrowserStreamEvent<T extends Record<string, unknown>>(
  event: T,
  mappings: readonly AttachmentDisplayMapping[],
): T {
  if (mappings.length === 0) return event;
  return redactKnownAttachmentPathsDeep(event, mappings);
}
