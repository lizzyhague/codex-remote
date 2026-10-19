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
  const [readme, operations, readmeZh, operationsZh, manifestSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/operations.md"), "utf8"),
    readFile(path.join(repositoryRoot, "README.zh-CN.md"), "utf8"),
    readFile(path.join(repositoryRoot, "docs/operations.zh-CN.md"), "utf8"),
    readFile(path.join(repositoryRoot, "codex-protocol.json"), "utf8"),
  ]);
  for (const source of [readme, operations, readmeZh, operationsZh]) {
    assert.match(source, /codex-protocol\.json/);
    assert.match(source, /npm run codex:types/);
    assert.match(source, /npm run codex:protocol/);
  }
  assert.doesNotMatch(readme, /generate-ts --out \.\/schemas/);
  const manifest = JSON.parse(manifestSource) as { verifiedCodexCliVersion: string };
  for (const source of [readme, operations, readmeZh, operationsZh]) {
    assert.equal(source.includes(manifest.verifiedCodexCliVersion), false);
  }
  assert.match(readme, /does not restrict which Codex CLI version users install or run/);
  assert.match(operations, /currently installed Codex CLI/);
  assert.match(operations, /does not call a model/);
  assert.match(operations, /does not completely back up or restore Codex native threads/);
  assert.match(readmeZh, /不限制用户安装或运行其他版本/);
  assert.match(operationsZh, /当前安装的 Codex CLI/);
  assert.match(operationsZh, /不会调用模型/);
  assert.match(operationsZh, /不会完整备份或恢复 Codex\s+原生 thread/);
});

test("each public document links to its other language", async () => {
  const pairs = [
    ["README.md", "README.zh-CN.md"],
    ["SECURITY.md", "SECURITY.zh-CN.md"],
    ["CONTRIBUTING.md", "CONTRIBUTING.zh-CN.md"],
    ["docs/architecture.md", "docs/architecture.zh-CN.md"],
    ["docs/deployment.md", "docs/deployment.zh-CN.md"],
    ["docs/operations.md", "docs/operations.zh-CN.md"],
  ];
  for (const [english, chinese] of pairs) {
    const [englishSource, chineseSource] = await Promise.all([
      readFile(path.join(repositoryRoot, english!), "utf8"),
      readFile(path.join(repositoryRoot, chinese!), "utf8"),
    ]);
    assert.ok(englishSource.includes(`English | [中文](${path.basename(chinese!)})`), english);
    assert.ok(chineseSource.includes(`[English](${path.basename(english!)}) | 中文`), chinese);
  }
});
