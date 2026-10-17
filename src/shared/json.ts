/**
 * Two shared guards for reading loosely typed JSON from app-server and state files.
 *
 * These functions were previously copied verbatim across the backend more than a dozen times, with one
 * copy even returning a different failure value. Identical names with different contracts invite future
 * bugs, so they live here now and consistently return `null` on failure.
 */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}
