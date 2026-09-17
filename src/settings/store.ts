import path from "node:path";

import {
  readJsonIfPresent,
  writeJsonAtomically,
} from "../workers/atomic-json.ts";
import { resolveTrashStatePath } from "../sessions/trash-store.ts";

export const MAX_DEVELOPER_INSTRUCTIONS_LENGTH = 131_072;

export type ApplicationSettings = {
  developerInstructions: string;
};

type SettingsFile = {
  version: 1;
  developerInstructions: string;
};

export class ApplicationSettingsError extends Error {
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
  return { developerInstructions: "" };
}

/**
 * 后端全局应用设置。与回收站、钉住名单同目录，原子覆盖、属主读写。
 * 当前只有附加 Developer 指令；空字符串表示不追加用户内容。
 */
export class ApplicationSettingsStore {
  readonly #filePath: string;
  #settings: ApplicationSettings;
  #writeQueue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(settings: ApplicationSettings) => void>();

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
    return { developerInstructions: this.#settings.developerInstructions };
  }

  onChange(listener: (settings: ApplicationSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async update(developerInstructions: string): Promise<ApplicationSettings> {
    const normalized = normalizeDeveloperInstructions(developerInstructions);
    const operation = this.#writeQueue.then(() => this.#write(normalized));
    this.#writeQueue = operation.then(() => {}, () => {});
    return operation;
  }

  async #write(developerInstructions: string): Promise<ApplicationSettings> {
    if (this.#settings.developerInstructions === developerInstructions) {
      return this.get();
    }
    const snapshot: SettingsFile = {
      version: 1,
      developerInstructions,
    };
    await writeJsonAtomically(this.#filePath, snapshot);
    this.#settings = { developerInstructions };
    const next = this.get();
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error(`应用设置变更通知失败：${error instanceof Error ? error.message : error}`);
      }
    }
    return next;
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

function parseSettings(raw: unknown, filePath: string): ApplicationSettings {
  if (!isObject(raw) || raw.version !== 1 || typeof raw.developerInstructions !== "string") {
    throw new Error(`设置文件格式不正确：${filePath}`);
  }
  return {
    developerInstructions: normalizeDeveloperInstructions(raw.developerInstructions),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
