import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Merge each project's computed base view roots with service-level additional roots.
 * Inputs must already be resolved real absolute paths; this only builds an independent deduplicated allowlist.
 */
export function buildViewableRoots(
  baseRoots: readonly string[],
  additionalRoots: readonly string[] = [],
): string[] {
  return [...new Set([...baseRoots, ...additionalRoots])];
}

export function resolvePreviewRoot(homeDirectory: string = homedir()): string {
  return path.join(homeDirectory, "preview");
}

export async function ensurePreviewRoot(
  directory: string = resolvePreviewRoot(),
): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await realpath(directory);
  } catch (error) {
    throw new Error(`Could not prepare the file preview directory: ${directory}`, { cause: error });
  }
}
