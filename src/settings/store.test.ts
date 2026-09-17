import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  ApplicationSettingsError,
  ApplicationSettingsStore,
  MAX_DEVELOPER_INSTRUCTIONS_LENGTH,
  resolveSettingsStatePath,
} from "./store.ts";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "state", "settings.json");
}

test("defaults to an empty developerInstructions value when the file is missing", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  assert.deepEqual(store.get(), { developerInstructions: "" });
  await assert.rejects(readFile(filePath));
});

test("persists developerInstructions atomically and reloads them", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  const saved = await store.update("始终用中文回复。");
  assert.deepEqual(saved, { developerInstructions: "始终用中文回复。" });
  assert.deepEqual(store.get(), { developerInstructions: "始终用中文回复。" });

  const file = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    developerInstructions: string;
  };
  assert.equal(file.version, 1);
  assert.equal(file.developerInstructions, "始终用中文回复。");
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const reloaded = await ApplicationSettingsStore.open(filePath);
  assert.deepEqual(reloaded.get(), { developerInstructions: "始终用中文回复。" });

  await reloaded.update("");
  assert.deepEqual((await ApplicationSettingsStore.open(filePath)).get(), {
    developerInstructions: "",
  });
});

test("rejects values over the character limit and malformed files", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  await assert.rejects(
    () => store.update("字".repeat(MAX_DEVELOPER_INSTRUCTIONS_LENGTH + 1)),
    (error: unknown) =>
      error instanceof ApplicationSettingsError && error.code === "invalid_field",
  );
  assert.deepEqual(store.get(), { developerInstructions: "" });

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, developerInstructions: 12 }));
  await assert.rejects(
    () => ApplicationSettingsStore.open(filePath),
    /格式不正确/u,
  );
});

test("notifies listeners only when the stored value changes", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  const received: string[] = [];
  const stop = store.onChange((settings) => {
    received.push(settings.developerInstructions);
  });
  await store.update("第一版");
  await store.update("第一版");
  await store.update("第二版");
  stop();
  await store.update("第三版");
  assert.deepEqual(received, ["第一版", "第二版"]);
});

test("a throwing listener does not reject the update or block later listeners", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  const received: string[] = [];
  context.mock.method(console, "error", () => {});
  store.onChange(() => {
    throw new Error("stale browser");
  });
  store.onChange((settings) => {
    received.push(settings.developerInstructions);
  });
  await assert.doesNotReject(() => store.update("第一版"));
  assert.deepEqual(store.get(), { developerInstructions: "第一版" });
  assert.deepEqual(received, ["第一版"]);
});

test("keeps settings beside the trash file unless an explicit settings path is set", () => {
  assert.equal(resolveSettingsStatePath({
    CODEX_REMOTE_SETTINGS_FILE: "/var/lib/codex-remote/settings.json",
    CODEX_REMOTE_STATE_FILE: "/ignored/trash.json",
  }), "/var/lib/codex-remote/settings.json");
  assert.equal(resolveSettingsStatePath({
    CODEX_REMOTE_STATE_FILE: "/var/lib/codex-remote/trash.json",
  }), "/var/lib/codex-remote/settings.json");
  assert.equal(resolveSettingsStatePath({
    XDG_STATE_HOME: "/var/state",
  }), "/var/state/codex-remote/settings.json");
});
