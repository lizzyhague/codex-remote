import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
