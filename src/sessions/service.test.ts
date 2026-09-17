import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ProjectCatalog } from "../projects/catalog.ts";
import {
  CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  CodexSessionService,
  composeDeveloperInstructions,
  TRASH_RETENTION_SECONDS,
  type AppServerRequester,
} from "./service.ts";
import { ApplicationSettingsStore } from "../settings/store.ts";
import { TrashStore } from "./trash-store.ts";
import { MarkStore } from "./mark-store.ts";

const EXPECTED_CODEX_REMOTE_DEVELOPER_INSTRUCTIONS = [
  "Codex Remote 是一个由浏览器 PWA 和本机后端组成的远程使用平台；它通过 Codex App Server 将 Codex 接到网页，让用户从手机或电脑使用。你正在通过 Codex Remote 与用户对话。用户通过网页发送消息，看到的是 Codex Remote 的浏览器界面，不是 Codex CLI 的终端界面。",
  "后端服务 `codex-remote` 承载这次对话，是当前会话运行环境的一部分。修改、重启或停止该服务的进程、配置或网络连接，可能中断当前会话。涉及 Codex Remote 自身的操作时，先说明影响；能由你完成的操作和核查由你完成，必要时使用延迟重启。如果必须由用户在当前会话之外重启服务，只提供完成重启所需的最简命令，不要求用户代为核查。重启前告知用户：如果服务未能恢复，可以通过 SSH 登录 node1，改用不依赖该后端的 Codex CLI 寻求帮助。连接恢复后，由你自行核查服务状态并继续后续工作。不要把本可在重连后完成的核查步骤交给用户。",
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
  const marks = await MarkStore.open(path.join(temporaryDirectory, "marks.json"));
  const settings = await ApplicationSettingsStore.open(
    path.join(temporaryDirectory, "settings.json"),
  );
  return { catalog, project, outside, trash, marks, settings };
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
  await settings.update("始终用中文回复。");
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

  await settings.update("   ");
  transport.results.push({ thread: thread("thread-blank", project) });
  await service.start("workspace/alpha");
  assert.equal(
    (transport.requests.at(-1)?.params as { developerInstructions?: string })
      .developerInstructions,
    CODEX_REMOTE_DEVELOPER_INSTRUCTIONS,
  );
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
