import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";

import type { AppServerMessageListener } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import { ApprovalBroker, type ApprovalTransport } from "../approvals/broker.ts";
import type { RequestId } from "../generated/RequestId.ts";
import type { OpenedSession, SessionPage } from "../sessions/service.ts";
import type { BrowserConnectionServices } from "./connection.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { ProjectTaskLocks } from "./project-locks.ts";

class EmptyTransport implements AppServerTransport, ApprovalTransport {
  readonly #notifications = new Set<AppServerMessageListener>();
  readonly #requests = new Set<AppServerMessageListener>();

  async request<Result>(): Promise<Result> {
    throw new Error("此网络测试不应调用 App Server 请求。");
  }
  onNotification(listener: AppServerMessageListener): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }
  onServerRequest(listener: AppServerMessageListener): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }
  respondToServerRequest(_id: RequestId, _result: unknown): void {}
}

test("serves health and authenticated WebSocket only on loopback", async () => {
  const transport = new EmptyTransport();
  const approvals = new ApprovalBroker(transport);
  const services = emptyServices(transport, approvals);
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services,
    authTimeoutMs: 2_000,
  });
  const address = await server.listen(0);
  const webSocket = new WebSocket(`ws://${address.host}:${address.port}/ws`);
  const opened = once(webSocket, "open");

  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const page = await fetch(`http://${address.host}:${address.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Codex Remote/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);

    for (const asset of ["/boot.js", "/markdown.js", "/slash-menu.js"]) {
      const response = await fetch("http://" + address.host + ":" + address.port + asset);
      assert.equal(response.status, 200, asset + " should be served");
      assert.equal(
        response.headers.get("content-type"),
        "text/javascript; charset=utf-8",
      );
      assert.match(await response.text(), /\S/);
    }

    for (const asset of ["/icon-192.png", "/icon-512.png", "/icon-512-maskable.png"]) {
      const response = await fetch("http://" + address.host + ":" + address.port + asset);
      assert.equal(response.status, 200, asset + " should be served");
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(
        [...new Uint8Array(await response.arrayBuffer()).slice(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
    }

    const missing = await fetch(`http://${address.host}:${address.port}/not-a-file`);
    assert.equal(missing.status, 404);

    await withTimeout(opened, "打开 WebSocket");
    const authResponse = once(webSocket, "message");
    webSocket.send(JSON.stringify({
      type: "auth",
      requestId: "auth-1",
      token: "test-secret",
    }));
    const authMessage = await withTimeout(authResponse, "等待认证响应");
    const auth = JSON.parse(String(authMessage[0])) as {
      ok: boolean;
    };
    assert.equal(auth.ok, true);

    const projectsResponse = once(webSocket, "message");
    webSocket.send(JSON.stringify({
      type: "projects.list",
      requestId: "projects-1",
    }));
    const projectsMessage = await withTimeout(projectsResponse, "等待项目列表");
    const projects = JSON.parse(String(projectsMessage[0])) as {
      data: { projects: unknown[] };
    };
    assert.equal(projects.data.projects.length, 1);
    assert.deepEqual(address.host, "127.0.0.1");
  } finally {
    if (webSocket.readyState !== WebSocket.CLOSED) {
      const closed = once(webSocket, "close");
      webSocket.close();
      await withTimeout(closed, "关闭 WebSocket");
    }
    await withTimeout(server.close(), "关闭服务器");
    approvals.dispose();
  }
});

test("streams same-origin uploads through the local attachment adapter", async () => {
  const transport = new EmptyTransport();
  const approvals = new ApprovalBroker(transport);
  const received: Buffer[] = [];
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services: emptyServices(transport, approvals),
    uploads: {
      async upload(ticket, contentLength, source) {
        assert.equal(ticket, "ticket-secret");
        for await (const chunk of source) received.push(Buffer.from(chunk));
        assert.equal(contentLength, 5);
        return {
          id: "attachment-1",
          caller: "codex",
          projectId: "project-1",
          sessionId: "thread-1",
          originalName: "note.txt",
          declaredMime: "text/plain",
          detectedMime: "text/plain",
          kind: "file",
          size: 5,
          sha256: "a".repeat(64),
          createdAtMs: 1,
          expiresAtMs: 2,
        };
      },
    },
  });
  const address = await server.listen(0);
  const origin = `http://${address.host}:${address.port}`;
  try {
    const uploaded = await fetch(`${origin}/attachments/upload`, {
      method: "POST",
      headers: { origin, "x-upload-ticket": "ticket-secret" },
      body: Buffer.from("hello"),
    });
    assert.equal(uploaded.status, 201);
    const body = await uploaded.json() as { attachment: Record<string, unknown> };
    assert.equal(body.attachment.id, "attachment-1");
    assert.equal("path" in body.attachment, false);
    assert.equal(Buffer.concat(received).toString("utf8"), "hello");

    const crossOrigin = await fetch(`${origin}/attachments/upload`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "x-upload-ticket": "ticket-secret",
      },
      body: Buffer.from("hello"),
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await server.close();
    approvals.dispose();
  }
});

test("releases writers only after the last thread-using browser disconnects", async () => {
  const transport = new EmptyTransport();
  const approvals = new ApprovalBroker(transport);
  const services = emptyServices(transport, approvals);
  let nextSession = 1;
  services.sessions.start = async () => openedSession(`session-${nextSession++}`);

  let idleCalls = 0;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services,
    authTimeoutMs: 2_000,
    onWritersIdle: async () => {
      idleCalls += 1;
      resolveIdle();
    },
  });
  const address = await server.listen(0);
  const url = `ws://${address.host}:${address.port}/ws`;
  const first = new WebSocket(url);
  const second = new WebSocket(url);

  try {
    await Promise.all([
      withTimeout(once(first, "open"), "打开第一个 WebSocket"),
      withTimeout(once(second, "open"), "打开第二个 WebSocket"),
    ]);
    for (const [index, socket] of [first, second].entries()) {
      await sendRequest(socket, {
        type: "auth",
        requestId: `auth-${index}`,
        token: "test-secret",
      });
      await sendRequest(socket, {
        type: "session.start",
        requestId: `open-${index}`,
        projectId: "projects/demo",
      });
    }

    const firstClosed = once(first, "close");
    first.close();
    await withTimeout(firstClosed, "关闭第一个 WebSocket");
    await delay(20);
    assert.equal(idleCalls, 0);

    const secondClosed = once(second, "close");
    second.close();
    await withTimeout(secondClosed, "关闭第二个 WebSocket");
    await withTimeout(idle, "等待 writer 释放");
    assert.equal(idleCalls, 1);
  } finally {
    first.terminate();
    second.terminate();
    await withTimeout(server.close(), "关闭服务器");
    approvals.dispose();
  }
});

function emptyServices(
  transport: EmptyTransport,
  approvals: ApprovalBroker,
): BrowserConnectionServices {
  return {
    projects: {
      async list() {
        return [{ id: "projects/demo", name: "demo", rootId: "projects" }];
      },
    },
    sessions: {
      async list(): Promise<SessionPage> {
        return { sessions: [], marked: [], nextCursor: null };
      },
      async start(): Promise<OpenedSession> {
        throw new Error("未使用");
      },
      async resume(): Promise<OpenedSession> {
        throw new Error("未使用");
      },
      async archive(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async unarchive(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async moveToTrash(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async restoreTrash(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async deleteTrash(_projectId: string, sessionIds: string[]) {
        return { succeeded: sessionIds, failed: [] };
      },
      async setMarked(projectId: string, sessionId: string, marked: boolean) {
        return {
          id: sessionId,
          sessionId,
          title: "测试会话",
          preview: "",
          createdAt: 1,
          updatedAt: 1,
          state: "idle" as const,
          projectId,
          marked,
          deletedAt: null,
          purgeAt: null,
        };
      },
    },
    turnTransport: transport,
    approvals,
    locks: new ProjectTaskLocks(),
  };
}

function openedSession(id: string): OpenedSession {
  return {
    session: {
      id,
      sessionId: id,
      title: "测试会话",
      preview: "",
      createdAt: 1,
      updatedAt: 1,
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

async function sendRequest(socket: WebSocket, message: object): Promise<unknown> {
  const response = once(socket, "message");
  socket.send(JSON.stringify(message));
  const received = await withTimeout(response, "等待 WebSocket 响应");
  return JSON.parse(String(received[0]));
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时。`)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("only accepts WebSocket upgrades from its own page", async () => {
  const transport = new EmptyTransport();
  const approvals = new ApprovalBroker(transport);
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services: emptyServices(transport, approvals),
    authTimeoutMs: 2_000,
    allowedOrigins: ["https://vps.example.ts.net"],
  });
  const address = await server.listen(0);
  const url = `ws://${address.host}:${address.port}/ws`;

  try {
    // 用户浏览的其它网站发起的连接：Origin 与 Host 不符，直接拒绝。
    const attacker = new WebSocket(url, {
      headers: { origin: "https://attacker.example" },
    });
    const rejected = await withTimeout(
      once(attacker, "error").then(() => "rejected" as const),
      "等待跨站连接被拒绝",
    );
    assert.equal(rejected, "rejected");

    // 页面自己发起的连接：Origin 与 Host 同源。
    const sameOrigin = new WebSocket(url, {
      headers: { origin: `http://${address.host}:${address.port}` },
    });
    await withTimeout(once(sameOrigin, "open"), "打开同源 WebSocket");
    sameOrigin.close();

    // 反向代理入口：Host 是内部地址，Origin 是对外域名，靠白名单放行。
    const proxied = new WebSocket(url, {
      headers: { origin: "https://vps.example.ts.net" },
    });
    await withTimeout(once(proxied, "open"), "打开白名单来源的 WebSocket");
    proxied.close();

    // 冒烟脚本和命令行客户端不发 Origin，仍然可用。
    const headless = new WebSocket(url);
    await withTimeout(once(headless, "open"), "打开无 Origin 的 WebSocket");
    headless.close();
  } finally {
    await withTimeout(server.close(), "关闭服务器");
    approvals.dispose();
  }
});
