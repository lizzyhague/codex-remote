import { localText, type DisplayText, type LocalText, type LocalTextParam } from "../shared/local-text.ts";
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
  label: DisplayText;
  description: DisplayText;
  /** The currently active option; the frontend uses this flag for highlighting instead of inspecting labels. */
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  items?: CommandOption[];
};

export type CommandOptions = {
  title: DisplayText;
  items: CommandOption[];
};

export type CommandMessage = {
  kind: "message";
  title: DisplayText;
  lines: CommandMessageLine[];
  sessionName?: string;
  fullAccessEnabled?: boolean;
};

export type CommandMessageLine = DisplayText | {
  kind: "timestamp";
  before: string;
  timestamp: number;
  after: string;
};

const THREAD_HISTORY_PAGE_SIZE = 100;
const NEXT_TURN_LINE = localText("command.nextTurn");
export type RewindOutcome = "reverted" | "already_reverted" | "stale";

/**
 * Slash-command adapter for the session open in the current browser connection.
 * Returns only menu and display data needed by the frontend, never raw app-server objects.
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

  /** `pending` is selected while a session is running and takes effect next turn; menus prefer it as selected. */
  async options(
    command: CommandName,
    pending: PendingTurnSettings | null = null,
  ): Promise<CommandOptions> {
    if (command === "model") {
      const models = await listModels(this.#transport);
      const selectedModel = pending?.model?.id ?? this.#runtime.model;
      const selectedEffort = pending?.model ? pending.model.effort : this.#runtime.reasoningEffort;
      return {
        title: localText("composer.chooseModel"),
        items: models.map((model) => ({
          id: model.id,
          label: model.displayName,
          selected: model.id === selectedModel,
          description: model.description ||
            localText("command.defaultEffort", { effort: effortLabel(model.defaultReasoningEffort) }),
          items: model.supportedReasoningEfforts.map((effort) => ({
            id: effort.reasoningEffort,
            label: effort.reasoningEffort,
            selected: model.id === selectedModel &&
              effort.reasoningEffort === selectedEffort,
            description: effort.reasoningEffort !== model.defaultReasoningEffort
              ? effort.description
              : effort.description
              ? localText("command.effortWithDefault", { description: effort.description })
              : localText("command.modelDefault"),
          })),
        })),
      };
    }

    if (command === "permissions") {
      const profiles = await this.#listPermissionProfiles();
      const selectedProfile = pending?.permissions ?? this.#runtime.activePermissionProfile?.id;
      return {
        title: localText("command.choosePermission"),
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

    throw new PublicError(localText("error.commandNoSubmenu", { command }));
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
      title: localText("command.modelSwitched"),
      lines: modelLines(model.displayName, selectedEffort),
    };
  }

  /** Selects a model while running: validates against the current list without touching Codex; the caller stages it for the next turn. */
  async stageModel(
    modelId: string,
    effort?: string | null,
  ): Promise<{ model: { id: string; effort: string | null }; message: CommandMessage }> {
    const { model, effort: selectedEffort } = await this.#resolveModel(modelId, effort);
    return {
      model: { id: model.id, effort: selectedEffort },
      message: {
        kind: "message",
        title: localText("command.modelNextTurn"),
        lines: [...modelLines(model.displayName, selectedEffort), NEXT_TURN_LINE],
      },
    };
  }

  async setPermissions(profileId: string): Promise<CommandMessage> {
    const profile = await this.#resolvePermissionProfile(profileId);
    const settingsRevision = this.#settingsRevision;
    await this.#updateSettings(permissionSettings(profile.id));
    // Use the structured result when the notification arrives; fall back to recognizing the name only if it does not.
    if (this.#settingsRevision === settingsRevision) {
      this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
      this.#fullAccessEnabled = isFullAccessProfile(profile.id);
    }
    return {
      kind: "message",
      title: localText("command.permissionsUpdated"),
      lines: [permissionLabel(profile.id), profile.description || permissionDescription(profile.id)],
      fullAccessEnabled: this.#fullAccessEnabled,
    };
  }

  /**
   * Selects permissions while running: validates without touching Codex. `fullAccess` is the expectation
   * inferred from the name; once effective next turn, the structured sandbox policy from
   * `thread/settings/updated` takes precedence.
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
        title: localText("command.permissionsNextTurn"),
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
        throw new PublicError(localText("error.noRestrictedPermission"));
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
          title: localText("command.fullAccessStillOn"),
          lines: [localText("command.fullAccessStillOnDetail")],
          fullAccessEnabled: true,
        };
      }
      return {
        kind: "message",
        title: localText("command.fullAccessOff"),
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
      throw new PublicError(localText("error.noFullAccess"));
    }
    const settingsRevision = this.#settingsRevision;
    await this.#updateSettings(permissionSettings(profile.id));
    if (this.#settingsRevision === settingsRevision) {
      this.#runtime.activePermissionProfile = { id: profile.id, extends: null };
      this.#fullAccessEnabled = true;
    }
    return {
      kind: "message",
      title: localText("command.fullAccessOn"),
      lines: [profile.description || permissionDescription(profile.id)],
      fullAccessEnabled: this.#fullAccessEnabled,
    };
  }

  async rename(name: string): Promise<CommandMessage> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new PublicError(localText("error.renameNeedsName"));
    }
    if (trimmed.length > 160 || trimmed.includes("\n")) {
      throw new PublicError(localText("error.sessionNameTooLong"));
    }
    await this.#transport.request("thread/name/set", {
      threadId: this.#threadId,
      name: trimmed,
    });
    return {
      kind: "message",
      title: localText("command.renamed"),
      lines: [trimmed],
      sessionName: trimmed,
    };
  }

  async compact(): Promise<string | null> {
    await this.#transport.request("thread/compact/start", { threadId: this.#threadId });
    return null;
  }

  /**
   * Rewinds only the turn seen when the browser confirmed. A retry after a lost response carries the same ID:
   * if it has disappeared, treat the operation as complete; if it remains but is no longer the last turn,
   * reject the request rather than rewinding the new last turn.
   */
  async rewind(targetTurnId: string): Promise<RewindOutcome> {
    if (this.#runtime.historyMode !== "paginated") {
      throw new PublicError(localText("error.rewindLegacyHistory"));
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
        throw new Error("Codex returned unrecognized paged history.");
      }
      const ids = turnIds(page.data);
      if (firstPage && ids[0] === targetTurnId) break;
      if (ids.includes(targetTurnId)) return "stale";
      if (page.nextCursor === null) return "already_reverted";
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Codex returned a repeated page cursor.");
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
      throw new Error("Codex returned an unrecognized rollback result.");
    }

    return "reverted";
  }

  async #resolveModel(modelId: string, effort?: string | null) {
    const model = (await listModels(this.#transport)).find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new PublicError(localText("error.modelUnavailable"));
    }
    if (
      effort &&
      !model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    ) {
      throw new PublicError(localText("error.effortUnsupported"));
    }
    return { model, effort: effort || model.defaultReasoningEffort || null };
  }

  async #resolvePermissionProfile(profileId: string): Promise<PermissionProfileSummary> {
    const profile = (await this.#listPermissionProfiles())
      .find((candidate) => candidate.id === profileId);
    if (!profile || !profile.allowed) {
      throw new PublicError(localText("error.permissionUnavailable"));
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

function modelLines(displayName: string, effort: string | null): LocalText[] {
  return [
    localText("command.modelLine", { model: displayName }),
    localText("command.effortLine", { effort: effortLabel(effort) }),
  ];
}

/** A reasoning effort name from Codex, or "auto" in the reader's language when none is set. */
function effortLabel(effort: string | null | undefined): LocalTextParam {
  return effort || localText("command.effortAuto");
}

function turnIds(turns: unknown[]): string[] {
  return turns.flatMap((turn) => {
    const id = asObject(turn)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

/** Discriminant values for `SandboxPolicy`; also normalizes parameter forms such as `danger-full-access`. */
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
 * The sandbox policy is a discriminated union that directly answers whether full access is active;
 * a permission profile ID is only a name. Inspect the policy first and fall back to the name only when
 * it is unrecognized, which indicates a Codex protocol change worth logging.
 */
function runtimeUsesFullAccess(runtime: SessionRuntime): boolean {
  const sandboxType = normalizedSandboxType(runtime.sandboxPolicy);
  if (sandboxType) return sandboxType === FULL_ACCESS_SANDBOX_TYPE;

  const profileId = runtime.activePermissionProfile?.id ?? "";
  console.warn(
    "codex app-server returned an unrecognized sandbox policy; judging full access by the permission profile name: " +
      `sandboxPolicy=${JSON.stringify(runtime.sandboxPolicy)} profile=${profileId || "(none)"}`,
  );
  return isFullAccessProfile(profileId);
}
