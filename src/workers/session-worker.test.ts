import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectCatalog } from "../projects/catalog.ts";
import type { TrashStore } from "../sessions/trash-store.ts";
import {
  SessionWorker,
  SessionWorkerStartCancelledError,
} from "./session-worker.ts";

test("cancelling startup closes an app-server that never initializes", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-worker-start-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "hanging-codex");
  await writeFile(binary, "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o755 });
  await chmod(binary, 0o755);

  const controller = new AbortController();
  const starting = SessionWorker.create({
    projectId: "project-1",
    projects: {} as ProjectCatalog,
    trash: {} as TrashStore,
    codexBinary: binary,
    workingDirectory: directory,
    startupSignal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    starting,
    (error: unknown) => error instanceof SessionWorkerStartCancelledError,
  );
});
