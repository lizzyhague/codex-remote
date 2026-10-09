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
  legacyTurns = [
    completedTurn("legacy-kept"),
    completedTurn("legacy-removed"),
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
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          turns: this.legacyTurns,
        },
      } as Result;
    }
    if (method === "thread/rollback") {
      this.legacyTurns = this.legacyTurns.slice(0, -1);
      return {
        thread: {
          id: "thread-1",
          turns: this.legacyTurns,
        },
      } as Result;
    }
    if (method === "thread/turns/list") {
      const values = params as JsonObject;
      const turns = this.reverted ? this.paginatedTurns.slice(0, -1) : this.paginatedTurns;
      const descending = [...turns].reverse();
      const start = typeof values.cursor === "string" ? Number(values.cursor) : 0;
      const limit = typeof values.limit === "number" ? values.limit : descending.length;
      const data = descending.slice(start, start + limit);
      const nextCursor = start + data.length < descending.length
        ? String(start + data.length)
        : null;
      return {
        data: values.sortDirection === "desc" ? data : turns,
        nextCursor: values.sortDirection === "desc" ? nextCursor : null,
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

test("publishes the five commands in alphabetical order", () => {
  const names = COMMAND_CATALOG.map((command) => command.name);
  assert.deepEqual(names, [
    "compact",
    "model",
    "permissions",
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

test("stages model and permission choices without touching Codex", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport);

  const model = await runner.stageModel("gpt-test", null);
  assert.deepEqual(model.model, { id: "gpt-test", effort: "medium" });
  assert.equal(model.message.title, "模型将在下一轮生效");
  const permission = await runner.stagePermissions(":read-only");
  assert.equal(permission.permissions, ":read-only");
  assert.equal(permission.fullAccess, false);
  await assert.rejects(runner.stagePermissions(":full-access"), /当前不可用/);
  await assert.rejects(runner.stageModel("missing", null), /不在当前 Codex 返回的可用列表/);
  assert.equal(
    transport.requests.some((request) => request.method === "thread/settings/update"),
    false,
  );

  // 菜单优先把待生效的选择标成选中项。
  const permissions = await runner.options("permissions", { permissions: ":read-only" });
  assert.deepEqual(
    permissions.items.filter((item) => item.selected).map((item) => item.id),
    [":read-only"],
  );
  const models = await runner.options("model", { model: { id: "gpt-test", effort: "high" } });
  assert.equal(models.items[0]?.selected, true);
  assert.deepEqual(
    models.items[0]?.items?.filter((item) => item.selected).map((item) => item.id),
    ["high"],
  );
  runner.dispose();
});

test("runs all five commands through app-server methods", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport);

  const modelResult = await runner.setModel("gpt-test", "high");
  assert.equal(modelResult.title, "模型已切换");
  assert.equal(modelResult.lines.at(-1), "思考强度：high");
  const permissionsResult = await runner.setPermissions(":read-only");
  assert.equal(permissionsResult.title, "权限已更新");
  assert.equal(permissionsResult.fullAccessEnabled, false);
  // 受限方案明确带上“需要时询问”，config.toml 写了 never 也能弹出批准卡。
  assert.deepEqual(
    transport.requests.filter((request) => request.method === "thread/settings/update").at(-1),
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", permissions: ":read-only", approvalPolicy: "on-request" },
    },
  );
  assert.equal((await runner.rename("测试会话")).sessionName, "测试会话");

  assert.equal(await runner.compact(), null);
  assert.equal(await runner.rewind("legacy-removed"), "reverted");

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

test("rewinds only the named latest paginated turn and treats a retry as complete", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport, "paginated");

  assert.equal(await runner.rewind("paginated-removed"), "reverted");
  assert.deepEqual(
    transport.requests.map((request) => request.method),
    ["thread/turns/list", "thread/revert"],
  );
  assert.deepEqual(transport.requests[1], {
    method: "thread/revert",
    params: { threadId: "thread-1", beforeTurnId: "paginated-removed" },
  });
  assert.equal(await runner.rewind("paginated-removed"), "already_reverted");
  assert.equal(
    transport.requests.filter((request) => request.method === "thread/revert").length,
    1,
  );
  runner.dispose();
});

test("refuses to rewind a target that is still present but no longer latest", async () => {
  const transport = new FakeTransport();
  const runner = createRunner(transport);

  assert.equal(await runner.rewind("legacy-kept"), "stale");
  assert.equal(
    transport.requests.filter((request) => request.method === "thread/rollback").length,
    0,
  );
  runner.dispose();
});

test("finds a stale paginated target beyond the first history page without reverting", async () => {
  const transport = new FakeTransport();
  transport.paginatedTurns = Array.from(
    { length: 102 },
    (_, index) => completedTurn(`paginated-${index + 1}`),
  );
  const runner = createRunner(transport, "paginated");

  assert.equal(await runner.rewind("paginated-1"), "stale");
  assert.equal(
    transport.requests.filter((request) => request.method === "thread/turns/list").length,
    2,
  );
  assert.equal(
    transport.requests.filter((request) => request.method === "thread/revert").length,
    0,
  );
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
      params: { threadId: "thread-1", permissions: ":full-access", approvalPolicy: "never" },
    },
    {
      method: "thread/settings/update",
      params: { threadId: "thread-1", permissions: ":workspace", approvalPolicy: "on-request" },
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
