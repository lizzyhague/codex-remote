import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function eventHarness() {
  const calls = [];
  const context = vm.createContext({
    state: {
      sessionId: "session-b",
      sessionOpenState: null,
      running: true,
      pendingUserMessages: [],
      rewindText: null,
      rewindAttachments: [],
    },
    isTaskProgressEvent: () => false,
    clearNotice() {},
    hideThinking: () => calls.push("hide"),
    showThinking: () => calls.push("show"),
    addApproval: (...args) => calls.push(["add-approval", ...args]),
    removeApproval: (id) => calls.push(["remove-approval", id]),
    addInteraction: (...args) => calls.push(["add-interaction", ...args]),
    removeInteraction: (id) => calls.push(["remove-interaction", id]),
  });
  vm.runInContext(section("function handleServerEvent(", "function setCurrentSessionState("), context);
  return { context, calls };
}

test("background pending requests do not change the current session thinking indicator", () => {
  const h = eventHarness();
  const sourceSession = { id: "session-a", title: "后台会话" };
  h.context.handleServerEvent({
    type: "approval.requested",
    sessionId: "session-a",
    sourceSession,
    approval: { id: "approval-a" },
  });
  h.context.handleServerEvent({
    type: "approval.resolved",
    sessionId: "session-a",
    approvalId: "approval-a",
  });
  h.context.handleServerEvent({
    type: "interaction.requested",
    sessionId: "session-a",
    sourceSession,
    interaction: { id: "interaction-a" },
  });
  h.context.handleServerEvent({
    type: "interaction.resolved",
    sessionId: "session-a",
    interactionId: "interaction-a",
  });

  assert.deepEqual(h.calls, [
    ["add-approval", { id: "approval-a" }, sourceSession, "session-a"],
    ["remove-approval", "approval-a"],
    ["add-interaction", { id: "interaction-a" }, sourceSession, "session-a"],
    ["remove-interaction", "interaction-a"],
  ]);

  h.context.handleServerEvent({
    type: "approval.requested",
    sessionId: "session-b",
    sourceSession: { id: "session-b", title: "当前会话" },
    approval: { id: "approval-b" },
  });
  h.context.handleServerEvent({
    type: "approval.resolved",
    sessionId: "session-b",
    approvalId: "approval-b",
  });
  assert.deepEqual(h.calls.slice(-4).map((call) =>
    Array.isArray(call) ? call[0] : call
  ), ["hide", "add-approval", "remove-approval", "show"]);
});

test("redrawing a conversation keeps the global pending-request area", () => {
  let timelineClears = 0;
  let pendingClears = 0;
  const context = vm.createContext({
    state: {
      assistantStreams: new Map(),
      commands: new Map(),
      pendingUserMessages: [],
      rewindTargetTurnId: "turn-1",
      rewindText: "text",
      rewindAttachments: [],
    },
    cancelAnimationFrame() {},
    slashCommands: { close() {} },
    hideThinking() {},
    elements: {
      historyLoader: { hidden: false },
      timeline: { replaceChildren: () => { timelineClears += 1; } },
      approvalList: { replaceChildren: () => { pendingClears += 1; } },
    },
  });
  vm.runInContext(section("function clearTimeline()", "function showEmpty("), context);
  context.clearTimeline();
  assert.equal(timelineClears, 1);
  assert.equal(pendingClears, 0);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  querySelectorAll() {
    return [];
  }
}

function visibleText(element) {
  return [element.textContent, ...element.children.map((child) => visibleText(child))]
    .filter(Boolean)
    .join("\n");
}

function approvalHarness() {
  const approvalList = new FakeElement("aside");
  approvalList.querySelector = () => null;
  const context = vm.createContext({
    state: { sessionId: "session-b", running: true },
    elements: { approvalList },
    document: { createElement: (tagName) => new FakeElement(tagName) },
    CSS: { escape: (value) => value },
    findSessionSummary: () => null,
    answerApproval() {},
  });
  vm.runInContext(
    section("function addApproval(", "async function requestSlashCommand("),
    context,
  );
  return { context, approvalList };
}

test("an approval card always names its source and shows only the public scope summary", () => {
  const h = approvalHarness();
  h.context.addApproval({
    id: "approval-1",
    kind: "command",
    reason: "需要读取一个文件",
    commandSummary: "cat ‹主机路径›",
    network: { protocol: "https", host: "example.com" },
    canApprove: true,
  }, {
    id: "session-a-123456",
    title: "后台会话",
  }, "session-a-123456");

  const card = h.approvalList.children[0];
  assert.equal(card.dataset.sessionId, "session-a-123456");
  assert.match(visibleText(card), /来源会话：后台会话 · session-/u);
  assert.match(visibleText(card), /命令：cat ‹主机路径›/u);
  assert.match(visibleText(card), /网络访问：https:\/\/example\.com/u);
  assert.equal(visibleText(card).includes("/home/"), false);
});

test("an incomplete permission summary offers decline but not approval", () => {
  const h = approvalHarness();
  h.context.addApproval({
    id: "approval-2",
    kind: "permissions",
    reason: "需要额外权限",
    permissionSummary: [],
    canApprove: false,
  }, { id: "session-a", title: "后台会话" }, "session-a");

  const card = h.approvalList.children[0];
  const buttons = card.children.filter((child) => child.tagName === "button");
  assert.deepEqual(buttons.map((button) => button.textContent), ["拒绝"]);
  assert.match(visibleText(card), /只能拒绝/u);
});

test("an interaction card keeps the same explicit source-session label", () => {
  const approvalList = new FakeElement("aside");
  approvalList.querySelector = () => null;
  const context = vm.createContext({
    elements: { approvalList },
    document: { createElement: (tagName) => new FakeElement(tagName) },
    CSS: { escape: (value) => value },
    pendingRequestSessionLabel: (sourceSession, sessionId) =>
      `${sourceSession.title} · ${sessionId.slice(0, 8)}`,
    answerInteraction() {},
  });
  vm.runInContext(
    section("function addInteraction(", "/**\n * 外部来源的地址"),
    context,
  );
  context.addInteraction({
    id: "interaction-1",
    kind: "user_input",
    questions: [{
      id: "choice",
      question: "继续吗？",
      isSecret: false,
      isOther: false,
      options: [{ label: "继续", description: "继续任务" }],
    }],
  }, { id: "session-a-123456", title: "后台会话" }, "session-a-123456");

  const card = approvalList.children[0];
  assert.equal(card.dataset.sessionId, "session-a-123456");
  assert.match(visibleText(card), /来源会话：后台会话 · session-/u);
});

test("answering a background approval does not restart current-session thinking", async () => {
  const shown = [];
  const context = vm.createContext({
    state: { sessionId: "session-b", running: true },
    request: async () => ({ answered: true }),
    showThinking: () => shown.push("show"),
    showNotice() {},
    errorMessage: (error) => error.message,
    TEMPORARY_ERROR: {},
  });
  vm.runInContext(section("async function answerApproval(", "function removeApproval("), context);
  const card = {
    dataset: { sessionId: "session-a" },
    querySelectorAll: () => [],
  };
  await context.answerApproval(card, "approval-a", "approve_once");
  assert.deepEqual(shown, []);

  card.dataset.sessionId = "session-b";
  await context.answerApproval(card, "approval-b", "approve_once");
  assert.deepEqual(shown, ["show"]);
});
