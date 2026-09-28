import assert from "node:assert/strict";
import fs, { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { AttachmentDisplayIndex } from "./attachment-index.ts";
import { injectFsFaults, temporaryFiles } from "./fs-fault-injection.ts";

const SESSION = "thread-1";
const MESSAGE = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("registers mappings idempotently, survives reopen, and stays owner-only", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  const attachment = {
    id: "id-1",
    originalName: "报告.pdf",
    path: "/example/uploads/blobs/ab/id-1.pdf",
  };
  await index.register(SESSION, MESSAGE, [attachment]);
  await index.register(SESSION, MESSAGE, [attachment]);
  assert.deepEqual(index.peek(SESSION), [attachment]);

  const stats = await stat(path.join(directory, "attachment-index", `${SESSION}.json`));
  assert.equal(stats.mode & 0o777, 0o600);

  const reopened = await AttachmentDisplayIndex.open(directory);
  assert.deepEqual(await reopened.mappingsFor(SESSION), [attachment]);
});

test("removes the file when a session is deleted", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  await index.register(SESSION, MESSAGE, [{
    id: "id-1",
    originalName: "a.txt",
    path: "/tmp/a.txt",
  }]);
  await index.remove(SESSION);
  await assert.rejects(() => stat(path.join(directory, "attachment-index", `${SESSION}.json`)));
  assert.deepEqual(await index.mappingsFor(SESSION), []);
});

test("a failed index write leaves no temporary copy of private paths", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  injectFsFaults(t, { fail: { "file-sync": 1 } });

  await assert.rejects(
    index.register(SESSION, MESSAGE, [{
      id: "id-1",
      originalName: "a.txt",
      path: "/example/private/a.txt",
    }]),
    /injected file-sync failure/u,
  );
  assert.deepEqual(await temporaryFiles(path.join(directory, "attachment-index")), []);
});

test("removal is not reported complete until the directory entry is durable", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  await index.register(SESSION, MESSAGE, [{
    id: "id-1",
    originalName: "a.txt",
    path: "/tmp/a.txt",
  }]);
  const faults = injectFsFaults(t, { fail: { "directory-sync": 1 } });

  await assert.rejects(index.remove(SESSION), /injected directory-sync failure/u);
  await index.remove(SESSION);
  assert.deepEqual(faults.events, [
    `directory-sync:${path.join(directory, "attachment-index")}`,
    `directory-sync:${path.join(directory, "attachment-index")}`,
  ]);
  await assert.rejects(() => stat(path.join(directory, "attachment-index", `${SESSION}.json`)));
});

test("a whole-history rebuild cannot be split by a deletion", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  const renames = pauseFirstRename(t);

  const rebuilding = index.rebuild(SESSION, [
    { messageId: "message-1", attachments: [privateAttachment("one")] },
    { messageId: "message-2", attachments: [privateAttachment("two")] },
  ]);
  await renames.reached;
  const removing = index.remove(SESSION);
  renames.release();

  await rebuilding;
  await removing;
  assert.equal(renames.count(), 1, "整轮重建只写一次，删除不能插在两次登记之间");
  await assert.rejects(() => stat(indexFile(directory)));
  assert.deepEqual(index.peek(SESSION), []);
  assert.deepEqual(await index.mappingsFor(SESSION), []);
});

test("operations queued before a deletion but run after it never recreate the index", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  const renames = pauseFirstRename(t);

  const first = index.register(SESSION, "message-1", [privateAttachment("one")]);
  await renames.reached;
  // 已经发出、但排在删除之前还没轮到执行的旧操作。
  const lateRegister = index.register(SESSION, "message-2", [privateAttachment("two")]);
  const lateRebuild = index.rebuild(SESSION, [
    { messageId: "message-3", attachments: [privateAttachment("three")] },
  ]);
  const removing = index.remove(SESSION);
  renames.release();

  await first;
  await lateRegister;
  assert.deepEqual(await lateRebuild, []);
  await removing;
  assert.equal(renames.count(), 1);
  await assert.rejects(() => stat(indexFile(directory)));
  assert.deepEqual(await index.mappingsFor(SESSION), []);
});

test("a deleted session stays deleted for later registrations and reads", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  await index.register(SESSION, "message-1", [privateAttachment("one")]);
  await index.remove(SESSION);

  await index.register(SESSION, "message-2", [privateAttachment("two")]);
  assert.deepEqual(
    await index.rebuild(SESSION, [
      { messageId: "message-3", attachments: [privateAttachment("three")] },
    ]),
    [],
  );
  await index.drain();
  await assert.rejects(() => stat(indexFile(directory)));
  assert.deepEqual(index.peek(SESSION), []);
  assert.deepEqual(await index.mappingsFor(SESSION), []);

  const other = privateAttachment("other");
  await index.register("thread-2", "message-1", [other]);
  assert.deepEqual(index.peek("thread-2"), [other], "删除屏障只作用于被删的会话");
});

test("rebuilding an unchanged history does not rewrite the index", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  const history = [
    { messageId: "message-1", attachments: [privateAttachment("one")] },
    { messageId: "message-2", attachments: [privateAttachment("two")] },
  ];
  assert.deepEqual(
    await index.rebuild(SESSION, history),
    [privateAttachment("one"), privateAttachment("two")],
  );
  const faults = injectFsFaults(t);

  const reopened = await AttachmentDisplayIndex.open(directory);
  assert.deepEqual(
    await reopened.rebuild(SESSION, history),
    [privateAttachment("one"), privateAttachment("two")],
  );
  assert.deepEqual(faults.events, []);
});

test("a failed rebuild write is retried by the next rebuild of the same history", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const index = await AttachmentDisplayIndex.open(directory);
  const history = [{ messageId: "message-1", attachments: [privateAttachment("one")] }];
  const faults = injectFsFaults(t, { fail: { rename: 1 } });

  await assert.rejects(index.rebuild(SESSION, history), /injected rename failure/u);
  assert.deepEqual(index.peek(SESSION), []);
  faults.heal();
  assert.deepEqual(await index.rebuild(SESSION, history), [privateAttachment("one")]);

  const reopened = await AttachmentDisplayIndex.open(directory);
  assert.deepEqual(await reopened.mappingsFor(SESSION), [privateAttachment("one")]);
});

function indexFile(directory: string): string {
  return path.join(directory, "attachment-index", `${SESSION}.json`);
}

function privateAttachment(name: string) {
  return { id: `id-${name}`, originalName: `${name}.txt`, path: `/example/private/${name}.txt` };
}

/** 让第一次 rename 停住，模拟索引写入正在进行时插进来的其他调用。 */
function pauseFirstRename(context: TestContext) {
  const realRename = fs.rename.bind(fs);
  let calls = 0;
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    calls += 1;
    if (calls === 1) {
      markReached();
      await released;
    }
    return realRename(...args);
  });
  return { reached, release, count: () => calls };
}
