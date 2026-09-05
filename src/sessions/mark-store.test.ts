import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  MarkStore,
  resolveMarkStatePath,
  type MarkEntry,
} from "./mark-store.ts";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-marks-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "state", "marks.json");
}

function entry(threadId = "thread-1"): MarkEntry {
  return {
    threadId,
    projectId: "workspace/alpha",
  };
}

test("persists marked sessions atomically and reloads them", async (context) => {
  const filePath = await fixture(context);
  const store = await MarkStore.open(filePath);

  await store.put(entry());
  assert.deepEqual(store.get("thread-1"), entry());
  assert.equal(store.has("thread-1"), true);

  const reloaded = await MarkStore.open(filePath);
  assert.deepEqual(reloaded.list(), [entry()]);
  const file = JSON.parse(await readFile(filePath, "utf8")) as { version: number };
  assert.equal(file.version, 1);

  await reloaded.remove("thread-1");
  assert.deepEqual((await MarkStore.open(filePath)).list(), []);
});

test("rejects malformed state instead of silently discarding it", async (context) => {
  const filePath = await fixture(context);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, entries: [{ bad: true }] }));
  await assert.rejects(
    () => MarkStore.open(filePath),
    /格式不正确/u,
  );
});

test("keeps marks beside the trash file unless an explicit marks path is set", () => {
  assert.equal(resolveMarkStatePath({
    CODEX_REMOTE_MARKS_FILE: "/var/lib/codex-remote/marks.json",
    CODEX_REMOTE_STATE_FILE: "/ignored/trash.json",
  }), "/var/lib/codex-remote/marks.json");
  assert.equal(resolveMarkStatePath({
    CODEX_REMOTE_STATE_FILE: "/var/lib/codex-remote/trash.json",
  }), "/var/lib/codex-remote/marks.json");
  assert.equal(resolveMarkStatePath({
    XDG_STATE_HOME: "/var/state",
  }), "/var/state/codex-remote/marks.json");
});
