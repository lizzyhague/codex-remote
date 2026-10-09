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
import { injectFsFaults, temporaryFiles } from "../workers/fs-fault-injection.ts";

async function fixture(context: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "state", "settings.json");
}

const DEFAULTS = {
  developerInstructions: "",
  defaultModel: null,
  defaultReasoningEffort: null,
};

test("defaults to Codex-owned model settings when the file is missing", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  assert.deepEqual(store.get(), DEFAULTS);
  await assert.rejects(readFile(filePath));
});

test("persists full settings atomically and applies partial updates", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  const saved = await store.update({ developerInstructions: "始终用中文回复。" });
  assert.deepEqual(saved, { ...DEFAULTS, developerInstructions: "始终用中文回复。" });

  await store.update({
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
  });
  assert.deepEqual(store.get(), {
    developerInstructions: "始终用中文回复。",
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
  });

  const file = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    developerInstructions: string;
    defaultModel: string | null;
    defaultReasoningEffort: string | null;
  };
  assert.equal(file.version, 1);
  assert.equal(file.developerInstructions, "始终用中文回复。");
  assert.equal(file.defaultModel, "gpt-test");
  assert.equal(file.defaultReasoningEffort, "high");
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const reloaded = await ApplicationSettingsStore.open(filePath);
  assert.deepEqual(reloaded.get(), store.get());

  await reloaded.update({ developerInstructions: "" });
  assert.deepEqual((await ApplicationSettingsStore.open(filePath)).get(), {
    developerInstructions: "",
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
  });
});

test("loads legacy version 1 settings without model fields", async (context) => {
  const filePath = await fixture(context);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    version: 1,
    developerInstructions: "旧指令",
  }));
  assert.deepEqual((await ApplicationSettingsStore.open(filePath)).get(), {
    ...DEFAULTS,
    developerInstructions: "旧指令",
  });
});

test("rejects values over the character limit and malformed files", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  await assert.rejects(
    () => store.update({
      developerInstructions: "字".repeat(MAX_DEVELOPER_INSTRUCTIONS_LENGTH + 1),
    }),
    (error: unknown) =>
      error instanceof ApplicationSettingsError && error.code === "invalid_field",
  );
  await assert.rejects(
    () => store.update({ defaultModel: "gpt-test" }),
    /必须一起保存/u,
  );
  await assert.rejects(
    () => store.update({ defaultModel: null, defaultReasoningEffort: "high" }),
    /思考强度也必须跟随/u,
  );
  assert.deepEqual(store.get(), DEFAULTS);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ version: 1, developerInstructions: 12 }));
  await assert.rejects(
    () => ApplicationSettingsStore.open(filePath),
    /格式不正确/u,
  );
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

test("a failed save keeps the previous value and leaves no temporary file", async (context) => {
  const filePath = await fixture(context);
  const store = await ApplicationSettingsStore.open(filePath);
  await store.update({ developerInstructions: "旧指令" });

  for (const stage of ["file-write", "directory-sync"] as const) {
    const faults = injectFsFaults(context, { fail: { [stage]: 1 } });
    await assert.rejects(
      store.update({ developerInstructions: "新指令" }),
      new RegExp(`injected ${stage} failure`, "u"),
    );
    faults.heal();
    context.mock.restoreAll();
    assert.deepEqual(store.get(), { ...DEFAULTS, developerInstructions: "旧指令" });
    assert.deepEqual(await temporaryFiles(path.dirname(filePath)), []);
  }

  await store.update({ developerInstructions: "新指令" });
  assert.deepEqual(store.get(), { ...DEFAULTS, developerInstructions: "新指令" });
});
