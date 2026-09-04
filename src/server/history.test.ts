import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import { PRIVATE_ATTACHMENT_INPUT_PREFIX } from "../app-server/turn-session.ts";
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
        delivery: null,
        questions: null,
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
        delivery: null,
        questions: null,
      },
    ]),
  ]);

  assert.equal(tasks[0]?.restoresInput, true);
  assert.equal(tasks[1]?.restoresInput, false);
  assert.equal(tasks[2]?.restoresInput, false);
  assert.equal(tasks[3]?.restoresInput, false);
});

test("reload restores only dialog while preserving separate assistant items", () => {
  const hiddenItems = [
    {
      type: "agentMessage",
      id: "assistant-before",
      text: "第一段",
      phase: null,
      memoryCitation: null,
    },
    { type: "reasoning", id: "reasoning-1", summary: ["hidden"], content: [] },
    {
      type: "commandExecution",
      id: "command-1",
      command: "npm test",
      aggregatedOutput: "private output",
    },
    {
      type: "fileChange",
      id: "change-1",
      changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "private" }],
    },
    {
      type: "agentMessage",
      id: "assistant-after",
      text: "第二段",
      phase: null,
      memoryCitation: null,
    },
    { type: "exitedReviewMode", id: "review-result", review: "审查报告" },
  ] as ThreadItem[];

  const tasks = toBrowserTasks([turn("tool-boundaries", hiddenItems)]);
  assert.deepEqual(tasks[0]?.items, [
    { type: "message", id: "assistant-before", role: "assistant", text: "第一段" },
    { type: "message", id: "assistant-after", role: "assistant", text: "第二段" },
    { type: "message", id: "review-result", role: "assistant", text: "审查报告" },
  ]);
  assert.equal(JSON.stringify(tasks).includes("private"), false);
  assert.equal(JSON.stringify(tasks).includes("npm test"), false);
});

test("reload hides inlined attachment content from the browser timeline", () => {
  const tasks = toBrowserTasks([turn("attachment", [
    userMessage(
      "user-attachment",
      "检查附件\n\n[附件：notes.txt · file-id]",
      `${PRIVATE_ATTACHMENT_INPUT_PREFIX}\n/private/path\nsecret note`,
    ),
  ])]);

  assert.deepEqual(tasks[0]?.items, [{
    type: "message",
    id: "user-attachment",
    role: "user",
    text: "检查附件\n\n[附件：notes.txt · file-id]",
  }]);
  assert.equal(JSON.stringify(tasks).includes("/private/path"), false);
  assert.equal(JSON.stringify(tasks).includes("secret note"), false);
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
