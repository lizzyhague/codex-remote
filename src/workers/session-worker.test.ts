import assert from "node:assert/strict";
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

test("concurrent close calls share one close that waits for the process to exit", async (context) => {
  const fixture = await fakeAppServer(context, "shutdownOnStdinEnd");
  const worker = await fixture.create();

  const first = worker.close();
  const second = worker.close();
  assert.equal(second, first);
  await second;
  await access(fixture.exitedMarker);
  await first;
});

test("reports an unexpected exit with the exact Worker instance", async (context) => {
  const fixture = await fakeAppServer(context, "exitAfterThreadStart");
  let reported: { worker: SessionWorker; exited: boolean } | null = null;
  const worker = await fixture.create({
    onUnexpectedExit: (exited) => {
      reported = { worker: exited, exited: exited.exited };
    },
  });
  context.after(() => worker.close());

  await waitUntil(() => reported !== null);
  assert.equal(reported!.worker, worker);
  assert.equal(reported!.exited, true);
  assert.equal(worker.exited, true);
});

async function fakeAppServer(
  context: test.TestContext,
  mode: "shutdownOnStdinEnd" | "exitAfterThreadStart",
) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "codex-remote-worker-exit-")),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const exitedMarker = path.join(directory, "exited");
  const binary = path.join(directory, "fake-codex");
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = ${JSON.stringify(mode)};
const exit = () => {
  writeFileSync(${JSON.stringify(exitedMarker)}, "");
  process.exit(0);
};
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      userAgent: "fake", codexHome: "/tmp/fake-codex", platformFamily: "unix", platformOs: "linux",
    } }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: {
      thread: {
        id: "thread-1", sessionId: "session-1", preview: "", name: null,
        createdAt: 1, updatedAt: 1, cwd: ${JSON.stringify(directory)},
        turns: [], status: { type: "idle" },
      },
      cwd: ${JSON.stringify(directory)}, model: "test", reasoningEffort: null,
      approvalPolicy: "on-request", sandbox: { type: "workspace-write" },
    } }));
    if (mode === "exitAfterThreadStart") setTimeout(exit, 20);
  }
});
lines.on("close", () => {
  // 让关闭有可观察的耗时：第二个 close() 若不等待同一次关闭，会早于这里返回。
  setTimeout(exit, 150);
});
`, { mode: 0o755 });
  await chmod(binary, 0o755);
  return {
    exitedMarker,
    create: (options: { onUnexpectedExit?: (worker: SessionWorker, error: Error) => void } = {}) =>
      SessionWorker.create({
        projectId: "project-1",
        projects: {
          resolve: async () => ({ id: "project-1", path: directory }),
        } as unknown as ProjectCatalog,
        trash: {} as TrashStore,
        codexBinary: binary,
        workingDirectory: directory,
        ...options,
      }),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
