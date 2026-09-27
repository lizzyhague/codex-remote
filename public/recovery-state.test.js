import assert from "node:assert/strict";
import test from "node:test";

import {
  RecoveryStateError,
  RecoveryStateStore,
  beginMessageDelivery,
  beginRewind,
  completeRewind,
  composerDraft,
  recoverMessageDelivery,
  setComposerDraft,
} from "./recovery-state.js";

const KEYS = {
  key: "recovery",
  legacy: {
    messages: "messages",
    rewinds: "rewinds",
    attachmentDrafts: "attachment-drafts",
  },
};

class MemoryStorage {
  values = new Map();
  getError = null;
  setError = null;
  writes = 0;

  getItem(key) {
    if (this.getError) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.writes += 1;
    if (this.setError) throw this.setError;
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function attachment(id = "attachment-1") {
  return {
    id,
    originalName: `${id}.txt`,
    size: 12,
    declaredMime: "text/plain",
    detectedMime: "text/plain",
    kind: "file",
    expiresAtMs: Date.now() + 60_000,
  };
}

function message(overrides = {}) {
  return {
    clientMessageId: "message-1",
    projectId: "project-a",
    sessionId: "session-a",
    text: "待发送正文",
    attachmentIds: ["attachment-1"],
    attachments: [attachment()],
    createdAtMs: 10,
    ...overrides,
  };
}

test("composer drafts survive reload and stay scoped to project plus session", () => {
  const storage = new MemoryStorage();
  const first = new RecoveryStateStore(storage, KEYS);
  const result = first.update((state) => {
    setComposerDraft(state, "project-a", "session-a", {
      text: "A 草稿",
      attachments: [attachment()],
    });
    setComposerDraft(state, "project-a", "session-b", { text: "B 草稿", attachments: [] });
    setComposerDraft(state, "project-b", "session-a", { text: "另一个项目", attachments: [] });
  });
  assert.equal(result.committed, true);
  assert.equal(result.persisted, true);

  const reopened = new RecoveryStateStore(storage, KEYS).load();
  assert.equal(composerDraft(reopened, "project-a", "session-a").text, "A 草稿");
  assert.equal(composerDraft(reopened, "project-a", "session-b").text, "B 草稿");
  assert.equal(composerDraft(reopened, "project-b", "session-a").text, "另一个项目");
  assert.equal(composerDraft(reopened, "project-a", "session-a").attachments[0].id, "attachment-1");
});

test("delivery moves a draft into outbox atomically and final rejection restores only its owner", () => {
  const storage = new MemoryStorage();
  const store = new RecoveryStateStore(storage, KEYS);
  store.update((state) => {
    setComposerDraft(state, "project-a", "session-a", {
      text: "待发送正文",
      attachments: [attachment()],
    });
    setComposerDraft(state, "project-b", "session-b", {
      text: "正在另一个会话写的新草稿",
      attachments: [],
    });
  });

  const begun = store.update((state) => beginMessageDelivery(state, message()), {
    retainOnFailure: false,
  });
  assert.equal(begun.persisted, true);
  assert.equal(composerDraft(begun.state, "project-a", "session-a").text, "");
  assert.equal(begun.state.messages[0].attachments[0].originalName, "attachment-1.txt");

  const recovered = store.update((state) => recoverMessageDelivery(state, message()));
  assert.equal(recovered.persisted, true);
  assert.deepEqual(recovered.state.messages, []);
  assert.equal(composerDraft(recovered.state, "project-a", "session-a").text, "待发送正文");
  assert.equal(composerDraft(recovered.state, "project-a", "session-a").attachments[0].id, "attachment-1");
  assert.equal(
    composerDraft(recovered.state, "project-b", "session-b").text,
    "正在另一个会话写的新草稿",
  );
});

test("a quota failure before send rolls back the outbox transition and keeps the draft", () => {
  const storage = new MemoryStorage();
  const store = new RecoveryStateStore(storage, KEYS);
  store.update((state) => setComposerDraft(state, "project-a", "session-a", {
    text: "不能丢的正文",
    attachments: [attachment()],
  }));
  const durableBefore = storage.values.get("recovery");
  storage.setError = Object.assign(new Error("quota full"), { name: "QuotaExceededError" });

  const result = store.update((state) => beginMessageDelivery(state, message({
    text: "不能丢的正文",
  })), { retainOnFailure: false });

  assert.equal(result.committed, false);
  assert.equal(result.persisted, true);
  assert.deepEqual(result.state.messages, []);
  assert.equal(composerDraft(result.state, "project-a", "session-a").text, "不能丢的正文");
  assert.equal(storage.values.get("recovery"), durableBefore);
  assert.equal(store.lastError.code, "recovery_unavailable");
});

test("a failed post-result write keeps a volatile recovery until storage can sync", () => {
  const storage = new MemoryStorage();
  const store = new RecoveryStateStore(storage, KEYS);
  store.update((state) => beginMessageDelivery(state, message()), { retainOnFailure: false });
  const durableOutbox = storage.values.get("recovery");
  storage.setError = new Error("temporarily unavailable");

  const recovered = store.update((state) => recoverMessageDelivery(state, message()));
  assert.equal(recovered.persisted, false);
  assert.deepEqual(recovered.state.messages, []);
  assert.equal(composerDraft(recovered.state, "project-a", "session-a").text, "待发送正文");
  assert.equal(storage.values.get("recovery"), durableOutbox);

  storage.setError = null;
  assert.equal(store.ensurePersisted(), true);
  const reopened = new RecoveryStateStore(storage, KEYS).load();
  assert.deepEqual(reopened.messages, []);
  assert.equal(composerDraft(reopened, "project-a", "session-a").text, "待发送正文");
});

test("getItem exceptions and damaged JSON are errors rather than empty recovery queues", () => {
  const unavailableStorage = new MemoryStorage();
  unavailableStorage.getError = new Error("storage blocked");
  assert.throws(
    () => new RecoveryStateStore(unavailableStorage, KEYS).load(),
    (error) => error instanceof RecoveryStateError && error.code === "recovery_unavailable",
  );

  const damagedStorage = new MemoryStorage();
  damagedStorage.values.set("recovery", "{not-json");
  const writesBefore = damagedStorage.writes;
  assert.throws(
    () => new RecoveryStateStore(damagedStorage, KEYS).load(),
    (error) => error instanceof RecoveryStateError &&
      error.code === "recovery_corrupt" && error.raw === "{not-json",
  );
  assert.equal(damagedStorage.values.get("recovery"), "{not-json");
  assert.equal(damagedStorage.writes, writesBefore);
});

test("legacy message, rewind and attachment records migrate only after confirmed write", () => {
  const storage = new MemoryStorage();
  storage.values.set("messages", JSON.stringify([{
    clientMessageId: "legacy-message",
    projectId: "project-a",
    sessionId: "session-a",
    text: "旧消息",
    attachmentIds: [],
  }]));
  storage.values.set("rewinds", JSON.stringify([{
    projectId: "project-a",
    sessionId: "session-a",
    targetTurnId: "turn-1",
    text: "旧问题",
    attachments: [],
  }]));
  storage.values.set("attachment-drafts", JSON.stringify({
    "project-a\nsession-a": [attachment()],
  }));

  const state = new RecoveryStateStore(storage, KEYS).load();
  assert.equal(state.messages[0].clientMessageId, "legacy-message");
  assert.equal(state.rewinds[0].targetTurnId, "turn-1");
  assert.equal(composerDraft(state, "project-a", "session-a").attachments[0].id, "attachment-1");
  assert.equal(storage.values.has("recovery"), true);
  assert.equal(storage.values.has("messages"), false);
  assert.equal(storage.values.has("rewinds"), false);
  assert.equal(storage.values.has("attachment-drafts"), false);
});

test("rewind completion merges restored input without replacing a newer draft", () => {
  const storage = new MemoryStorage();
  const store = new RecoveryStateStore(storage, KEYS);
  const rewind = {
    projectId: "project-a",
    sessionId: "session-a",
    targetTurnId: "turn-1",
    text: "被回退的问题",
    attachments: [attachment()],
    createdAtMs: 1,
  };
  store.update((state) => {
    setComposerDraft(state, "project-a", "session-a", { text: "后来写的草稿", attachments: [] });
    beginRewind(state, rewind);
  });
  const completed = store.update((state) => completeRewind(state, rewind, true));
  assert.deepEqual(completed.state.rewinds, []);
  assert.equal(
    composerDraft(completed.state, "project-a", "session-a").text,
    "被回退的问题\n\n后来写的草稿",
  );
});
