import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Interface text the browser shows in its own language: a key from public/strings.js plus parameters.
 * The backend never picks a language for these; it sends the key and keeps the English form for logs.
 * A parameter may itself be a LocalText, such as a scope label inside an approval line.
 */
export type LocalText = { key: string; params?: Record<string, LocalTextParam> };
export type LocalTextParam = string | number | LocalText;

type Translation = string | { one: string; other: string };
export type TextLanguage = "zh" | "en";

const STRINGS_URL = new URL("../../public/strings.js", import.meta.url);
const context: { window: { codexRemoteStrings?: Record<string, Record<string, Translation>> } } = { window: {} };
vm.runInNewContext(readFileSync(STRINGS_URL, "utf8"), context);
const strings = context.window.codexRemoteStrings ?? {};

export function localText(key: string, params?: Record<string, LocalTextParam>): LocalText {
  return params ? { key, params } : { key };
}

/** Whether public/strings.js defines the key. */
export function hasText(key: string): boolean {
  return Object.hasOwn(strings, key);
}

/** The English form of the text, filled in the same way as the browser fills it. */
export function englishText(text: LocalText): string {
  return renderText(text, "en");
}

/** Fills the text in one language, as the browser does; plain strings pass through unchanged. */
export function renderText(text: DisplayText, language: TextLanguage): string {
  if (typeof text === "string") return text;
  const entry = strings[text.key];
  let template = entry?.[language] ?? entry?.zh ?? text.key;
  if (typeof template === "object") template = text.params?.count === 1 ? template.one : template.other;
  const params = text.params;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name]!;
    return typeof value === "object" ? renderText(value, language) : String(value);
  });
}

export function isLocalText(value: unknown): value is LocalText {
  if (typeof value !== "object" || value === null) return false;
  const { key, params } = value as { key?: unknown; params?: unknown };
  return typeof key === "string" && (params === undefined || (typeof params === "object" && params !== null &&
    Object.values(params).every((item) =>
      typeof item === "string" || typeof item === "number" || isLocalText(item))));
}

/** Text that is either already final (for example from Codex) or Remote's own interface text. */
export type DisplayText = string | LocalText;
