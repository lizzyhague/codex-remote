import type { LocalText } from "../shared/local-text.ts";
import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { OpenedSession, SessionPage, SessionSummary } from "../sessions/service.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import { redactKnownAttachmentPaths } from "../attachments/path-redaction.ts";
import {
  messageAttachmentOf,
  splitUserMessageContent,
  type MessageAttachment,
  type UserMessageContent,
} from "../attachments/private-paths.ts";
import { publicTurnErrorMessage } from "./public-output.ts";

export type BrowserSessionSummary = Omit<SessionSummary, "sessionId">;

export type BrowserTimelineItem = {
  type: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Present only for user messages with Remote attachments; sourced from a separate path block, never inferred from text. */
  attachments?: MessageAttachment[];
};

export type BrowserTaskSnapshot = {
  id: string;
  status: Turn["status"];
  error: LocalText | null;
  restoresInput: boolean;
  items: BrowserTimelineItem[];
};

export type BrowserOpenedSession = {
  session: BrowserSessionSummary;
  tasks: BrowserTaskSnapshot[];
  activeTaskId: string | null;
  hasOlder: boolean;
};

export function toBrowserSessionPage(page: SessionPage): {
  sessions: BrowserSessionSummary[];
  marked: BrowserSessionSummary[];
  nextCursor: string | null;
} {
  return {
    sessions: page.sessions.map(toBrowserSessionSummary),
    marked: page.marked.map(toBrowserSessionSummary),
    nextCursor: page.nextCursor,
  };
}

export function toBrowserOpenedSession(
  opened: OpenedSession,
  visibleTurns: Turn[] = opened.turns,
  hasOlder = false,
  mappings: readonly AttachmentDisplayMapping[] = [],
): BrowserOpenedSession {
  return {
    session: toBrowserSessionSummary(opened.session),
    tasks: toBrowserTasks(visibleTurns, mappings),
    activeTaskId: opened.activeTurnId,
    hasOlder,
  };
}

export function toBrowserTasks(
  turns: Turn[],
  mappings: readonly AttachmentDisplayMapping[] = [],
): BrowserTaskSnapshot[] {
  return turns.map((turn) => toBrowserTask(turn, mappings));
}

/** Collect records from Remote's separate path block after a user message to complete the display index. */
export function collectHistoryAttachmentRecords(turns: Turn[]): Array<{
  messageId: string;
  attachments: AttachmentDisplayMapping[];
}> {
  const collected: Array<{ messageId: string; attachments: AttachmentDisplayMapping[] }> = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      const records = userMessageContent(item).attachments;
      if (records.length === 0) continue;
      collected.push({
        messageId: item.id,
        attachments: records.map((record) => ({
          id: record.id,
          originalName: record.originalName,
          path: record.path,
        })),
      });
    }
  }
  return collected;
}

function toBrowserSessionSummary(session: SessionSummary): BrowserSessionSummary {
  const { sessionId: _engineSessionId, ...summary } = session;
  return summary;
}

function toBrowserTask(
  turn: Turn,
  mappings: readonly AttachmentDisplayMapping[],
): BrowserTaskSnapshot {
  return {
    id: turn.id,
    status: turn.status,
    error: publicTurnErrorMessage(
      turn.error?.message,
      `Error of history turn ${turn.id} withheld from the browser`,
    ),
    restoresInput: restoresInput(turn),
    items: turn.items.flatMap((item) => toBrowserTimelineItem(item, mappings)),
  };
}

function restoresInput(turn: Turn): boolean {
  const isSpecialTurn = turn.items.some((item) =>
    item.type === "contextCompaction" ||
    item.type === "enteredReviewMode" ||
    item.type === "exitedReviewMode"
  );
  return !isSpecialTurn && turn.items.some((item) => {
    if (item.type !== "userMessage") return false;
    const content = userMessageContent(item);
    return Boolean(content.text) || content.attachments.length > 0;
  });
}

function toBrowserTimelineItem(
  item: ThreadItem,
  mappings: readonly AttachmentDisplayMapping[],
): BrowserTimelineItem[] {
  if (item.type === "userMessage") {
    const content = userMessageContent(item);
    return [{
      type: "message",
      id: item.id,
      role: "user",
      text: redactKnownAttachmentPaths(content.text, mappings),
      ...(content.attachments.length > 0
        ? { attachments: content.attachments.map(messageAttachmentOf) }
        : {}),
    }];
  }
  if (item.type === "agentMessage") {
    return [{
      type: "message",
      id: item.id,
      role: "assistant",
      text: redactKnownAttachmentPaths(item.text, mappings),
    }];
  }
  if (item.type === "exitedReviewMode") {
    return [{
      type: "message",
      id: item.id,
      role: "assistant",
      text: redactKnownAttachmentPaths(item.review, mappings),
    }];
  }
  // Reloading restores conversation only. Tools, reasoning, and mode changes remain separate ThreadItems
  // in App Server, so adjacent agentMessages must not be merged into one bubble.
  return [];
}

function userMessageContent(
  item: Extract<ThreadItem, { type: "userMessage" }>,
): UserMessageContent {
  return splitUserMessageContent(
    item.content.map((part) => part.type === "text" ? part.text : null),
  );
}
