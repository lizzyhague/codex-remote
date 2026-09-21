import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";

import type { AppServerMessageListener } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { ApprovalTransport } from "../approvals/broker.ts";
import type { RequestId } from "../generated/RequestId.ts";
import type { OpenedSession, SessionPage } from "../sessions/service.ts";
import type { BrowserConnectionServices } from "./connection.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import type { SessionWorkerManager } from "../workers/manager.ts";

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

test("serves health and requires a cookie before the WebSocket upgrade", async () => {
  const transport = new EmptyTransport();
  const services = emptyServices(transport);
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services,
  });
  const address = await server.listen(0);
  const rejected = new WebSocket(`ws://${address.host}:${address.port}/ws`);
  const rejectedError = once(rejected, "error");
  let webSocket: WebSocket | null = null;

  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const page = await fetch(`http://${address.host}:${address.port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Codex Remote/);
    assert.match(html, /\/assets\/[a-f0-9]{64}\/app\.js/u);
    assert.match(html, /<meta name="codex-remote-assets"/u);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(page.headers.get("cache-control") ?? "", /no-cache/u);

    const worker = await fetch(`http://${address.host}:${address.port}/sw.js`);
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("cache-control") ?? "", /no-cache/u);
    assert.equal(worker.headers.get("service-worker-allowed"), "/");

    for (const asset of [
      "/boot.js",
      "/markdown.js",
      "/notice.js",
      "/slash-menu.js",
      "/display-timezone.js",
    ]) {
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

    await withTimeout(rejectedError, "等待未登录连接被拒绝");
    const cookie = await loginCookie(address);
    webSocket = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
      headers: { cookie },
    });
    await withTimeout(once(webSocket, "open"), "打开 WebSocket");

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
    rejected.terminate();
    if (webSocket && webSocket.readyState !== WebSocket.CLOSED) {
      const closed = once(webSocket, "close");
      webSocket.close();
      await withTimeout(closed, "关闭 WebSocket");
    }
    await withTimeout(server.close(), "关闭服务器");
  }
});

test("streams same-origin uploads through the local attachment adapter", async () => {
  const transport = new EmptyTransport();
  const received: Buffer[] = [];
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services: emptyServices(transport),
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
    const cookie = await loginCookie(address);
    const uploaded = await fetch(`${origin}/attachments/upload`, {
      method: "POST",
      headers: { cookie, origin, "x-upload-ticket": "ticket-secret" },
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
  }
});

test("HTTP login survives restarts and token rotation revokes its cookie", async (t) => {
  const transport = new EmptyTransport();
  const services = emptyServices(transport);
  const first = new RemoteWebSocketServer({ token: "test-secret", services });
  // close() 可以重复调用；注册清理是为了断言失败时服务器不会留着不放，
  // 否则测试进程不会退出，一次断言失败会表现成整套测试挂住。
  t.after(() => first.close());
  const firstAddress = await first.listen(0);
  const cookie = await loginCookie(firstAddress);
  const session = await fetch(
    `http://${firstAddress.host}:${firstAddress.port}/auth/session`,
    { headers: { cookie } },
  );
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });
  assert.match(session.headers.get("set-cookie") ?? "", /Max-Age=34560000/u);
  await first.close();

  const restarted = new RemoteWebSocketServer({ token: "test-secret", services });
  t.after(() => restarted.close());
  const restartedAddress = await restarted.listen(0);
  assert.equal((await fetch(
    `http://${restartedAddress.host}:${restartedAddress.port}/auth/session`,
    { headers: { cookie } },
  )).status, 200);
  await restarted.close();

  const rotated = new RemoteWebSocketServer({ token: "rotated-secret", services });
  t.after(() => rotated.close());
  const rotatedAddress = await rotated.listen(0);
  assert.equal((await fetch(
    `http://${rotatedAddress.host}:${rotatedAddress.port}/auth/session`,
    { headers: { cookie } },
  )).status, 401);
  const crossSite = await fetch(`http://${rotatedAddress.host}:${rotatedAddress.port}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: JSON.stringify({ token: "rotated-secret" }),
  });
  assert.equal(crossSite.status, 403);
  await rotated.close();
});

test("raw serves only caged Markdown and images with sandbox headers", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "codex-remote-view-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const firstRoot = path.join(temp, "first");
  const secondRoot = path.join(temp, "second");
  const outside = path.join(temp, "outside");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot), mkdir(outside)]);
  const note = path.join(firstRoot, "note.md");
  const image = path.join(secondRoot, "image.svg");
  const secret = path.join(outside, "secret.md");
  await Promise.all([
    writeFile(note, "# hello"),
    writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    writeFile(secret, "outside"),
    writeFile(path.join(firstRoot, "source.ts"), "code"),
  ]);
  await symlink(secret, path.join(firstRoot, "escape.md"));

  const transport = new EmptyTransport();
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services: emptyServices(transport),
    fileRoots: [await realpath(firstRoot), await realpath(secondRoot)],
  });
  const address = await server.listen(0);
  t.after(async () => {
    await server.close();
  });
  const origin = `http://${address.host}:${address.port}`;
  const cookie = await loginCookie(address);

  const markdown = await fetch(`${origin}/raw?${new URLSearchParams({ path: note })}`, {
    headers: { cookie },
  });
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await markdown.text(), "# hello");
  assert.equal(markdown.headers.get("cache-control"), "no-store");
  assert.match(markdown.headers.get("content-security-policy") ?? "", /sandbox/u);

  const svg = await fetch(`${origin}/raw?${new URLSearchParams({ path: image })}`, {
    method: "HEAD",
    headers: { cookie },
  });
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.match(svg.headers.get("content-security-policy") ?? "", /default-src 'none'/u);

  for (const denied of [
    "note.md",
    secret,
    path.join(firstRoot, "escape.md"),
    path.join(firstRoot, "source.ts"),
  ]) {
    const response = await fetch(`${origin}/raw?${new URLSearchParams({ path: denied })}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 404, denied);
  }
  assert.equal((await fetch(`${origin}/raw?${new URLSearchParams({ path: note })}`)).status, 401);
  for (const asset of ["/view?path=anything", "/viewer.js", "/viewer.css"]) {
    assert.equal((await fetch(`${origin}${asset}`)).status, 200, asset);
  }
});

/** 这些测试只验证 HTTP 与升级路径，Worker 管理器只需要能被订阅和断开。 */
function stubWorkers(): SessionWorkerManager {
  return {
    onEvent: () => () => {},
    clientAuthenticated() {},
    clientDisconnected() {},
    detachSession() {},
    activeTask: () => null,
  } as unknown as SessionWorkerManager;
}

function emptyServices(
  transport: EmptyTransport,
): BrowserConnectionServices {
  return {
    projects: {
      async list() {
        return [{ id: "projects/demo", name: "demo", rootId: "projects" }];
      },
    },
    sessions: {
      isMarked() {
        return false;
      },
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
          lastReplyAt: null,
          state: "idle" as const,
          projectId,
          marked,
          deletedAt: null,
          purgeAt: null,
        };
      },
      async rename(projectId: string, sessionId: string, title: string) {
        return {
          id: sessionId,
          sessionId,
          title,
          preview: "",
          createdAt: 1,
          updatedAt: 1,
          lastReplyAt: null,
          state: "idle" as const,
          projectId,
          marked: false,
          deletedAt: null,
          purgeAt: null,
        };
      },
    },
    turnTransport: transport,
    locks: new ProjectTaskLocks(),
    workers: stubWorkers(),
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
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services: emptyServices(transport),
    allowedOrigins: ["https://vps.example.ts.net"],
  });
  const address = await server.listen(0);
  const url = `ws://${address.host}:${address.port}/ws`;
  const cookie = await loginCookie(address);

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
      headers: { cookie, origin: `http://${address.host}:${address.port}` },
    });
    await withTimeout(once(sameOrigin, "open"), "打开同源 WebSocket");
    sameOrigin.close();

    // 反向代理入口：Host 是内部地址，Origin 是对外域名，靠白名单放行。
    const proxied = new WebSocket(url, {
      headers: { cookie, origin: "https://vps.example.ts.net" },
    });
    await withTimeout(once(proxied, "open"), "打开白名单来源的 WebSocket");
    proxied.close();

    // 冒烟脚本和命令行客户端不发 Origin，但仍要带登录 cookie。
    const headless = new WebSocket(url, { headers: { cookie } });
    await withTimeout(once(headless, "open"), "打开无 Origin 的 WebSocket");
    headless.close();
  } finally {
    await withTimeout(server.close(), "关闭服务器");
  }
});

async function loginCookie(
  address: { host: string; port: number },
  token = "test-secret",
): Promise<string> {
  const response = await fetch(`http://${address.host}:${address.port}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function withWebRoot(
  t: test.TestContext,
  files: Record<string, string>,
): Promise<{ base: string; webRoot: string }> {
  const webRoot = await mkdtemp(path.join(tmpdir(), "codex-pwa-http-"));
  t.after(() => rm(webRoot, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(webRoot, name), body);
  }
  const transport = new EmptyTransport();
  const server = new RemoteWebSocketServer({
    token: "test-secret",
    services: emptyServices(transport),
    webRoot,
  });
  const address = await server.listen(0);
  t.after(() => server.close());
  return { webRoot, base: `http://${address.host}:${address.port}` };
}

test("refresh serves a new resource snapshot while old module URLs survive changes and restarts", async (t) => {
  const files = {
    "index.html": '<head><script type="module" src="/app.js"></script><link href="/styles.css" rel="stylesheet"></head>mark-A',
    "view.html": '<head><script type="module" src="/viewer.js"></script><link href="/viewer.css" rel="stylesheet"></head>',
    "app.js": 'import "./markdown.js"; window.__PWA_MARK__ = "A";',
    "markdown.js": "// dependency-A",
    "styles.css": "body { color: red }",
    "viewer.js": 'import "./markdown.js";',
    "viewer.css": ".file-viewer {}",
    "boot.js": "// boot",
    "slash-menu.js": "// menu",
    "display-timezone.js": "// tz",
    "sw.js": "// sw",
  };
  const { webRoot, base } = await withWebRoot(t, files);
  const first = await fetch(base);
  assert.match(first.headers.get("cache-control")!, /no-cache/u);
  const firstHtml = await first.text();
  assert.match(firstHtml, /mark-A/u);
  const oldApp = /src="([^"]+)"/u.exec(firstHtml)![1]!;
  assert.match(oldApp, /^\/assets\/[a-f0-9]{64}\/app.js$/u);
  assert.match(firstHtml, /<meta name="codex-remote-assets"/u);
  const oldModule = new URL("./markdown.js", `${base}${oldApp}`).pathname;
  const asset = await fetch(`${base}${oldApp}`);
  assert.match(asset.headers.get("cache-control")!, /immutable/u);
  assert.match(await asset.text(), /__PWA_MARK__ = "A"/u);
  assert.equal(await (await fetch(`${base}${oldModule}`)).text(), "// dependency-A");

  const view = await (await fetch(`${base}/view`)).text();
  assert.match(view, /\/assets\/[a-f0-9]{64}\/viewer\.js/u);

  await writeFile(path.join(webRoot, "markdown.js"), "// dependency-B");
  await writeFile(path.join(webRoot, "index.html"), files["index.html"]!.replace("mark-A", "mark-B"));
  const secondHtml = await (await fetch(base)).text();
  assert.match(secondHtml, /mark-B/u);
  const newApp = /src="([^"]+)"/u.exec(secondHtml)![1]!;
  assert.notEqual(newApp, oldApp);
  const newModule = new URL("./markdown.js", `${base}${newApp}`).pathname;
  assert.equal(await (await fetch(`${base}${newModule}`)).text(), "// dependency-B");
  assert.equal(await (await fetch(`${base}${oldModule}`)).text(), "// dependency-A");

  const head = await fetch(`${base}${newApp}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${base}${newApp.replace("app.js", "config.json")}`)).status, 404);
  assert.equal((await fetch(`${base}/assets/${"0".repeat(64)}/app.js`)).status, 404);
  assert.equal((await fetch(`${base}/assets/${"0".repeat(64)}/%2e%2e%2findex.html`)).status, 404);
  assert.equal((await fetch(`${base}/boot.js`)).status, 200);
});

test("storage failures for versioned assets are not disguised as missing files", async (t) => {
  const { webRoot, base } = await withWebRoot(t, {
    "index.html": '<head><script src="/app.js"></script></head>',
    "app.js": "// app",
    "markdown.js": "// md",
    "styles.css": "body {}",
    "viewer.js": "// viewer",
    "viewer.css": ".file-viewer {}",
    "boot.js": "// boot",
    "slash-menu.js": "// menu",
    "display-timezone.js": "// tz",
  });
  const html = await (await fetch(base)).text();
  const appUrl = /src="([^"]+)"/u.exec(html)![1]!;
  const snapshotFile = path.join(webRoot, ".web-assets", appUrl.split("/")[2]!, "app.js");
  await chmod(snapshotFile, 0);
  t.after(() => chmod(snapshotFile, 0o644).catch(() => {}));
  const denied = await fetch(`${base}${appUrl}`);
  assert.equal(denied.status, 500);
  assert.notEqual(denied.status, 404);
});

test("a page that references a missing script is not published as a complete snapshot", async (t) => {
  const { base } = await withWebRoot(t, {
    "index.html": '<head><script src="/app.js"></script></head>',
  });
  const response = await fetch(base);
  assert.equal(response.status, 500);
});
