import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { ThreadRevertResponse } from "../generated/v2/ThreadRevertResponse.ts";
import type { ThreadTurnsListResponse } from "../generated/v2/ThreadTurnsListResponse.ts";
import type { SessionRuntime } from "../sessions/service.ts";
import type { CommandName } from "./catalog.ts";
import { asObject } from "../shared/json.ts";
import { PublicError } from "../shared/public-error.ts";
import { listModels } from "../app-server/models.ts";
import {
  isFullAccessProfile,
  listPermissionProfiles,
  permissionDescription,
  permissionLabel,
  permissionSettings,
  pickRestrictedProfile,
  type PermissionProfileSummary,
} from "../app-server/permissions.ts";
import type { PendingTurnSettings } from "../app-server/turn-settings.ts";

export type CommandOption = {
  id: string;
  label: string;
  description: string;
  /** 当前生效的那一项；前端据此高亮，不靠标签文字判断。 */
  selected?: boolean;
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

const THREAD_HISTORY_PAGE_SIZE = 100;
const NEXT_TURN_LINE = "当前这一轮不受影响，下一条消息开始生效。";
export type RewindOutcome = "reverted" | "already_reverted" | "stale";

/**
 * 当前浏览器连接所打开会话的斜杠命令适配器。
 * 它只返回前端需要的菜单和展示数据，不透传 app-server 原始对象。
 */
export class CommandRunner {
  readonly #transport: AppServerTransport;
  readonly #threadId: string;
  readonly #unsubscribe: () => void;
  #runtime: SessionRuntime;
  #fullAccessEnabled: boolean;
  #settingsRevision = 0;

  constructor(
    transport: AppServerTransport,
    threadId: string,
    runtime: SessionRuntime,
  ) {
    this.#transport = transport;
    this.#threadId = threadId;
    this.#runtime = { ...runtime };
    this.#fullAccessEnabled = runtimeUsesFullAccess(runtime);
    this.#unsubscribe = transport.onNotification((message) => {
      this.#handleNotification(message);
    });
  }

  dispose(): void {
    this.#unsubscribe();
  }

  /** `pending` 是会话运行中选定、下一轮才生效的设置；菜单优先把它标成选中项。 */
  async options(
    command: CommandName,
    pending: PendingTurnSettings | null = null,
  ): Promise<CommandOptions> {
    if (command === "model") {
      const models = await listModels(this.#transport);
      const selectedModel = pending?.model?.id ?? this.#runtime.model;
      const selectedEffort = pending?.model ? pending.model.effort : this.#runtime.reasoningEffort;
      return {
        title: "选择模型",
        items: models.map((model) => ({
          id: model.id,
          label: model.displayName,
          selected: model.id === selectedModel,
          description: model.description ||
            `默认思考强度：${model.defaultReasoningEffort || "自动"}`,
          items: model.supportedReasoningEfforts.map((effort) => ({
            id: effort.reasoningEffort,
            label: effort.reasoningEffort,
            selected: model.id === selectedModel &&
              effort.reasoningEffort === selectedEffort,
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
      const selectedProfile = pending?.permissions ?? this.#runtime.activePermissionProfile?.id;
      return {
        title: "选择权限",
        items: profiles.map((profile) => ({
          id: profile.id,
          label: permissionLabel(profile.id),
          selected: profile.id === selectedProfile,
          description: profile.description || permissionDescription(profile.id),
          disabled: !profile.allowed,
          danger: isFullAccessProfile(profile.id),
        })),
      };
    }

    throw new PublicError(`/${command} 没有二级菜单。`);
  }

  async setModel(modelId: string, effort?: string | null): Promise<CommandMessage> {
    const { model, effort: selectedEffort } = await this.#resolveModel(modelId, effort);
    await this.#updateSettings({
      model: model.id,
      effort: selectedEffort,
    });
    this.#runtime.model = model.id;
    this.#runtime.reasoningEffort = selectedEffort;
    return {
      kind: "message",
      title: "模型已切换",
      lines: modelLines(model.displayName, selectedEffort),
    };
  }

  /** 运行中选模型：只按当前列表校验，不碰 Codex；由调用方存成下一轮的设置。 */
  async stageModel(
    modelId: string,
    effort?: string | null,
  ): Promise<{ model: { id: string; effort: string | null }; message: CommandMessage }> {
    const { model, effort: selectedEffort } = await this.#resolveModel(modelId, effort);
    return {
      model: { id: model.id, effort: selectedEffort },
      message: {
        kind: "message",
        title: "模型将在下一轮生效",
        lines: [...modelLines(model.displayName, selectedEffort), NEXT_TURN_LINE],
      },
    };
  }

  async setPermissions(profileId: string): Promise<CommandMessage> {
    const profile = await this.#resolvePermissionProfile(profileId);
    const settingsRevision = this.#settingsRevision;
    await this.#updateSettings(permissionSettings(profile.id));
    // 通知到了就用它算出的结构化结果，只有没等到才退回认名字。
    if (this.#settingsRevision === settingsRevision) {
      this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
      this.#fullAccessEnabled = isFullAccessProfile(profile.id);
    }
    return {
      kind: "message",
      title: "权限已更新",
      lines: [permissionLabel(profile.id), profile.description || permissionDescription(profile.id)],
      fullAccessEnabled: this.#fullAccessEnabled,
    };
  }

  /**
   * 运行中选权限：只校验，不碰 Codex。`fullAccess` 是按名字认的预期，下一轮生效后
   * 以 `thread/settings/updated` 的结构化沙箱策略为准。
   */
  async stagePermissions(
    profileId: string,
  ): Promise<{ permissions: string; fullAccess: boolean; message: CommandMessage }> {
    const profile = await this.#resolvePermissionProfile(profileId);
    return {
      permissions: profile.id,
      fullAccess: isFullAccessProfile(profile.id),
      message: {
        kind: "message",
        title: "权限将在下一轮生效",
        lines: [
          permissionLabel(profile.id),
          profile.description || permissionDescription(profile.id),
          NEXT_TURN_LINE,
        ],
      },
    };
  }

  fullAccessEnabled(): boolean {
    return this.#fullAccessEnabled;
  }

  async toggleFullAccess(): Promise<CommandMessage> {
    if (this.#fullAccessEnabled) {
      const profile = pickRestrictedProfile(await this.#listPermissionProfiles());
      if (!profile) {
        throw new PublicError("当前 Codex 没有提供可用的受限权限，无法关闭 Full access。");
      }
      const settingsRevision = this.#settingsRevision;
      await this.#updateSettings(permissionSettings(profile.id));
      if (this.#settingsRevision === settingsRevision) {
        this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
        this.#fullAccessEnabled = isFullAccessProfile(profile.id);
      }
      if (this.#fullAccessEnabled) {
        return {
          kind: "message",
          title: "Full access 没有关闭",
          lines: ["Codex 报告当前会话仍在不受沙箱限制地运行。"],
          fullAccessEnabled: true,
        };
      }
      return {
        kind: "message",
        title: "Full access 已关闭",
        lines: [
          permissionLabel(profile.id),
          profile.description || permissionDescription(profile.id),
        ],
        fullAccessEnabled: false,
      };
    }

    const profile = (await this.#listPermissionProfiles()).find((candidate) =>
      candidate.allowed && isFullAccessProfile(candidate.id)
    );
    if (!profile) {
      throw new PublicError("当前 Codex 没有提供可用的 Full access 权限。");
    }
    const settingsRevision = this.#settingsRevision;
    await this.#updateSettings(permissionSettings(profile.id));
    if (this.#settingsRevision === settingsRevision) {
      this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
      this.#fullAccessEnabled = true;
    }
    return {
      kind: "message",
      title: "Full access 已打开",
      lines: [profile.description || permissionDescription(profile.id)],
      fullAccessEnabled: this.#fullAccessEnabled,
    };
  }

  async rename(name: string): Promise<CommandMessage> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new PublicError("请在 /rename 后面写一个会话名称。");
    }
    if (trimmed.length > 160 || trimmed.includes("\n")) {
      throw new PublicError("会话名称请控制在 160 个字以内，并且不要换行。");
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

  /**
   * 只回退浏览器确认时看到的那一轮。响应丢失后重试仍带同一个 ID：
   * 已经消失就当作完成；仍在但不再是最后一轮则拒绝，绝不改退新的最后一轮。
   */
  async rewind(targetTurnId: string): Promise<RewindOutcome> {
    if (this.#runtime.historyMode !== "paginated") {
      throw new PublicError("这个会话使用旧版历史格式，新版 Codex 不支持回退。");
    }

    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let firstPage = true;

    while (true) {
      const page = asObject(await this.#transport.request<ThreadTurnsListResponse>(
        "thread/turns/list",
        {
          threadId: this.#threadId,
          cursor,
          limit: THREAD_HISTORY_PAGE_SIZE,
          sortDirection: "desc",
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
      const ids = turnIds(page.data);
      if (firstPage && ids[0] === targetTurnId) break;
      if (ids.includes(targetTurnId)) return "stale";
      if (page.nextCursor === null) return "already_reverted";
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Codex 返回了重复的分页标记。");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
      firstPage = false;
    }

    const reverted = asObject(await this.#transport.request<ThreadRevertResponse>(
      "thread/revert",
      { threadId: this.#threadId, beforeTurnId: targetTurnId },
    ));
    const thread = asObject(reverted?.thread);
    if (!thread || thread.id !== this.#threadId) {
      throw new Error("Codex 返回了无法识别的回退结果。");
    }

    return "reverted";
  }

  async #resolveModel(modelId: string, effort?: string | null) {
    const model = (await listModels(this.#transport)).find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new PublicError("这个模型不在当前 Codex 返回的可用列表中。");
    }
    if (
      effort &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    ) {
      throw new PublicError("这个模型不支持所选思考强度。");
    }
    return { model, effort: effort || model.defaultReasoningEffort || null };
  }

  async #resolvePermissionProfile(profileId: string): Promise<PermissionProfileSummary> {
    const profile = (await this.#listPermissionProfiles())
      .find((candidate) => candidate.id === profileId);
    if (!profile || !profile.allowed) {
      throw new PublicError("这个权限选项当前不可用。");
    }
    return profile;
  }

  #listPermissionProfiles(): Promise<PermissionProfileSummary[]> {
    return listPermissionProfiles(this.#transport, this.#runtime.cwd);
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
  }
}

function modelLines(displayName: string, effort: string | null): string[] {
  return [`模型：${displayName}`, `思考强度：${effort || "自动"}`];
}

function turnIds(turns: unknown[]): string[] {
  return turns.flatMap((turn) => {
    const id = asObject(turn)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

/** `SandboxPolicy` 的判别值。参数侧用 `danger-full-access` 这种写法，一并归一。 */
const SANDBOX_POLICY_TYPES = new Set([
  "dangerfullaccess",
  "readonly",
  "workspacewrite",
  "externalsandbox",
]);
const FULL_ACCESS_SANDBOX_TYPE = "dangerfullaccess";

function normalizedSandboxType(policy: unknown): string | null {
  const raw = asObject(policy)?.type ?? policy;
  if (typeof raw !== "string") return null;
  const normalized = raw.toLowerCase().replace(/[^a-z]/g, "");
  return SANDBOX_POLICY_TYPES.has(normalized) ? normalized : null;
}

/**
 * 沙箱策略是判别联合，直接就能回答"是不是完全访问"；权限方案的 id 只是名字。
 * 所以先认沙箱策略，认不出来才退回认名字——那说明 Codex 换了协议，值得记一条。
 */
function runtimeUsesFullAccess(runtime: SessionRuntime): boolean {
  const sandboxType = normalizedSandboxType(runtime.sandboxPolicy);
  if (sandboxType) return sandboxType === FULL_ACCESS_SANDBOX_TYPE;

  const profileId = runtime.activePermissionProfile?.id ?? "";
  console.warn(
    "codex app-server 返回了无法识别的沙箱策略，改按权限方案名称判断 Full access：" +
      `sandboxPolicy=${JSON.stringify(runtime.sandboxPolicy)} profile=${profileId || "(无)"}`,
  );
  return isFullAccessProfile(profileId);
}
