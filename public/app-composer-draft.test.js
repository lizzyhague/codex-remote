import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  RecoveryStateStore,
  beginMessageDelivery,
  composerDraft,
  setComposerDraft,
} from "./recovery-state.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function harness() {
  const storage = new Map();
  const backing = {
    getError: null,
    setError: null,
    getItem: (key) => {
      if (backing.getError) throw backing.getError;
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (backing.setError) throw backing.setError;
      storage.set(key, value);
    },
    removeItem: (key) => storage.delete(key),
  };
  const recoveryStore = new RecoveryStateStore(backing, { key: "recovery" });
  const notices = [];
  const requests = [];
  let serial = 0;
  const messageInput = {
    value: "A 的草稿",
    style: {},
    scrollHeight: 20,
    focus() {},
    setSelectionRange() {},
  };
  const context = vm.createContext({
    Date,
    state: {
      projectId: "project-a",
      sessionId: "session-a",
      composerProjectId: "project-a",
      composerSessionId: "session-a",
      sessionOpenState: null,
      sessionResumeTimer: null,
      sessionTitle: "A",
      metrics: null,
      connectionReady: true,
      authenticated: true,
      running: false,
      stopping: false,
      controlsTask: false,
      pendingAttachments: [],
      attachmentUploads: new Map(),
      rewindTargetTurnId: null,
      rewindText: null,
      rewindAttachments: [],
      pendingUserMessages: [],
    },
    elements: {
      messageInput,
      modelPickerLabel: { textContent: "" },
      permissionPickerLabel: { textContent: "" },
    },
    recoveryStore,
    volatileComposerDrafts: new Map(),
    readRecoveryState: () => {
      try { return recoveryStore.load(); } catch { return null; }
    },
    updateRecoveryState: (mutator, options) => {
      try { return recoveryStore.update(mutator, options); } catch { return null; }
    },
    composerDraft,
    setComposerDraft,
    beginMessageDelivery,
    publicAttachments: (value) => Array.isArray(value)
      ? value.filter((item) => item && typeof item.id === "string").map((item) => ({
        id: item.id,
        originalName: item.originalName,
        size: Number.isFinite(item.size) ? item.size : NaN,
        declaredMime: item.declaredMime || "",
        detectedMime: item.detectedMime || "",
        kind: item.kind === "image" ? "image" : "file",
        expiresAtMs: Number.isFinite(item.expiresAtMs) ? item.expiresAtMs : null,
      }))
      : [],
    createClientMessageId: () => `client-${++serial}`,
    clearCurrentSessionNotice() {},
    abortAttachmentUploads() {},
    clearSessionResumeTimer() {},
    refreshPickerLabels() {},
    renderSessionMetrics() {},
    upsertSession() {},
    renderSessionList() {},
    updateConversationTitle() {},
    closeMobileSidebar() {},
    renderHistory() {},
    handleServerEvent() {},
    refreshSessionMetrics() {},
    showThinking() {},
    hideThinking() {},
    showNotice: (text, options) => notices.push({ text, options }),
    clearNotice() {},
    taskNoticeKey: () => "task-control",
    updateControls() {},
    retryDeferredActionsForCurrentSession() {},
    renderAttachmentList() {},
    resizeComposer() {},
    closeComposerPicker() {},
    requestAnimationFrame: (callback) => callback(),
    request: async (type, payload) => {
      requests.push({ type, payload });
      return {};
    },
    readyAttachments: () => context.state.pendingAttachments.filter((item) => item.status === "ready"),
    hasUnfinishedUploads: () => false,
    slashCommands: { submit: async () => false },
    RECOVERY_NOTICE_KEY: "recovery-storage",
  });
  vm.runInContext([
    section("function applyOpenedSession(", "function setSessionView("),
    section("function resetCurrentSession()", "function openSidebar("),
    section("function loadComposerDraftForCurrentSession(", "function publicAttachments("),
    section("function storeMessageForDelivery(", "function loadOutbox("),
    section("async function sendMessage()", "async function uploadFiles("),
  ].join("\n"), context);
  return { context, recoveryStore, storage, backing, notices, requests };
}

function opened(id, title = id) {
  return { session: { id, title }, tasks: [] };
}

test("same-project, cross-project and new-session navigation keep separate text drafts", () => {
  const h = harness();
  h.context.applyOpenedSession(opened("session-b"));
  assert.equal(h.context.elements.messageInput.value, "");
  assert.equal(composerDraft(h.recoveryStore.load(), "project-a", "session-a").text, "A 的草稿");

  h.context.elements.messageInput.value = "B 的草稿";
  h.context.persistCurrentComposerDraft();
  h.context.applyOpenedSession(opened("session-a"));
  assert.equal(h.context.elements.messageInput.value, "A 的草稿");

  h.context.state.projectId = "project-b";
  h.context.applyOpenedSession(opened("new-session", "新会话"));
  assert.equal(h.context.elements.messageInput.value, "");
  assert.equal(composerDraft(h.recoveryStore.load(), "project-a", "session-b").text, "B 的草稿");
  assert.equal(composerDraft(h.recoveryStore.load(), "project-b", "new-session").text, "");
});

test("falling back after an open failure saves the old draft and clears its visible ownership", () => {
  const h = harness();
  h.context.resetCurrentSession();
  assert.equal(h.context.elements.messageInput.value, "");
  assert.equal(h.context.state.composerProjectId, null);
  assert.equal(h.context.state.composerSessionId, null);
  assert.equal(composerDraft(h.recoveryStore.load(), "project-a", "session-a").text, "A 的草稿");
});

test("a local-storage quota error prevents message.send and leaves the composer intact", async () => {
  const h = harness();
  h.backing.setError = Object.assign(new Error("quota full"), { name: "QuotaExceededError" });
  await h.context.sendMessage();
  assert.deepEqual(h.requests, []);
  assert.equal(h.context.elements.messageInput.value, "A 的草稿");
  assert.match(h.notices.at(-1).text, /没有发送/u);
});

test("a getItem failure keeps per-session drafts in page memory without leaking them", () => {
  const h = harness();
  h.backing.getError = new Error("storage blocked");
  h.context.applyOpenedSession(opened("session-b"));
  assert.equal(h.context.elements.messageInput.value, "");

  h.context.applyOpenedSession(opened("session-a"));
  assert.equal(h.context.elements.messageInput.value, "A 的草稿");
});
