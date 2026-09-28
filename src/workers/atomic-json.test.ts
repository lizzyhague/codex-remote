import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { removeFileDurably, writeJsonAtomically } from "./atomic-json.ts";
import { injectFsFaults, temporaryFiles, type FsStage } from "./fs-fault-injection.ts";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-atomic-json-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("syncs the parent directory only after the rename, before resolving", async (context) => {
  const directory = await fixture(context);
  const filePath = path.join(directory, "state.json");
  const faults = injectFsFaults(context);

  await writeJsonAtomically(filePath, { secret: "new" });

  assert.deepEqual(faults.events, [
    "file-write",
    "file-sync",
    "file-close",
    "rename",
    `directory-sync:${directory}`,
  ]);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { secret: "new" });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await temporaryFiles(directory), []);
});

test("syncs every parent whose directory entry it had to create", async (context) => {
  const root = await fixture(context);
  const filePath = path.join(root, "a", "b", "state.json");
  const faults = injectFsFaults(context);

  await writeJsonAtomically(filePath, { ok: true });

  const directorySyncs = faults.events.filter((event) => event.startsWith("directory-sync:"));
  assert.deepEqual(directorySyncs, [
    `directory-sync:${path.join(root, "a")}`,
    `directory-sync:${root}`,
    `directory-sync:${path.join(root, "a", "b")}`,
  ]);
  assert.equal((await stat(path.join(root, "a", "b"))).mode & 0o777, 0o700);
});

for (const stage of ["file-write", "file-sync", "file-close", "rename"] as const satisfies FsStage[]) {
  test(`${stage} failure keeps the old file, leaves no temporary data, and can be retried`, async (context) => {
    const directory = await fixture(context);
    const filePath = path.join(directory, "state.json");
    await writeFile(filePath, `${JSON.stringify({ secret: "old" })}\n`);
    const faults = injectFsFaults(context, { fail: { [stage]: 1 } });

    await assert.rejects(
      writeJsonAtomically(filePath, { secret: "private /example/path" }),
      (error: NodeJS.ErrnoException) =>
        error.message === `injected ${stage} failure` && error.code === "EIO",
    );
    assert.deepEqual(await temporaryFiles(directory), []);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { secret: "old" });
    assert.equal(faults.events.includes(`directory-sync:${directory}`), false);

    await writeJsonAtomically(filePath, { secret: "retried" });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { secret: "retried" });
    assert.deepEqual(await temporaryFiles(directory), []);
  });
}

test("keeps the write error when closing the failed temporary file also fails", async (context) => {
  const directory = await fixture(context);
  const filePath = path.join(directory, "state.json");
  injectFsFaults(context, { fail: { "file-sync": 1, "file-close": 1 } });

  await assert.rejects(
    writeJsonAtomically(filePath, { secret: "x" }),
    /injected file-sync failure/u,
  );
  assert.deepEqual(await temporaryFiles(directory), []);
});

test("rejects when the directory entry cannot be made durable", async (context) => {
  const directory = await fixture(context);
  const filePath = path.join(directory, "state.json");
  const faults = injectFsFaults(context, { fail: { "directory-sync": 1 } });

  await assert.rejects(
    writeJsonAtomically(filePath, { state: "deleting" }),
    /injected directory-sync failure/u,
  );
  assert.deepEqual(faults.events.slice(-2), ["rename", `directory-sync:${directory}`]);
  assert.deepEqual(await temporaryFiles(directory), []);
});

test("removes a file durably, including an already missing one", async (context) => {
  const directory = await fixture(context);
  const nested = path.join(directory, "index");
  await mkdir(nested);
  const filePath = path.join(nested, "thread.json");
  await writeFile(filePath, "{}\n");
  const faults = injectFsFaults(context, { fail: { "directory-sync": 1 } });

  await assert.rejects(removeFileDurably(filePath), /injected directory-sync failure/u);
  await assert.rejects(stat(filePath));

  await removeFileDurably(filePath);
  assert.deepEqual(faults.events, [
    `directory-sync:${nested}`,
    `directory-sync:${nested}`,
  ]);
});
