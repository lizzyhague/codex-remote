import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

/** 私有运行数据只允许属主读写。 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

/**
 * 写临时文件 → fsync → rename 覆盖 → fsync 父目录。
 *
 * resolve 表示新内容和指向它的目录项都已同步到存储，掉电后读到的就是新内容。
 * rename 之前的任何失败都会尽力关闭并删除临时文件，再抛出原始错误，目标文件保持旧内容。
 * 目录同步失败时 rename 已经发生：掉电后可能是旧内容也可能是新内容，调用方必须把它当作
 * 失败处理，不能继续依赖这次写入的不可逆操作。
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

/** 删除文件并同步父目录；文件本来不存在也同步一次，补上此前可能未落盘的删除。 */
export async function removeFileDurably(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

/** 目录不存在时逐级创建，并同步每个新目录项所在的上级目录。 */
async function ensureDurableDirectory(directory: string): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (created === undefined) return;
  const topmostParent = path.dirname(created);
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    await syncDirectory(current);
    if (current === topmostParent || path.dirname(current) === current) break;
  }
}

/** Linux 与 macOS 都允许以只读方式打开目录并 fsync；Node 在 macOS 上会用 F_FULLFSYNC。 */
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

/** 文件不存在时返回 null；内容损坏时抛错，由调用方决定是否保持未就绪。 */
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
