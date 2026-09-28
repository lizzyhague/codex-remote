import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { OpenedSession, SessionPage, SessionSummary } from "../sessions/service.ts";
import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import { redactPublicText } from "../attachments/path-redaction.ts";
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
  /** 只在用户消息带有 Remote 附件时出现；来自独立路径块，不从正文反推。 */
  attachments?: MessageAttachment[];
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

/** 从 Remote 附加在用户消息后的独立路径块收集记录，用来补齐显示索引。 */
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
      `未向浏览器透传的历史 turn ${turn.id} 错误`,
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
      text: redactPublicText(content.text, mappings),
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
      text: redactPublicText(item.text, mappings),
    }];
  }
  if (item.type === "exitedReviewMode") {
    return [{
      type: "message",
      id: item.id,
      role: "assistant",
      text: redactPublicText(item.review, mappings),
    }];
  }
  // 重新加载只恢复对话。工具、思考和模式切换仍作为独立 ThreadItem
  // 保存在 App Server 中，因此相邻的 agentMessage 不会被合并成一个气泡。
  return [];
}

function userMessageContent(
  item: Extract<ThreadItem, { type: "userMessage" }>,
): UserMessageContent {
  return splitUserMessageContent(
    item.content.map((part) => part.type === "text" ? part.text : null),
  );
}
