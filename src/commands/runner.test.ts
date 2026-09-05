import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { ThreadHistoryMode } from "../generated/v2/ThreadHistoryMode.ts";
import { COMMAND_CATALOG } from "./catalog.ts";
import { CommandRunner } from "./runner.ts";

class FakeTransport implements AppServerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly #listeners = new Set<AppServerMessageListener>();
  fullAccessAllowed = false;
  paginatedTurns = [
    completedTurn("paginated-kept"),
    completedTurn("paginated-removed"),
  ];
  reverted = false;

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    if (method === "model/list") {
      return {
        data: [{
          id: "gpt-test",
          displayName: "GPT Test",
          description: "测试模型",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "较快" },
            { reasoningEffort: "medium", description: "平衡" },
            { reasoningEffort: "high", description: "更深入" },
          ],
        }],
        nextCursor: null,
      } as Result;
    }
    if (method === "permissionProfile/list") {
      return {
        data: [
          { id: ":read-only", description: "只读", allowed: true },
          { id: ":workspace", description: "项目内自动工作", allowed: true },
          {
            id: ":full-access",
            description: "完全访问",
            allowed: this.fullAccessAllowed,
          },
        ],
        nextCursor: null,
      } as Result;
    }
    if (method === "collaborationMode/list") {
      return {
        data: [
          { name: "Default", mode: "default", model: null, reasoning_effort: null },
          { name: "Plan", mode: "plan", model: "gpt-test", reasoning_effort: "high" },
        ],
      } as Result;
    }
    if (method === "review/start") {
      return { turn: { id: "review-1" }, reviewThreadId: "thread-1" } as Result;
    }
    if (method === "thread/rollback") {
      return {
        thread: {
          id: "thread-1",
          turns: [{
            id: "turn-after-rewind",
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          }],
        },
      } as Result;
    }
    if (method === "thread/turns/list") {
      const values = params as JsonObject;
      const turns = this.reverted ? this.paginatedTurns.slice(0, -1) : this.paginatedTurns;
      return {
        data: values.sortDirection === "desc" ? turns.slice(-1) : turns,
        nextCursor: null,
        backwardsCursor: null,
      } as Result;
    }
    if (method === "thread/revert") {
      this.reverted = true;
      return {
        thread: { id: "thread-1", turns: [] },
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
      } as Result;
    }
    return {} as Result;
  }

  onNotification(listener: AppServerMessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(message: JsonObject): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function createRunner(
  transport: FakeTransport,
  historyMode: ThreadHistoryMode = "legacy",
): CommandRunner {
  return new CommandRunner(transport, "thread-1", {
    cwd: "/projects/demo",
    historyMode,
    model: "gpt-old",
    reasoningEffort: "low",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" },
    activePermissionProfile: { id: ":workspace", extends: null },
  });
}

function completedTurn(id: string) {
  return {
    id,
    items: [],
    itemsView: "summary" as const,
    status: "completed" as const,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

test("publishes the seven commands in alphabetical order", () => {
  const names = COMMAND_CATALOG.map((command) => command.name);
  assert.deepEqual(names, [
    "compact",
    "model",
    "permissions",
    "plan",
    "rename",
    "review",
    "rewind",
  ]);
  assert.match(COMMAND_CATALOG.find((command) => command.name === "rewind")?.confirmation ?? "", /不会撤销/);
});

test("builds dynamic model and permission menus", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport);

  const models = await runner.options("model");
  assert.equal(models.items[0]?.id, "gpt-test");
  assert.deepEqual(
    models.items[0]?.items?.map((item) => item.id),
    ["low", "medium", "high"],
  );
  assert.match(models.items[0]?.items?.[1]?.description ?? "", /模型默认/);
  const permissions = await runner.options("permissions");
  assert.equal(permissions.items[1]?.label.startsWith("✓ "), true);
  assert.equal(permissions.items[2]?.disabled, true);
  runner.dispose();
});

test("runs all seven commands through app-server methods", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport);

  const modelResult = await runner.setModel("gpt-test", "high");
  assert.equal(modelResult.title, "模型已切换");
  assert.equal(modelResult.lines.at(-1), "思考强度：high");
  const permissionsResult = await runner.setPermissions(":read-only");
  assert.equal(permissionsResult.title, "权限已更新");
  assert.equal(permissionsResult.fullAccessEnabled, false);
  assert.equal((await runner.togglePlan()).title, "已进入计划模式");
  assert.equal((await runner.rename("测试会话")).sessionName, "测试会话");

  assert.equal(await runner.compact(), null);
  assert.equal(await runner.review(), "review-1");
  assert.deepEqual(
    (await runner.rewind()).map((turn) => turn.id),
    ["turn-after-rewind"],
  );

  const methods = transport.requests.map((request) => request.method);
  assert.ok(methods.includes("thread/settings/update"));
  assert.ok(methods.includes("thread/name/set"));
  assert.ok(methods.includes("thread/compact/start"));
  assert.ok(methods.includes("review/start"));
  assert.deepEqual(transport.requests.find((request) => request.method === "thread/rollback"), {
    method: "thread/rollback",
    params: { threadId: "thread-1", numTurns: 1 },
  });
  assert.equal(methods.includes("turn/start"), false);
  assert.deepEqual(
    transport.requests.find((request) => request.method === "thread/settings/update"),
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", model: "gpt-test", effort: "high" },
    },
  );
  runner.dispose();
});

test("rewinds paginated history with thread/revert and reloads retained turns", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport, "paginated");

  assert.deepEqual(
    (await runner.rewind()).map((turn) => turn.id),
    ["paginated-kept"],
  );
  assert.deepEqual(
    transport.requests.map((request) => request.method),
    ["thread/turns/list", "thread/revert", "thread/turns/list"],
  );
  assert.deepEqual(transport.requests[1], {
    method: "thread/revert",
    params: { threadId: "thread-1", beforeTurnId: "paginated-removed" },
  });
  runner.dispose();
});

test("toggles Full access for only the current thread and restores defaults", async () => {
  const transport = new FakeTransport();
  transport.fullAccessAllowed = true;
  const runner = createRunner(transport);

  const enabled = await runner.toggleFullAccess();
  assert.equal(enabled.fullAccessEnabled, true);
  assert.equal(runner.fullAccessEnabled(), true);
  const disabled = await runner.toggleFullAccess();
  assert.equal(disabled.fullAccessEnabled, false);
  assert.equal(runner.fullAccessEnabled(), false);

  const updates = transport.requests.filter((request) =>
    request.method === "thread/settings/update"
  );
  assert.deepEqual(updates, [
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", permissions: ":full-access" },
    },
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", permissions: null },
    },
  ]);
  runner.dispose();
});

test("rejects an effort the selected model does not support", async () => {
  const runner = createRunner(new FakeTransport());
  await assert.rejects(
    runner.setModel("gpt-test", "xhigh"),
    /不支持所选思考强度/,
  );
  runner.dispose();
});
