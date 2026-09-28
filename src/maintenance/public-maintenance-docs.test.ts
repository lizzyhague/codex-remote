import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("launchd documentation names every template placeholder exactly", async () => {
  const [deployment, template] = await Promise.all([
    readFile(path.join(repositoryRoot, "docs/deployment.md"), "utf8"),
    readFile(path.join(repositoryRoot, "deploy/launchd/codex-remote.plist.example"), "utf8"),
  ]);
  const placeholders = [...new Set(template.match(/__[A-Z_]+__/g) ?? [])];
  for (const placeholder of placeholders) {
    assert.match(deployment, new RegExp(placeholder), `${placeholder} must be documented`);
  }
  assert.doesNotMatch(deployment, /__SERVICE_LABEL__/);
});

test("public maintenance docs point to the reproducible protocol workflow", async () => {
  const [readme, operations, manifestSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/operations.md"), "utf8"),
    readFile(path.join(repositoryRoot, "codex-protocol.json"), "utf8"),
  ]);
  for (const source of [readme, operations]) {
    assert.match(source, /codex-protocol\.json/);
    assert.match(source, /npm run codex:types/);
    assert.match(source, /npm run codex:protocol/);
  }
  assert.doesNotMatch(readme, /generate-ts --out \.\/schemas/);
  const manifest = JSON.parse(manifestSource) as { codexCliVersion: string };
  assert.equal(readme.includes(manifest.codexCliVersion), false);
  assert.equal(operations.includes(manifest.codexCliVersion), false);
  assert.match(operations, /不会调用模型/);
  assert.match(operations, /不会完整备份或恢复 Codex\s+原生 thread/);
});
