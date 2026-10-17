/**
 * Use this base class only for business errors explicitly authored by Remote and safe to show verbatim
 * in the browser. Errors from external services, the operating system, and unknown exceptions must not
 * be wrapped ad hoc as PublicError merely to preserve their original text.
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicError";
  }
}

export function isPublicError(error: unknown): error is PublicError {
  return error instanceof PublicError;
}
