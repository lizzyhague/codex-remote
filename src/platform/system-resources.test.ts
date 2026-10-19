import { englishText, localText } from "../shared/local-text.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryDegradedMessage,
  memoryLowMessage,
  parseDarwinAvailableBytes,
  parseLinuxAvailableBytes,
  readAvailableMemory,
} from "./system-resources.ts";

/** Real `vm_stat` output from base (Apple Silicon Mac mini), with 16 KiB pages. */
const appleSiliconVmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     9183.
Pages active:                                 411410.
Pages inactive:                               487519.
Pages speculative:                              1860.
Pages throttled:                                   0.
Pages wired down:                             103114.
Pages purgeable:                               12355.
"Translation faults":                       17091566.
Pages copy-on-write:                         1024590.
Pages zero filled:                          12602470.
Pages reactivated:                              7665.
Pages purged:                                 115981.
File-backed pages:                            433779.
Anonymous pages:                              467010.
Pages stored in compressor:                     3223.
Pages occupied by compressor:                    798.
Decompressions:                                 2043.
Compressions:                                   5266.
Pageins:                                      543115.
Pageouts:                                         12.
Swapins:                                           0.
Swapouts:                                          0.
`;

/** Intel `vm_stat` output with 4 KiB pages. */
const intelVmStat = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              200000.
Pages wired down:                         50000.
Anonymous pages:                         100000.
Pages occupied by compressor:             10000.
`;

const sixteenGiB = 17_179_869_184;
const eightGiB = 8_589_934_592;

test("Linux reads MemAvailable and counts reclaimable cache as available", async () => {
  assert.equal(parseLinuxAvailableBytes("MemTotal: 1000 kB\nMemAvailable: 2048 kB\n"), 2_097_152);

  const reading = await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemTotal: 4000000 kB\nMemAvailable: 2861716 kB\n",
  });
  assert.deepEqual(reading, {
    availableBytes: 2_930_397_184,
    platform: "linux",
    source: "linux-meminfo",
  });
});

test("Linux falls back to os.freemem() instead of returning zero when reading is missing or fails", async () => {
  const missing = await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemTotal: 1000 kB\n",
    readFreeMemory: () => 512 * 1_048_576,
  });
  assert.equal(missing.source, "os-freemem");
  assert.equal(missing.availableBytes, 512 * 1_048_576);
  assert.match(missing.degradedReason ?? "", /MemAvailable/u);

  const failed = await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => {
      throw new Error("EACCES");
    },
    readFreeMemory: () => 0,
  });
  assert.equal(failed.source, "os-freemem");
  assert.match(failed.degradedReason ?? "", /EACCES/u);
});

test("macOS derives available memory from occupied pages without counting cache as used", () => {
  const parsed = parseDarwinAvailableBytes(appleSiliconVmStat, sixteenGiB);
  assert.equal(parsed.ok, true);
  // (Anonymous 467010 + wired 103114 + compressor 798) × 16384 = 9_353_986_048
  assert.equal(parsed.ok && parsed.availableBytes, sixteenGiB - 9_353_986_048);
});

test("macOS reads page size from the first output line instead of assuming 4096", () => {
  const parsed = parseDarwinAvailableBytes(intelVmStat, eightGiB);
  assert.equal(parsed.ok, true);
  // (100000 + 50000 + 10000) × 4096 = 655_360_000
  assert.equal(parsed.ok && parsed.availableBytes, eightGiB - 655_360_000);
});

test("macOS reports the missing required field instead of guessing a value", () => {
  const withoutCompressor = appleSiliconVmStat
    .split("\n")
    .filter((line) => !line.startsWith("Pages occupied by compressor:"))
    .join("\n");
  const parsed = parseDarwinAvailableBytes(withoutCompressor, sixteenGiB);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.missing, /compressor/u);

  const withoutHeader = intelVmStat.split("\n").slice(1).join("\n");
  const noPageSize = parseDarwinAvailableBytes(withoutHeader, eightGiB);
  assert.equal(noPageSize.ok, false);
  assert.match(noPageSize.ok ? "" : noPageSize.missing, /page size/u);

  assert.equal(parseDarwinAvailableBytes(appleSiliconVmStat, 0).ok, false);
});

test("macOS falls back to os.freemem() after a parsing or command failure", async () => {
  const unparsable = await readAvailableMemory({
    platform: "darwin",
    readVmStat: async () => "totally unexpected output",
    readTotalMemory: () => sixteenGiB,
    readFreeMemory: () => 216 * 1_048_576,
  });
  assert.equal(unparsable.source, "os-freemem");
  assert.equal(unparsable.availableBytes, 216 * 1_048_576);
  assert.match(unparsable.degradedReason ?? "", /vm_stat/u);

  const failed = await readAvailableMemory({
    platform: "darwin",
    readVmStat: async () => {
      throw new Error("spawn ENOENT");
    },
    readTotalMemory: () => sixteenGiB,
    readFreeMemory: () => 0,
  });
  assert.equal(failed.source, "os-freemem");
  assert.match(failed.degradedReason ?? "", /ENOENT/u);
});

test("macOS does not fall back when its reading succeeds", async () => {
  const reading = await readAvailableMemory({
    platform: "darwin",
    readVmStat: async () => appleSiliconVmStat,
    readTotalMemory: () => sixteenGiB,
    readFreeMemory: () => 216 * 1_048_576,
  });
  assert.equal(reading.source, "darwin-vm-stat");
  assert.equal(reading.degradedReason, undefined);
  assert.equal(reading.availableBytes, sixteenGiB - 9_353_986_048);
});

test("unsupported platforms fall back to os.freemem() and report the reason", async () => {
  const reading = await readAvailableMemory({
    platform: "win32",
    readFreeMemory: () => 1_048_576,
  });
  assert.equal(reading.source, "os-freemem");
  assert.equal(reading.availableBytes, 1_048_576);
  assert.match(reading.degradedReason ?? "", /win32/u);
});

test("blocking message for a normal reading includes value, source, and configurable environment variable", () => {
  const message = englishText(memoryLowMessage(
    localText("memory.cannotCreateSession"),
    { availableBytes: 512 * 1_048_576, platform: "linux", source: "linux-meminfo" },
    1_024 * 1_048_576,
  ));
  assert.match(message, /A new session can't be started right now/u);
  assert.match(message, /Available: 512 MiB/u);
  assert.match(message, /threshold: 1024 MiB/u);
  assert.match(message, /MemAvailable/u);
  assert.match(message, /CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB/u);
});

test("degraded notice explains allowance, failure point, disabled threshold, and configuration location", () => {
  const message = englishText(memoryDegradedMessage(
    {
      availableBytes: 216 * 1_048_576,
      platform: "darwin",
      source: "os-freemem",
      degradedReason: "vm_stat output is missing Pages occupied by compressor",
    },
    1_024 * 1_048_576,
  ));
  assert.match(message, /allowed through/u);
  assert.match(message, /compressor/u);
  assert.match(message, /os\.freemem\(\)/u);
  assert.match(message, /216 MiB/u);
  assert.match(message, /1024 MiB threshold is suspended/u);
  assert.match(message, /without the memory guard/u);
  assert.match(message, /On macOS, os\.freemem\(\) counts only completely free pages/u);
  assert.match(message, /system-resources\.ts/u);
});
