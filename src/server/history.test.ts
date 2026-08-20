import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import { toBrowserTasks } from "./history.ts";

test("marks only ordinary user turns for input restoration", () => {
  const tasks = toBrowserTasks([
    turn("ordinary", [
      userMessage("user-ordinary", "第一行", "第二行"),
      {
        type: "agentMessage",
        id: "assistant-ordinary",
        text: "回复",
        phase: null,
        memoryCitation: null,
      },
    ]),
    turn("review", [
      userMessage("user-review", "Review current changes"),
      { type: "enteredReviewMode", id: "review-entered", review: "current changes" },
      { type: "exitedReviewMode", id: "review-exited", review: "没有发现问题" },
    ]),
    turn("compact", [
      { type: "contextCompaction", id: "compact-item" },
    ]),
    turn("assistant-only", [
      {
        type: "agentMessage",
        id: "assistant-only-item",
        text: "系统消息",
        phase: null,
        memoryCitation: null,
      },
    ]),
  ]);

  assert.equal(tasks[0]?.restoresInput, true);
  assert.equal(tasks[1]?.restoresInput, false);
  assert.equal(tasks[2]?.restoresInput, false);
  assert.equal(tasks[3]?.restoresInput, false);
});

function turn(id: string, items: ThreadItem[]): Turn {
  return {
    id,
    items,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function userMessage(id: string, ...parts: string[]): ThreadItem {
  return {
    type: "userMessage",
    id,
    clientId: null,
    content: parts.map((text) => ({ type: "text", text, text_elements: [] })),
  };
}
