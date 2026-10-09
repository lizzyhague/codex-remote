import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ProjectCatalog } from "../projects/catalog.ts";
import { AppServerRpcError } from "../app-server/client.ts";
import {
  CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  CodexSessionService,
  composeDeveloperInstructions,
  TRASH_RETENTION_SECONDS,
  type AppServerRequester,
} from "./service.ts";
import { ApplicationSettingsStore } from "../settings/store.ts";
import { TrashStore, type TrashEntry } from "./trash-store.ts";
import { injectFsFaults } from "../workers/fs-fault-injection.ts";
import { MarkStore } from "./mark-store.ts";

const EXPECTED_CODEX_REMOTE_DEVELOPER_INSTRUCTIONS = [
  "Codex Remote 是一个由浏览器 PWA 和本机后端组成的远程使用平台；它通过 Codex App Server 将 Codex 接到网页，让用户从手机或电脑使用。你正在通过 Codex Remote 与用户对话。用户通过网页发送消息，看到的是 Codex Remote 的浏览器界面，不是 Codex CLI 的终端界面。",
  "后端服务 `codex-remote` 承载这次对话，是当前会话运行环境的一部分。修改、重启或停止该服务的进程、配置或网络连接，可能中断当前会话。涉及 Codex Remote 自身的操作时，先说明影响；能由你完成的操作和核查由你完成，必要时使用延迟重启。如果必须由用户在当前会话之外重启服务，只给出重启所需的最简命令。",
  "需要交给用户查看的 Markdown 或图片分两类：正式文件保存在当前项目内它本来应该在的位置；只用于比较、挑选或试验的临时预览一律写到 ~/preview，不分项目、不纳入 Git，用户看过后会自行删除。不要把这类文件放到 ~/.codex 或 /tmp。回复中提供 Markdown 链接，目标为 /view?path= 加 URL 编码后的绝对路径。",
].join("\n\n");

class FakeTransport implements AppServerRequester {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly results: unknown[] = [];

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    if (this.results.length === 0) {
      throw new Error("测试没有准备响应。");
    }
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result as Result;
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
  const trashPath = path.join(temporaryDirectory, "trash.json");
  const trash = await TrashStore.open(trashPath);
  const marks = await MarkStore.open(path.join(temporaryDirectory, "marks.json"));
  const settings = await ApplicationSettingsStore.open(
    path.join(temporaryDirectory, "settings.json"),
  );
  return { catalog, project, outside, trash, trashPath, marks, settings };
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
  transport.results.push(
    {
      data: [thread("thread-good", project), thread("thread-outside", outside)],
      nextCursor: "next-page",
    },
    {
      data: [
        { completedAt: null, items: [{ type: "agentMessage" }] },
        { completedAt: 19, items: [{ type: "agentMessage" }] },
      ],
      nextCursor: null,
    },
  );
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
      lastReplyAt: 19,
      state: "not_loaded",
      projectId: "workspace/alpha",
      marked: false,
      deletedAt: null,
      purgeAt: null,
    }],
    marked: [],
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
  assert.deepEqual(transport.requests[1], {
    method: "thread/turns/list",
    params: {
      threadId: "thread-good",
      cursor: null,
      limit: 20,
      sortDirection: "desc",
      itemsView: "summary",
    },
  });

  transport.results.push({
    data: [thread("thread-good", project)],
    nextCursor: null,
  });
  const refreshed = await service.list("workspace/alpha");
  assert.equal(refreshed.sessions[0]?.lastReplyAt, 19);
  assert.equal(
    transport.requests.filter((request) => request.method === "thread/turns/list").length,
    1,
  );
});

test("composeDeveloperInstructions keeps the built-in text and appends nonblank custom copy", () => {
  assert.equal(composeDeveloperInstructions(""), CODEX_REMOTE_DEVELOPER_INSTRUCTIONS);
  assert.equal(composeDeveloperInstructions("   \n"), CODEX_REMOTE_DEVELOPER_INSTRUCTIONS);
  assert.equal(
    composeDeveloperInstructions("始终用中文回复。"),
    `${CODEX_REMOTE_DEVELOPER_INSTRUCTIONS}\n\n始终用中文回复。`,
  );
});

test("starts a persistent session with a catalog-resolved cwd", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push({ thread: thread("thread-new", project) });
  const service = new CodexSessionService(transport, catalog, trash);

  const opened = await service.start("workspace/alpha");

  assert.equal(opened.session.id, "thread-new");
  assert.equal(
    CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
    EXPECTED_CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  );
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

test("injects saved developerInstructions on start and resume", async (context) => {
  const { catalog, project, trash, settings } = await createFixture(context);
  await settings.update({ developerInstructions: "始终用中文回复。" });
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { settings });
  const expected = `${CODEX_REMOTE_DEVELOPER_INSTRUCTIONS}\n\n始终用中文回复。`;

  transport.results.push({ thread: thread("thread-new", project) });
  await service.start("workspace/alpha");
  assert.equal(
    (transport.requests[0]?.params as { developerInstructions?: string }).developerInstructions,
    expected,
  );
  assert.equal(
    "baseInstructions" in (transport.requests[0]?.params as object),
    false,
  );

  transport.results.push(
    { thread: thread("thread-old", project) },
    { thread: thread("thread-old", project) },
  );
  await service.resume("workspace/alpha", "thread-old");
  const resume = transport.requests.find((request) => request.method === "thread/resume");
  assert.equal(
    (resume?.params as { developerInstructions?: string }).developerInstructions,
    expected,
  );
  assert.equal("baseInstructions" in (resume?.params as object), false);

  await settings.update({ developerInstructions: "   " });
  transport.results.push({ thread: thread("thread-blank", project) });
  await service.start("workspace/alpha");
  assert.equal(
    (transport.requests.at(-1)?.params as { developerInstructions?: string })
      .developerInstructions,
    CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  );
});

test("uses saved model defaults only when starting a new session", async (context) => {
  const { catalog, project, trash, settings } = await createFixture(context);
  await settings.update({
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
  });
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { settings });

  transport.results.push({
    thread: thread("thread-new", project),
    model: "gpt-test",
    reasoningEffort: "high",
  });
  await service.start("workspace/alpha");
  assert.deepEqual(transport.requests[0], {
    method: "thread/start",
    params: {
      cwd: project,
      ephemeral: false,
      serviceName: "codex_remote",
      developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
      model: "gpt-test",
      config: { model_reasoning_effort: "high" },
    },
  });

  transport.results.push(
    { thread: thread("thread-old", project) },
    { thread: thread("thread-old", project) },
  );
  await service.resume("workspace/alpha", "thread-old");
  const resume = transport.requests.find((request) => request.method === "thread/resume");
  assert.deepEqual(resume, {
    method: "thread/resume",
    params: {
      threadId: "thread-old",
      cwd: project,
      developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
    },
  });
});

test("starts new sessions with the saved permissions paired with an approval policy", async (context) => {
  const { catalog, project, trash, settings } = await createFixture(context);
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { settings });
  const base = {
    cwd: project,
    ephemeral: false,
    serviceName: "codex_remote",
    developerInstructions: CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  };

  await settings.update({ defaultPermissions: ":danger-full-access" });
  transport.results.push({ thread: thread("thread-full", project) });
  const full = await service.start("workspace/alpha");
  assert.equal(full.settingsNotice, undefined);
  assert.deepEqual(transport.requests.at(-1), {
    method: "thread/start",
    params: { ...base, permissions: ":danger-full-access", approvalPolicy: "never" },
  });

  await settings.update({ defaultPermissions: ":workspace" });
  transport.results.push({ thread: thread("thread-workspace", project) });
  await service.start("workspace/alpha");
  assert.deepEqual(transport.requests.at(-1), {
    method: "thread/start",
    params: { ...base, permissions: ":workspace", approvalPolicy: "on-request" },
  });

  transport.results.push(
    { thread: thread("thread-old", project) },
    { thread: thread("thread-old", project) },
  );
  await service.resume("workspace/alpha", "thread-old");
  const resume = transport.requests.at(-1)?.params as Record<string, unknown>;
  assert.equal("permissions" in resume, false);
  assert.equal("approvalPolicy" in resume, false);
});

test("falls back to Codex default permissions only when Codex rejects the profile", async (context) => {
  const { catalog, project, trash, settings } = await createFixture(context);
  await settings.update({ defaultPermissions: ":gone" });
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { settings });
  const warn = context.mock.method(console, "warn", () => {});

  transport.results.push(
    new AppServerRpcError({
      code: -32600,
      message:
        "failed to load configuration: default_permissions refers to unknown built-in profile `:gone`",
    }),
    { thread: thread("thread-fallback", project) },
  );
  const opened = await service.start("workspace/alpha");
  assert.match(opened.settingsNotice ?? "", /默认权限当前不可用/u);
  assert.equal(warn.mock.callCount(), 1);
  const retry = transport.requests.at(-1)?.params as Record<string, unknown>;
  assert.equal("permissions" in retry, false);
  assert.equal("approvalPolicy" in retry, false);
  assert.equal(settings.get().defaultPermissions, ":gone", "the saved setting is kept");

  transport.results.push(new AppServerRpcError({ code: -32603, message: "not logged in" }));
  const before = transport.requests.length;
  await assert.rejects(service.start("workspace/alpha"), /not logged in/u);
  assert.equal(transport.requests.length, before + 1, "other failures are not retried");
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

test("resuming reads the current pin without changing the stored mark or adding RPCs", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { marks });
  const threadId = "thread-pinned";
  await marks.put({ threadId, projectId: "workspace/alpha" });

  for (const marked of [true, false]) {
    if (!marked) await marks.remove(threadId);
    transport.results.push(
      { thread: thread(threadId, project) },
      { thread: thread(threadId, project) },
    );
    const opened = await service.resume("workspace/alpha", threadId);
    assert.equal(opened.session.marked, marked);
    assert.equal(service.isMarked(threadId), marked);
    assert.equal(marks.has(threadId), marked);
  }
  assert.deepEqual(transport.requests.map(({ method }) => method), [
    "thread/read", "thread/resume", "thread/read", "thread/resume",
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
      lastReplyAt: null,
      state: "idle",
      projectId: "workspace/alpha",
      marked: false,
      deletedAt: now,
      purgeAt: now + TRASH_RETENTION_SECONDS,
    }],
    marked: [],
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
  const { catalog, trash, marks } = await createFixture(context);
  await trash.put({
    threadId: "thread-old",
    projectId: "workspace/alpha",
    deletedAt: 1_000,
    origin: "active",
    state: "trashed",
  });
  await marks.put({ threadId: "thread-old", projectId: "workspace/alpha" });
  const transport = new FakeTransport();
  transport.results.push({});
  const forgotten: string[] = [];
  const service = new CodexSessionService(transport, catalog, trash, {
    marks,
    deletedSessionArtifacts: {
      async forgetSession(threadId) {
        forgotten.push(threadId);
      },
    },
  });

  assert.deepEqual(await service.deleteTrash("workspace/alpha", ["thread-old"]), {
    succeeded: ["thread-old"],
    failed: [],
  });
  assert.equal(trash.has("thread-old"), false);
  assert.equal(marks.has("thread-old"), false);
  assert.deepEqual(forgotten, ["thread-old"]);
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
    state: "trashed",
  });
  const transport = new FakeTransport();
  transport.results.push({});
  const service = new CodexSessionService(transport, catalog, trash, {
    now: () => 100 + TRASH_RETENTION_SECONDS,
  });

  assert.deepEqual(await service.purgeExpired(), { settled: 0, deleted: 1, failed: [] });
  assert.equal(trash.has("thread-expired"), false);
  assert.deepEqual(transport.requests, [{
    method: "thread/delete",
    params: { threadId: "thread-expired" },
  }]);
});

test("rechecks retention after an expired session is restored and trashed again", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  for (const threadId of ["thread-blocking", "thread-refreshed"]) {
    await trash.put({
      threadId,
      projectId: "workspace/alpha",
      deletedAt: 100,
      origin: "archived",
      state: "trashed",
    });
  }
  const firstDeleteStarted = Promise.withResolvers<void>();
  const releaseFirstDelete = Promise.withResolvers<void>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const transport: AppServerRequester = {
    async request<Result>(method: string, params: unknown) {
      requests.push({ method, params });
      const threadId = (params as { threadId?: unknown }).threadId;
      if (method === "thread/delete") {
        assert.equal(threadId, "thread-blocking");
        firstDeleteStarted.resolve();
        await releaseFirstDelete.promise;
        return {} as Result;
      }
      if (method === "thread/read" && threadId === "thread-refreshed") {
        return { thread: thread("thread-refreshed", project) } as Result;
      }
      assert.fail(`unexpected request: ${method} ${String(threadId)}`);
    },
  };
  let now = 100 + TRASH_RETENTION_SECONDS;
  const service = new CodexSessionService(transport, catalog, trash, { now: () => now });

  const cleanup = service.purgeExpired();
  await firstDeleteStarted.promise;
  const restore = service.restoreTrash("workspace/alpha", ["thread-refreshed"]);
  now += 1;
  const retrash = service.moveToTrash(
    "workspace/alpha",
    ["thread-refreshed"],
    "archived",
  );
  releaseFirstDelete.resolve();
  assert.deepEqual(await restore, { succeeded: ["thread-refreshed"], failed: [] });
  assert.deepEqual(
    await retrash,
    { succeeded: ["thread-refreshed"], failed: [] },
  );

  assert.deepEqual(await cleanup, { settled: 0, deleted: 1, failed: [] });
  assert.equal(trash.has("thread-blocking"), false);
  assert.deepEqual(trash.get("thread-refreshed"), {
    threadId: "thread-refreshed",
    projectId: "workspace/alpha",
    deletedAt: now,
    origin: "archived",
    state: "trashed",
  });
  assert.deepEqual(
    requests.filter((request) => request.method === "thread/delete"),
    [{ method: "thread/delete", params: { threadId: "thread-blocking" } }],
  );
});

test("startup cleanup resumes a recent deletion left in progress", async (context) => {
  const { catalog, trash, marks } = await createFixture(context);
  await trash.put({
    threadId: "thread-pending",
    projectId: "workspace/alpha",
    deletedAt: 1_000,
    origin: "active",
    state: "deleting",
  });
  await marks.put({ threadId: "thread-pending", projectId: "workspace/alpha" });
  const transport = new FakeTransport();
  transport.results.push(new AppServerRpcError({
    code: -32600,
    message: "no rollout found for thread id thread-pending",
  }));
  const forgotten: string[] = [];
  const service = new CodexSessionService(transport, catalog, trash, {
    now: () => 1_001,
    marks,
    deletedSessionArtifacts: {
      async forgetSession(threadId) {
        forgotten.push(threadId);
      },
    },
  });

  assert.deepEqual(await service.purgeExpired(), { settled: 0, deleted: 1, failed: [] });
  assert.deepEqual(forgotten, ["thread-pending"]);
  assert.equal(trash.has("thread-pending"), false);
  assert.equal(marks.has("thread-pending"), false);
});

test("a pending permanent deletion cannot reappear in trash or be restored", async (context) => {
  const { catalog, trash } = await createFixture(context);
  await trash.put({
    threadId: "thread-pending",
    projectId: "workspace/alpha",
    deletedAt: 1_000,
    origin: "active",
    state: "deleting",
  });
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash);

  assert.deepEqual(await service.list("workspace/alpha", { view: "trash" }), {
    sessions: [],
    marked: [],
    nextCursor: null,
  });
  assert.deepEqual(await service.restoreTrash("workspace/alpha", ["thread-pending"]), {
    succeeded: [],
    failed: [{
      sessionId: "thread-pending",
      message: "这个会话正在永久删除，不能恢复。",
    }],
  });
  assert.deepEqual(transport.requests, []);
});

function trashEntry(overrides: Partial<TrashEntry> = {}): TrashEntry {
  return {
    threadId: "thread-old",
    projectId: "workspace/alpha",
    deletedAt: 1_000,
    origin: "active",
    state: "trashed",
    ...overrides,
  };
}

function rpcError(message: string, code = -32600): AppServerRpcError {
  return new AppServerRpcError({ code, message });
}

test("keeps a durable trashing record when the trash write fails after archive", async (context) => {
  const { catalog, project, trash, trashPath } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    {},
  );
  const service = new CodexSessionService(transport, catalog, trash, { now: () => 1_000 });
  // 第一次写是 `trashing` 凭据，第二次写 `trashed` 时失败。
  const faults = injectFsFaults(context, { fail: { "file-write": 2 } });

  const result = await service.moveToTrash("workspace/alpha", ["thread-old"], "active");
  assert.deepEqual(result, {
    succeeded: [],
    failed: [{ sessionId: "thread-old", message: "会话整理失败，请查看服务日志。" }],
  });
  // 不再尽力 unarchive：Codex 已归档，本地凭据负责把这次请求做完。
  assert.deepEqual(transport.requests.map((request) => request.method), [
    "thread/read",
    "thread/archive",
  ]);
  assert.deepEqual(trash.get("thread-old"), trashEntry({ state: "trashing" }));
  assert.deepEqual(
    (await TrashStore.open(trashPath)).get("thread-old"),
    trashEntry({ state: "trashing" }),
  );

  // 回收站里能看到它，不会从三个列表同时消失。
  transport.results.push({
    thread: thread("thread-old", project, { status: { type: "idle" } }),
  });
  const page = await service.list("workspace/alpha", { view: "trash" });
  assert.deepEqual(page.sessions.map((session) => session.id), ["thread-old"]);

  // 重试同一请求：重复归档得到精确的 no rollout found，视为已完成。
  faults.heal();
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    rpcError("no rollout found for thread id thread-old"),
  );
  assert.deepEqual(
    await service.moveToTrash("workspace/alpha", ["thread-old"], "active"),
    { succeeded: ["thread-old"], failed: [] },
  );
  assert.deepEqual(transport.requests.slice(3).map((request) => request.method), [
    "thread/read",
    "thread/archive",
  ]);
  assert.deepEqual(
    (await TrashStore.open(trashPath)).get("thread-old"),
    trashEntry({ state: "trashed" }),
  );
});

test("startup cleanup finishes a move to trash interrupted before or after archive", async (context) => {
  const { catalog, trash, trashPath } = await createFixture(context);
  // 两条都停在 `trashing`：一条退出时还没归档，一条已归档但没来得及登记。
  await trash.put(trashEntry({ threadId: "thread-before", state: "trashing" }));
  await trash.put(trashEntry({ threadId: "thread-after", state: "trashing" }));
  const transport = new FakeTransport();
  transport.results.push(
    {},
    rpcError("no rollout found for thread id thread-after"),
  );
  const service = new CodexSessionService(transport, catalog, await TrashStore.open(trashPath), {
    now: () => 1_001,
  });
  const changes: unknown[] = [];
  service.onChange((event) => changes.push(event));

  assert.deepEqual(await service.purgeExpired(), { settled: 2, deleted: 0, failed: [] });
  assert.deepEqual(transport.requests, [
    { method: "thread/archive", params: { threadId: "thread-before" } },
    { method: "thread/archive", params: { threadId: "thread-after" } },
  ]);
  assert.deepEqual(
    (await TrashStore.open(trashPath)).list().map((entry) => [entry.threadId, entry.state]),
    [["thread-before", "trashed"], ["thread-after", "trashed"]],
  );
  assert.deepEqual(changes, [
    { projectId: "workspace/alpha", sessionIds: ["thread-before"], change: "trash" },
    { projectId: "workspace/alpha", sessionIds: ["thread-after"], change: "trash" },
  ]);
});

test("a failed restore stays restorable and a retry tolerates an earlier unarchive", async (context) => {
  const { catalog, project, trash, trashPath } = await createFixture(context);
  await trash.put(trashEntry());
  const transport = new FakeTransport();
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    new Error("app-server 连接已断开"),
  );
  const service = new CodexSessionService(transport, catalog, trash);

  assert.deepEqual(await service.restoreTrash("workspace/alpha", ["thread-old"]), {
    succeeded: [],
    failed: [{ sessionId: "thread-old", message: "会话整理失败，请查看服务日志。" }],
  });
  assert.deepEqual(
    (await TrashStore.open(trashPath)).get("thread-old"),
    trashEntry({ state: "restoring" }),
  );
  transport.results.push({
    thread: thread("thread-old", project, { status: { type: "idle" } }),
  });
  const page = await service.list("workspace/alpha", { view: "trash" });
  assert.deepEqual(page.sessions.map((session) => session.id), ["thread-old"]);

  // 断开前 Codex 其实已经恢复：重复 unarchive 得到精确的 no archived rollout found。
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    rpcError("no archived rollout found for thread id thread-old"),
  );
  assert.deepEqual(await service.restoreTrash("workspace/alpha", ["thread-old"]), {
    succeeded: ["thread-old"],
    failed: [],
  });
  assert.deepEqual(transport.requests.slice(3).map((request) => request.method), [
    "thread/read",
    "thread/unarchive",
  ]);
  assert.equal((await TrashStore.open(trashPath)).has("thread-old"), false);
});

test("startup cleanup finishes an interrupted restore instead of purging it", async (context) => {
  const { catalog, trash, trashPath } = await createFixture(context);
  // 已超过 30 天，但用户最后的意图是恢复，不能被当成过期条目永久删除。
  await trash.put(trashEntry({ threadId: "thread-ok", deletedAt: 100, state: "restoring" }));
  await trash.put(trashEntry({ threadId: "thread-stuck", deletedAt: 100, state: "restoring" }));
  const transport = new FakeTransport();
  transport.results.push(
    rpcError("no archived rollout found for thread id thread-ok"),
    new Error("app-server 连接已断开"),
  );
  const service = new CodexSessionService(transport, catalog, trash, {
    now: () => 100 + TRASH_RETENTION_SECONDS,
  });
  const changes: unknown[] = [];
  service.onChange((event) => changes.push(event));

  assert.deepEqual(await service.purgeExpired(), {
    settled: 1,
    deleted: 0,
    failed: [{ sessionId: "thread-stuck", message: "会话整理失败，请查看服务日志。" }],
  });
  assert.deepEqual(transport.requests.map((request) => request.method), [
    "thread/unarchive",
    "thread/unarchive",
  ]);
  assert.deepEqual(
    (await TrashStore.open(trashPath)).list().map((entry) => [entry.threadId, entry.state]),
    [["thread-stuck", "restoring"]],
  );
  assert.deepEqual(changes, [
    { projectId: "workspace/alpha", sessionIds: ["thread-ok"], change: "restore" },
  ]);
});

test("only the exact already-done response counts as a finished archive", async (context) => {
  const { catalog, trash } = await createFixture(context);
  await trash.put(trashEntry({ state: "trashing" }));
  const transport = new FakeTransport();
  transport.results.push(
    rpcError("no rollout found for thread id thread-other"),
    rpcError("no rollout found for thread id thread-old", -32603),
  );
  const service = new CodexSessionService(transport, catalog, trash);

  for (const message of [
    "no rollout found for thread id thread-other",
    "no rollout found for thread id thread-old",
  ]) {
    assert.deepEqual(await service.purgeExpired(), {
      settled: 0,
      deleted: 0,
      failed: [{ sessionId: "thread-old", message: "会话整理失败，请查看服务日志。" }],
    });
    assert.equal(trash.get("thread-old")?.state, "trashing");
  }
});

test("trashing and restoring an archived-origin session only touch the trash list", async (context) => {
  const { catalog, project, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
    { thread: thread("thread-old", project, { status: { type: "idle" } }) },
  );
  const service = new CodexSessionService(transport, catalog, trash, { now: () => 1_000 });

  await service.moveToTrash("workspace/alpha", ["thread-old"], "archived");
  assert.deepEqual(trash.get("thread-old"), trashEntry({ origin: "archived" }));
  await service.restoreTrash("workspace/alpha", ["thread-old"]);
  assert.equal(trash.has("thread-old"), false);
  assert.deepEqual(transport.requests.map((request) => request.method), [
    "thread/read",
    "thread/read",
  ]);
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

test("pins marked sessions across projects and omits them from the directory page", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  const betaDirectory = path.join(path.dirname(project), "beta");
  await mkdir(betaDirectory, { recursive: true });
  const beta = await realpath(betaDirectory);
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { marks });

  transport.results.push({
    thread: thread("thread-beta", beta, { status: { type: "idle" }, name: "别的项目" }),
  });
  const pinned = await service.setMarked("workspace/beta", "thread-beta", true);
  assert.equal(pinned.marked, true);
  assert.equal(pinned.projectId, "workspace/beta");
  assert.equal(marks.has("thread-beta"), true);

  transport.results.push(
    { data: [thread("thread-alpha", project)], nextCursor: null },
    { data: [], nextCursor: null },
    { thread: thread("thread-beta", beta, { status: { type: "idle" }, name: "别的项目" }) },
  );
  const page = await service.list("workspace/alpha");
  assert.deepEqual(page.sessions.map((session) => session.id), ["thread-alpha"]);
  assert.deepEqual(page.marked.map((session) => session.id), ["thread-beta"]);
  assert.equal(page.marked[0]?.projectId, "workspace/beta");
  assert.equal(page.marked[0]?.marked, true);

  transport.results.push({
    thread: thread("thread-beta", beta, { status: { type: "idle" }, name: "别的项目" }),
  });
  const unmarked = await service.setMarked("workspace/beta", "thread-beta", false);
  assert.equal(unmarked.marked, false);
  assert.equal(marks.has("thread-beta"), false);
});

test("keeps archived marked sessions out of the recent-session pin group", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash, { marks });
  transport.results.push({
    thread: thread("thread-home", project, { status: { type: "idle" } }),
  });
  await service.setMarked("workspace/alpha", "thread-home", true);

  transport.results.push(
    { data: [thread("thread-other", project)], nextCursor: null },
    { data: [thread("thread-home", project)], nextCursor: null },
  );
  const page = await service.list("workspace/alpha");
  assert.deepEqual(page.sessions.map((session) => session.id), ["thread-other"]);
  assert.deepEqual(page.marked, []);
});

function archivedPagesWithout(count: number, project: string): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    data: [thread(`thread-archived-${index}`, project)],
    nextCursor: `archived-${index + 1}`,
  }));
}

test("a pinned session beyond the archive scan limit stays out of recent when it is not active", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  await marks.put({ threadId: "thread-deep", projectId: "workspace/alpha" });
  const transport = new FakeTransport();
  transport.results.push(
    { data: [thread("thread-other", project)], nextCursor: null },
    ...archivedPagesWithout(10, project),
    { data: [thread("thread-other", project)], nextCursor: null },
  );
  const service = new CodexSessionService(transport, catalog, trash, { marks });

  const page = await service.list("workspace/alpha");
  assert.deepEqual(page.sessions.map((session) => session.id), ["thread-other"]);
  assert.deepEqual(page.marked, []);
  const lists = transport.requests.filter((request) => request.method === "thread/list");
  assert.deepEqual(
    lists.map((request) => (request.params as { archived: boolean }).archived),
    [false, ...Array<boolean>(10).fill(true), false],
  );
  assert.equal(
    transport.requests.some((request) => request.method === "thread/read"),
    false,
  );
});

test("a pinned session beyond the archive scan limit is kept once found in the active list", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  await marks.put({ threadId: "thread-pinned", projectId: "workspace/alpha" });
  const transport = new FakeTransport();
  transport.results.push(
    { data: [thread("thread-other", project)], nextCursor: null },
    ...archivedPagesWithout(10, project),
    { data: [thread("thread-other", project)], nextCursor: "active-2" },
    { data: [thread("thread-pinned", project)], nextCursor: "active-3" },
    { thread: thread("thread-pinned", project, { status: { type: "idle" } }) },
  );
  const service = new CodexSessionService(transport, catalog, trash, { marks });

  const page = await service.list("workspace/alpha");
  assert.deepEqual(page.marked.map((session) => session.id), ["thread-pinned"]);
});

test("a pinned session unresolved in both bounded scans is treated as unknown", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  await marks.put({ threadId: "thread-unknown", projectId: "workspace/alpha" });
  const transport = new FakeTransport();
  transport.results.push(
    { data: [thread("thread-other", project)], nextCursor: null },
    ...archivedPagesWithout(10, project),
    ...archivedPagesWithout(10, project),
  );
  const service = new CodexSessionService(transport, catalog, trash, { marks });

  const page = await service.list("workspace/alpha");
  assert.deepEqual(page.marked, []);
  const methods = transport.requests.map((request) => request.method);
  assert.equal(methods.filter((method) => method === "thread/list").length, 21);
  assert.equal(methods.includes("thread/read"), false);
});

test("renames a not-loaded thread through app-server without resuming it", async (context) => {
  const { catalog, project, trash, marks } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push(
    { thread: thread("thread-old", project, { status: { type: "notLoaded" }, preview: "首条消息" }) },
    {},
  );
  const service = new CodexSessionService(transport, catalog, trash, { marks });
  const changes: Array<{ change: string; sessionIds: string[] }> = [];
  service.onChange((event) => changes.push(event));

  const renamed = await service.rename("workspace/alpha", "thread-old", "  新名字  ");
  assert.equal(renamed.title, "新名字");
  assert.equal(renamed.preview, "首条消息");
  assert.equal(renamed.marked, false);
  assert.deepEqual(transport.requests, [
    { method: "thread/read", params: { threadId: "thread-old", includeTurns: false } },
    { method: "thread/name/set", params: { threadId: "thread-old", name: "新名字" } },
  ]);
  assert.deepEqual(changes, [{
    projectId: "workspace/alpha",
    sessionIds: ["thread-old"],
    change: "rename",
  }]);
});

test("rejects an empty or oversized session rename before talking to Codex", async (context) => {
  const { catalog, trash } = await createFixture(context);
  const transport = new FakeTransport();
  const service = new CodexSessionService(transport, catalog, trash);

  await assert.rejects(service.rename("workspace/alpha", "thread-old", "   "), /会话名称不能为空/u);
  await assert.rejects(
    service.rename("workspace/alpha", "thread-old", "名".repeat(161)),
    /160 个字以内/u,
  );
  await assert.rejects(
    service.rename("workspace/alpha", "thread-old", "第一行\n第二行"),
    /不要换行/u,
  );
  assert.deepEqual(transport.requests, []);
});

test("refuses to rename a session from another project", async (context) => {
  const { catalog, outside, trash } = await createFixture(context);
  const transport = new FakeTransport();
  transport.results.push({ thread: thread("thread-outside", outside) });
  const service = new CodexSessionService(transport, catalog, trash);

  await assert.rejects(
    service.rename("workspace/alpha", "thread-outside", "新名字"),
    /不属于所选项目/u,
  );
  assert.deepEqual(transport.requests.map((request) => request.method), ["thread/read"]);
});
