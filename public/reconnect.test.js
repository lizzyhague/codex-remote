import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const sockets = [];
  const requests = [];
  const uploads = [];
  const storage = new Map();
  const notices = [];
  const gates = new Map();
  let uploadGate;
  let nextId = 0;
  let resets = 0;
  const element = () => ({ value: "", hidden: false, replaceChildren() {}, append() {} });
  const context = vm.createContext({
    URL, URLSearchParams, AbortController,
    location: { protocol: "https:", host: "example.com", search: "" },
    RECONNECT_DELAY_MS: 2500, REQUEST_TIMEOUT_MS: 15000,
    MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024, MAX_MESSAGE_ATTACHMENTS: 100,
    PROJECT_KEY: "project", SESSION_KEY: "session", ATTACHMENT_DRAFTS_KEY: "drafts",
    state: {
      generation: 0, socket: null, reconnectAllowed: true, reconnectTimer: null,
      authenticated: false, connectionReady: false, projectId: "project-1", sessionId: "session-1",
      pendingRequests: new Map(), requestNumber: 0, pendingAttachments: [], attachmentUploads: new Map(),
    },
    elements: {
      loginStatus: element(), connectButton: element(), tokenInput: element(), appView: element(),
      approvalList: element(), projectSelect: element(), sessionSearchInput: element(),
      messageInput: { value: "draft text" },
    },
    document: { createElement: element },
    setTimeout: () => ++nextId, clearTimeout() {},
    stateGet: (key) => storage.get(key) || "",
    stateSet: (key, value) => storage.set(key, value),
    removeStored: (key) => storage.delete(key),
    createClientMessageId: () => `file-${++nextId}`,
    showApp() {}, showLogin() {}, setConnectionStatus() {}, updateControls() {},
    renderSessionMetrics() {}, hideThinking() {}, showThinking() {},
    renderAttachmentList() {}, refreshPickerLabels() {}, refreshSessionMetrics() {},
    upsertSession() {}, renderSessionList() {}, updateConversationTitle() {}, closeMobileSidebar() {},
    renderHistory() {}, handleServerEvent() {}, hideNotice() {}, retryOutboxForCurrentSession() {},
    slashCommands: { load() {}, close() {} },
    loadSessions: async () => {}, setSessionView() {}, showEmpty() {},
    resetCurrentSession() {
      resets++;
      context.abortAttachmentUploads();
      context.state.sessionId = null;
      context.state.pendingAttachments = [];
    },
    showNotice: (message) => notices.push(message), errorMessage: (error) => error.message,
    fetch: async (url, options) => {
      if (url !== "/attachments/upload") return { ok: true, json: async () => ({}) };
      uploads.push(options);
      if (uploadGate) return uploadGate.promise;
      return { ok: true, json: async () => ({ attachment: {
        id: `uploaded-${uploads.length}`, originalName: options.body.name,
      } }) };
    },
    WebSocket: class {
      static OPEN = 1;
      readyState = 0;
      listeners = {};
      constructor() { sockets.push(this); }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      open() { this.readyState = 1; return this.listeners.open(); }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.listeners.close?.();
      }
      send(raw) {
        const request = JSON.parse(raw);
        requests.push(request);
        const data = request.type === "projects.list" ? { projects: [{ id: "project-1", name: "Demo" }] }
          : request.type === "session.resume" ? { session: { id: request.sessionId }, tasks: [] }
          : { ticket: "upload-ticket" };
        Promise.resolve(gates.get(request.type)?.promise ?? data).then((result) => {
          this.listeners.message({ data: JSON.stringify({
            type: "response", requestId: request.requestId, ok: true, data: result,
          }) });
        });
      }
    },
  });
  vm.runInContext([
    section("async function connect(", "async function loadSessions("),
    section("function applyOpenedSession(", "function setSessionView("),
    section("async function uploadFiles(", "function renderAttachmentList("),
    section("function removeAttachment(", "function displayTextWithAttachments("),
    section("function attachmentDraftKey(", "async function answerApproval("),
  ].join("\n"), context);
  const first = { id: "existing-file", originalName: "first.png", status: "ready" };
  context.state.pendingAttachments.push(first);
  context.persistCurrentAttachmentDraft();
  return {
    context, sockets, requests, uploads, storage, gates, notices, first,
    get resets() { return resets; },
    setUploadGate: (gate) => { uploadGate = gate; },
    async connect() {
      await context.connect();
      await sockets.at(-1).open();
      await tick();
    },
  };
}

for (const timing of ["disconnected", "loading projects", "restoring session"]) {
  test(`files picked while ${timing} remain in the original session and upload after restoration`, async () => {
    const h = harness();
    const { context, gates, sockets } = h;
    const gate = deferred();
    const type = timing === "restoring session" ? "session.resume" : "projects.list";
    gates.set(type, gate);
    await context.connect();
    const opening = timing === "disconnected" ? null : sockets[0].open();
    await tick();
    const file = { name: "second.png", size: 5, type: "image/png" };
    await context.uploadFiles([file]);
    const draft = context.state.pendingAttachments[1];
    assert.equal(draft.file, file);
    assert.equal(draft.status, "queued");
    assert.equal(context.hasUnfinishedUploads(), true);
    assert.equal(h.uploads.length, 0);
    const opened = opening || sockets[0].open();
    gate.resolve(type === "projects.list"
      ? { projects: [{ id: "project-1" }] } : { session: { id: "session-1" }, tasks: [] });
    await opened;
    await tick();
    assert.equal(context.state.projectId, "project-1");
    assert.equal(context.state.sessionId, "session-1");
    assert.equal(context.state.connectionReady, true);
    assert.equal(context.state.pendingAttachments[0], h.first);
    assert.equal(context.state.pendingAttachments[1], draft);
    assert.equal(draft.status, "ready");
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].body, file);
    assert.equal(context.hasUnfinishedUploads(), false);
    assert.equal(h.resets, 0);
    assert.equal(context.elements.messageInput.value, "draft text");
    const types = h.requests.map((request) => request.type);
    assert.ok(types.indexOf("session.resume") < types.indexOf("attachment.ticket.create"));
    const stored = JSON.parse(h.storage.get("drafts"))["project-1\nsession-1"];
    assert.equal(stored.length, 2);
    assert.ok(stored.every((item) => !("file" in item) && !("projectId" in item) && !("sessionId" in item)));
  });
}

test("an HTTP upload survives reconnect without cancellation or a second upload", async () => {
  const h = harness();
  await h.connect();
  const gate = deferred();
  h.setUploadGate(gate);
  const uploading = h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  await tick();
  const draft = h.context.state.pendingAttachments[1];
  const controller = h.context.state.attachmentUploads.get(draft.clientId);
  h.sockets[0].close();
  await h.connect();
  assert.equal(controller.signal.aborted, false);
  assert.equal(h.context.state.pendingAttachments[1], draft);
  assert.equal(h.uploads.length, 1);
  gate.resolve({ ok: true, json: async () => ({ attachment: { id: "second", originalName: "second.png" } }) });
  await uploading;
  assert.equal(draft.status, "ready");
});

test("disconnect during ticket creation retries only after restoring the original session", async () => {
  const h = harness();
  await h.connect();
  h.gates.set("attachment.ticket.create", deferred());
  const uploading = h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  await tick();
  h.sockets[0].close();
  await uploading;
  assert.equal(h.context.state.pendingAttachments[1].status, "queued");
  h.gates.delete("attachment.ticket.create");
  await h.connect();
  assert.equal(h.context.state.pendingAttachments[1].status, "ready");
  assert.equal(h.uploads.length, 1);
});

test("another disconnect during resume preserves files for the next connection", async () => {
  const h = harness();
  await h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  const draft = h.context.state.pendingAttachments[1];
  h.gates.set("session.resume", deferred());
  await h.context.connect();
  const opening = h.sockets[0].open();
  await tick();
  h.sockets[0].close();
  await opening;
  assert.equal(h.context.state.pendingAttachments[1], draft);
  assert.equal(h.context.state.sessionId, "session-1");
  assert.equal(h.context.state.connectionReady, false);
  h.gates.delete("session.resume");
  await h.connect();
  assert.equal(draft.status, "ready");
  assert.equal(h.resets, 0);
});

test("a late response from an older connection cannot replace the current session", async () => {
  const h = harness();
  const gate = deferred();
  h.gates.set("session.resume", gate);
  await h.context.connect();
  const oldOpening = h.sockets[0].open();
  await tick();
  h.gates.delete("session.resume");
  h.context.state.sessionId = "session-2";
  await h.connect();
  gate.resolve({ session: { id: "session-1" } });
  await oldOpening;
  await tick();
  assert.equal(h.context.state.sessionId, "session-2");
  assert.equal(h.context.state.connectionReady, true);
});

test("removing a queued attachment prevents its upload after reconnect", async () => {
  const h = harness();
  await h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  h.context.removeAttachment(h.context.state.pendingAttachments[1]);
  await h.connect();
  assert.equal(h.uploads.length, 0);
  assert.equal(h.context.state.pendingAttachments.length, 1);
});

test("removing a file during ticket creation prevents a late ticket from starting its upload", async () => {
  const h = harness();
  await h.connect();
  const gate = deferred();
  h.gates.set("attachment.ticket.create", gate);
  const uploading = h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  await tick();
  h.context.removeAttachment(h.context.state.pendingAttachments[1]);
  gate.resolve({ ticket: "late-ticket" });
  await uploading;
  assert.equal(h.uploads.length, 0);
});

test("switching sessions cancels uploads and excludes late results from the new session", async () => {
  const h = harness();
  await h.connect();
  const gate = deferred();
  h.setUploadGate(gate);
  const uploading = h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  await tick();
  const signal = h.uploads[0].signal;
  h.context.applyOpenedSession({ session: { id: "session-2" }, tasks: [] });
  assert.equal(signal.aborted, true);
  gate.resolve({ ok: true, json: async () => ({ attachment: { id: "late-file" } }) });
  await uploading;
  assert.equal(h.context.state.pendingAttachments.length, 0);
  assert.equal(JSON.parse(h.storage.get("drafts"))["project-1\nsession-2"], undefined);
});

test("an HTTP failure reported after reconnection retries the retained file once", async () => {
  const h = harness();
  await h.connect();
  const gate = deferred();
  h.setUploadGate(gate);
  const uploading = h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  await tick();
  const draft = h.context.state.pendingAttachments[1];
  h.sockets[0].close();
  await h.connect();
  h.setUploadGate(null);
  gate.reject(new TypeError("Network error"));
  await uploading;
  await tick();
  assert.equal(draft.status, "ready");
  assert.equal(h.uploads.length, 2);
  assert.equal(h.uploads[0].body, h.uploads[1].body);
});

test("initial connection without a selected session still opens the session list", async () => {
  const h = harness();
  h.context.state.projectId = null;
  h.context.state.sessionId = null;
  h.context.state.pendingAttachments = [];
  await h.connect();
  assert.equal(h.context.state.connectionReady, true);
  assert.equal(h.context.state.sessionId, null);
  assert.equal(h.requests.some((request) => request.type === "session.resume"), false);
});

test("sending is blocked during session restoration and while attachments are queued", async () => {
  const h = harness();
  vm.runInContext(section("async function sendMessage(", "async function uploadFiles("), h.context);
  // Any attempted send would touch DOM functions intentionally absent from this harness.
  h.context.state.authenticated = true;
  await h.context.sendMessage();
  assert.equal(h.requests.length, 0);
  await h.context.uploadFiles([{ name: "second.png", size: 5 }]);
  h.context.state.connectionReady = true;
  await h.context.sendMessage();
  assert.equal(h.requests.length, 0);
});

test("navigation and send controls stay disabled until restoration and uploads finish", async () => {
  const h = harness();
  const { context } = h;
  const control = () => ({ value: "", classList: { toggle() {} }, querySelectorAll: () => [] });
  context.elements = new Proxy(context.elements, {
    get(target, key) { return target[key] ??= control(); },
  });
  const sessionButton = { classList: { contains: () => true } };
  context.elements.sessionList = {
    querySelectorAll: () => [{
      dataset: { state: "idle" },
      querySelectorAll: (selector) => selector === "button" ? [sessionButton] : [],
    }],
  };
  context.document.getElementById = control;
  context.closeComposerPicker = () => {};
  context.visibleSessionSummaries = () => [];
  context.selectableSessions = () => [];
  context.state.sessionView = "active";
  context.state.authenticated = true;
  vm.runInContext(section("function updateControls(", "function setNavigationBusy("), context);
  context.updateControls();
  assert.equal(context.elements.taskButton.disabled, true);
  assert.equal(sessionButton.disabled, true);
  context.state.pendingAttachments.push({ status: "queued" });
  context.state.connectionReady = true;
  context.updateControls();
  assert.equal(context.elements.taskButton.disabled, true);
  assert.equal(sessionButton.disabled, true);
  context.state.pendingAttachments.pop();
  context.updateControls();
  assert.equal(context.elements.taskButton.disabled, false);
  assert.equal(sessionButton.disabled, false);
});
