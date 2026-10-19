import { englishText, type LocalText } from "./local-text.ts";

/**
 * Use this base class only for business errors explicitly authored by Remote and safe to show in the
 * browser. Errors from external services, the operating system, and unknown exceptions must not be
 * wrapped ad hoc as PublicError merely to preserve their original text.
 *
 * The browser shows `text` in its own language; `message` is the English form for logs and fallbacks.
 */
export class PublicError extends Error {
  readonly text: LocalText;

  constructor(text: LocalText) {
    super(englishText(text));
    this.name = "PublicError";
    this.text = text;
  }
}

export function isPublicError(error: unknown): error is PublicError {
  return error instanceof PublicError;
}
