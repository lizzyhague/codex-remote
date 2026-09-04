import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ProjectCatalog } from "../projects/catalog.ts";
import {
  CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  CodexSessionService,
  TRASH_RETENTION_SECONDS,
  type AppServerRequester,
} from "./service.ts";
import { TrashStore } from "./trash-store.ts";

class FakeTransport implements AppServerRequester {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly results: unknown[] = [];

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    if (this.results.length === 0) {
      throw new Error("测试没有准备响应。");
    }
    return this.results.shift() as Result;
  }
}

async function createFixture(context: TestContext) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "codex-remote-sessions-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const root = path.join(temporaryDirectory, "projects");
  const projectPath = path.join(root, "alpha");
  const outsidePath = path.join(temporaryDirectory, "outside");
  await mkdir(projectPath, { recursive: true });
  await mkdir(outsidePath);
  const project = await realpath(projectPath);
  const outside = await realpath(outsidePath);
  const catalog = await ProjectCatalog.fromRoots([{ id: "workspace", path: root }]);
  const trash = await TrashStore.open(path.join(temporaryDirectory, "trash.json"));
  return { catalog, project, outside, trash };
}

function thread(
  id: string,
  cwd: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    sessionId: id,
    preview: "修复测试",
    name: null,
    createdAt: 10,
    updatedAt: 20,
    cwd,
    status: { type: "notLoaded" },
    turns: [],
    ...overrides,
  };
}

test("lists only sessions in the selected allowlisted project", async (context) => {
  const { catalog, project, outside, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push({
    data: [thread("thread-good", project), thread("thread-outside", outside)],
    nextCursor: "next-page",
  });
  const service = new CodexSessionService(transport, catalog, trash);

  const page = await service.list("workspace/alpha");

  assert.deepEqual(page, {
    sessions: [{
      id: "thread-good",
      sessionId: "thread-good",
      title: "修复测试",
      preview: "修复测试",
      createdAt: 10,
      updatedAt: 20,
      state: "not_loaded",
      deletedAt: null,
      purgeAt: null,
    }],
    nextCursor: "next-page",
  });
  assert.deepEqual(transport.requests[0], {
    method: "thread/list",
    params: {
      cursor: null,
      limit: 50,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
      cwd: project,
      archived: false,
    },
  });
});

test("starts a persistent session with a catalog-resolved cwd", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push({ thread: thread("thread-new", project) });
  const service = new CodexSessionService(transport, catalog, trash);

  const opened = await service.start("workspace/alpha");

  assert.equal(opened.session.id, "thread-new");
  assert.deepEqual(transport.requests[0], {
    method: "thread/start",
    params: {
      cwd: project,
      ephemeral: false,
      serviceName: "codex_remote",
      developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
    },
  });
});

test("checks ownership before resuming and returns stored turns", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push(
    { thread: thread("thread-old", project) },
    {
      thread: thread("thread-old", project, {
        status: { type: "idle" },
        turns: [{ id: "turn-1", status: "completed" }],
      }),
    },
  );
  const service = new CodexSessionService(transport, catalog, trash);

  const opened = await service.resume("workspace/alpha", "thread-old");

  assert.equal(opened.turns.length, 1);
  assert.deepEqual(transport.requests, [
    {
      method: "thread/read",
      params: { threadId: "thread-old", includeTurns: false },
    },
    {
      method: "thread/resume",
      params: {
        threadId: "thread-old",
        cwd: project,
        developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
      },
    },
  ]);
});

test("refuses to resume a session from another project", async (context) => {
  const { catalog, outside, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push({ thread: thread("thread-outside", outside) });
  const service = new CodexSessionService(transport, catalog, trash);

  await assert.rejects(
    service.resume("workspace/alpha", "thread-outside"),
    /不属于所选项目/u,
  );
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0]?.method, "thread/read");
});

test("moves an active session to trash and restores it to the active list", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    {},
  );
  const now = 1_000;
  const service = new CodexSessionService(transport, catalog, trash, { now: () => now });

  const removed = await service.moveToTrash("workspace/alpha", ["thread-old"], "active");
  assert.deepEqual(removed, { succeeded: ["thread-old"], failed: [] });
  assert.deepEqual(transport.requests.map((request) => request.method), [
    "thread/read",
    "thread/archive",
  ]);
  transport.results.push({
    thread: thread("thread-old", project, { status: { type: "idle" } }),
  });
  assert.deepEqual(await service.list("workspace/alpha", { view: "trash" }), {
    sessions: [{
      id: "thread-old",
      sessionId: "thread-old",
      title: "修复测试",
      preview: "修复测试",
      createdAt: 10,
      updatedAt: 20,
      state: "idle",
      deletedAt: now,
      purgeAt: now + TRASH_RETENTION_SECONDS,
    }],
    nextCursor: null,
  });

  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
  );
  const restored = await service.restoreTrash("workspace/alpha", ["thread-old"]);
  assert.deepEqual(restored, { succeeded: ["thread-old"], failed: [] });
  assert.equal(trash.has("thread-old"), false);
  assert.deepEqual(transport.requests.slice(3).map((request) => request.method), [
    "thread/read",
    "thread/unarchive",
  ]);
});

test("permanently deletes selected trash sessions immediately", async (context) => {
  const { catalog, trash } = await createFixture(context);
  await trash.put({
    threadId: "thread-old",
    projectId: "workspace/alpha",
    deletedAt: 1_000,
    origin: "active",
  });
  const transport = new FakeTransport();
  transport.results.push({});
  const service = new CodexSessionService(transport, catalog, trash);

  assert.deepEqual(await service.deleteTrash("workspace/alpha", ["thread-old"]), {
    succeeded: ["thread-old"],
    failed: [],
  });
  assert.equal(trash.has("thread-old"), false);
  assert.deepEqual(transport.requests, [{
    method: "thread/delete",
    params: { threadId: "thread-old" },
  }]);
});

test("refuses to permanently delete a session that is not in trash", async (context) => {
  const { catalog, trash } = await createFixture(context);
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash);
  const result = await service.deleteTrash("workspace/alpha", ["thread-old"]);
  assert.equal(result.succeeded.length, 0);
  assert.match(result.failed[0]?.message ?? "", /只能永久删除回收站里的会话/u);
  assert.deepEqual(transport.requests, []);
});

test("permanently deletes trash entries after thirty days", async (context) => {
  const { catalog, trash } = await createFixture(context);
  await trash.put({
    threadId: "thread-expired",
    projectId: "workspace/alpha",
    deletedAt: 100,
    origin: "archived",
  });
  const transport = new FakeTransport();
  transport.results.push({});
  const service = new CodexSessionService(transport, catalog, trash, {
    now: () => 100 + TRASH_RETENTION_SECONDS,
  });

  assert.deepEqual(await service.purgeExpired(), { deleted: 1, failed: [] });
  assert.equal(trash.has("thread-expired"), false);
  assert.deepEqual(transport.requests, [{
    method: "thread/delete",
    params: { threadId: "thread-expired" },
  }]);
});

test("does not archive a session while its task is active", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push({
    thread: thread("thread-running", project, { status: { type: "active" } }),
  });
  const service = new CodexSessionService(transport, catalog, trash);

  const result = await service.archive("workspace/alpha", ["thread-running"]);
  assert.equal(result.succeeded.length, 0);
  assert.match(result.failed[0]?.message ?? "", /仍有任务正在运行/u);
  assert.deepEqual(transport.requests.map((request) => request.method), ["thread/read"]);
});
