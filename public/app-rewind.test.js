import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function harness(storage = new Map()) {
  const requests = [];
  const results = [];
  const notices = [];
  let requestHandler = async () => ({});
  let attachmentSerial = 0;
  const context = vm.createContext({
    REWIND_OUTBOX_KEY: "rewind-outbox",
    state: {
      authenticated: true,
      commandBusy: false,
      projectId: "project-1",
      sessionId: "session-1",
      rewindTargetTurnId: "turn-2",
      rewindText: "原来的问题",
      rewindAttachments: [{ id: "attachment-1", originalName: "note.txt" }],
      pendingAttachments: [],
    },
    elements: { messageInput: { value: "" } },
    request: async (type, payload) => {
      requests.push({ type, payload });
      return requestHandler(type, payload);
    },
    applySessionResumeResult: () => true,
    publicAttachments: (value) => Array.isArray(value)
      ? value.filter((item) =>
        item && typeof item.id === "string" && typeof item.originalName === "string"
      ).map((item) => ({ ...item }))
      : [],
    stateGet: (key) => storage.get(key) || "",
    stateSet: (key, value) => storage.set(key, value),
    removeStored: (key) => storage.delete(key),
    restoreComposerText: (text) => { context.elements.messageInput.value = text; },
    setPendingAttachments: (attachments) => { context.state.pendingAttachments = attachments; },
    createClientMessageId: () => `attachment-client-${++attachmentSerial}`,
    clearNotice() {},
    addCommandResult: (result) => results.push(result),
    showNotice: (message, options) => notices.push({ message, options }),
    updateControls() {},
    errorMessage: (error) => error.message,
    retryOutboxForCurrentSession: async () => {},
  });
  vm.runInContext(
    section("async function requestSlashCommand(", "async function retryOutboxForCurrentSession("),
    context,
  );
  return {
    context,
    requests,
    results,
    notices,
    storage,
    setRequestHandler(handler) { requestHandler = handler; },
  };
}

function rewindResult(outcome) {
  return {
    kind: "rewind",
    outcome,
    targetTurnId: "turn-2",
    title: outcome === "stale" ? "没有执行回退" : "已回退一轮",
    lines: [],
  };
}

test("a rewind names the visible turn and restores its draft after reloading history", async () => {
  const h = harness();
  h.setRequestHandler(async (type) =>
    type === "command.run"
      ? rewindResult("reverted")
      : { session: { id: "session-1" }, tasks: [] });

  const menuResult = await h.context.requestSlashCommand("command.run", {
    command: "rewind",
    option: null,
    argument: null,
  });

  assert.equal(menuResult, null);
  assert.deepEqual(h.requests.map(({ type }) => type), ["command.run", "session.resume"]);
  assert.equal(h.requests[0].payload.projectId, "project-1");
  assert.equal(h.requests[0].payload.sessionId, "session-1");
  assert.equal(h.requests[0].payload.targetTurnId, "turn-2");
  assert.equal(h.context.elements.messageInput.value, "原来的问题");
  assert.equal(h.context.state.pendingAttachments[0].id, "attachment-1");
  assert.equal(h.storage.has("rewind-outbox"), false);
  assert.deepEqual(h.results.map((result) => result.outcome), ["reverted"]);
});

test("a PWA reopen retries the same turn instead of selecting the new latest turn", async () => {
  const storage = new Map();
  const first = harness(storage);
  first.setRequestHandler(async (type) => {
    assert.equal(type, "command.run");
    throw Object.assign(new Error("请求超时"), { code: "request_timeout" });
  });

  await assert.rejects(
    first.context.requestSlashCommand("command.run", {
      command: "rewind",
      option: null,
      argument: null,
    }),
    /请求超时/u,
  );
  assert.equal(storage.has("rewind-outbox"), true);

  const reopened = harness(storage);
  reopened.context.state.rewindTargetTurnId = "turn-1";
  reopened.context.state.rewindText = "更早的问题";
  reopened.setRequestHandler(async (type) =>
    type === "command.run"
      ? rewindResult("already_reverted")
      : { session: { id: "session-1" }, tasks: [] });

  assert.equal(await reopened.context.retryPendingRewindForCurrentSession(), true);
  assert.equal(reopened.requests[0].payload.projectId, "project-1");
  assert.equal(reopened.requests[0].payload.sessionId, "session-1");
  assert.equal(reopened.requests[0].payload.targetTurnId, "turn-2");
  assert.equal(reopened.context.elements.messageInput.value, "原来的问题");
  assert.equal(storage.has("rewind-outbox"), false);
});

test("a stale rewind target never restores a draft for a turn that was not removed", async () => {
  const h = harness();
  h.setRequestHandler(async (type) =>
    type === "command.run"
      ? rewindResult("stale")
      : { session: { id: "session-1" }, tasks: [] });

  await h.context.requestSlashCommand("command.run", {
    command: "rewind",
    option: null,
    argument: null,
  });

  assert.equal(h.context.elements.messageInput.value, "");
  assert.deepEqual(h.context.state.pendingAttachments, []);
  assert.equal(h.storage.has("rewind-outbox"), false);
  assert.deepEqual(h.results.map((result) => result.outcome), ["stale"]);
});

test("the rewind draft records the turn id even when that turn has no restorable input", () => {
  const context = vm.createContext({
    splitAttachmentDisplayText: (text) => ({ text, attachments: [] }),
  });
  vm.runInContext(
    section("function rewindDraftFromLatestTask(", "function splitAttachmentDisplayText("),
    context,
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.rewindDraftFromLatestTask([
      { id: "turn-special", restoresInput: false, items: [] },
    ]))),
    { targetTurnId: "turn-special", text: null, attachments: [] },
  );
});
