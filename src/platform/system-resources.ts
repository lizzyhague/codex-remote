import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** LaunchDaemon may provide a minimal PATH, so use an absolute path instead of relying on PATH. */
const VM_STAT_PATH = "/usr/bin/vm_stat";
const VM_STAT_TIMEOUT_MS = 1_000;

/** Reading source. `os-freemem` indicates a fallback after the platform-specific source failed. */
export type MemorySource = "linux-meminfo" | "darwin-vm-stat" | "os-freemem";

export type MemoryReading = {
  /** Conservative number of bytes available for starting a new Worker. */
  availableBytes: number;
  platform: NodeJS.Platform;
  source: MemorySource;
  /** Present only after falling back to `os.freemem()`; identifies where platform-specific measurement failed. */
  degradedReason?: string;
};

export type AvailableMemoryOptions = {
  platform?: NodeJS.Platform;
  readLinuxMeminfo?: () => Promise<string>;
  readVmStat?: () => Promise<string>;
  readFreeMemory?: () => number;
  readTotalMemory?: () => number;
};

/**
 * Returns a conservative memory budget for deciding whether to start a new Worker.
 *
 * Linux uses `MemAvailable` from `/proc/meminfo`; macOS derives the value from `vm_stat`.
 * Both count reclaimable file cache as available, giving them equivalent semantics and allowing one
 * shared threshold. If platform-specific measurement fails, this falls back to `os.freemem()` and
 * records the reason in `degradedReason` for the caller to present. It does not return zero, because
 * that would cause the threshold to block every session indefinitely.
 */
export async function readAvailableMemory(
  options: AvailableMemoryOptions = {},
): Promise<MemoryReading> {
  const platform = options.platform ?? process.platform;

  if (platform === "linux") {
    try {
      const source = await (options.readLinuxMeminfo ?? readProcMeminfo)();
      const bytes = parseLinuxAvailableBytes(source);
      if (bytes !== undefined) {
        return { availableBytes: bytes, platform, source: "linux-meminfo" };
      }
      return degraded(platform, "/proc/meminfo 中没有可用的 MemAvailable 数值", options);
    } catch (error) {
      return degraded(platform, `读取 /proc/meminfo 失败（${errorSummary(error)}）`, options);
    }
  }

  if (platform === "darwin") {
    try {
      const source = await (options.readVmStat ?? readVmStat)();
      const total = readTotal(options);
      const parsed = parseDarwinAvailableBytes(source, total);
      if (parsed.ok) {
        return { availableBytes: parsed.availableBytes, platform, source: "darwin-vm-stat" };
      }
      return degraded(platform, `vm_stat 输出缺少${parsed.missing}`, options);
    } catch (error) {
      return degraded(platform, `执行 vm_stat 失败（${errorSummary(error)}）`, options);
    }
  }

  return degraded(platform, `没有为 ${platform} 实现专用的内存读数`, options);
}

/** Parses `MemAvailable` from `/proc/meminfo`; returns undefined if no trustworthy value is available. */
export function parseLinuxAvailableBytes(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo);
  if (!match?.[1]) return undefined;
  const bytes = Number(match[1]) * 1_024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

export type DarwinMemoryParse =
  | { ok: true; availableBytes: number }
  | { ok: false; missing: string };

/**
 * Converts `vm_stat` output into available bytes.
 *
 * macOS has no direct equivalent to `MemAvailable`, so this first totals memory that is truly occupied:
 * anonymous pages, wired pages, and compressor pages, corresponding to "Memory Used" in Activity Monitor.
 * It then subtracts that from total physical memory. Free pages and reclaimable file cache do not count
 * as used, making the result equivalent in meaning to Linux `MemAvailable`.
 *
 * If any required field, including page size, cannot be parsed, returns `missing` so the caller can
 * fall back instead of guessing a plausible-looking number.
 */
export function parseDarwinAvailableBytes(vmStat: string, totalBytes: number): DarwinMemoryParse {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return { ok: false, missing: "可用的物理内存总量" };
  }

  const pageSize = parsePageSize(vmStat);
  if (pageSize === undefined) return { ok: false, missing: "页大小（首行的 page size of N bytes）" };

  const fields = [
    { label: "Anonymous pages", name: "Anonymous pages（匿名页）" },
    { label: "Pages wired down", name: "Pages wired down（wired 页）" },
    { label: "Pages occupied by compressor", name: "Pages occupied by compressor（压缩器占用页）" },
  ] as const;

  let occupiedPages = 0;
  for (const field of fields) {
    const pages = parsePageCount(vmStat, field.label);
    if (pages === undefined) return { ok: false, missing: field.name };
    occupiedPages += pages;
  }

  const occupiedBytes = occupiedPages * pageSize;
  if (!Number.isSafeInteger(occupiedBytes)) return { ok: false, missing: "可信的页数（数值超出安全范围）" };
  return { ok: true, availableBytes: Math.max(0, totalBytes - occupiedBytes) };
}

/** Blocking message for a trustworthy reading below the threshold, including value, source, and configurable limit. */
export function memoryLowMessage(
  action: string,
  reading: MemoryReading,
  minimumBytes: number,
): string {
  return `主机可用内存不足，${action}` +
    `当前可用 ${mebibytes(reading.availableBytes)} MiB，门槛 ${mebibytes(minimumBytes)} MiB` +
    `（平台 ${reading.platform}，读数来源 ${sourceLabel(reading.source)}）。` +
    `内存回落后会自动恢复；如果这台主机本来就该在这个水位上工作，` +
    `可以调整环境变量 CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB。`;
}

/**
 * Allow-through notice for a degraded reading.
 *
 * Failure to read memory does not imply low memory, so a degraded reading does not enforce the threshold.
 * Otherwise, a single parsing failure could prevent every session on the host, including one needed to fix
 * the problem. The tradeoff is losing the pre-start memory guard during this period, so every new Worker
 * reports the condition to encourage a prompt repair.
 */
export function memoryDegradedMessage(reading: MemoryReading, minimumBytes: number): string {
  const freememNote = reading.platform === "darwin"
    ? "os.freemem() 在 macOS 上只统计完全空闲的页，不含可回收的文件缓存，读数通常远低于真实可用内存。"
    : "os.freemem() 只统计完全空闲的内存，不含可回收的缓存，比平台专用读数保守得多。";

  return `主机内存读数不可靠，这个会话已经放行。` +
    `平台 ${reading.platform} 的专用读数失败：${reading.degradedReason ?? "原因未知"}，` +
    `已降级为 os.freemem()，读到 ${mebibytes(reading.availableBytes)} MiB。${freememNote}` +
    `因为这个读数不能代表真实可用内存，${mebibytes(minimumBytes)} MiB 的门槛暂时不生效，` +
    `期间没有启动 Worker 前的内存保护。` +
    `多半是这台主机上该命令的输出格式与解析不一致（例如系统升级后改了字段），` +
    `请尽早修正 src/platform/system-resources.ts 里的解析。`;
}

function degraded(
  platform: NodeJS.Platform,
  reason: string,
  options: AvailableMemoryOptions,
): MemoryReading {
  const free = (options.readFreeMemory ?? freemem)();
  const availableBytes = Number.isSafeInteger(free) && free >= 0 ? free : 0;
  return { availableBytes, platform, source: "os-freemem", degradedReason: reason };
}

function readTotal(options: AvailableMemoryOptions): number {
  const total = (options.readTotalMemory ?? totalmem)();
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

function readProcMeminfo(): Promise<string> {
  return readFile("/proc/meminfo", "utf8");
}

async function readVmStat(): Promise<string> {
  const { stdout } = await execFileAsync(VM_STAT_PATH, { timeout: VM_STAT_TIMEOUT_MS });
  return stdout;
}

function parsePageSize(vmStat: string): number | undefined {
  const match = /page size of (\d+) bytes/u.exec(vmStat);
  if (!match?.[1]) return undefined;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

function parsePageCount(vmStat: string, label: string): number | undefined {
  const match = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "mu").exec(vmStat);
  if (!match?.[1]) return undefined;
  const pages = Number(match[1]);
  return Number.isSafeInteger(pages) && pages >= 0 ? pages : undefined;
}

function sourceLabel(source: MemorySource): string {
  if (source === "linux-meminfo") return "/proc/meminfo 的 MemAvailable";
  if (source === "darwin-vm-stat") return "vm_stat";
  return "os.freemem()";
}

function mebibytes(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

function errorSummary(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
