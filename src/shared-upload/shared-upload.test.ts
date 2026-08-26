import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedUploadClient } from "./client.ts";
import type { SharedUploadPaths } from "./paths.ts";
import { SharedUploadServer } from "./server.ts";
import { SharedUploadStore } from "./store.ts";

async function fixture(
  context: test.TestContext,
  options: { now?: () => number; leaseTtlMs?: number } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "shared-upload-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "uploads");
  const paths: SharedUploadPaths = {
    root,
    socket: path.join(directory, "upload.sock"),
    database: path.join(root, "metadata.sqlite"),
    blobs: path.join(root, "blobs"),
    parts: path.join(root, "parts"),
  };
  const store = await SharedUploadStore.open({
    paths,
    minFreeBytes: 0,
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseTtlMs ? { leaseTtlMs: options.leaseTtlMs } : {}),
  });
  context.after(() => store.close());
  const server = new SharedUploadServer({ store, socketPath: paths.socket });
  await server.listen();
  context.after(() => server.close());
  return { paths, store, client: new SharedUploadClient(paths.socket) };
}

test("streams an image through a one-time ticket without exposing its path", async (context) => {
  const { paths, client } = await fixture(context);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from("test-image"),
  ]);
  const sourcePath = path.join(paths.root, "source.png");
  await writeFile(sourcePath, png);
  const ticket = await client.createTicket({
    caller: "codex",
    projectId: "project-1",
    sessionId: "thread-1",
    originalName: "../screen.png",
    declaredMime: "image/png",
    expectedSize: png.byteLength,
  });
  const attachment = await uploadFile(client, ticket.ticket, sourcePath, png.byteLength);

  assert.equal(attachment.originalName, "screen.png");
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.detectedMime, "image/png");
  assert.equal("path" in attachment, false);
  assert.equal(JSON.stringify(ticket).includes(paths.root), false);
  await assert.rejects(
    uploadFile(client, ticket.ticket, sourcePath, png.byteLength),
    /已使用|已过期/u,
  );

  const lease = await client.createLease(
    { caller: "codex", projectId: "project-1", sessionId: "thread-1" },
    "task-1",
    [attachment.id],
  );
  assert.equal(lease.attachments[0]?.path.startsWith(paths.blobs), true);
  assert.deepEqual(await readFile(lease.attachments[0]!.path), png);
  assert.equal((await stat(lease.attachments[0]!.path)).mode & 0o777, 0o600);
  await client.renewLease(lease.leaseId, "task-1");
  await client.releaseLease(lease.leaseId, "task-1");
});

test("rejects binding mismatches, size mismatches, and low disk", async (context) => {
  const { paths, store, client } = await fixture(context);
  const sourcePath = path.join(paths.root, "note.txt");
  await writeFile(sourcePath, "hello");
  const ticket = await client.createTicket({
    caller: "codex",
    projectId: "project-1",
    sessionId: "thread-1",
    originalName: "note.txt",
    declaredMime: "text/plain",
    expectedSize: 6,
  });
  await assert.rejects(uploadFile(client, ticket.ticket, sourcePath, 5), /大小/u);

  const exact = await client.createTicket({
    caller: "codex",
    projectId: "project-1",
    sessionId: "thread-1",
    originalName: "note.txt",
    declaredMime: "text/plain",
    expectedSize: 5,
  });
  const attachment = await uploadFile(client, exact.ticket, sourcePath, 5);
  await assert.rejects(
    client.createLease(
      { caller: "codex", projectId: "project-1", sessionId: "another-thread" },
      "task-1",
      [attachment.id],
    ),
    /不属于当前会话/u,
  );

  const lowRoot = path.join(paths.root, "low");
  const lowPaths = {
    root: lowRoot,
    socket: path.join(paths.root, "low.sock"),
    database: path.join(lowRoot, "metadata.sqlite"),
    blobs: path.join(lowRoot, "blobs"),
    parts: path.join(lowRoot, "parts"),
  };
  const lowStore = await SharedUploadStore.open({ paths: lowPaths, minFreeBytes: Number.MAX_SAFE_INTEGER });
  context.after(() => lowStore.close());
  const lowTicket = lowStore.createTicket({
    caller: "codex",
    projectId: "project-1",
    sessionId: "thread-1",
    originalName: "note.txt",
    declaredMime: "text/plain",
    expectedSize: 5,
  });
  await assert.rejects(lowStore.receiveUpload(lowTicket.ticket, chunks("hello")), /磁盘空间/u);
  assert.ok(store);
});

test("cleanup keeps leased expired attachments and removes them after release", async (context) => {
  let nowMs = 1_000;
  const { paths, store, client } = await fixture(context, {
    now: () => nowMs,
    leaseTtlMs: 31 * 24 * 60 * 60 * 1_000,
  });
  const sourcePath = path.join(paths.root, "note.txt");
  await writeFile(sourcePath, "hello");
  const ticket = await client.createTicket({
    caller: "codex",
    projectId: "project-1",
    sessionId: "thread-1",
    originalName: "note.txt",
    declaredMime: "text/plain",
    expectedSize: 5,
  });
  const attachment = await uploadFile(client, ticket.ticket, sourcePath, 5);
  const lease = await client.createLease(
    { caller: "codex", projectId: "project-1", sessionId: "thread-1" },
    "task-1",
    [attachment.id],
  );
  nowMs += 30 * 24 * 60 * 60 * 1_000 + 1;
  assert.equal((await store.cleanup()).attachments, 0);
  await client.releaseLease(lease.leaseId, "task-1");
  assert.equal((await store.cleanup()).attachments, 1);
  await assert.rejects(stat(lease.attachments[0]!.path), /ENOENT/u);
});

test("cleanup removes an old blob left behind before its metadata commit", async (context) => {
  const { paths, store } = await fixture(context);
  const shard = path.join(paths.blobs, "or");
  const orphan = path.join(shard, "orphan.txt");
  await mkdir(shard, { mode: 0o700 });
  await writeFile(orphan, "orphan", { mode: 0o600 });
  await utimes(orphan, new Date(0), new Date(0));

  const result = await store.cleanup();
  assert.equal(result.orphans, 1);
  await assert.rejects(stat(orphan), /ENOENT/u);
});

async function uploadFile(
  client: SharedUploadClient,
  ticket: string,
  sourcePath: string,
  contentLength: number,
) {
  // The production client receives an IncomingMessage. This small local HTTP hop
  // produces the same streaming interface without buffering the fixture in the client.
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const instance = createServer((request, response) => {
      void client.upload(ticket, contentLength, request).then((attachment) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(attachment));
      }, (error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    });
    instance.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试 HTTP 地址无效。");
    return await new Promise<import("./types.ts").PublicAttachment>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        headers: { "content-length": contentLength },
      }, async (response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(Buffer.from(chunk));
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(value.error || "测试上传失败。"));
          } else {
            resolve(value);
          }
        } catch (error) {
          reject(error);
        }
      });
      request.once("error", reject);
      createReadStream(sourcePath).pipe(request);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}
