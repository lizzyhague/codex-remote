import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { OpenedSession, SessionPage, SessionSummary } from "../sessions/service.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import { redactKnownAttachmentPaths } from "../attachments/path-redaction.ts";
import { parsePrivateAttachmentPaths } from "../attachments/private-paths.ts";
import {
  isPrivateAttachmentInputText,
  stripPrivateAttachmentInputs,
} from "../app-server/turn-session.ts";

export type BrowserSessionSummary = Omit<SessionSummary, "sessionId">;

export type BrowserTimelineItem = {
  type: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type BrowserTaskSnapshot = {
  id: string;
  status: Turn["status"];
  error: string | null;
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

/** 从 CLI 原始用户消息里收集路径块，用来补齐显示索引。 */
export function collectHistoryAttachmentRecords(turns: Turn[]): Array<{
  messageId: string;
  attachments: AttachmentDisplayMapping[];
}> {
  const collected: Array<{ messageId: string; attachments: AttachmentDisplayMapping[] }> = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      const records = item.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .flatMap((part) => parsePrivateAttachmentPaths(part.text));
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
    error: turn.error?.message
      ? redactKnownAttachmentPaths(turn.error.message, mappings)
      : null,
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
  return !isSpecialTurn && turn.items.some((item) =>
    item.type === "userMessage" && Boolean(userMessageText(item))
  );
}

function toBrowserTimelineItem(
  item: ThreadItem,
  mappings: readonly AttachmentDisplayMapping[],
): BrowserTimelineItem[] {
  if (item.type === "userMessage") {
    return [{
      type: "message",
      id: item.id,
      role: "user",
      text: redactKnownAttachmentPaths(userMessageText(item), mappings),
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
  // 重新加载只恢复对话。工具、思考和模式切换仍作为独立 ThreadItem
  // 保存在 App Server 中，因此相邻的 agentMessage 不会被合并成一个气泡。
  return [];
}

function userMessageText(item: Extract<ThreadItem, { type: "userMessage" }>): string {
  return stripPrivateAttachmentInputs(
    item.content
      .filter((part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text" && !isPrivateAttachmentInputText(part.text))
      .map((part) => part.text)
      .join("\n"),
  );
}
