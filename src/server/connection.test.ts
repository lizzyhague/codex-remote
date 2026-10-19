import { localText, type LocalText } from "../shared/local-text.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ApplicationSettingsStore } from "../settings/store.ts";

import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type {
  OpenedSession,
  SessionChangeEvent,
  SessionPage,
} from "../sessions/service.ts";
import {
  BrowserConnection,
  BrowserRequestError,
  publicError,
  type BrowserConnectionServices,
  type BrowserSocket,
  type ProjectsApi,
  type SessionsApi,
} from "./connection.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import type {
  ManagedSessionOpen,
  SessionWorkerManager,
  WorkerManagerEvent,
} from "../workers/manager.ts";

class FakeSocket implements BrowserSocket {
  readonly messages: JsonObject[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as JsonObject);
  }

  close(): void {}

  /** Most recent message of a given type; most tests only care about this one. */
  last(type: string): JsonObject | undefined {
    return [...this.messages].reverse().find((message) => message.type === type);
  }

  events(eventType: string): JsonObject[] {
    return this.messages
      .filter((message) => message.type === "event")
      .map((message) => message.event as JsonObject)
      .filter((event) => event.type === eventType);
  }
}

/** Directory App Server; sessions and turns do not pass through it. */
class FakeTransport implements AppServerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  beforeModels: (() => Promise<void>) | null = null;

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    if (method === "model/list") {
      if (this.beforeModels) await this.beforeModels();
      return {
        data: [{
          id: "gpt-test",
          displayName: "GPT Test",
          description: "测试模型",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "平衡" },
            { reasoningEffort: "high", description: "深入" },
          ],
        }],
        nextCursor: null,
      } as Result;
    }
    if (method === "permissionProfile/list") {
      return {
        data: [
          { id: ":workspace", description: null, allowed: true },
          { id: ":danger-full-access", description: null, allowed: true },
        ],
        nextCursor: null,
      } as Result;
    }
    throw new Error(`测试不应通过目录 App Server 发 ${method} 请求。`);
  }

  onNotification(_listener: AppServerMessageListener): () => void {
    return () => {};
  }
}

/**
 * Worker manager double. The real manager starts codex children; this one only records calls,
 * returns prepared results, and lets tests push events explicitly.
 */
class FakeWorkers {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly authenticatedClients = new Set<string>();
  readonly attached = new Map<string, string>();
  readonly metrics = {
    async read() {
      return { context: null, windows: [], lastReplyAt: null };
    },
  };
  readonly #listeners = new Set<(event: WorkerManagerEvent) => void>();
  readonly opens = new Map<string, ManagedSessionOpen>();
  readonly runningSessions = new Set<string>();
  readonly busyProjects = new Set<string>();
  commandResult: Record<string, unknown> = { kind: "message", title: "完成", lines: [] };
  /** Wait before resuming a session; tests use it to simulate a pending backend request at disconnect. */
  beforeResume: (() => Promise<void>) | null = null;
  #sequence = 0;
  #nextSession = 1;

  onEvent(listener: (event: WorkerManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Simulate the manager broadcasting an event. */
  emit(
    event: Record<string, unknown> & { type: string },
    audience: WorkerManagerEvent["audience"],
    threadId: string,
  ): void {
    const stored: WorkerManagerEvent = {
      sequence: ++this.#sequence,
      taskId: "task-1",
      threadId,
      createdAtMs: 1,
      event,
      audience,
    };
    for (const listener of this.#listeners) listener(stored);
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  clientAuthenticated(clientId: string): void {
    this.authenticatedClients.add(clientId);
  }

  clientDisconnected(clientId: string): void {
    this.authenticatedClients.delete(clientId);
    this.attached.delete(clientId);
  }

  attachSession(clientId: string, _projectId: string, threadId: string): void {
    this.attached.set(clientId, threadId);
  }

  detachSession(clientId: string): void {
    this.attached.delete(clientId);
  }

  /** Default-setting fallback explanation returned by the next startSession. */
  startSettingsNotice: LocalText | null = null;

  async startSession(projectId: string): Promise<ManagedSessionOpen> {
    this.#record("startSession", projectId);
    const opened = this.#open(`session-${this.#nextSession++}`);
    if (!this.startSettingsNotice) return opened;
    return { ...opened, settingsNotice: this.startSettingsNotice } as ManagedSessionOpen;
  }

  async resumeSession(projectId: string, sessionId: string): Promise<ManagedSessionOpen> {
    this.#record("resumeSession", projectId, sessionId);
    if (this.beforeResume) await this.beforeResume();
    return this.opens.get(sessionId) ?? this.#open(sessionId);
  }

  #open(sessionId: string): ManagedSessionOpen {
    return managedOpen(openedSession(sessionId));
  }

  activeTask(threadId: string): { id: string } | null {
    return this.runningSessions.has(threadId) ? { id: "task-1" } : null;
  }

  projectBusy(projectId: string): boolean {
    return this.busyProjects.has(projectId);
  }

  peekAttachmentMappings(): [] {
    return [];
  }

  /** Real wait while opening a session; tests use it to hold events in the timing window. */
  beforeAttachmentSync: (() => Promise<void>) | null = null;

  async syncAttachmentMappings(): Promise<[]> {
    if (this.beforeAttachmentSync) await this.beforeAttachmentSync();
    return [];
  }

  async commandOptions(projectId: string, sessionId: string, command: string) {
    this.#record("commandOptions", projectId, sessionId, command);
    return { title: "选择", items: [] };
  }

  async runCommand(
    projectId: string,
    sessionId: string,
    clientMessageId: string,
    command: string,
    option: string | null,
    argument: string | null,
    targetTurnId: string | null,
  ): Promise<Record<string, unknown>> {
    this.#record(
      "runCommand",
      projectId,
      sessionId,
      clientMessageId,
      command,
      option,
      argument,
      targetTurnId,
    );
    return this.commandResult;
  }

  async enqueueMessageWithAttachments(
    projectId: string,
    sessionId: string,
    clientMessageId: string,
    text: string,
    attachmentIds: string[],
  ) {
    this.#record(
      "enqueueMessageWithAttachments",
      projectId,
      sessionId,
      clientMessageId,
      text,
      attachmentIds,
    );
    return { accepted: true as const, taskId: "task-1", status: "queued" as const, duplicate: false };
  }

  async stopTask(sessionId: string) {
    this.#record("stopTask", sessionId);
    return { requested: true };
  }

  answerApproval(approvalId: string, decision: string) {
    this.#record("answerApproval", approvalId, decision);
    return { answered: true as const };
  }

  async answerInteraction(interactionId: string, action: string, answers: unknown) {
    this.#record("answerInteraction", interactionId, action, answers);
    return { answered: true as const };
  }
}

class FakeProjects implements ProjectsApi {
  async list() {
    return [{ id: "projects/demo", name: "demo", rootId: "projects" }];
  }
}

class FakeSessions implements SessionsApi {
  readonly marks = new Set<string>();
  sessions: SessionPage["sessions"] = [];
  archiveFailure: string | null = null;
  readonly #listeners = new Set<(event: SessionChangeEvent) => void>();

  isMarked(sessionId: string): boolean {
    return this.marks.has(sessionId);
  }

  onChange(listener: (event: SessionChangeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: SessionChangeEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  async list(_projectId: string): Promise<SessionPage> {
    return { sessions: [...this.sessions], marked: [], nextCursor: null };
  }

  async start(_projectId: string): Promise<OpenedSession> {
    throw new Error("会话由 Worker 管理器打开。");
  }

  async resume(_projectId: string, sessionId: string): Promise<OpenedSession> {
    return openedSession(sessionId);
  }

  async archive(projectId: string, sessionIds: string[]) {
    if (this.archiveFailure !== null) {
      return {
        succeeded: [],
        failed: sessionIds.map((sessionId) => ({
          sessionId,
          text: localText("error.sessionTaskRunning"),
          message: this.archiveFailure!,
        })),
      };
    }
    this.#emit({ projectId, sessionIds, change: "archive" });
    return { succeeded: sessionIds, failed: [] };
  }

  async unarchive(projectId: string, sessionIds: string[]) {
    this.#emit({ projectId, sessionIds, change: "unarchive" });
    return { succeeded: sessionIds, failed: [] };
  }

  async moveToTrash(projectId: string, sessionIds: string[]) {
    this.#emit({ projectId, sessionIds, change: "trash" });
    return { succeeded: sessionIds, failed: [] };
  }

  async restoreTrash(projectId: string, sessionIds: string[]) {
    this.#emit({ projectId, sessionIds, change: "restore" });
    return { succeeded: sessionIds, failed: [] };
  }

  async deleteTrash(projectId: string, sessionIds: string[]) {
    this.#emit({ projectId, sessionIds, change: "delete" });
    return { succeeded: sessionIds, failed: [] };
  }

  async setMarked(projectId: string, sessionId: string, marked: boolean) {
    if (marked) this.marks.add(sessionId);
    else this.marks.delete(sessionId);
    this.#emit({ projectId, sessionIds: [sessionId], change: marked ? "mark" : "unmark" });
    return { ...openedSession(sessionId).session, projectId, marked };
  }

  async rename(projectId: string, sessionId: string, title: string) {
    this.#emit({ projectId, sessionIds: [sessionId], change: "rename" });
    return { ...openedSession(sessionId).session, projectId, title };
  }
}

function openedSession(id: string): OpenedSession {
  return {
    session: {
      id,
      sessionId: id,
      title: "新会话",
      preview: "",
      createdAt: 1,
      updatedAt: 1,
      lastReplyAt: null,
      state: "idle",
      projectId: "projects/demo",
      marked: false,
      deletedAt: null,
      purgeAt: null,
    },
    turns: [],
    activeTurnId: null,
    runtime: {
      cwd: "/projects/demo",
      historyMode: "legacy",
      model: "gpt-test",
      reasoningEffort: "medium",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      activePermissionProfile: { id: ":workspace", extends: null },
    },
  };
}

function managedOpen(opened: OpenedSession): ManagedSessionOpen {
  return {
    loadState: "ready",
    opened,
    activeTaskId: null,
    controlsActiveTask: false,
    replayEvents: [],
  };
}

function managedLoading(
  sessionId: string,
  loadState: "queued" | "starting",
  projectId = "projects/demo",
): ManagedSessionOpen {
  return {
    loadState,
    projectId,
    sessionId,
    activeTaskId: "task-loading",
    controlsActiveTask: true,
  };
}

function completedTurn(id: string): OpenedSession["turns"][number] {
  return {
    id,
    rootTurnId: null,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function request(type: string, requestId: string, fields: JsonObject = {}): string {
  return JSON.stringify({ type, requestId, ...fields });
}

function setup() {
  const workers = new FakeWorkers();
  const sessions = new FakeSessions();
  const services: BrowserConnectionServices = {
    projects: new FakeProjects(),
    sessions,
    turnTransport: new FakeTransport(),
    locks: new ProjectTaskLocks(),
    workers: workers as unknown as SessionWorkerManager,
  };
  return { workers, sessions, services };
}

async function openSession(
  connection: BrowserConnection,
  sessionId = "session-1",
): Promise<void> {
  connection.receiveText(request("session.resume", `open-${sessionId}`, {
    projectId: "projects/demo",
    sessionId,
  }));
  await connection.whenIdle();
}

test("passes the default-settings fallback notice back on session start", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("session.start", "start-1", { projectId: "projects/demo" }));
  await connection.whenIdle();
  assert.equal("settingsNotice" in data(socket.last("response")), false);

  workers.startSettingsNotice = localText("notice.defaultPermissionsUnavailable");
  connection.receiveText(request("session.start", "start-2", { projectId: "projects/demo" }));
  await connection.whenIdle();
  assert.deepEqual(data(socket.last("response")).settingsNotice, workers.startSettingsNotice);
});

function data(message: JsonObject | undefined): JsonObject {
  assert.ok(message, "缺少响应");
  assert.equal(message.ok, true, `请求失败：${JSON.stringify(message.error)}`);
  return message.data as JsonObject;
}

for (const snapshotReuse of [false, true]) {
  test(
    `opening a session returns the current pin instead of the ${
      snapshotReuse ? "cached" : "fresh"
    } worker snapshot`,
    async (context) => {
      const { workers, services, sessions } = setup();
      const snapshot = openedSession("session-pinned");
      workers.opens.set(
        "session-pinned",
        managedOpen(snapshotReuse ? snapshot : structuredClone(snapshot)),
      );
      const socket = new FakeSocket();
      const connection = new BrowserConnection("phone", socket, services);
      context.after(() => connection.disconnect());

      for (const marked of [true, false, true]) {
        // Cover snapshots in both directions, including switching again after one open.
        snapshot.session.marked = !marked;
        connection.receiveText(request("session.mark", "mark", {
          projectId: "projects/demo", sessionId: "session-pinned", marked,
        }));
        connection.receiveText(request("session.resume", "resume", {
          projectId: "projects/demo", sessionId: "session-pinned",
        }));
        await connection.whenIdle();
        const response = socket.messages.at(-1)!;
        assert.equal(response.requestId, "resume");
        assert.equal((data(response).session as JsonObject).marked, marked);
        assert.equal(snapshot.session.marked, !marked, "不能改写 Worker 的快照");
        assert.equal(sessions.isMarked("session-pinned"), marked);
      }
    },
  );
}

test("opens a loading session only for browsers that understand loading states", async (context) => {
  const { workers, services } = setup();
  workers.opens.set("session-loading", managedLoading("session-loading", "queued"));
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("session.resume", "old-browser", {
    projectId: "projects/demo",
    sessionId: "session-loading",
  }));
  await connection.whenIdle();
  const oldResponse = socket.last("response")!;
  assert.equal(oldResponse.ok, false);
  assert.equal((oldResponse.error as JsonObject).code, "worker_starting");
  assert.equal(workers.attached.has("phone"), false);

  connection.receiveText(request("session.resume", "new-browser", {
    projectId: "projects/demo",
    sessionId: "session-loading",
    acceptLoadingStates: true,
  }));
  await connection.whenIdle();
  assert.deepEqual(data(socket.last("response")), {
    loadState: "queued",
    sessionId: "session-loading",
    activeTaskId: "task-loading",
    controlsActiveTask: true,
  });
  assert.equal(workers.attached.get("phone"), "session-loading");

  connection.receiveText(request("task.stop", "stop-loading", {
    projectId: "projects/demo",
    sessionId: "session-loading",
  }));
  await connection.whenIdle();
  assert.equal(workers.calls.some((call) =>
    call.method === "stopTask" && call.args[0] === "session-loading"
  ), true);
});

test("refuses a ready or pending session whose canonical project differs from the request", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection, "session-current");

  const foreign = openedSession("session-foreign");
  foreign.session.projectId = "projects/foreign";
  workers.opens.set("session-foreign", managedOpen(foreign));
  workers.opens.set(
    "session-pending-foreign",
    managedLoading("session-pending-foreign", "queued", "projects/foreign"),
  );

  for (const sessionId of ["session-foreign", "session-pending-foreign"]) {
    connection.receiveText(request("session.resume", `open-${sessionId}`, {
      projectId: "projects/demo",
      sessionId,
      acceptLoadingStates: true,
    }));
    await connection.whenIdle();
    const response = socket.last("response")!;
    assert.equal(response.ok, false);
    assert.equal((response.error as JsonObject).code, "session_project_mismatch");
    assert.equal(workers.attached.get("phone"), "session-current");
  }
});

test("holds events raised while opening until the page has been told about the session", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  await openSession(connection, "session-1");
  workers.beforeAttachmentSync = async () => {
    // The connection already points to session-2, but the “会话已打开” response has not been sent.
    // These two events would reach the page first and then be cleared by initial rendering.
    workers.emit(
      { type: "message.delta", sessionId: "session-2", delta: "半" },
      "session",
      "session-2",
    );
    workers.emit(
      { type: "message.delta", sessionId: "session-1", delta: "旧" },
      "session",
      "session-1",
    );
  };
  await openSession(connection, "session-2");

  const opened = socket.messages.findIndex((message) =>
    message.type === "response" && message.requestId === "open-session-2"
  );
  const delta = socket.messages.findIndex((message) =>
    message.type === "event" && (message.event as JsonObject).delta === "半"
  );
  assert.ok(opened >= 0, "缺少打开会话的响应");
  assert.ok(delta > opened, "新会话的增量必须排在响应之后");

  // Re-filter against the current session when replaying; the session just left must not render on the page.
  assert.deepEqual(socket.events("message.delta").map((event) => event.delta), ["半"]);
});

for (const action of ["archive", "trash", "delete"] as const) {
  test(`a session removed by another device (${action}) while its attachments sync is not reported open`, async (context) => {
    const { workers, sessions, services } = setup();
    const socket = new FakeSocket();
    const connection = new BrowserConnection("phone", socket, services);
    context.after(() => connection.disconnect());
    await openSession(connection, "session-1");

    workers.beforeAttachmentSync = async () => {
      // The connection is attached to session-2 while its response awaits attachment sync; another device moves it now.
      assert.equal(workers.attached.get("phone"), "session-2");
      workers.emit(
        { type: "message.delta", sessionId: "session-2", delta: "迟到" },
        "session",
        "session-2",
      );
      if (action === "archive") await sessions.archive("projects/demo", ["session-2"]);
      else if (action === "trash") await sessions.moveToTrash("projects/demo", ["session-2"]);
      else await sessions.deleteTrash("projects/demo", ["session-2"]);
    };
    await openSession(connection, "session-2");

    const changedIndex = socket.messages.findIndex((message) =>
      message.type === "event" && (message.event as JsonObject).type === "sessions.changed"
    );
    const responseIndex = socket.messages.findIndex((message) =>
      message.requestId === "open-session-2"
    );
    assert.ok(changedIndex >= 0 && responseIndex > changedIndex);
    assert.equal(socket.events("sessions.changed")[0]?.closedSessionId, "session-2");
    const response = socket.messages[responseIndex]!;
    assert.equal(response.ok, false, "后端已经 detach，不能再回“已打开”");
    assert.equal((response.error as JsonObject).code, "session_open_cancelled");
    assert.equal(workers.attached.has("phone"), false);
    assert.deepEqual(socket.events("message.delta"), [], "被移走会话的扣留事件不能补发");

    connection.receiveText(request("history.older", "older-after-removal", {
      projectId: "projects/demo",
      sessionId: "session-2",
    }));
    await connection.whenIdle();
    const older = socket.last("response")!;
    assert.equal(older.ok, false);
    assert.equal((older.error as JsonObject).code, "session_not_open");
  });
}

for (const loadState of ["ready", "queued"] as const) {
  test(`a ${loadState} resume whose target is archived before it returns never attaches`, async (context) => {
    const { workers, sessions, services } = setup();
    if (loadState === "queued") {
      workers.opens.set("session-2", managedLoading("session-2", "queued"));
    }
    const socket = new FakeSocket();
    const connection = new BrowserConnection("phone", socket, services);
    context.after(() => connection.disconnect());
    await openSession(connection, "session-1");

    workers.beforeResume = async () => {
      await sessions.archive("projects/demo", ["session-2"]);
    };
    connection.receiveText(request("session.resume", "open-session-2", {
      projectId: "projects/demo",
      sessionId: "session-2",
      acceptLoadingStates: true,
    }));
    await connection.whenIdle();

    const response = socket.last("response")!;
    assert.equal(response.ok, false);
    assert.equal((response.error as JsonObject).code, "session_open_cancelled");
    // Attachment never begins, so the previously open session remains unchanged.
    assert.equal(workers.attached.get("phone"), "session-1");
    assert.equal(socket.events("sessions.changed")[0]?.closedSessionId, null);
  });
}

test("changes to other sessions or non-removing changes do not cancel an open", async (context) => {
  const { workers, sessions, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  workers.beforeResume = async () => {
    await sessions.archive("projects/demo", ["session-other"]);
    await sessions.rename("projects/demo", "session-2", "新标题");
  };
  workers.beforeAttachmentSync = async () => {
    await sessions.moveToTrash("projects/demo", ["session-other"]);
    await sessions.setMarked("projects/demo", "session-2", true);
  };
  await openSession(connection, "session-2");

  const response = data(socket.last("response"));
  assert.equal((response.session as JsonObject).id, "session-2");
  assert.equal(workers.attached.get("phone"), "session-2");
});

test("forwards worker events for the open session and hides other sessions", async (context) => {
  const { workers, services } = setup();
  const phoneSocket = new FakeSocket();
  const computerSocket = new FakeSocket();
  const phone = new BrowserConnection("phone", phoneSocket, services);
  const computer = new BrowserConnection("computer", computerSocket, services);
  context.after(async () => {
    await phone.disconnect();
    await computer.disconnect();
  });

  await openSession(phone, "session-1");
  await openSession(computer, "session-2");

  workers.emit({ type: "message.delta", sessionId: "session-1", delta: "你" }, "session", "session-1");
  // Pending requests and their terminal states go to every logged-in device, even those viewing another session.
  workers.emit({
    type: "approval.requested",
    sessionId: "session-1",
    sourceSession: { id: "session-1", title: "第一条会话" },
    approval: { id: "a-1" },
  }, "all", "session-1");
  workers.emit({
    type: "interaction.requested",
    sessionId: "session-1",
    sourceSession: { id: "session-1", title: "第一条会话" },
    interaction: { id: "i-1" },
  }, "all", "session-1");
  workers.emit({
    type: "approval.resolved",
    sessionId: "session-1",
    approvalId: "a-1",
  }, "all", "session-1");

  assert.deepEqual(phoneSocket.events("message.delta").map((event) => event.delta), ["你"]);
  assert.deepEqual(computerSocket.events("message.delta"), []);
  assert.equal(phoneSocket.events("approval.requested").length, 1);
  assert.equal(computerSocket.events("approval.requested").length, 1);
  assert.equal(phoneSocket.events("interaction.requested").length, 1);
  assert.equal(computerSocket.events("interaction.requested").length, 1);
  assert.equal(phoneSocket.events("approval.resolved").length, 1);
  assert.equal(computerSocket.events("approval.resolved").length, 1);
  assert.deepEqual(computerSocket.events("approval.requested")[0]?.sourceSession, {
    id: "session-1",
    title: "第一条会话",
  });
  // Events carry manager-assigned sequence numbers so the frontend can deduplicate after reconnecting.
  assert.equal(phoneSocket.events("message.delta")[0]?.sequence, 1);
});

test("sends only the latest 20 turns and loads older history in pages", async (context) => {
  const { workers, services } = setup();
  const opened = openedSession("session-long");
  opened.turns = Array.from({ length: 45 }, (_, index) => completedTurn(`turn-${index + 1}`));
  workers.opens.set("session-long", managedOpen(opened));
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  await openSession(connection, "session-long");
  const first = data(socket.last("response"));
  assert.equal((first.tasks as unknown[]).length, 20);
  assert.equal((first.tasks as JsonObject[])[0]?.id, "turn-26");
  assert.equal(first.hasOlder, true);

  connection.receiveText(request("history.older", "older-1", {
    projectId: "projects/demo",
    sessionId: "session-long",
  }));
  await connection.whenIdle();
  const second = data(socket.last("response"));
  assert.equal((second.tasks as unknown[]).length, 20);
  assert.equal((second.tasks as JsonObject[])[0]?.id, "turn-6");
  assert.equal(second.hasOlder, true);

  connection.receiveText(request("history.older", "older-2", {
    projectId: "projects/demo",
    sessionId: "session-long",
  }));
  await connection.whenIdle();
  const third = data(socket.last("response"));
  assert.equal((third.tasks as unknown[]).length, 5);
  assert.equal((third.tasks as JsonObject[])[0]?.id, "turn-1");
  assert.equal(third.hasOlder, false, "翻到头之后不能再显示“加载更早”");
});

test("a rewind command forwards its fixed target and returns only the receipt", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection);

  workers.commandResult = {
    kind: "rewind",
    title: "已回退一轮",
    outcome: "reverted",
    targetTurnId: "turn-last",
    lines: [],
  };
  connection.receiveText(request("command.run", "rewind-1", {
    projectId: "projects/demo", sessionId: "session-1",
    command: "rewind", option: null, argument: null, targetTurnId: "turn-last",
  }));
  await connection.whenIdle();

  const result = data(socket.last("response"));
  assert.equal(result.kind, "rewind");
  assert.equal(result.outcome, "reverted");
  assert.equal(result.targetTurnId, "turn-last");
  assert.equal(result.tasks, undefined);
  assert.deepEqual(
    workers.calls.find((call) => call.method === "runCommand")?.args.slice(3),
    ["rewind", null, null, "turn-last"],
  );
});

test("archiving the open session closes it and tells every device", async (context) => {
  const { workers, services } = setup();
  const phoneSocket = new FakeSocket();
  const computerSocket = new FakeSocket();
  const phone = new BrowserConnection("phone", phoneSocket, services);
  const computer = new BrowserConnection("computer", computerSocket, services);
  context.after(async () => {
    await phone.disconnect();
    await computer.disconnect();
  });
  await openSession(phone, "session-1");

  phone.receiveText(request("sessions.mutate", "archive-1", {
    projectId: "projects/demo", sessionIds: ["session-1"], action: "archive",
  }));
  await phone.whenIdle();

  const changed = phoneSocket.events("sessions.changed").at(-1);
  assert.equal(changed?.change, "archive");
  assert.equal(changed?.closedSessionId, "session-1");
  // Another device receives the notice too, but it has not opened this session and must not hear “当前会话已关闭”.
  assert.equal(computerSocket.events("sessions.changed").at(-1)?.closedSessionId, null);
  assert.equal(workers.attached.has("phone"), false, "会话关掉后必须 detach");

  phone.receiveText(request("history.older", "older-after-archive", {
    projectId: "projects/demo",
    sessionId: "session-1",
  }));
  await phone.whenIdle();
  assert.equal(phoneSocket.last("response")?.ok, false);
});

test("a successful mutation response cannot carry a private failure path", async (context) => {
  context.mock.method(console, "error", () => {});
  const { sessions, services } = setup();
  sessions.archiveFailure = "archive failed at /home/example-user/My Projects/秘密.md";
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("sessions.mutate", "archive-private", {
    projectId: "projects/demo",
    sessionIds: ["session-1"],
    action: "archive",
  }));
  await connection.whenIdle();

  const result = data(socket.last("response"));
  assert.deepEqual(result, {
    succeeded: [],
    failed: [{
      sessionId: "session-1",
      message: "Organizing the session failed; check the service log.",
      text: { key: "error.sessionMutationFailed" },
    }],
  });
  assert.equal(JSON.stringify(result).includes("/home/example-user"), false);
});

test("refuses session housekeeping while the project has a task", async (context) => {
  const { workers, services } = setup();
  workers.busyProjects.add("projects/demo");
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("sessions.mutate", "archive-1", {
    projectId: "projects/demo", sessionIds: ["session-1"], action: "archive",
  }));
  await connection.whenIdle();
  const response = socket.last("response")!;
  assert.equal(response.ok, false);
  assert.equal((response.error as JsonObject).code, "project_busy");
});

test("switching projects detaches the session and marks running ones as active", async (context) => {
  const { workers, sessions, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection);
  assert.equal(workers.attached.get("phone"), "session-1");

  sessions.sessions = [{ ...openedSession("session-9").session, state: "idle" }];
  workers.runningSessions.add("session-9");
  connection.receiveText(request("sessions.list", "list-1", {
    projectId: "projects/other", cursor: null, view: "active", searchTerm: null,
  }));
  await connection.whenIdle();

  const page = data(socket.last("response"));
  assert.equal((page.sessions as JsonObject[])[0]?.state, "active");
  assert.equal(workers.attached.has("phone"), false, "切换项目就是释放旧会话的边界");
});

test("routes task requests to the worker manager", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection);

  connection.receiveText(request("message.send", "send-1", {
    projectId: "projects/demo", sessionId: "session-1",
    text: "检查项目", clientMessageId: "client-1", attachmentIds: [],
  }));
  connection.receiveText(request("task.stop", "stop-1", {
    projectId: "projects/demo", sessionId: "session-1",
  }));
  connection.receiveText(request("approval.answer", "approve-1", {
    approvalId: "a-1", decision: "approve_once",
  }));
  connection.receiveText(request("interaction.answer", "answer-1", {
    interactionId: "i-1", action: "submit", answers: { q1: ["是"] },
  }));
  await connection.whenIdle();

  const byMethod = (method: string) => workers.calls.find((call) => call.method === method)?.args;
  assert.deepEqual(byMethod("enqueueMessageWithAttachments"), [
    "projects/demo",
    "session-1",
    "client-1",
    "检查项目",
    [],
  ]);
  assert.deepEqual(byMethod("stopTask"), ["session-1"]);
  assert.deepEqual(byMethod("answerApproval"), ["a-1", "approve_once"]);
  assert.deepEqual(byMethod("answerInteraction"), ["i-1", "submit", { q1: ["是"] }]);
  assert.equal(socket.messages.filter((message) => message.ok === false).length, 0);
});

test("keeps every current-session request bound to its explicit target", async (context) => {
  const { workers, services } = setup();
  const opened = openedSession("session-2");
  opened.turns = Array.from({ length: 45 }, (_, index) => completedTurn(`turn-${index + 1}`));
  workers.opens.set("session-2", managedOpen(opened));
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  await openSession(connection, "session-1");
  await openSession(connection, "session-2");
  workers.calls.length = 0;

  const staleRequests: Array<{ type: string; fields?: JsonObject }> = [
    { type: "session.metrics" },
    { type: "history.older" },
    { type: "command.options", fields: { command: "model" } },
    {
      type: "command.run",
      fields: { command: "compact", option: null, argument: null, targetTurnId: null },
    },
    {
      type: "attachment.ticket.create",
      fields: { originalName: "note.txt", declaredMime: "text/plain", expectedSize: 1 },
    },
    {
      type: "message.send",
      fields: { text: "不能改投", clientMessageId: "stale-message", attachmentIds: [] },
    },
    { type: "task.stop" },
  ];
  for (const [index, stale] of staleRequests.entries()) {
    connection.receiveText(request(stale.type, `stale-${index}`, {
      projectId: "projects/demo",
      sessionId: "session-1",
      ...stale.fields,
    }));
  }
  await connection.whenIdle();

  for (const [index] of staleRequests.entries()) {
    const response = socket.messages.find((message) => message.requestId === `stale-${index}`);
    assert.equal(response?.ok, false);
    assert.equal((response?.error as JsonObject).code, "session_target_mismatch");
  }
  assert.deepEqual(workers.calls, [], "错目标请求不能到达 Worker 或附件服务");

  // A history request for the wrong target does not advance session-2's cursor.
  connection.receiveText(request("history.older", "current-history", {
    projectId: "projects/demo",
    sessionId: "session-2",
  }));
  await connection.whenIdle();
  const history = data(socket.messages.find((message) => message.requestId === "current-history"));
  assert.equal((history.tasks as JsonObject[])[0]?.id, "turn-6");
});

test("an outbox message cannot move to a session opened between retries", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection, "session-1");
  workers.calls.length = 0;

  connection.receiveText(request("message.send", "retry-1", {
    projectId: "projects/demo",
    sessionId: "session-1",
    text: "第一条",
    clientMessageId: "outbox-1",
    attachmentIds: [],
  }));
  connection.receiveText(request("session.resume", "open-session-2", {
    projectId: "projects/demo",
    sessionId: "session-2",
  }));
  connection.receiveText(request("message.send", "retry-2", {
    projectId: "projects/demo",
    sessionId: "session-1",
    text: "第二条",
    clientMessageId: "outbox-2",
    attachmentIds: [],
  }));
  await connection.whenIdle();

  assert.equal(socket.messages.find((message) => message.requestId === "retry-1")?.ok, true);
  assert.equal(socket.messages.find((message) => message.requestId === "open-session-2")?.ok, true);
  const refused = socket.messages.find((message) => message.requestId === "retry-2");
  assert.equal(refused?.ok, false);
  assert.equal((refused?.error as JsonObject).code, "session_target_mismatch");
  assert.deepEqual(
    workers.calls.filter((call) => call.method === "enqueueMessageWithAttachments")
      .map((call) => call.args.slice(0, 4)),
    [["projects/demo", "session-1", "outbox-1", "第一条"]],
  );
});

test("task requests without an open session are refused", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("message.send", "send-1", {
    projectId: "projects/demo", sessionId: "session-1",
    text: "你好", clientMessageId: "client-1", attachmentIds: [],
  }));
  await connection.whenIdle();
  const response = socket.last("response")!;
  assert.equal(response.ok, false);
  assert.equal((response.error as JsonObject).code, "session_not_open");
  assert.equal(workers.calls.length, 0);
});

test("disconnecting releases the session and stops delivering events", async () => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  await openSession(connection);
  assert.equal(workers.authenticatedClients.has("phone"), true);

  await connection.disconnect();
  assert.equal(workers.authenticatedClients.has("phone"), false);
  assert.equal(workers.attached.has("phone"), false);

  const before = socket.messages.length;
  workers.emit({ type: "message.delta", sessionId: "session-1", delta: "迟到" }, "session", "session-1");
  assert.equal(socket.messages.length, before, "断开之后不能再往这个连接写东西");
});

test("disconnecting does not wait for an in-flight request or let it reattach later", async () => {
  const { workers, services } = setup();
  let reportResumeStarted!: () => void;
  let releaseResume!: () => void;
  const resumeStarted = new Promise<void>((resolve) => {
    reportResumeStarted = resolve;
  });
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  workers.beforeResume = async () => {
    reportResumeStarted();
    await resumeGate;
  };

  const connection = new BrowserConnection("phone", new FakeSocket(), services);
  connection.receiveText(request("session.resume", "resume-slow", {
    projectId: "projects/demo",
    sessionId: "session-slow",
  }));
  await resumeStarted;

  await connection.disconnect();
  assert.equal(workers.authenticatedClients.has("phone"), false);
  assert.equal(workers.attached.has("phone"), false);

  releaseResume();
  await connection.whenIdle();
  assert.equal(workers.attached.has("phone"), false, "迟到的恢复结果不能挂回死连接");
});

test("reads and updates backend settings without pushing into other browsers", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-connection-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await ApplicationSettingsStore.open(path.join(directory, "settings.json"));
  const { services } = setup();
  services.settings = settings;

  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const first = new BrowserConnection("phone", firstSocket, services);
  const second = new BrowserConnection("computer", secondSocket, services);
  context.after(async () => {
    await first.disconnect();
    await second.disconnect();
  });

  first.receiveText(request("settings.get", "get-1"));
  await first.whenIdle();
  assert.deepEqual(data(firstSocket.last("response")), {
    developerInstructions: "",
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissions: null,
  });

  first.receiveText(request("settings.update", "update-1", {
    developerInstructions: "额外说明",
  }));
  await first.whenIdle();
  assert.equal(data(firstSocket.last("response")).developerInstructions, "额外说明");
  assert.deepEqual(secondSocket.events("settings.updated"), []);

  first.receiveText(request("settings.update", "update-2", {
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
    defaultPermissions: ":danger-full-access",
  }));
  await first.whenIdle();
  assert.deepEqual(data(firstSocket.last("response")), {
    developerInstructions: "额外说明",
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
    defaultPermissions: ":danger-full-access",
  });

  second.receiveText(request("settings.get", "get-2"));
  await second.whenIdle();
  assert.deepEqual(data(secondSocket.last("response")), {
    developerInstructions: "额外说明",
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
    defaultPermissions: ":danger-full-access",
  });

  second.receiveText(request("settings.models", "models-1"));
  await second.whenIdle();
  assert.deepEqual(data(secondSocket.last("response")), [{
    id: "gpt-test",
    displayName: "GPT Test",
    description: "测试模型",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "平衡" },
      { reasoningEffort: "high", description: "深入" },
    ],
  }]);
  second.receiveText(request("settings.permissions", "permissions-1"));
  await second.whenIdle();
  assert.deepEqual(data(secondSocket.last("response")), [
    {
      id: ":workspace",
      description: { key: "permission.autoHint" },
      allowed: true,
      label: { key: "permission.auto" },
      fullAccess: false,
    },
    {
      id: ":danger-full-access",
      description: { key: "permission.fullAccessHint" },
      allowed: true,
      label: { key: "permission.fullAccess" },
      fullAccess: true,
    },
  ]);
  assert.deepEqual((services.turnTransport as FakeTransport).requests, [
    {
      method: "model/list",
      params: { cursor: null, limit: 100, includeHidden: false },
    },
    {
      method: "permissionProfile/list",
      params: { cursor: null, limit: 100 },
    },
  ]);
});

test("rejects settings requests when the backend has no settings store", async (context) => {
  const { services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("settings.get", "get-1"));
  await connection.whenIdle();
  const response = socket.last("response")!;
  assert.equal(response.ok, false);
  assert.equal((response.error as JsonObject).code, "settings_unavailable");
});

test("a slow model catalog does not block saving other settings", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-connection-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await ApplicationSettingsStore.open(path.join(directory, "settings.json"));
  const { services } = setup();
  services.settings = settings;
  const transport = services.turnTransport as FakeTransport;
  let releaseModels!: () => void;
  let reportModelsStarted!: () => void;
  const modelsStarted = new Promise<void>((resolve) => {
    reportModelsStarted = resolve;
  });
  const modelsGate = new Promise<void>((resolve) => {
    releaseModels = resolve;
  });
  transport.beforeModels = async () => {
    reportModelsStarted();
    await modelsGate;
  };
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("settings.models", "models-slow"));
  await modelsStarted;
  connection.receiveText(request("settings.update", "update-fast", {
    developerInstructions: "不等模型列表",
  }));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.messages.some((message) => message.requestId === "update-fast")) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const updateResponse = socket.messages.find((message) => message.requestId === "update-fast");
  const modelsFinishedBeforeSave = socket.messages.some(
    (message) => message.requestId === "models-slow",
  );
  releaseModels();
  await connection.whenIdle();
  assert.equal(updateResponse?.ok, true);
  assert.equal(modelsFinishedBeforeSave, false);
  assert.equal(socket.messages.find((message) => message.requestId === "models-slow")?.ok, true);
});

test("only explicit business errors keep their message at the request boundary", (context) => {
  context.mock.method(console, "error", () => {});
  const systemError = Object.assign(new Error("ENOENT: /home/someone/projects/demo"), {
    code: "ENOENT",
    syscall: "open",
  });
  const requestFailed = {
    message: "The request failed; check the service log.",
    text: { key: "error.requestFailedSeeLog" },
  };
  assert.deepEqual(publicError(systemError), {
    message: "The server can't access local files; check the service log.",
    text: { key: "error.localFilesUnavailable" },
  });
  assert.deepEqual(publicError(new Error("无法读取 /home/someone/My Projects/中文/秘密.md")), requestFailed);
  assert.deepEqual(publicError(new BrowserRequestError("known", localText("error.projectTaskRunning"))), {
    message: "A task is running in this project, so sessions can't be organized right now.",
    text: { key: "error.projectTaskRunning" },
  });
  assert.deepEqual(
    publicError(new BrowserRequestError(
      "unsafe",
      localText("error.attachmentUnreadable", { name: "/home/private/project/file.ts" }),
    )),
    requestFailed,
  );
  assert.deepEqual(publicError("字符串不是错误"), requestFailed);
});
