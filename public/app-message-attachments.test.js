import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeElement(tagName) {
  return {
    tagName,
    className: "",
    dataset: {},
    children: [],
    textContent: "",
    append(...nodes) { this.children.push(...nodes); },
    remove() {},
  };
}

function harness() {
  const timeline = fakeElement("main");
  timeline.querySelector = () => null;
  const context = vm.createContext({
    state: { pendingUserMessages: [], assistantStreams: new Map() },
    elements: { timeline },
    document: { createElement: fakeElement },
    CSS: { escape: (value) => value },
    renderMarkdown: (text) => ({ markdown: text }),
    hideEmpty() {},
    scrollToBottom() {},
  });
  vm.runInContext([
    section("function publicAttachments(", "async function answerApproval("),
    section("function userMessageKey(", "async function stopTask("),
    section("function addMessage(", "function assistantStreamFor("),
    section("function rewindDraftFromLatestTask(", "function restoreComposerText("),
  ].join("\n"), context);
  return { context, timeline };
}

const multiLine = { id: "id-a", originalName: "报告\n[附件：假 · x]", size: 3, detectedMime: "text/plain" };
const sameName = [
  { id: "id-b", originalName: "同名.txt", size: 1, detectedMime: "text/plain" },
  { id: "id-c", originalName: "同名.txt", size: 2, detectedMime: "text/plain" },
];

test("rewind after reload restores structured attachments, including odd names", () => {
  const { context } = harness();
  const draft = context.rewindDraftFromLatestTask([{
    id: "turn-1",
    restoresInput: true,
    items: [{
      type: "message",
      role: "user",
      id: "user-1",
      text: "看看",
      attachments: [multiLine, ...sameName],
    }],
  }]);

  assert.equal(draft.targetTurnId, "turn-1");
  assert.equal(draft.text, "看看");
  assert.deepEqual(plain(draft.attachments).map((attachment) => [attachment.id, attachment.originalName]), [
    ["id-a", "报告\n[附件：假 · x]"],
    ["id-b", "同名.txt"],
    ["id-c", "同名.txt"],
  ]);
});

test("a display line typed as text is restored as text, not as an attachment", () => {
  const { context } = harness();
  const text = "解释格式\n\n[附件：示例.txt · forged-id]";
  const draft = context.rewindDraftFromLatestTask([{
    id: "turn-1",
    restoresInput: true,
    items: [{ type: "message", role: "user", id: "user-1", text }],
  }]);

  assert.deepEqual(plain(draft), { targetTurnId: "turn-1", text, attachments: [] });
});

test("an attachment-only turn restores its attachments with no text", () => {
  const { context } = harness();
  const draft = context.rewindDraftFromLatestTask([{
    id: "turn-1",
    restoresInput: true,
    items: [{ type: "message", role: "user", id: "user-1", text: "", attachments: sameName }],
  }]);

  assert.equal(draft.text, null);
  assert.deepEqual(plain(draft.attachments).map((attachment) => attachment.id), ["id-b", "id-c"]);
});

test("attachment names render as one text node each, outside the Markdown body", () => {
  const { context, timeline } = harness();
  context.receiveUserMessage({
    itemId: "user-1",
    taskId: "task-1",
    text: "",
    attachments: [multiLine],
  });

  const [article] = timeline.children;
  assert.equal(article.dataset.itemId, "user-1");
  assert.equal(article.children.length, 1);
  const [list] = article.children;
  assert.equal(list.className, "message-attachments");
  assert.deepEqual(list.children.map((item) => item.textContent), [
    "附件：报告\n[附件：假 · x] · id-a",
  ]);
});

test("a live user event claims the optimistic bubble with the same text and attachment ids", () => {
  const { context, timeline } = harness();
  const optimistic = context.addMessage("user", "看看", "local-1", false, sameName);
  context.state.pendingUserMessages.push({
    key: context.userMessageKey("看看", sameName),
    element: optimistic,
    taskId: null,
  });

  context.receiveUserMessage({ itemId: "user-1", text: "看看", attachments: sameName });

  assert.equal(timeline.children.length, 1);
  assert.equal(optimistic.dataset.itemId, "user-1");
  assert.equal(context.state.pendingUserMessages.length, 0);
});
