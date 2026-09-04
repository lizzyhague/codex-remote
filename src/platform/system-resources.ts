import { readFile } from "node:fs/promises";
import { freemem } from "node:os";

export type AvailableMemoryOptions = {
  platform?: NodeJS.Platform;
  readLinuxMeminfo?: () => Promise<string>;
  readFreeMemory?: () => number;
};

/**
 * 返回可用于决定是否启动新 Worker 的保守内存预算。
 * 无法取得可信读数或平台尚未支持时返回 0，由调度器继续排队。
 */
export async function readAvailableMemory(
  options: AvailableMemoryOptions = {},
): Promise<number> {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    try {
      const source = await (options.readLinuxMeminfo ?? (() => readFile("/proc/meminfo", "utf8")))();
      const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(source);
      const kibibytes = match?.[1] ? Number(match[1]) : Number.NaN;
      const bytes = kibibytes * 1_024;
      return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    } catch {
      return 0;
    }
  }

  if (platform === "darwin") {
    try {
      const bytes = (options.readFreeMemory ?? freemem)();
      return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0;
    } catch {
      return 0;
    }
  }

  return 0;
}
