import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Private runtime data is readable and writable only by its owner. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

/**
 * Write temporary file → fsync → rename over target → fsync parent directory.
 *
 * Resolution means both the new content and its directory entry have reached storage.
 * Any failure before rename closes and removes the temporary file when possible, then rethrows the original error.
 * If directory sync fails, rename has already happened and either version may survive power loss. Callers must
 * treat this as failure and must not proceed with irreversible operations that depend on this write.
 */
export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle: FileHandle | null = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const closing = handle;
    handle = null;
    await closing.close();
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(directory);
}

/** Delete a file and sync its parent; sync even when absent to persist a possibly unsynced earlier deletion. */
export async function removeFileDurably(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

/** Create missing directories one level at a time and sync each new entry's parent. */
async function ensureDurableDirectory(directory: string): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (created === undefined) return;
  const topmostParent = path.dirname(created);
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    await syncDirectory(current);
    if (current === topmostParent || path.dirname(current) === current) break;
  }
}

/** Linux and macOS both allow opening a directory read-only for fsync; Node uses F_FULLFSYNC on macOS. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  await handle.close();
}

/** Return null when absent; throw for corrupt content so the caller can decide whether to remain unready. */
export async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`状态文件不是有效 JSON：${filePath}`, { cause: error });
  }
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
