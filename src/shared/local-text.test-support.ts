import { renderText, type DisplayText } from "./local-text.ts";

/** Renders backend interface text in Chinese, so tests can keep asserting the wording users read. */
export function zh(text: DisplayText | null | undefined): string {
  return text === null || text === undefined ? "" : renderText(text, "zh");
}

/** An assert.rejects / assert.throws check: the error's interface text, rendered in Chinese, matches. */
export function inChinese(pattern: RegExp): (error: unknown) => boolean {
  return (error) => {
    const text = (error as { text?: DisplayText } | null)?.text;
    return pattern.test(text === undefined ? String((error as Error)?.message) : zh(text));
  };
}
