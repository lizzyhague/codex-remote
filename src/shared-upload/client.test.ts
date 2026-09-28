import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { SharedUploadClient, type SharedUploadClientOptions } from "./client.ts";
import { SharedUploadError, type AttachmentBinding } from "./types.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const BINDING: AttachmentBinding = { caller: "codex", projectId: "project-1", sessionId: "thread-1" };

function attachment(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ...BINDING,
    originalName: `${id}.txt`,
    declaredMime: "text/plain",
    detectedMime: "text/plain",
    kind: "file",
    size: 5,
    sha256: "a".repeat(64),
    createdAtMs: 1,
    expiresAtMs: 2,
    ...extra,
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.byteLength });
  response.end(body);
}

/** 假共享服务：监听隔离目录里的 Unix socket，记录每个下游请求何时被关闭。 */
async function fakeService(context: TestContext, handler: Handler) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-upload-client-"));
  const socketPath = path.join(directory, "upload.sock");
  const requests: Array<{ url: string; body: Promise<string>; closed: Promise<void> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    const body = new Promise<string>((resolve) => {
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    // 没有写响应时，ServerResponse 的 close 只会因为连接被对端关闭而触发。
    const closed = new Promise<void>((resolve) => response.once("close", () => resolve()));
    requests.push({ url: request.url ?? "", body, closed });
    handler(request, response);
  });
  server.listen(socketPath);
  await once(server, "listening");
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const client = (options: SharedUploadClientOptions = {}) => new SharedUploadClient(socketPath, options);
  return { client, requests };
}

/**
 * 真实浏览器入口：在一个本地 HTTP 服务里把收到的请求体交给 `upload()`，这样 `source`
 * 是真正的 IncomingMessage，并且可以从“浏览器”这一侧中断。
 */
async function uploadThroughFrontServer(
  context: TestContext,
  client: SharedUploadClient,
  options: { body: Buffer; signal?: AbortSignal; interruptAfterBytes?: number },
): Promise<unknown> {
  let result!: Promise<unknown>;
  const started = new Promise<void>((resolve) => {
    const front: Server = createServer((request, response) => {
      result = client.upload("ticket-secret", options.body.byteLength, request, options.signal)
        .then((value) => value, (error: unknown) => error);
      resolve();
      void result.then(() => response.end());
    });
    front.listen(0, "127.0.0.1", () => {
      const { port } = front.address() as AddressInfo;
      const browser = httpRequest({
        host: "127.0.0.1",
        port,
        method: "POST",
        headers: { "content-length": options.body.byteLength },
      });
      browser.on("error", () => {});
      if (options.interruptAfterBytes !== undefined) {
        browser.write(options.body.subarray(0, options.interruptAfterBytes));
        setTimeout(() => browser.destroy(), 30);
      } else {
        browser.end(options.body);
      }
    });
    context.after(async () => {
      front.closeAllConnections();
      await new Promise<void>((done) => front.close(() => done()));
    });
  });
  await started;
  return result;
}

async function settlesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 没有在 ${ms} ms 内结束`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertUploadError(value: unknown, code: string, status?: number): SharedUploadError {
  assert.ok(value instanceof SharedUploadError, `期望 SharedUploadError，实际是 ${String(value)}`);
  assert.equal(value.code, code);
  if (status !== undefined) assert.equal(value.status, status);
  return value;
}

test("upload fails after no progress when the service reads the body but never responds", async (t) => {
  const service = await fakeService(t, () => {});
  const client = service.client({ idleTimeoutMs: 100, uploadTimeoutMs: 10_000 });
  const result = await settlesWithin(
    uploadThroughFrontServer(t, client, { body: Buffer.from("hello") }),
    3_000,
    "停住的上传",
  );
  assertUploadError(result, "upload_service_timeout", 504);
  assert.equal(await service.requests[0]!.body, "hello");
  await settlesWithin(service.requests[0]!.closed, 1_000, "下游 socket 关闭");
});

test("upload has a total deadline even when the service keeps trickling bytes", async (t) => {
  const service = await fakeService(t, (request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      const timer = setInterval(() => response.write(" "), 20);
      response.once("close", () => clearInterval(timer));
    });
  });
  const client = service.client({ idleTimeoutMs: 200, uploadTimeoutMs: 300 });
  const result = await settlesWithin(
    uploadThroughFrontServer(t, client, { body: Buffer.from("hello") }),
    3_000,
    "滴流响应",
  );
  assertUploadError(result, "upload_service_timeout", 504);
  await settlesWithin(service.requests[0]!.closed, 1_000, "下游 socket 关闭");
});

test("aborting the signal after the body is sent destroys the downstream request", async (t) => {
  const service = await fakeService(t, () => {});
  const client = service.client({ idleTimeoutMs: 10_000 });
  const controller = new AbortController();
  const pending = uploadThroughFrontServer(t, client, {
    body: Buffer.from("hello"),
    signal: controller.signal,
  });
  while (service.requests.length === 0) await delay(5);
  await service.requests[0]!.body;
  const reason = new SharedUploadError("service_stopping", "服务正在停止，请稍后重试。", 503);
  controller.abort(reason);
  assert.equal(await settlesWithin(pending, 1_000, "取消的上传"), reason);
  await settlesWithin(service.requests[0]!.closed, 1_000, "下游 socket 关闭");
});

test("an interrupted browser body destroys the downstream request", async (t) => {
  const service = await fakeService(t, () => {});
  const client = service.client({ idleTimeoutMs: 10_000 });
  const result = await settlesWithin(
    uploadThroughFrontServer(t, client, { body: Buffer.alloc(1_000, 1), interruptAfterBytes: 10 }),
    3_000,
    "中断的上传",
  );
  assertUploadError(result, "upload_interrupted", 400);
  await settlesWithin(service.requests[0]!.closed, 1_000, "下游 socket 关闭");
});

test("a service that half-closes without a response fails as unavailable", async (t) => {
  const service = await fakeService(t, (request) => {
    request.resume();
    request.on("end", () => request.socket.end());
  });
  const client = service.client({ idleTimeoutMs: 10_000 });
  const result = await settlesWithin(
    uploadThroughFrontServer(t, client, { body: Buffer.from("hello") }),
    3_000,
    "半关闭",
  );
  assertUploadError(result, "upload_service_unavailable", 503);
});

test("JSON requests have a total deadline", async (t) => {
  const service = await fakeService(t, (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => response.write(" "), 20);
    response.once("close", () => clearInterval(timer));
  });
  const client = service.client({ requestTimeoutMs: 200, idleTimeoutMs: 10_000 });
  const result = await settlesWithin(client.health().catch((error: unknown) => error), 3_000, "health");
  assertUploadError(result, "upload_service_timeout", 504);
});

test("upload responses are projected to public fields and malformed ones are rejected", async (t) => {
  let reply: unknown = null;
  const service = await fakeService(t, (request, response) => {
    request.resume();
    request.on("end", () => sendJson(response, 201, reply));
  });
  const client = service.client();

  reply = { attachment: attachment("a1", { path: "/srv/blobs/a1", storagePath: "/srv/x", internalNote: "n" }), extra: 1 };
  const uploaded = await uploadThroughFrontServer(t, client, { body: Buffer.from("hello") });
  assert.deepEqual(uploaded, attachment("a1"));

  for (const broken of [
    { attachment: attachment("a1", { kind: "folder" }) },
    { attachment: attachment("a1", { sha256: "/srv/blobs/a1" }) },
    { attachment: attachment("a1", { size: -1 }) },
    { attachment: attachment("a1", { caller: "other" }) },
    { attachment: { ...attachment("a1"), id: undefined } },
    { attachment: [attachment("a1")] },
    [],
  ]) {
    reply = broken;
    const result = await uploadThroughFrontServer(t, client, { body: Buffer.from("hello") });
    assertUploadError(result, "invalid_response", 502);
  }
});

test("downstream error text stays in logs and the browser gets a stable code and local text", async (t) => {
  let reply: { status: number; body: unknown } = { status: 400, body: null };
  const service = await fakeService(t, (request, response) => {
    request.resume();
    request.on("end", () => sendJson(response, reply.status, reply.body));
  });
  const client = service.client();
  const logged: string[] = [];
  t.mock.method(console, "error", (message: unknown) => logged.push(String(message)));

  reply = {
    status: 404,
    body: { error: { code: "attachment_unavailable", message: "附件 /srv/private/blobs/a1 不存在" } },
  };
  let error = assertUploadError(
    await client.createTicket({ ...BINDING, originalName: "a", declaredMime: "text/plain", expectedSize: 1 })
      .catch((value: unknown) => value),
    "attachment_unavailable",
    404,
  );
  assert.doesNotMatch(error.message, /srv/u);
  assert.ok(logged.some((line) => line.includes("/srv/private/blobs/a1")));

  reply = { status: 500, body: { error: { code: "Weird Code /srv", message: "boom /srv/x" } } };
  error = assertUploadError(
    await client.health().catch((value: unknown) => value),
    "upload_service_error",
    500,
  );
  assert.equal(error.message, "共享上传服务拒绝了请求。");

  reply = { status: 502, body: "not json" };
  assertUploadError(await client.health().catch((value: unknown) => value), "upload_service_error", 502);
});

test("oversized responses are rejected", async (t) => {
  const service = await fakeService(t, (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(Buffer.alloc(1_048_577, 0x20));
  });
  const result = await service.client().health().catch((error: unknown) => error);
  assertUploadError(result, "response_too_large", 502);
});

test("tickets drop undeclared fields and must match the requested binding", async (t) => {
  let reply: unknown = null;
  const service = await fakeService(t, (request, response) => {
    request.resume();
    request.on("end", () => sendJson(response, 201, reply));
  });
  const client = service.client();
  const input = { ...BINDING, originalName: "a.txt", declaredMime: "text/plain", expectedSize: 5 };
  const ticketAttachment = { ...BINDING, originalName: "a.txt", declaredMime: "text/plain", expectedSize: 5 };

  reply = {
    ticket: "secret",
    expiresAtMs: 10,
    tokenHash: "abc",
    attachment: { ...ticketAttachment, path: "/srv/blobs/a.part" },
  };
  assert.deepEqual(await client.createTicket(input), {
    ticket: "secret",
    expiresAtMs: 10,
    attachment: ticketAttachment,
  });

  for (const attachmentValue of [
    { ...ticketAttachment, projectId: "project-2" },
    { ...ticketAttachment, sessionId: "thread-2" },
    { ...ticketAttachment, caller: "grok" },
    { ...ticketAttachment, expectedSize: 6 },
  ]) {
    reply = { ticket: "secret", expiresAtMs: 10, attachment: attachmentValue };
    assertUploadError(await client.createTicket(input).catch((error: unknown) => error), "invalid_response");
  }
});

test("leases must match owner, binding and the requested ID set; mismatches are released", async (t) => {
  let reply: unknown = null;
  const released: Array<{ url: string; body: string }> = [];
  const service = await fakeService(t, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/release")) {
        released.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") });
        sendJson(response, 200, { released: true });
      } else {
        sendJson(response, 201, reply);
      }
    });
  });
  const client = service.client();
  const resolved = (id: string, extra: Record<string, unknown> = {}) =>
    attachment(id, { path: `/srv/blobs/${id}`, ...extra });
  const lease = (attachments: unknown[], extra: Record<string, unknown> = {}) => ({
    lease: { leaseId: "lease-1", ownerId: "task-1", expiresAtMs: 100, attachments, ...extra },
  });

  // 服务端按首次出现去重并可能换顺序；客户端按请求顺序返回，并去掉未声明字段。
  reply = lease([resolved("b", { storagePath: "/srv/x" }), resolved("a")], { internal: true });
  const accepted = await client.createLease(BINDING, "task-1", ["a", "b", "a"]);
  assert.deepEqual(accepted, {
    leaseId: "lease-1",
    ownerId: "task-1",
    expiresAtMs: 100,
    attachments: [resolved("a"), resolved("b")],
  });
  assert.deepEqual(released, []);

  const mismatches: Array<[string, unknown]> = [
    ["错 owner", lease([resolved("a"), resolved("b")], { ownerId: "task-2" })],
    ["错项目", lease([resolved("a"), resolved("b", { projectId: "project-2" })])],
    ["错会话", lease([resolved("a", { sessionId: "thread-2" }), resolved("b")])],
    ["错 caller", lease([resolved("a", { caller: "claude" }), resolved("b")])],
    ["缺 ID", lease([resolved("a")])],
    ["多 ID", lease([resolved("a"), resolved("b"), resolved("c")])],
    ["重复 ID", lease([resolved("a"), resolved("a")])],
    ["相对路径", lease([resolved("a"), resolved("b", { path: "blobs/b" })])],
    ["缺路径", lease([resolved("a"), attachment("b")])],
  ];
  for (const [label, value] of mismatches) {
    reply = value;
    released.length = 0;
    const result = await client.createLease(BINDING, "task-1", ["a", "b"]).catch((error: unknown) => error);
    assertUploadError(result, "invalid_response");
    assert.deepEqual(released, [{ url: "/v1/leases/lease-1/release", body: '{"ownerId":"task-1"}' }], label);
  }

  // 连 leaseId 都没有时无从释放，只能等共享服务按租约时限回收。
  reply = { lease: { ownerId: "task-1" } };
  released.length = 0;
  assertUploadError(
    await client.createLease(BINDING, "task-1", ["a"]).catch((error: unknown) => error),
    "invalid_response",
  );
  assert.deepEqual(released, []);
});

test("lease renewals must answer for the requested lease", async (t) => {
  let reply: unknown = null;
  const service = await fakeService(t, (request, response) => {
    request.resume();
    request.on("end", () => sendJson(response, 200, reply));
  });
  const client = service.client();
  reply = { leaseId: "lease-1", expiresAtMs: 50, path: "/srv/x" };
  assert.deepEqual(await client.renewLease("lease-1", "task-1"), { leaseId: "lease-1", expiresAtMs: 50 });
  reply = { leaseId: "lease-2", expiresAtMs: 50 };
  assertUploadError(
    await client.renewLease("lease-1", "task-1").catch((error: unknown) => error),
    "invalid_response",
  );
  reply = { leaseId: "lease-1", expiresAtMs: "later" };
  assertUploadError(
    await client.renewLease("lease-1", "task-1").catch((error: unknown) => error),
    "invalid_response",
  );
});
