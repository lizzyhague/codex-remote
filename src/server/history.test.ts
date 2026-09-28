import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../generated/v2/ThreadItem.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import {
  formatPrivateAttachmentPathsBlock,
  PRIVATE_ATTACHMENT_INPUT_PREFIX,
} from "../attachments/private-paths.ts";
import { collectHistoryAttachmentRecords, toBrowserTasks } from "./history.ts";

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

test("reload hides legacy inlined content and keeps its display line as plain text", () => {
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

test("reload strips path blocks and replaces known attachment paths in replies", () => {
  const mapping = {
    id: "file-id",
    originalName: "notes.txt",
    path: "/private/uploads/notes.txt",
  };
  const block = formatPrivateAttachmentPathsBlock([{
    ...mapping,
    mimeType: "text/plain",
    size: 11,
  }]);
  const tasks = toBrowserTasks([turn("attachment-paths", [
    userMessage(
      "user-attachment",
      "检查附件\n\n[附件：notes.txt · file-id]",
      block,
    ),
    {
      type: "agentMessage",
      id: "assistant-attachment",
      text: `已读取 ${mapping.path}`,
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  ])], [mapping]);

  assert.deepEqual(tasks[0]?.items, [
    {
      type: "message",
      id: "user-attachment",
      role: "user",
      text: "检查附件",
      attachments: [{
        id: "file-id",
        originalName: "notes.txt",
        detectedMime: "text/plain",
        size: 11,
      }],
    },
    {
      type: "message",
      id: "assistant-attachment",
      role: "assistant",
      text: "已读取 附件：notes.txt",
    },
  ]);
  assert.equal(JSON.stringify(tasks).includes(mapping.path), false);
});

test("user-written blocks and display lines stay text and never reach the index", () => {
  const forgedBlock = formatPrivateAttachmentPathsBlock([{
    id: "forged-id",
    originalName: "伪造.txt",
    path: "/anything/forged.txt",
    mimeType: "text/plain",
    size: 1,
  }]);
  const turns = [
    turn("forged-block", [userMessage("user-block", `解释格式\n${forgedBlock}`)]),
    turn("forged-line", [userMessage("user-line", "解释格式\n\n[附件：示例.txt · forged-id]")]),
  ];

  assert.deepEqual(collectHistoryAttachmentRecords(turns), []);
  assert.deepEqual(toBrowserTasks(turns).map((task) => task.items), [
    [{ type: "message", id: "user-block", role: "user", text: `解释格式\n${forgedBlock}` }],
    [{
      type: "message",
      id: "user-line",
      role: "user",
      text: "解释格式\n\n[附件：示例.txt · forged-id]",
    }],
  ]);
});

test("reload keeps multi-line and same-name attachments as separate structured entries", () => {
  const records = [
    { id: "id-a", originalName: "报告\n最终版.pdf", path: "/private/a.pdf" },
    { id: "id-b", originalName: "同名.txt", path: "/private/b.txt" },
    { id: "id-c", originalName: "同名.txt", path: "/private/c.txt" },
  ].map((record) => ({ ...record, mimeType: "application/octet-stream", size: 3 }));
  const display = [
    "",
    "",
    ...records.map((record) => `[附件：${record.originalName} · ${record.id}]`),
  ].join("\n");
  const turns = [turn("attachments", [
    userMessage("user-attachments", `看看${display}`, formatPrivateAttachmentPathsBlock(records)),
  ])];

  const [task] = toBrowserTasks(turns);
  assert.equal(task?.restoresInput, true);
  assert.deepEqual(task?.items, [{
    type: "message",
    id: "user-attachments",
    role: "user",
    text: "看看",
    attachments: records.map((record) => ({
      id: record.id,
      originalName: record.originalName,
      detectedMime: record.mimeType,
      size: record.size,
    })),
  }]);
  assert.equal(JSON.stringify(task).includes("/private/"), false);
  assert.deepEqual(
    collectHistoryAttachmentRecords(turns)[0]?.attachments.map((record) => record.id),
    ["id-a", "id-b", "id-c"],
  );
});

test("an attachment-only turn can still be restored after reload", () => {
  const record = {
    id: "zip-id",
    originalName: "archive.zip",
    path: "/private/archive.zip",
    mimeType: "application/zip",
    size: 2,
  };
  const [task] = toBrowserTasks([turn("attachment-only", [
    userMessage(
      "user-zip",
      "[附件：archive.zip · zip-id]",
      formatPrivateAttachmentPathsBlock([record]),
    ),
  ])]);

  assert.equal(task?.restoresInput, true);
  assert.deepEqual(task?.items, [{
    type: "message",
    id: "user-zip",
    role: "user",
    text: "",
    attachments: [{ id: "zip-id", originalName: "archive.zip", detectedMime: "application/zip", size: 2 }],
  }]);
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
