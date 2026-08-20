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

test("uses an explicit state file before the platform state directory", () => {
  assert.equal(resolveTrashStatePath({
    CODEX_REMOTE_STATE_FILE: "/var/lib/codex-remote/trash.json",
    XDG_STATE_HOME: "/ignored",
  }), "/var/lib/codex-remote/trash.json");
  assert.equal(resolveTrashStatePath({
    XDG_STATE_HOME: "/var/state",
  }), "/var/state/codex-remote/trash.json");
});
