import { localText, type LocalText } from "../shared/local-text.ts";
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
      return degraded(platform, "/proc/meminfo has no usable MemAvailable value", options);
    } catch (error) {
      return degraded(platform, `reading /proc/meminfo failed (${errorSummary(error)})`, options);
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
      return degraded(platform, `vm_stat output is missing ${parsed.missing}`, options);
    } catch (error) {
      return degraded(platform, `running vm_stat failed (${errorSummary(error)})`, options);
    }
  }

  return degraded(platform, `no dedicated memory reading is implemented for ${platform}`, options);
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
    return { ok: false, missing: "a usable total physical memory" };
  }

  const pageSize = parsePageSize(vmStat);
  if (pageSize === undefined) return { ok: false, missing: "the page size (page size of N bytes on the first line)" };

  const fields = [
    { label: "Anonymous pages", name: "Anonymous pages" },
    { label: "Pages wired down", name: "Pages wired down" },
    { label: "Pages occupied by compressor", name: "Pages occupied by compressor" },
  ] as const;

  let occupiedPages = 0;
  for (const field of fields) {
    const pages = parsePageCount(vmStat, field.label);
    if (pages === undefined) return { ok: false, missing: field.name };
    occupiedPages += pages;
  }

  const occupiedBytes = occupiedPages * pageSize;
  if (!Number.isSafeInteger(occupiedBytes)) return { ok: false, missing: "a trustworthy page count (the value exceeds the safe range)" };
  return { ok: true, availableBytes: Math.max(0, totalBytes - occupiedBytes) };
}

/** Blocking message for a trustworthy reading below the threshold, including value, source, and configurable limit. */
export function memoryLowMessage(
  action: LocalText,
  reading: MemoryReading,
  minimumBytes: number,
): LocalText {
  return localText("memory.low", {
    action,
    available: mebibytes(reading.availableBytes),
    minimum: mebibytes(minimumBytes),
    platform: reading.platform,
    source: sourceLabel(reading.source),
  });
}

/**
 * Allow-through notice for a degraded reading.
 *
 * Failure to read memory does not imply low memory, so a degraded reading does not enforce the threshold.
 * Otherwise, a single parsing failure could prevent every session on the host, including one needed to fix
 * the problem. The tradeoff is losing the pre-start memory guard during this period, so every new Worker
 * reports the condition to encourage a prompt repair.
 */
export function memoryDegradedMessage(reading: MemoryReading, minimumBytes: number): LocalText {
  return localText("memory.degraded", {
    platform: reading.platform,
    reason: reading.degradedReason ?? "unknown reason",
    available: mebibytes(reading.availableBytes),
    note: localText(reading.platform === "darwin" ? "memory.freememNoteMac" : "memory.freememNote"),
    minimum: mebibytes(minimumBytes),
  });
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
  if (source === "linux-meminfo") return "MemAvailable in /proc/meminfo";
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
