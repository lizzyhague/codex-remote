import path from "node:path";

import {
  readJsonIfPresent,
  writeJsonAtomically,
} from "../workers/atomic-json.ts";
import { resolveTrashStatePath } from "../sessions/trash-store.ts";
import { isObject } from "../shared/json.ts";
import { PublicError } from "../shared/public-error.ts";

export const MAX_DEVELOPER_INSTRUCTIONS_LENGTH = 131_072;
export const MAX_MODEL_ID_LENGTH = 256;
export const MAX_REASONING_EFFORT_LENGTH = 64;

export type ApplicationSettings = {
  developerInstructions: string;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
};

export type ApplicationSettingsPatch = {
  developerInstructions?: string;
  defaultModel?: string | null;
  defaultReasoningEffort?: string | null;
};

type SettingsFile = {
  version: 1;
  developerInstructions: string;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
};

export class ApplicationSettingsError extends PublicError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
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
  };
}

/**
 * 后端全局应用设置。与回收站、钉住名单同目录，原子覆盖、属主读写。
 * 空 Developer 指令表示不追加用户内容；空模型和强度表示沿用 Codex 默认。
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
      next.defaultReasoningEffort === this.#settings.defaultReasoningEffort
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
    throw new ApplicationSettingsError("invalid_field", "附加 Developer 指令必须是字符串。");
  }
  if (value.length > MAX_DEVELOPER_INSTRUCTIONS_LENGTH) {
    throw new ApplicationSettingsError(
      "invalid_field",
      `附加 Developer 指令过长。上限是 ${MAX_DEVELOPER_INSTRUCTIONS_LENGTH} 个字符。`,
    );
  }
  return value;
}

function normalizeSettingsPatch(patch: ApplicationSettingsPatch): ApplicationSettingsPatch {
  if (!isObject(patch)) {
    throw new ApplicationSettingsError("invalid_field", "应用设置更新格式不正确。");
  }
  const normalized: ApplicationSettingsPatch = {};
  if (patch.developerInstructions !== undefined) {
    normalized.developerInstructions = normalizeDeveloperInstructions(patch.developerInstructions);
  }
  const hasModel = patch.defaultModel !== undefined;
  const hasEffort = patch.defaultReasoningEffort !== undefined;
  if (hasModel !== hasEffort) {
    throw new ApplicationSettingsError("invalid_field", "默认模型和默认思考强度必须一起保存。");
  }
  if (hasModel && hasEffort) {
    const defaultModel = normalizeNullableString(
      patch.defaultModel,
      "默认模型",
      MAX_MODEL_ID_LENGTH,
    );
    const defaultReasoningEffort = normalizeNullableString(
      patch.defaultReasoningEffort,
      "默认思考强度",
      MAX_REASONING_EFFORT_LENGTH,
    );
    if (defaultModel === null && defaultReasoningEffort !== null) {
      throw new ApplicationSettingsError(
        "invalid_field",
        "跟随 Codex 默认模型时，思考强度也必须跟随 Codex 默认。",
      );
    }
    normalized.defaultModel = defaultModel;
    normalized.defaultReasoningEffort = defaultReasoningEffort;
  }
  return normalized;
}

function normalizeNullableString(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApplicationSettingsError("invalid_field", `${label}必须是字符串或 null。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ApplicationSettingsError("invalid_field", `${label}不能为空或过长。`);
  }
  return normalized;
}

function parseSettings(raw: unknown, filePath: string): ApplicationSettings {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.developerInstructions !== "string") {
    throw new Error(`设置文件格式不正确：${filePath}`);
  }
  const defaultModel = raw.defaultModel === undefined
    ? null
    : normalizeNullableString(raw.defaultModel, "默认模型", MAX_MODEL_ID_LENGTH);
  const defaultReasoningEffort = raw.defaultReasoningEffort === undefined
    ? null
    : normalizeNullableString(
      raw.defaultReasoningEffort,
      "默认思考强度",
      MAX_REASONING_EFFORT_LENGTH,
    );
  if (defaultModel === null && defaultReasoningEffort !== null) {
    throw new Error(`设置文件格式不正确：${filePath}`);
  }
  return {
    developerInstructions: normalizeDeveloperInstructions(raw.developerInstructions),
    defaultModel,
    defaultReasoningEffort,
  };
}
