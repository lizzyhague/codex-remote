import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryDegradedMessage,
  memoryLowMessage,
  parseDarwinAvailableBytes,
  parseLinuxAvailableBytes,
  readAvailableMemory,
} from "./system-resources.ts";

/** base（Apple Silicon Mac mini）上 vm_stat 的真实输出，页大小 16 KiB。 */
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

/** Intel 的 vm_stat 输出，页大小 4 KiB。 */
const intelVmStat = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              200000.
Pages wired down:                         50000.
Anonymous pages:                         100000.
Pages occupied by compressor:             10000.
`;

const sixteenGiB = 17_179_869_184;
const eightGiB = 8_589_934_592;

test("Linux 读取 MemAvailable，可回收缓存算作可用", async () => {
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

test("Linux 读数缺失或读取失败时降级到 os.freemem()，而不是返回 0", async () => {
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

test("macOS 用已占用的页换算可用内存，缓存不计入已用", () => {
  const parsed = parseDarwinAvailableBytes(appleSiliconVmStat, sixteenGiB);
  assert.equal(parsed.ok, true);
  // (Anonymous 467010 + wired 103114 + compressor 798) × 16384 = 9_353_986_048
  assert.equal(parsed.ok && parsed.availableBytes, sixteenGiB - 9_353_986_048);
});

test("macOS 页大小取自输出首行，不写死 4096", () => {
  const parsed = parseDarwinAvailableBytes(intelVmStat, eightGiB);
  assert.equal(parsed.ok, true);
  // (100000 + 50000 + 10000) × 4096 = 655_360_000
  assert.equal(parsed.ok && parsed.availableBytes, eightGiB - 655_360_000);
});

test("macOS 缺少必需字段时报出缺的是哪一项，不猜数字", () => {
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
  assert.match(noPageSize.ok ? "" : noPageSize.missing, /页大小/u);

  assert.equal(parseDarwinAvailableBytes(appleSiliconVmStat, 0).ok, false);
});

test("macOS 解析失败或命令失败时降级到 os.freemem()", async () => {
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

test("macOS 正常读数不走降级", async () => {
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

test("未支持的平台降级到 os.freemem() 并说明原因", async () => {
  const reading = await readAvailableMemory({
    platform: "win32",
    readFreeMemory: () => 1_048_576,
  });
  assert.equal(reading.source, "os-freemem");
  assert.equal(reading.availableBytes, 1_048_576);
  assert.match(reading.degradedReason ?? "", /win32/u);
});

test("正常读数的拦截提示写明数值、来源和可调的环境变量", () => {
  const message = memoryLowMessage(
    "暂时不能新建会话。",
    { availableBytes: 512 * 1_048_576, platform: "linux", source: "linux-meminfo" },
    1_024 * 1_048_576,
  );
  assert.match(message, /当前可用 512 MiB/u);
  assert.match(message, /门槛 1024 MiB/u);
  assert.match(message, /MemAvailable/u);
  assert.match(message, /CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB/u);
});

test("降级提示说明已放行、断在哪里、门槛暂不生效，以及往哪里改", () => {
  const message = memoryDegradedMessage(
    {
      availableBytes: 216 * 1_048_576,
      platform: "darwin",
      source: "os-freemem",
      degradedReason: "vm_stat 输出缺少 Pages occupied by compressor（压缩器占用页）",
    },
    1_024 * 1_048_576,
  );
  assert.match(message, /已经放行/u);
  assert.match(message, /compressor/u);
  assert.match(message, /os\.freemem\(\)/u);
  assert.match(message, /216 MiB/u);
  assert.match(message, /1024 MiB 的门槛暂时不生效/u);
  assert.match(message, /没有启动 Worker 前的内存保护/u);
  assert.match(message, /system-resources\.ts/u);
});
