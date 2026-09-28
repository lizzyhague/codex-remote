import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  resolveTrashStatePath,
  TrashStore,
  type TrashEntry,
} from "./trash-store.ts";
import { injectFsFaults, temporaryFiles } from "../workers/fs-fault-injection.ts";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-trash-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "state", "trash.json");
}

function entry(threadId = "thread-1"): TrashEntry {
  return {
    threadId,
    projectId: "projects/demo",
    deletedAt: 100,
    origin: "active",
    state: "trashed",
  };
}

test("persists trash entries atomically and reloads them", async (context) => {
  const filePath = await fixture(context);
  const store = await TrashStore.open(filePath);

  await store.put(entry());
  assert.deepEqual(store.get("thread-1"), entry());

  const reloaded = await TrashStore.open(filePath);
  assert.deepEqual(reloaded.list("projects/demo"), [entry()]);
  const file = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
  assert.equal(file.version, 1);

  await reloaded.remove("thread-1");
  assert.deepEqual((await TrashStore.open(filePath)).list(), []);
});

test("rejects malformed state instead of silently discarding it", async (context) => {
  const filePath = await fixture(context);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, entries: [{ bad: true }] }));
  await assert.rejects(
    () => TrashStore.open(filePath),
    /格式不正确/u,
  );
});

test("loads legacy entries without a deletion state as ordinary trash", async (context) => {
  const filePath = await fixture(context);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    version: 1,
    entries: [{
      threadId: "thread-legacy",
      projectId: "projects/demo",
      deletedAt: 100,
      origin: "active",
    }],
  }));

  const store = await TrashStore.open(filePath);
  assert.equal(store.get("thread-legacy")?.state, "trashed");
});

test("uses an explicit state file before the platform state directory", () => {
  assert.equal(resolveTrashStatePath({
    CODEX_REMOTE_STATE_FILE: "/var/lib/codex-remote/trash.json",
    XDG_STATE_HOME: "/ignored",
  }), "/var/lib/codex-remote/trash.json");
  assert.equal(resolveTrashStatePath({
    XDG_STATE_HOME: "/var/state",
  }), "/var/state/codex-remote/trash.json");
});

test("rolls back an entry whose directory entry could not be made durable", async (context) => {
  const filePath = await fixture(context);
  const store = await TrashStore.open(filePath);
  await store.put(entry());
  const faults = injectFsFaults(context, { fail: { "directory-sync": 1, "file-sync": 2 } });

  await assert.rejects(
    store.put({ ...entry(), state: "deleting" }),
    /injected directory-sync failure/u,
  );
  assert.equal(store.get("thread-1")?.state, "trashed");

  await assert.rejects(store.put(entry("thread-2")), /injected file-sync failure/u);
  assert.equal(store.has("thread-2"), false);
  assert.deepEqual(await temporaryFiles(path.dirname(filePath)), []);

  faults.heal();
  await store.put(entry("thread-2"));
  assert.deepEqual(
    (await TrashStore.open(filePath)).list().map((item) => [item.threadId, item.state]),
    [["thread-1", "trashed"], ["thread-2", "trashed"]],
  );
});
