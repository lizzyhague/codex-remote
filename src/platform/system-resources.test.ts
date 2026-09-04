import assert from "node:assert/strict";
import test from "node:test";

import { readAvailableMemory } from "./system-resources.ts";

test("reads Linux MemAvailable in bytes", async () => {
  assert.equal(await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 2048 kB\n",
  }), 2_097_152);
});

test("returns zero for missing, invalid, or unreadable Linux memory data", async () => {
  assert.equal(await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemTotal: 1000 kB\n",
  }), 0);
  assert.equal(await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemAvailable: no kB\n",
  }), 0);
  assert.equal(await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => { throw new Error("unavailable"); },
  }), 0);
});

test("uses os free memory on macOS", async () => {
  assert.equal(await readAvailableMemory({
    platform: "darwin",
    readFreeMemory: () => 4_294_967_296,
  }), 4_294_967_296);
});

test("returns zero for invalid macOS readings and unsupported platforms", async () => {
  assert.equal(await readAvailableMemory({
    platform: "darwin",
    readFreeMemory: () => Number.NaN,
  }), 0);
  assert.equal(await readAvailableMemory({ platform: "win32" }), 0);
});
