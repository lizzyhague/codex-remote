import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** 私有运行数据只允许属主读写。 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

/** 写临时文件 → fsync → rename 覆盖。崩溃时要么是旧内容，要么是完整的新内容。 */
export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

/** 文件不存在时返回 null；内容损坏时抛错，由调用方决定是否保持未就绪。 */
export async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
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
