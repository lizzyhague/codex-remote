import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { OpenedSession, SessionPage, SessionSummary } from "../sessions/service.ts";

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
  nextCursor: string | null;
} {
  return {
    sessions: page.sessions.map(toBrowserSessionSummary),
    nextCursor: page.nextCursor,
  };
}

export function toBrowserOpenedSession(
  opened: OpenedSession,
  visibleTurns: Turn[] = opened.turns,
  hasOlder = false,
): BrowserOpenedSession {
  return {
    session: toBrowserSessionSummary(opened.session),
    tasks: toBrowserTasks(visibleTurns),
    activeTaskId: opened.activeTurnId,
    hasOlder,
  };
}

export function toBrowserTasks(turns: Turn[]): BrowserTaskSnapshot[] {
  return turns.map(toBrowserTask);
}

function toBrowserSessionSummary(session: SessionSummary): BrowserSessionSummary {
  const { sessionId: _engineSessionId, ...summary } = session;
  return summary;
}

function toBrowserTask(turn: Turn): BrowserTaskSnapshot {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error?.message ?? null,
    restoresInput: restoresInput(turn),
    items: turn.items.flatMap(toBrowserTimelineItem),
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

function toBrowserTimelineItem(item: ThreadItem): BrowserTimelineItem[] {
  if (item.type === "userMessage") {
    return [{
      type: "message",
      id: item.id,
      role: "user",
      text: userMessageText(item),
    }];
  }
  if (item.type === "agentMessage") {
    return [{
      type: "message",
      id: item.id,
      role: "assistant",
      text: item.text,
    }];
  }
  if (item.type === "exitedReviewMode") {
    return [{
      type: "message",
      id: item.id,
      role: "assistant",
      text: item.review,
    }];
  }
  // 重新加载只恢复对话。工具、思考和模式切换仍作为独立 ThreadItem
  // 保存在 App Server 中，因此相邻的 agentMessage 不会被合并成一个气泡。
  return [];
}

function userMessageText(item: Extract<ThreadItem, { type: "userMessage" }>): string {
  return item.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
