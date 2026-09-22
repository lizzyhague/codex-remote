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
  sandboxPolicyByProfile: Record<string, JsonObject> = {
    ":read-only": { type: "readOnly", networkAccess: false },
    ":workspace": { type: "workspaceWrite", writableRoots: [] },
    ":full-access": { type: "dangerFullAccess" },
  };
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
    if (method === "thread/settings/update") {
      this.#emitSettingsUpdated((params as JsonObject).permissions);
      return {} as Result;
    }
    return {} as Result;
  }

  /**
   * 照 codex-cli 0.153.4 实测的行为：切到某个权限方案会回 `thread/settings/updated`
   * 并带上生效的沙箱策略；`permissions: null` 一条通知都不发，哪怕生效的沙箱真的变了。
   */
  #emitSettingsUpdated(permissions: unknown): void {
    if (typeof permissions !== "string") return;
    const sandboxPolicy = this.sandboxPolicyByProfile[permissions];
    if (!sandboxPolicy) return;
    this.notify({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          sandboxPolicy,
          activePermissionProfile: { id: permissions, extends: null },
        },
      },
    });
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
  runtime: Partial<{
    sandboxPolicy: unknown;
    activePermissionProfile: { id: string; extends: string | null } | null;
  }> = {},
): CommandRunner {
  return new CommandRunner(transport, "thread-1", {
    cwd: "/projects/demo",
    historyMode,
    model: "gpt-old",
    reasoningEffort: "low",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" },
    activePermissionProfile: { id: ":workspace", extends: null },
    ...runtime,
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
  assert.equal(permissions.items[1]?.selected, true);
  assert.equal(permissions.items[1]?.label.includes("✓"), false);
  assert.equal(permissions.items[0]?.selected, false);
  assert.equal(permissions.items[2]?.disabled, true);
  runner.dispose();
});

test("runs all six commands through app-server methods", async () => {
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
  assert.deepEqual(
    (await runner.rewind()).map((turn) => turn.id),
    ["turn-after-rewind"],
  );

  const methods = transport.requests.map((request) => request.method);
  assert.ok(methods.includes("thread/settings/update"));
  assert.ok(methods.includes("thread/name/set"));
  assert.ok(methods.includes("thread/compact/start"));
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
  // 关闭动作必须落到一个具体的受限方案。`permissions: null` 只是清回部署默认，
  // 而默认本身可能就是 Full access，App Server 对它又不发通知，等于关不掉也看不出来。
  assert.deepEqual(updates, [
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", permissions: ":full-access" },
    },
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", permissions: ":workspace" },
    },
  ]);
  runner.dispose();
});

test("reads Full access from the sandbox policy, not the profile name", async () => {
  // 主机默认权限就是 Full access 时的样子：方案名什么都不带，沙箱策略说了算。
  const enabled = createRunner(new FakeTransport(), "legacy", {
    sandboxPolicy: { type: "dangerFullAccess" },
    activePermissionProfile: null,
  });
  assert.equal(enabled.fullAccessEnabled(), true);
  enabled.dispose();

  // 反过来，名字里带 full 但沙箱是只读，就不能当成 Full access。
  const disabled = createRunner(new FakeTransport(), "legacy", {
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: { id: ":full-access", extends: null },
  });
  assert.equal(disabled.fullAccessEnabled(), false);
  disabled.dispose();
});

test("does not claim Full access is off when the sandbox says otherwise", async () => {
  const transport = new FakeTransport();
  transport.fullAccessAllowed = true;
  // 切到受限方案，Codex 却报告沙箱仍是完全访问。
  transport.sandboxPolicyByProfile[":workspace"] = { type: "dangerFullAccess" };
  const runner = createRunner(transport, "legacy", {
    sandboxPolicy: { type: "dangerFullAccess" },
    activePermissionProfile: null,
  });

  const result = await runner.toggleFullAccess();
  assert.equal(result.title, "Full access 没有关闭");
  assert.equal(result.fullAccessEnabled, true);
  assert.equal(runner.fullAccessEnabled(), true);
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
