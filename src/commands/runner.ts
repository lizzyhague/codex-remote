import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { Turn } from "../generated/v2/Turn.ts";
import type { ThreadRevertResponse } from "../generated/v2/ThreadRevertResponse.ts";
import type { ThreadRollbackResponse } from "../generated/v2/ThreadRollbackResponse.ts";
import type { ThreadTurnsListResponse } from "../generated/v2/ThreadTurnsListResponse.ts";
import type { SessionRuntime } from "../sessions/service.ts";
import type { CommandName } from "./catalog.ts";

export type CommandOption = {
  id: string;
  label: string;
  description: string;
  disabled?: boolean;
  danger?: boolean;
  items?: CommandOption[];
};

export type CommandOptions = {
  title: string;
  items: CommandOption[];
};

export type CommandMessage = {
  kind: "message";
  title: string;
  lines: CommandMessageLine[];
  sessionName?: string;
  fullAccessEnabled?: boolean;
};

export type CommandMessageLine = string | {
  kind: "timestamp";
  before: string;
  timestamp: number;
  after: string;
};

type RuntimeState = SessionRuntime & {
  collaborationMode: "default" | "plan";
};

const THREAD_HISTORY_PAGE_SIZE = 100;

/**
 * 当前浏览器连接所打开会话的斜杠命令适配器。
 * 它只返回前端需要的菜单和展示数据，不透传 app-server 原始对象。
 */
export class CommandRunner {
  readonly #transport: AppServerTransport;
  readonly #threadId: string;
  readonly #unsubscribe: () => void;
  #runtime: RuntimeState;
  #fullAccessEnabled: boolean;
  #settingsRevision = 0;

  constructor(
    transport: AppServerTransport,
    threadId: string,
    runtime: SessionRuntime,
  ) {
    this.#transport = transport;
    this.#threadId = threadId;
    this.#runtime = { ...runtime, collaborationMode: "default" };
    this.#fullAccessEnabled = runtimeUsesFullAccess(runtime);
    this.#unsubscribe = transport.onNotification((message) => {
      this.#handleNotification(message);
    });
  }

  dispose(): void {
    this.#unsubscribe();
  }

  async options(command: CommandName): Promise<CommandOptions> {
    if (command === "model") {
      const models = await this.#listModels();
      return {
        title: "选择模型",
        items: models.map((model) => ({
          id: model.id,
          label: `${model.id === this.#runtime.model ? "✓ " : ""}${model.displayName}`,
          description: model.description ||
            `默认思考强度：${model.defaultReasoningEffort || "自动"}`,
          items: model.supportedReasoningEfforts.map((effort) => ({
            id: effort.reasoningEffort,
            label: `${
              model.id === this.#runtime.model &&
                effort.reasoningEffort === this.#runtime.reasoningEffort
                ? "✓ "
                : ""
            }${effort.reasoningEffort}`,
            description: [
              effort.description,
              effort.reasoningEffort === model.defaultReasoningEffort ? "模型默认" : "",
            ].filter(Boolean).join(" · "),
          })),
        })),
      };
    }

    if (command === "permissions") {
      const profiles = await this.#listPermissionProfiles();
      return {
        title: "选择权限",
        items: profiles.map((profile) => ({
          id: profile.id,
          label: `${profile.id === this.#runtime.activePermissionProfile?.id ? "✓ " : ""}${permissionLabel(profile.id)}`,
          description: profile.description || permissionDescription(profile.id),
          disabled: !profile.allowed,
          danger: isFullAccessProfile(profile.id),
        })),
      };
    }

    throw new Error(`/${command} 没有二级菜单。`);
  }

  async setModel(modelId: string, effort?: string | null): Promise<CommandMessage> {
    const model = (await this.#listModels()).find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error("这个模型不在当前 Codex 返回的可用列表中。");
    }
    if (
      effort &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    ) {
      throw new Error("这个模型不支持所选思考强度。");
    }
    const selectedEffort = effort || model.defaultReasoningEffort || null;
    await this.#updateSettings({
      model: model.id,
      effort: selectedEffort,
    });
    this.#runtime.model = model.id;
    this.#runtime.reasoningEffort = selectedEffort;
    return {
      kind: "message",
      title: "模型已切换",
      lines: [
        `模型：${model.displayName}`,
        `思考强度：${selectedEffort || "自动"}`,
      ],
    };
  }

  async setPermissions(profileId: string): Promise<CommandMessage> {
    const profile = (await this.#listPermissionProfiles())
      .find((candidate) => candidate.id === profileId);
    if (!profile || !profile.allowed) {
      throw new Error("这个权限选项当前不可用。");
    }
    await this.#updateSettings({ permissions: profile.id });
    this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
    this.#fullAccessEnabled = isFullAccessProfile(profile.id);
    return {
      kind: "message",
      title: "权限已更新",
      lines: [permissionLabel(profile.id), profile.description || permissionDescription(profile.id)],
      fullAccessEnabled: this.#fullAccessEnabled,
    };
  }

  fullAccessEnabled(): boolean {
    return this.#fullAccessEnabled;
  }

  async toggleFullAccess(): Promise<CommandMessage> {
    if (this.#fullAccessEnabled) {
      const settingsRevision = this.#settingsRevision;
      await this.#updateSettings({ permissions: null });
      if (this.#settingsRevision === settingsRevision) {
        this.#runtime.activePermissionProfile = null;
        this.#fullAccessEnabled = false;
      }
      if (this.#fullAccessEnabled) {
        return {
          kind: "message",
          title: "已恢复默认权限",
          lines: ["权限覆盖已清除；当前部署的默认权限本身是 Full access。"],
          fullAccessEnabled: true,
        };
      }
      return {
        kind: "message",
        title: "Full access 已关闭",
        lines: ["当前会话已恢复默认权限。"],
        fullAccessEnabled: false,
      };
    }

    const profile = (await this.#listPermissionProfiles()).find((candidate) =>
      candidate.allowed && isFullAccessProfile(candidate.id)
    );
    if (!profile) {
      throw new Error("当前 Codex 没有提供可用的 Full access 权限。");
    }
    await this.#updateSettings({ permissions: profile.id });
    this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
    this.#fullAccessEnabled = true;
    return {
      kind: "message",
      title: "Full access 已打开",
      lines: [profile.description || permissionDescription(profile.id)],
      fullAccessEnabled: true,
    };
  }

  async togglePlan(): Promise<CommandMessage> {
    const target = this.#runtime.collaborationMode === "plan" ? "default" : "plan";
    const modes = await this.#listCollaborationModes();
    const preset = modes.find((candidate) => candidate.mode === target);
    if (!preset) {
      throw new Error(`当前 Codex 没有返回${target === "plan" ? "计划" : "普通"}模式。`);
    }

    const model = preset.model || this.#runtime.model;
    const effort = preset.reasoning_effort ?? this.#runtime.reasoningEffort;
    await this.#updateSettings({
      collaborationMode: {
        mode: target,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      },
    });
    this.#runtime.collaborationMode = target;
    this.#runtime.model = model;
    this.#runtime.reasoningEffort = effort;
    return {
      kind: "message",
      title: target === "plan" ? "已进入计划模式" : "已回到普通模式",
      lines: [target === "plan"
        ? "后续消息会先讨论和制定方案。再次运行 /plan 可退出。"
        : "后续消息恢复普通工作模式。"],
    };
  }

  async rename(name: string): Promise<CommandMessage> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("请在 /rename 后面写一个会话名称。");
    }
    if (trimmed.length > 160 || trimmed.includes("\n")) {
      throw new Error("会话名称请控制在 160 个字以内，并且不要换行。");
    }
    await this.#transport.request("thread/name/set", {
      threadId: this.#threadId,
      name: trimmed,
    });
    return {
      kind: "message",
      title: "会话已重命名",
      lines: [trimmed],
      sessionName: trimmed,
    };
  }

  async compact(): Promise<string | null> {
    await this.#transport.request("thread/compact/start", { threadId: this.#threadId });
    return null;
  }

  async review(): Promise<string> {
    const response = asObject(await this.#transport.request("review/start", {
      threadId: this.#threadId,
      delivery: "inline",
      target: { type: "uncommittedChanges" },
    }));
    const turn = asObject(response?.turn);
    if (!turn || typeof turn.id !== "string") {
      throw new Error("Codex 返回了无法识别的检查任务。");
    }
    return turn.id;
  }

  async rewind(): Promise<Turn[]> {
    if (this.#runtime.historyMode === "paginated") {
      return this.#rewindPaginated();
    }

    const response = asObject(await this.#transport.request<ThreadRollbackResponse>(
      "thread/rollback",
      {
        threadId: this.#threadId,
        numTurns: 1,
      },
    ));
    const thread = asObject(response?.thread);
    if (
      !thread ||
      thread.id !== this.#threadId ||
      !Array.isArray(thread.turns)
    ) {
      throw new Error("Codex 返回了无法识别的回退结果。");
    }
    return thread.turns as Turn[];
  }

  async #rewindPaginated(): Promise<Turn[]> {
    const latest = asObject(await this.#transport.request<ThreadTurnsListResponse>(
      "thread/turns/list",
      {
        threadId: this.#threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "summary",
      },
    ));
    if (!latest || !Array.isArray(latest.data)) {
      throw new Error("Codex 返回了无法识别的分页历史。");
    }
    const latestTurn = asObject(latest.data[0]);
    if (!latestTurn || typeof latestTurn.id !== "string") {
      throw new Error("当前会话没有可以回退的轮次。");
    }

    const reverted = asObject(await this.#transport.request<ThreadRevertResponse>(
      "thread/revert",
      { threadId: this.#threadId, beforeTurnId: latestTurn.id },
    ));
    const thread = asObject(reverted?.thread);
    if (!thread || thread.id !== this.#threadId) {
      throw new Error("Codex 返回了无法识别的回退结果。");
    }

    return this.#readPaginatedTurns();
  }

  async #readPaginatedTurns(): Promise<Turn[]> {
    const turns: Turn[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      const page = asObject(await this.#transport.request<ThreadTurnsListResponse>(
        "thread/turns/list",
        {
          threadId: this.#threadId,
          cursor,
          limit: THREAD_HISTORY_PAGE_SIZE,
          sortDirection: "asc",
          itemsView: "summary",
        },
      ));
      if (
        !page ||
        !Array.isArray(page.data) ||
        !(page.nextCursor === null || typeof page.nextCursor === "string")
      ) {
        throw new Error("Codex 返回了无法识别的分页历史。");
      }
      turns.push(...page.data as Turn[]);
      if (page.nextCursor === null) return turns;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Codex 返回了重复的分页标记。");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async #listModels(): Promise<ModelSummary[]> {
    const result: ModelSummary[] = [];
    let cursor: string | null = null;
    do {
      const response = asObject(await this.#transport.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }));
      if (!response || !Array.isArray(response.data)) {
        throw new Error("Codex 返回了无法识别的模型列表。");
      }
      for (const value of response.data) {
        const model = asObject(value);
        if (!model || typeof model.id !== "string") continue;
        result.push({
          id: model.id,
          displayName: typeof model.displayName === "string" ? model.displayName : model.id,
          description: typeof model.description === "string" ? model.description : "",
          defaultReasoningEffort: typeof model.defaultReasoningEffort === "string"
            ? model.defaultReasoningEffort
            : "",
          supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.flatMap((value) => {
              const option = asObject(value);
              return option && typeof option.reasoningEffort === "string"
                ? [{
                  reasoningEffort: option.reasoningEffort,
                  description: typeof option.description === "string"
                    ? option.description
                    : "",
                }]
                : [];
            })
            : [],
        });
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    } while (cursor && result.length < 400);
    return result;
  }

  async #listPermissionProfiles(): Promise<PermissionProfileSummary[]> {
    const response = asObject(await this.#transport.request("permissionProfile/list", {
      cursor: null,
      limit: 100,
      cwd: this.#runtime.cwd,
    }));
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Codex 返回了无法识别的权限列表。");
    }
    return response.data.flatMap((value) => {
      const profile = asObject(value);
      if (!profile || typeof profile.id !== "string") return [];
      return [{
        id: profile.id,
        description: typeof profile.description === "string" ? profile.description : "",
        allowed: profile.allowed === true,
      }];
    });
  }

  async #listCollaborationModes(): Promise<CollaborationModeSummary[]> {
    const response = asObject(
      await this.#transport.request("collaborationMode/list", {}),
    );
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Codex 返回了无法识别的工作模式列表。");
    }
    return response.data.flatMap((value) => {
      const mode = asObject(value);
      if (!mode || (mode.mode !== "plan" && mode.mode !== "default")) return [];
      return [{
        mode: mode.mode,
        model: typeof mode.model === "string" ? mode.model : null,
        reasoning_effort: typeof mode.reasoning_effort === "string"
          ? mode.reasoning_effort
          : null,
      }];
    });
  }

  async #updateSettings(settings: JsonObject): Promise<void> {
    await this.#transport.request("thread/settings/update", {
      threadId: this.#threadId,
      ...settings,
    });
  }

  #handleNotification(message: JsonObject): void {
    const params = asObject(message.params);
    if (!params || params.threadId !== this.#threadId) return;
    if (message.method !== "thread/settings/updated") return;
    const settings = asObject(params.threadSettings);
    if (!settings) return;
    this.#settingsRevision += 1;
    if (typeof settings.model === "string") this.#runtime.model = settings.model;
    if (typeof settings.effort === "string" || settings.effort === null) {
      this.#runtime.reasoningEffort = settings.effort;
    }
    if (settings.approvalPolicy !== undefined) {
      this.#runtime.approvalPolicy = settings.approvalPolicy;
    }
    if (settings.sandboxPolicy !== undefined) {
      this.#runtime.sandboxPolicy = settings.sandboxPolicy;
    }
    const profile = asObject(settings.activePermissionProfile);
    this.#runtime.activePermissionProfile = profile && typeof profile.id === "string"
      ? { id: profile.id, extends: typeof profile.extends === "string" ? profile.extends : null }
      : null;
    this.#fullAccessEnabled = runtimeUsesFullAccess(this.#runtime);
    const collaboration = asObject(settings.collaborationMode);
    if (collaboration?.mode === "plan" || collaboration?.mode === "default") {
      this.#runtime.collaborationMode = collaboration.mode;
    }
  }
}

type ModelSummary = {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortSummary[];
};

type ReasoningEffortSummary = {
  reasoningEffort: string;
  description: string;
};

type PermissionProfileSummary = {
  id: string;
  description: string;
  allowed: boolean;
};

type CollaborationModeSummary = {
  mode: "default" | "plan";
  model: string | null;
  reasoning_effort: string | null;
};

function permissionLabel(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized.includes("read")) return "只读";
  if (isFullAccessProfile(id)) return "完全访问";
  if (normalized.includes("workspace") || normalized.includes("auto")) {
    return "自动（可修改项目）";
  }
  return id;
}

function permissionDescription(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized.includes("read")) return "可以阅读和分析；修改文件或执行高权限操作前会受限。";
  if (isFullAccessProfile(id)) return "可以不受沙箱限制地操作主机；请谨慎选择。";
  if (normalized.includes("workspace") || normalized.includes("auto")) {
    return "可在项目目录内工作，超出范围或敏感操作仍会询问。";
  }
  return "由当前 Codex 配置提供的权限方案。";
}

function isFullAccessProfile(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.includes("full") || normalized.includes("danger");
}

function runtimeUsesFullAccess(runtime: SessionRuntime): boolean {
  if (runtime.activePermissionProfile) {
    return isFullAccessProfile(runtime.activePermissionProfile.id);
  }
  const sandbox = asObject(runtime.sandboxPolicy);
  const type = typeof sandbox?.type === "string"
    ? sandbox.type
    : typeof runtime.sandboxPolicy === "string"
    ? runtime.sandboxPolicy
    : "";
  return isFullAccessProfile(type);
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
