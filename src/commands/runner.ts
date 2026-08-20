import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { Turn } from "../generated/v2/Turn.ts";
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

/**
 * 当前浏览器连接所打开会话的斜杠命令适配器。
 * 它只返回前端需要的菜单和展示数据，不透传 app-server 原始对象。
 */
export class CommandRunner {
  readonly #transport: AppServerTransport;
  readonly #threadId: string;
  readonly #unsubscribe: () => void;
  #runtime: RuntimeState;
  #tokenUsage: JsonObject | null = null;

  constructor(
    transport: AppServerTransport,
    threadId: string,
    runtime: SessionRuntime,
  ) {
    this.#transport = transport;
    this.#threadId = threadId;
    this.#runtime = { ...runtime, collaborationMode: "default" };
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

    if (command === "usage") {
      return {
        title: "查看哪一种用量",
        items: [
          { id: "rate-limits", label: "当前限额", description: "查看已用百分比和重置时间。" },
          { id: "daily", label: "每日用量", description: "查看最近 7 个有记录的日期。" },
          { id: "weekly", label: "每周用量", description: "把最近 28 天按 7 天汇总。" },
          { id: "cumulative", label: "累计用量", description: "查看账户累计 Token 等摘要。" },
        ],
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
    return {
      kind: "message",
      title: "权限已更新",
      lines: [permissionLabel(profile.id), profile.description || permissionDescription(profile.id)],
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

  status(): CommandMessage {
    const total = asObject(this.#tokenUsage?.total);
    const totalTokens = readFiniteNumber(total?.totalTokens);
    const contextWindow = readFiniteNumber(this.#tokenUsage?.modelContextWindow);
    const lines = [
      `模型：${this.#runtime.model}`,
      `思考强度：${this.#runtime.reasoningEffort || "自动"}`,
      `模式：${this.#runtime.collaborationMode === "plan" ? "计划" : "普通"}`,
      `权限：${this.#runtime.activePermissionProfile
        ? permissionLabel(this.#runtime.activePermissionProfile.id)
        : describeLegacyPermissions(this.#runtime.approvalPolicy, this.#runtime.sandboxPolicy)}`,
    ];
    lines.push(totalTokens === null
      ? "上下文：本次连接尚未收到 Token 数据"
      : contextWindow === null
      ? `上下文：已使用 ${formatCount(totalTokens)} Token`
      : `上下文：${formatCount(totalTokens)} / ${formatCount(contextWindow)} Token`);
    return { kind: "message", title: "当前会话状态", lines };
  }

  async usage(view: string): Promise<CommandMessage> {
    if (view === "rate-limits") {
      return this.#rateLimits();
    }
    if (view !== "daily" && view !== "weekly" && view !== "cumulative") {
      throw new Error("无法识别这个用量选项。");
    }
    const response = asObject(await this.#transport.request("account/usage/read", undefined));
    if (!response) {
      throw new Error("Codex 返回了无法识别的账户用量。");
    }
    const summary = asObject(response.summary);
    const buckets = Array.isArray(response.dailyUsageBuckets)
      ? response.dailyUsageBuckets.map(asObject).filter(isObjectValue)
      : [];

    if (view === "cumulative") {
      return {
        kind: "message",
        title: "累计用量",
        lines: [
          summaryLine("累计 Token", summary?.lifetimeTokens),
          summaryLine("单日峰值", summary?.peakDailyTokens),
          summaryLine("当前连续使用", summary?.currentStreakDays, " 天"),
          summaryLine("最长连续使用", summary?.longestStreakDays, " 天"),
        ],
      };
    }

    const daily = buckets
      .map((bucket) => ({
        date: typeof bucket.startDate === "string" ? bucket.startDate : "",
        tokens: readFiniteNumber(bucket.tokens) ?? 0,
      }))
      .filter((bucket) => bucket.date)
      .sort((left, right) => left.date.localeCompare(right.date));

    if (view === "daily") {
      return {
        kind: "message",
        title: "每日用量",
        lines: daily.slice(-7).map((bucket) =>
          `${bucket.date}：${formatCount(bucket.tokens)} Token`
        ).concat(daily.length ? [] : ["目前没有每日用量记录。"]),
      };
    }

    const recent = daily.slice(-28);
    const weekly: string[] = [];
    for (let index = 0; index < recent.length; index += 7) {
      const group = recent.slice(index, index + 7);
      if (!group.length) continue;
      const total = group.reduce((sum, bucket) => sum + bucket.tokens, 0);
      weekly.push(`${group[0]!.date} ～ ${group.at(-1)?.date}：${formatCount(total)} Token`);
    }
    return {
      kind: "message",
      title: "每周用量",
      lines: weekly.length ? weekly : ["目前没有每周用量记录。"],
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
    const response = asObject(await this.#transport.request("thread/rollback", {
      threadId: this.#threadId,
      numTurns: 1,
    }));
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

  async #rateLimits(): Promise<CommandMessage> {
    const response = asObject(
      await this.#transport.request("account/rateLimits/read", undefined),
    );
    if (!response) {
      throw new Error("Codex 返回了无法识别的限额数据。");
    }
    const byId = asObject(response.rateLimitsByLimitId);
    const snapshots = byId
      ? Object.values(byId).map(asObject).filter(isObjectValue)
      : [asObject(response.rateLimits)].filter(isObjectValue);
    const lines: CommandMessageLine[] = [];
    for (const snapshot of snapshots) {
      const name = typeof snapshot.limitName === "string"
        ? snapshot.limitName
        : typeof snapshot.limitId === "string"
        ? snapshot.limitId
        : "Codex";
      for (const window of [asObject(snapshot.primary), asObject(snapshot.secondary)]) {
        if (!window) continue;
        const used = readFiniteNumber(window.usedPercent);
        const duration = readFiniteNumber(window.windowDurationMins);
        const resetsAt = readFiniteNumber(window.resetsAt);
        const usage = `${name}${duration === null ? "" : `（${formatDuration(duration)}）`}：${used === null ? "未知" : `${Math.round(used)}%`}`;
        lines.push(resetsAt === null
          ? usage
          : {
            kind: "timestamp",
            before: `${usage}，`,
            timestamp: resetsAt,
            after: " 重置",
          });
      }
    }
    return {
      kind: "message",
      title: "当前限额",
      lines: lines.length ? lines : ["当前账户没有返回可显示的限额窗口。"],
    };
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
    if (message.method === "thread/tokenUsage/updated") {
      this.#tokenUsage = asObject(params.tokenUsage);
      return;
    }
    if (message.method !== "thread/settings/updated") return;
    const settings = asObject(params.threadSettings);
    if (!settings) return;
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
  if (isFullAccessProfile(id)) return "可以不受沙箱限制地操作 VPS；请谨慎选择。";
  if (normalized.includes("workspace") || normalized.includes("auto")) {
    return "可在项目目录内工作，超出范围或敏感操作仍会询问。";
  }
  return "由当前 Codex 配置提供的权限方案。";
}

function isFullAccessProfile(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.includes("full") || normalized.includes("danger");
}

function describeLegacyPermissions(approval: unknown, sandbox: unknown): string {
  const policy = typeof approval === "string" ? approval : "自定义审批";
  const sandboxObject = asObject(sandbox);
  const sandboxType = typeof sandboxObject?.type === "string"
    ? sandboxObject.type
    : typeof sandbox === "string"
    ? sandbox
    : "自定义沙箱";
  return `${policy} / ${sandboxType}`;
}

function summaryLine(label: string, value: unknown, suffix = " Token"): string {
  const number = readFiniteNumber(value);
  return `${label}：${number === null ? "暂无" : `${formatCount(number)}${suffix}`}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value));
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 1_440)} 天`;
}

function readFiniteNumber(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : NaN;
  return Number.isFinite(number) ? number : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function isObjectValue(value: JsonObject | null): value is JsonObject {
  return value !== null;
}
