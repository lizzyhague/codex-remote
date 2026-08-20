import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

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
        return { sessions: [], nextCursor: null };
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
    },
    turnTransport: transport,
    approvals,
    locks: new ProjectTaskLocks(),
  };
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
