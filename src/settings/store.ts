import path from "node:path";

import {
  readJsonIfPresent,
  writeJsonAtomically,
} from "../workers/atomic-json.ts";
import { resolveTrashStatePath } from "../sessions/trash-store.ts";
import { isObject } from "../shared/json.ts";
import { PublicError } from "../shared/public-error.ts";
import { localText, type LocalText } from "../shared/local-text.ts";

export const MAX_DEVELOPER_INSTRUCTIONS_LENGTH = 131_072;
export const MAX_MODEL_ID_LENGTH = 256;
export const MAX_REASONING_EFFORT_LENGTH = 64;
export const MAX_PERMISSION_PROFILE_LENGTH = 256;

export type ApplicationSettings = {
  developerInstructions: string;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  /** Permission profile ID for new sessions; `null` leaves it unspecified and uses the Codex default. */
  defaultPermissions: string | null;
};

export type ApplicationSettingsPatch = {
  developerInstructions?: string;
  defaultModel?: string | null;
  defaultReasoningEffort?: string | null;
  defaultPermissions?: string | null;
};

type SettingsFile = {
  version: 1;
  developerInstructions: string;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  defaultPermissions: string | null;
};

export class ApplicationSettingsError extends PublicError {
  readonly code: string;

  constructor(code: string, text: LocalText) {
    super(text);
    this.name = "ApplicationSettingsError";
    this.code = code;
  }
}

export function resolveSettingsStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CODEX_REMOTE_SETTINGS_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(resolveTrashStatePath(environment)), "settings.json");
}

export function defaultApplicationSettings(): ApplicationSettings {
  return {
    developerInstructions: "",
    defaultModel: null,
    defaultReasoningEffort: null,
    defaultPermissions: null,
  };
}

/**
 * Backend-wide application settings. Stored beside trash and pinned-session data, replaced atomically,
 * and readable and writable only by the owner. Empty Developer instructions append no user content;
 * empty model, effort, and permissions values use Codex defaults.
 */
export class ApplicationSettingsStore {
  readonly #filePath: string;
  #settings: ApplicationSettings;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, settings: ApplicationSettings) {
    this.#filePath = filePath;
    this.#settings = settings;
  }

  static async open(filePath: string): Promise<ApplicationSettingsStore> {
    const absolute = path.resolve(filePath);
    const raw = await readJsonIfPresent(absolute);
    return new ApplicationSettingsStore(
      absolute,
      raw === null ? defaultApplicationSettings() : parseSettings(raw, absolute),
    );
  }

  get filePath(): string {
    return this.#filePath;
  }

  get(): ApplicationSettings {
    return { ...this.#settings };
  }

  async update(patch: ApplicationSettingsPatch): Promise<ApplicationSettings> {
    const normalized = normalizeSettingsPatch(patch);
    const operation = this.#writeQueue.then(() => this.#write(normalized));
    this.#writeQueue = operation.then(() => {}, () => {});
    return operation;
  }

  async #write(patch: ApplicationSettingsPatch): Promise<ApplicationSettings> {
    const next: ApplicationSettings = { ...this.#settings, ...patch };
    if (
      next.developerInstructions === this.#settings.developerInstructions &&
      next.defaultModel === this.#settings.defaultModel &&
      next.defaultReasoningEffort === this.#settings.defaultReasoningEffort &&
      next.defaultPermissions === this.#settings.defaultPermissions
    ) {
      return this.get();
    }
    const snapshot: SettingsFile = {
      version: 1,
      ...next,
    };
    await writeJsonAtomically(this.#filePath, snapshot);
    this.#settings = next;
    return this.get();
  }
}

export function normalizeDeveloperInstructions(value: string): string {
  if (typeof value !== "string") {
    throw new ApplicationSettingsError("invalid_field", localText("error.instructionsNotString"));
  }
  if (value.length > MAX_DEVELOPER_INSTRUCTIONS_LENGTH) {
    throw new ApplicationSettingsError(
      "invalid_field",
      localText("error.instructionsTooLong", { max: MAX_DEVELOPER_INSTRUCTIONS_LENGTH }),
    );
  }
  return value;
}

function normalizeSettingsPatch(patch: ApplicationSettingsPatch): ApplicationSettingsPatch {
  if (!isObject(patch)) {
    throw new ApplicationSettingsError("invalid_field", localText("error.settingsUpdateInvalid"));
  }
  const normalized: ApplicationSettingsPatch = {};
  if (patch.developerInstructions !== undefined) {
    normalized.developerInstructions = normalizeDeveloperInstructions(patch.developerInstructions);
  }
  const hasModel = patch.defaultModel !== undefined;
  const hasEffort = patch.defaultReasoningEffort !== undefined;
  if (hasModel !== hasEffort) {
    throw new ApplicationSettingsError("invalid_field", localText("error.modelEffortTogether"));
  }
  if (hasModel && hasEffort) {
    const defaultModel = normalizeNullableString(
      patch.defaultModel,
      localText("settings.defaultModel"),
      MAX_MODEL_ID_LENGTH,
    );
    const defaultReasoningEffort = normalizeNullableString(
      patch.defaultReasoningEffort,
      localText("settings.defaultReasoningEffort"),
      MAX_REASONING_EFFORT_LENGTH,
    );
    if (defaultModel === null && defaultReasoningEffort !== null) {
      throw new ApplicationSettingsError(
        "invalid_field",
        localText("error.effortFollowsModel"),
      );
    }
    normalized.defaultModel = defaultModel;
    normalized.defaultReasoningEffort = defaultReasoningEffort;
  }
  if (patch.defaultPermissions !== undefined) {
    normalized.defaultPermissions = normalizeNullableString(
      patch.defaultPermissions,
      localText("settings.defaultPermissions"),
      MAX_PERMISSION_PROFILE_LENGTH,
    );
  }
  return normalized;
}

function normalizeNullableString(
  value: unknown,
  label: LocalText,
  maxLength: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApplicationSettingsError("invalid_field", localText("error.fieldNotString", { field: label }));
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ApplicationSettingsError("invalid_field", localText("error.fieldEmptyOrLong", { field: label }));
  }
  return normalized;
}

function parseSettings(raw: unknown, filePath: string): ApplicationSettings {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.developerInstructions !== "string") {
    throw new Error(`The settings file has an invalid format: ${filePath}`);
  }
  const defaultModel = raw.defaultModel === undefined
    ? null
    : normalizeNullableString(raw.defaultModel, localText("settings.defaultModel"), MAX_MODEL_ID_LENGTH);
  const defaultReasoningEffort = raw.defaultReasoningEffort === undefined
    ? null
    : normalizeNullableString(
      raw.defaultReasoningEffort,
      localText("settings.defaultReasoningEffort"),
      MAX_REASONING_EFFORT_LENGTH,
    );
  if (defaultModel === null && defaultReasoningEffort !== null) {
    throw new Error(`The settings file has an invalid format: ${filePath}`);
  }
  const defaultPermissions = raw.defaultPermissions === undefined
    ? null
    : normalizeNullableString(raw.defaultPermissions, localText("settings.defaultPermissions"), MAX_PERMISSION_PROFILE_LENGTH);
  return {
    developerInstructions: normalizeDeveloperInstructions(raw.developerInstructions),
    defaultModel,
    defaultReasoningEffort,
    defaultPermissions,
  };
}
