import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** LaunchDaemon 下的 PATH 可能很小，因此使用绝对路径而不是依赖 PATH。 */
const VM_STAT_PATH = "/usr/bin/vm_stat";
const VM_STAT_TIMEOUT_MS = 1_000;

/** 读数来源。`os-freemem` 表示平台专用来源失败后的降级结果。 */
export type MemorySource = "linux-meminfo" | "darwin-vm-stat" | "os-freemem";

export type MemoryReading = {
  /** 可供启动新 Worker 使用的保守可用字节数。 */
  availableBytes: number;
  platform: NodeJS.Platform;
  source: MemorySource;
  /** 只有降级到 `os.freemem()` 时才有值，说明平台专用读数断在哪一步。 */
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
 * 返回可用于决定是否启动新 Worker 的保守内存预算。
 *
 * Linux 用 `/proc/meminfo` 的 `MemAvailable`，macOS 用 `vm_stat` 换算，两者都把
 * 可回收的文件缓存算作可用，语义一致，因此可以共用同一个门槛值。平台专用读数
 * 失败时降级到 `os.freemem()` 并在 `degradedReason` 里说明原因，由调用方决定
 * 怎么告诉用户；不返回 0，因为 0 会让门槛永久拦住所有会话。
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

/** 解析 `/proc/meminfo` 的 `MemAvailable`，取不到可信数值时返回 undefined。 */
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
 * 把 `vm_stat` 的输出换算成可用字节。
 *
 * macOS 没有 `MemAvailable` 那样的现成数值，因此这里先加出「确实被占住」的部分
 * ——匿名页、wired 页和压缩器占用的页，也就是活动监视器里的「已用内存」——再用
 * 物理内存总量减去它。空闲页和可回收的文件缓存都不计入已用，这样得到的结果与
 * Linux 的 `MemAvailable` 含义一致。
 *
 * 任何一个必需字段（含页大小）解析不出来就返回 `missing`，由调用方降级，而不是
 * 猜一个看起来合理的数字。
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

/** 可信读数低于门槛时的拦截提示，写明数值、来源和可调的门槛。 */
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
 * 降级读数时的放行提示。
 *
 * 读不到内存不等于内存不足，因此降级期间不按门槛拦截——否则一次解析失效就会让整台
 * 主机开不出任何会话，连修复所需的会话也开不出来。代价是这段时间没有启动前的内存
 * 保护，所以每次开新 Worker 都要把话说清楚，促成尽早修复。
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
