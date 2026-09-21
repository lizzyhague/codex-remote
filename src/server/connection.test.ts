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
  publicErrorMessage,
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

  /** 最近一条指定类型的消息，测试大多只关心这个。 */
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

/** 只用来读账号额度；会话和任务都不经过它。 */
class FakeTransport implements AppServerTransport {
  async request<Result>(): Promise<Result> {
    throw new Error("测试不应通过目录 App Server 发请求。");
  }

  onNotification(_listener: AppServerMessageListener): () => void {
    return () => {};
  }
}

/**
 * Worker 管理器替身。真管理器会启动 codex 子进程，这里只记录被调用了什么、
 * 返回事先准备好的结果，并允许测试主动推送事件。
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
  #sequence = 0;
  #nextSession = 1;

  onEvent(listener: (event: WorkerManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 模拟管理器广播一条事件。 */
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

  attachSession(clientId: string, threadId: string): void {
    this.attached.set(clientId, threadId);
  }

  detachSession(clientId: string): void {
    this.attached.delete(clientId);
  }

  async startSession(projectId: string): Promise<ManagedSessionOpen> {
    this.#record("startSession", projectId);
    return this.#open(`session-${this.#nextSession++}`);
  }

  async resumeSession(projectId: string, sessionId: string): Promise<ManagedSessionOpen> {
    this.#record("resumeSession", projectId, sessionId);
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
  ): Promise<Record<string, unknown>> {
    this.#record("runCommand", projectId, sessionId, clientMessageId, command, option, argument);
    return this.commandResult;
  }

  async toggleFullAccess(projectId: string, sessionId: string) {
    this.#record("toggleFullAccess", projectId, sessionId);
    return { kind: "message", title: "Full access 已打开", fullAccessEnabled: true };
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
    opened,
    activeTaskId: null,
    controlsActiveTask: false,
    fullAccessEnabled: false,
    replayEvents: [],
  };
}

function completedTurn(id: string): OpenedSession["turns"][number] {
  return {
    id,
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
        // 两个方向都要覆盖快照，包括在一次打开之后再次切换。
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
  // 审批要送到所有已登录设备，即使它们正在看别的会话。
  workers.emit({ type: "approval.requested", approval: { id: "a-1" } }, "all", "session-1");

  assert.deepEqual(phoneSocket.events("message.delta").map((event) => event.delta), ["你"]);
  assert.deepEqual(computerSocket.events("message.delta"), []);
  assert.equal(phoneSocket.events("approval.requested").length, 1);
  assert.equal(computerSocket.events("approval.requested").length, 1);
  // 事件带着管理器给的序号，断线重连后前端才能去重。
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

  connection.receiveText(request("history.older", "older-1"));
  await connection.whenIdle();
  const second = data(socket.last("response"));
  assert.equal((second.tasks as unknown[]).length, 20);
  assert.equal((second.tasks as JsonObject[])[0]?.id, "turn-6");
  assert.equal(second.hasOlder, true);

  connection.receiveText(request("history.older", "older-2"));
  await connection.whenIdle();
  const third = data(socket.last("response"));
  assert.equal((third.tasks as unknown[]).length, 5);
  assert.equal((third.tasks as JsonObject[])[0]?.id, "turn-1");
  assert.equal(third.hasOlder, false, "翻到头之后不能再显示“加载更早”");
});

test("a command that returns turns replaces the browser history in pages", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection);

  workers.commandResult = {
    kind: "rewind",
    title: "已回退一轮",
    turns: Array.from({ length: 25 }, (_, index) => completedTurn(`kept-${index + 1}`)),
  };
  connection.receiveText(request("command.run", "rewind-1", {
    command: "rewind", option: null, argument: null,
  }));
  await connection.whenIdle();

  const result = data(socket.last("response"));
  assert.equal(result.kind, "rewind");
  assert.equal(result.turns, undefined, "原始 turns 不应发给浏览器");
  assert.equal((result.tasks as unknown[]).length, 20);
  assert.equal((result.tasks as JsonObject[])[0]?.id, "kept-6");
  assert.equal(result.hasOlder, true);
  assert.deepEqual(
    workers.calls.find((call) => call.method === "runCommand")?.args.slice(3),
    ["rewind", null, null],
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
  // 别的设备也收到通知，但它没打开这个会话，所以不该被告知“当前会话已关闭”。
  assert.equal(computerSocket.events("sessions.changed").at(-1)?.closedSessionId, null);
  assert.equal(workers.attached.has("phone"), false, "会话关掉后必须 detach");

  phone.receiveText(request("history.older", "older-after-archive"));
  await phone.whenIdle();
  assert.equal(phoneSocket.last("response")?.ok, false);
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

test("refuses session settings changes while a task is running", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());
  await openSession(connection);

  workers.runningSessions.add("session-1");
  connection.receiveText(request("permissions.full-access.toggle", "toggle-1"));
  await connection.whenIdle();
  const blocked = socket.last("response")!;
  assert.equal(blocked.ok, false);
  assert.equal((blocked.error as JsonObject).code, "task_already_running");
  assert.equal(workers.calls.some((call) => call.method === "toggleFullAccess"), false);

  workers.runningSessions.delete("session-1");
  connection.receiveText(request("permissions.full-access.toggle", "toggle-2"));
  await connection.whenIdle();
  assert.equal(data(socket.last("response")).fullAccessEnabled, true);
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
    text: "检查项目", clientMessageId: "client-1", attachmentIds: [],
  }));
  connection.receiveText(request("task.stop", "stop-1"));
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

test("task requests without an open session are refused", async (context) => {
  const { workers, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, services);
  context.after(() => connection.disconnect());

  connection.receiveText(request("message.send", "send-1", {
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

test("reads and updates backend settings and notifies other browsers", async (context) => {
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
  assert.equal(data(firstSocket.last("response")).developerInstructions, "");

  first.receiveText(request("settings.update", "update-1", {
    developerInstructions: "额外说明",
  }));
  await first.whenIdle();
  assert.equal(data(firstSocket.last("response")).developerInstructions, "额外说明");
  assert.equal(
    secondSocket.events("settings.updated").at(-1)?.developerInstructions,
    "额外说明",
  );

  second.receiveText(request("settings.get", "get-2"));
  await second.whenIdle();
  assert.equal(data(secondSocket.last("response")).developerInstructions, "额外说明");
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

test("keeps host paths out of the errors sent to the browser", () => {
  const systemError = Object.assign(new Error("ENOENT: /home/someone/projects/demo"), {
    code: "ENOENT",
    syscall: "open",
  });
  assert.equal(publicErrorMessage(systemError), "服务器无法访问本地文件，请查看服务日志。");
  assert.equal(
    publicErrorMessage(new Error("无法读取 /home/someone/projects/demo/notes.md")),
    "无法读取 <路径>",
  );
  assert.equal(publicErrorMessage("字符串不是错误"), "请求失败。");
});
