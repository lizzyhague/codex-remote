import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import { ApprovalBroker, type ApprovalTransport } from "../approvals/broker.ts";
import type { RequestId } from "../generated/RequestId.ts";
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

class FakeSocket implements BrowserSocket {
  readonly messages: JsonObject[] = [];
  closeCall: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.messages.push(JSON.parse(data) as JsonObject);
  }

  close(code?: number, reason?: string): void {
    this.closeCall = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}

class FakeAppServer implements AppServerTransport, ApprovalTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  readonly #notificationListeners = new Set<AppServerMessageListener>();
  readonly #serverRequestListeners = new Set<AppServerMessageListener>();
  nextTask = 1;
  rollbackTurns: OpenedSession["turns"] = [];

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    const values = params as {
      threadId?: string;
      turnId?: string;
      input?: Array<{ type?: string; text?: string }>;
    };
    if (method === "turn/start") {
      const taskId = `task-${this.nextTask++}`;
      this.notify({
        method: "turn/started",
        params: {
          threadId: values.threadId,
          turn: { id: taskId },
        },
      });
      this.notify({
        method: "item/started",
        params: {
          threadId: values.threadId,
          turnId: taskId,
          item: {
            type: "userMessage",
            id: `user-${taskId}`,
            content: values.input ?? [],
          },
        },
      });
      return { turn: { id: taskId } } as Result;
    }
    if (method === "turn/interrupt") {
      this.notify({
        method: "turn/completed",
        params: {
          threadId: values.threadId,
          turn: { id: values.turnId, status: "interrupted", error: null },
        },
      });
      return {} as Result;
    }
    if (method === "thread/rollback") {
      return { thread: { id: values.threadId, turns: this.rollbackTurns } } as Result;
    }
    if (method === "thread/compact/start") {
      // 真实响应里没有 turn ID，而且这里刻意不发 turn/started 通知。
      return {} as Result;
    }
    if (method === "permissionProfile/list") {
      return {
        data: [
          { id: ":workspace", description: "", allowed: true },
          { id: ":full-access", description: "", allowed: true },
        ],
      } as Result;
    }
    if (method === "thread/settings/update") {
      return {} as Result;
    }
    throw new Error(`测试未实现请求：${method}`);
  }

  onNotification(listener: AppServerMessageListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: AppServerMessageListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  respondToServerRequest(id: RequestId, result: unknown): void {
    this.responses.push({ id, result });
  }

  notify(message: JsonObject): void {
    for (const listener of this.#notificationListeners) {
      listener(message);
    }
  }

  serverRequest(message: JsonObject): void {
    for (const listener of this.#serverRequestListeners) {
      listener(message);
    }
  }
}

class FakeProjects implements ProjectsApi {
  async list() {
    return [{ id: "projects/demo", name: "demo", rootId: "projects" }];
  }
}

class FakeSessions implements SessionsApi {
  #nextSession = 1;
  readonly #listeners = new Set<(event: SessionChangeEvent) => void>();

  onChange(listener: (event: SessionChangeEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: SessionChangeEvent) {
    for (const listener of this.#listeners) listener(event);
  }

  async list(_projectId: string): Promise<SessionPage> {
    return { sessions: [], nextCursor: null };
  }

  async start(_projectId: string): Promise<OpenedSession> {
    return openedSession(`session-${this.#nextSession++}`);
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
      state: "idle",
      deletedAt: null,
      purgeAt: null,
    },
    turns: [],
    activeTurnId: null,
    runtime: {
      cwd: "/projects/demo",
      model: "gpt-test",
      reasoningEffort: "medium",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      activePermissionProfile: { id: ":workspace", extends: null },
    },
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
  const appServer = new FakeAppServer();
  const approvals = new ApprovalBroker(appServer);
  const services: BrowserConnectionServices = {
    projects: new FakeProjects(),
    sessions: new FakeSessions(),
    turnTransport: appServer,
    approvals,
    locks: new ProjectTaskLocks(),
  };
  return { appServer, approvals, services };
}

async function authenticate(connection: BrowserConnection): Promise<void> {
  connection.receiveText(request("auth", "auth-1", { token: "test-secret" }));
  await connection.whenIdle();
}

async function openSession(connection: BrowserConnection): Promise<void> {
  connection.receiveText(request("session.start", "open-1", {
    projectId: "projects/demo",
  }));
  await connection.whenIdle();
}

test("authenticates and translates a full streaming task", async () => {
  const { appServer, approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  await openSession(connection);

  connection.receiveText(request("message.send", "send-1", { text: "检查项目" }));
  await connection.whenIdle();
  appServer.notify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "session-1",
      turnId: "task-1",
      itemId: "message-1",
      delta: "完成",
    },
  });
  appServer.notify({
    method: "item/started",
    params: {
      threadId: "session-1",
      turnId: "task-1",
      item: {
        type: "webSearch",
        id: "search-1",
        query: "Codex App Server",
        action: { type: "search", query: "Codex App Server" },
        results: null,
      },
    },
  });
  appServer.notify({
    method: "item/completed",
    params: {
      threadId: "session-1",
      turnId: "task-1",
      item: {
        type: "webSearch",
        id: "search-1",
        query: "Codex App Server",
        action: { type: "search", query: "Codex App Server" },
        results: [{ title: "Docs", url: "https://developers.openai.com/codex/app-server" }],
      },
    },
  });
  appServer.notify({
    method: "turn/completed",
    params: {
      threadId: "session-1",
      turn: { id: "task-1", status: "completed", error: null },
    },
  });

  assert.deepEqual(socket.messages.map((message) =>
    message.type === "event" ? (message.event as JsonObject).type : message.type
  ), [
    "response",
    "response",
    "task.started",
    "message.user",
    "response",
    "message.delta",
    "tool.started",
    "tool.completed",
    "task.completed",
  ]);
  const completedTool = socket.messages
    .map((message) => message.type === "event" ? message.event as JsonObject : null)
    .find((event) => event?.type === "tool.completed");
  assert.equal((completedTool?.tool as JsonObject).kind, "search");
  assert.deepEqual((completedTool?.tool as JsonObject).resources, [{
    address: "https://developers.openai.com/codex/app-server",
    label: "Docs",
  }]);
  assert.equal(services.locks.acquire("projects/demo", "computer", "other"), true);
  approvals.dispose();
  await connection.disconnect();
});

test("syncs a user message to another device without granting task control", async () => {
  const { approvals, services } = setup();
  const phoneSocket = new FakeSocket();
  const computerSocket = new FakeSocket();
  const phone = new BrowserConnection("phone", phoneSocket, "test-secret", services);
  const computer = new BrowserConnection("computer", computerSocket, "test-secret", services);
  await authenticate(phone);
  await authenticate(computer);
  await openSession(phone);
  computer.receiveText(request("session.resume", "resume-1", {
    projectId: "projects/demo",
    sessionId: "session-1",
  }));
  await computer.whenIdle();

  phone.receiveText(request("message.send", "send-1", { text: "两边都显示" }));
  await phone.whenIdle();

  const phoneEvents = phoneSocket.messages
    .filter((message) => message.type === "event")
    .map((message) => message.event as JsonObject);
  const computerEvents = computerSocket.messages
    .filter((message) => message.type === "event")
    .map((message) => message.event as JsonObject);
  assert.equal(phoneEvents.find((event) => event.type === "task.started")?.controlsActiveTask, true);
  assert.equal(
    computerEvents.find((event) => event.type === "task.started")?.controlsActiveTask,
    false,
  );
  assert.equal(computerEvents.find((event) => event.type === "message.user")?.text, "两边都显示");

  await phone.disconnect();
  await computer.disconnect();
  approvals.dispose();
});

test("sends only the latest 20 turns and loads older history in pages", async () => {
  const { approvals, services } = setup();
  const turns: OpenedSession["turns"] = Array.from({ length: 45 }, (_, index) => ({
    id: `turn-${index}`,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  }));
  services.sessions.resume = async () => ({
    ...openedSession("session-long"),
    turns,
  });
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  connection.receiveText(request("session.resume", "resume-long", {
    projectId: "projects/demo",
    sessionId: "session-long",
  }));
  await connection.whenIdle();

  const opened = socket.messages.at(-1)?.data as JsonObject;
  assert.equal((opened.tasks as JsonObject[]).length, 20);
  assert.equal((opened.tasks as JsonObject[])[0]?.id, "turn-25");
  assert.equal(opened.hasOlder, true);

  connection.receiveText(request("history.older", "older-1"));
  await connection.whenIdle();
  const middle = socket.messages.at(-1)?.data as JsonObject;
  assert.equal((middle.tasks as JsonObject[]).length, 20);
  assert.equal((middle.tasks as JsonObject[])[0]?.id, "turn-5");
  assert.equal(middle.hasOlder, true);

  connection.receiveText(request("history.older", "older-2"));
  await connection.whenIdle();
  const oldest = socket.messages.at(-1)?.data as JsonObject;
  assert.equal((oldest.tasks as JsonObject[]).length, 5);
  assert.equal((oldest.tasks as JsonObject[])[0]?.id, "turn-0");
  assert.equal(oldest.hasOlder, false);

  await connection.disconnect();
  approvals.dispose();
});

test("rewinds one turn per request and replaces paginated history", async () => {
  const { appServer, approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  await openSession(connection);

  appServer.rollbackTurns = Array.from(
    { length: 21 },
    (_, index) => completedTurn(`rewind-${index}`),
  );
  connection.receiveText(request("command.run", "rewind-1", {
    command: "rewind",
    option: null,
    argument: null,
  }));
  await connection.whenIdle();

  const first = socket.messages.at(-1)?.data as JsonObject;
  assert.equal(first.kind, "rewind");
  assert.equal((first.tasks as JsonObject[]).length, 20);
  assert.equal((first.tasks as JsonObject[])[0]?.id, "rewind-1");
  assert.equal(first.hasOlder, true);

  connection.receiveText(request("history.older", "rewind-older"));
  await connection.whenIdle();
  const older = socket.messages.at(-1)?.data as JsonObject;
  assert.equal((older.tasks as JsonObject[]).length, 1);
  assert.equal((older.tasks as JsonObject[])[0]?.id, "rewind-0");

  appServer.rollbackTurns = appServer.rollbackTurns.slice(0, -1);
  connection.receiveText(request("command.run", "rewind-2", {
    command: "rewind",
    option: null,
    argument: null,
  }));
  await connection.whenIdle();

  const second = socket.messages.at(-1)?.data as JsonObject;
  assert.equal((second.tasks as JsonObject[]).length, 20);
  assert.equal((second.tasks as JsonObject[])[0]?.id, "rewind-0");
  assert.equal(second.hasOlder, false);
  const rollbackRequests = appServer.requests
    .filter((item) => item.method === "thread/rollback");
  assert.equal(rollbackRequests.length, 2);
  assert.equal(rollbackRequests.every((item) =>
    (item.params as JsonObject).numTurns === 1
  ), true);
  assert.equal(services.locks.acquire("projects/demo", "computer", "session-2"), true);
  services.locks.release("projects/demo", "computer");

  await connection.disconnect();
  approvals.dispose();
});

test("blocks rewind while a task is active", async () => {
  const { appServer, approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  await openSession(connection);

  connection.receiveText(request("message.send", "send-before-rewind", { text: "仍在执行" }));
  await connection.whenIdle();
  connection.receiveText(request("command.run", "rewind-busy", {
    command: "rewind",
    option: null,
    argument: null,
  }));
  await connection.whenIdle();

  const failure = socket.messages.at(-1);
  assert.equal(failure?.ok, false);
  assert.equal((failure?.error as JsonObject).code, "task_already_running");
  assert.equal(appServer.requests.some((item) => item.method === "thread/rollback"), false);

  await connection.disconnect();
  approvals.dispose();
});

test("blocks a second task in the same project", async () => {
  const { approvals, services } = setup();
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const first = new BrowserConnection("phone", firstSocket, "test-secret", services);
  const second = new BrowserConnection("computer", secondSocket, "test-secret", services);
  await authenticate(first);
  await authenticate(second);
  await openSession(first);
  await openSession(second);

  first.receiveText(request("message.send", "send-first", { text: "开始" }));
  await first.whenIdle();
  second.receiveText(request("message.send", "send-second", { text: "同时开始" }));
  await second.whenIdle();

  const failure = secondSocket.messages.at(-1);
  assert.equal(failure?.type, "response");
  assert.equal(failure?.ok, false);
  assert.equal((failure?.error as JsonObject).code, "project_busy");

  await first.disconnect();
  second.receiveText(request("message.send", "send-after", { text: "现在开始" }));
  await second.whenIdle();
  assert.equal(secondSocket.messages.at(-1)?.ok, true);
  await second.disconnect();
  approvals.dispose();
});

test("routes approval answers and cancels pending approval on disconnect", async () => {
  const { appServer, approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  await openSession(connection);
  connection.receiveText(request("message.send", "send-1", { text: "执行" }));
  await connection.whenIdle();

  appServer.serverRequest({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "session-1",
      turnId: "task-1",
      itemId: "command-1",
      startedAtMs: 1,
      command: "npm test",
      reason: "运行测试",
      environmentId: null,
    },
  });
  const approvalEvent = socket.messages.at(-1)?.event as JsonObject;
  const approval = approvalEvent.approval as JsonObject;
  assert.equal(approval.reason, "运行测试");
  assert.equal("command" in approval, false);
  connection.receiveText(request("approval.answer", "answer-1", {
    approvalId: approval.id,
    decision: "approve_once",
  }));
  await connection.whenIdle();
  assert.deepEqual(appServer.responses[0], {
    id: "approval-1",
    result: { decision: "accept" },
  });

  appServer.serverRequest({
    id: "approval-2",
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "session-1",
      turnId: "task-1",
      itemId: "change-1",
      startedAtMs: 2,
    },
  });
  await connection.disconnect();
  assert.deepEqual(appServer.responses[1], {
    id: "approval-2",
    result: { decision: "cancel" },
  });
  assert.equal(appServer.requests.at(-1)?.method, "turn/interrupt");
  approvals.dispose();
});

test("rejects an invalid token", async () => {
  const { approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("unknown", socket, "test-secret", services);
  connection.receiveText(request("auth", "auth-bad", { token: "wrong" }));
  await connection.whenIdle();

  assert.equal(socket.messages[0]?.ok, false);
  assert.equal((socket.messages[0]?.error as JsonObject).code, "invalid_token");
  assert.equal(socket.closeCall?.code, 1008);
  await connection.disconnect();
  approvals.dispose();
});

test("archives an idle open session and notifies every connected device", async () => {
  const { approvals, services } = setup();
  const firstSocket = new FakeSocket();
  const secondSocket = new FakeSocket();
  const first = new BrowserConnection("first", firstSocket, "test-secret", services);
  const second = new BrowserConnection("second", secondSocket, "test-secret", services);
  await authenticate(first);
  await authenticate(second);
  await openSession(first);
  second.receiveText(request("session.resume", "resume-2", {
    projectId: "projects/demo",
    sessionId: "session-1",
  }));
  await second.whenIdle();

  first.receiveText(request("sessions.mutate", "archive-1", {
    projectId: "projects/demo",
    sessionIds: ["session-1"],
    action: "archive",
  }));
  await first.whenIdle();

  const firstEvents = firstSocket.messages.filter((message) => message.type === "event");
  const secondEvents = secondSocket.messages.filter((message) => message.type === "event");
  assert.equal((firstEvents.at(-1)?.event as JsonObject).type, "sessions.changed");
  assert.equal((firstEvents.at(-1)?.event as JsonObject).closedSessionId, "session-1");
  assert.equal((secondEvents.at(-1)?.event as JsonObject).closedSessionId, "session-1");

  first.receiveText(request("message.send", "after-archive", { text: "不应发送" }));
  await first.whenIdle();
  const response = firstSocket.messages.at(-1);
  assert.equal(response?.type, "response");
  assert.equal(response?.ok, false);

  approvals.dispose();
  await first.disconnect();
  await second.disconnect();
});

test("releases the project lock when a command never becomes a task", async () => {
  const { approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services, {
    taskClaimTimeoutMs: 20,
  });
  await authenticate(connection);
  await openSession(connection);

  connection.receiveText(request("command.run", "compact-1", {
    command: "compact",
    option: null,
    argument: null,
  }));
  await connection.whenIdle();
  assert.equal(socket.messages.at(-1)?.ok, true);
  assert.equal(services.locks.owns("projects/demo", "phone"), true);

  await delay(60);

  assert.equal(services.locks.owns("projects/demo", "phone"), false);
  const events = socket.messages.filter((message) => message.type === "event");
  assert.equal((events.at(-1)?.event as JsonObject).type, "task.completed");

  connection.receiveText(request("message.send", "send-after", { text: "继续" }));
  await connection.whenIdle();
  assert.equal(socket.messages.at(-1)?.ok, true);

  await connection.disconnect();
  approvals.dispose();
});

test("refuses session settings changes from a device that is only watching", async () => {
  const { approvals, services } = setup();
  const controllerSocket = new FakeSocket();
  const watcherSocket = new FakeSocket();
  const controller = new BrowserConnection("phone", controllerSocket, "test-secret", services);
  const watcher = new BrowserConnection("computer", watcherSocket, "test-secret", services);
  await authenticate(controller);
  await authenticate(watcher);
  await openSession(controller);
  watcher.receiveText(request("session.resume", "resume-1", {
    projectId: "projects/demo",
    sessionId: "session-1",
  }));
  await watcher.whenIdle();

  controller.receiveText(request("message.send", "send-1", { text: "开始" }));
  await controller.whenIdle();

  watcher.receiveText(request("command.run", "permissions-1", {
    command: "permissions",
    option: ":full-access",
    argument: null,
  }));
  await watcher.whenIdle();

  const failure = watcherSocket.messages.at(-1);
  assert.equal(failure?.ok, false);
  assert.equal((failure?.error as JsonObject).code, "task_already_running");
  assert.equal(
    appServerReceived(services, "thread/settings/update"),
    false,
  );

  await controller.disconnect();
  await watcher.disconnect();
  approvals.dispose();
});

test("toggles Full access per thread and restores its default permissions", async () => {
  const { approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  await openSession(connection);

  const opened = socket.messages.at(-1)?.data as JsonObject;
  assert.equal(opened.fullAccessEnabled, false);

  connection.receiveText(request(
    "permissions.full-access.toggle",
    "full-access-on",
  ));
  await connection.whenIdle();
  assert.equal((socket.messages.at(-1)?.data as JsonObject).fullAccessEnabled, true);

  connection.receiveText(request(
    "permissions.full-access.toggle",
    "full-access-off",
  ));
  await connection.whenIdle();
  assert.equal((socket.messages.at(-1)?.data as JsonObject).fullAccessEnabled, false);

  const updates = (services.turnTransport as FakeAppServer).requests.filter((item) =>
    item.method === "thread/settings/update"
  );
  assert.deepEqual(updates, [
    {
      method: "thread/settings/update",
      params: { threadId: "session-1", permissions: ":full-access" },
    },
    {
      method: "thread/settings/update",
      params: { threadId: "session-1", permissions: null },
    },
  ]);

  await connection.disconnect();
  approvals.dispose();
});

test("releases the project lock when the open session goes away", async () => {
  const { approvals, services } = setup();
  const socket = new FakeSocket();
  const connection = new BrowserConnection("phone", socket, "test-secret", services);
  await authenticate(connection);
  await openSession(connection);
  connection.receiveText(request("command.run", "compact-1", {
    command: "compact",
    option: null,
    argument: null,
  }));
  await connection.whenIdle();
  assert.equal(services.locks.owns("projects/demo", "phone"), true);

  // 关掉这个会话之后就再也收不到它的 turn/completed 了，锁必须跟着放开。
  connection.receiveText(request("session.start", "open-2", {
    projectId: "projects/demo",
  }));
  await connection.whenIdle();
  assert.equal(socket.messages.at(-1)?.ok, true);
  assert.equal(services.locks.owns("projects/demo", "phone"), false);

  await connection.disconnect();
  approvals.dispose();
});

test("keeps host paths out of the errors sent to the browser", () => {
  const systemError = Object.assign(
    new Error("ENOENT: no such file or directory, scandir '/home/example/projects'"),
    { code: "ENOENT", syscall: "scandir" },
  );
  assert.equal(publicErrorMessage(systemError).includes("/home/example"), false);
  assert.equal(
    publicErrorMessage(new Error("无法读取 /home/example/.local/state/trash.json。")),
    "无法读取 <路径>。",
  );
  assert.equal(publicErrorMessage(new Error("这个会话不属于所选项目。")), "这个会话不属于所选项目。");
  assert.equal(publicErrorMessage("字符串"), "请求失败。");
});

function appServerReceived(
  services: BrowserConnectionServices,
  method: string,
): boolean {
  return (services.turnTransport as FakeAppServer).requests
    .some((entry) => entry.method === method);
}
