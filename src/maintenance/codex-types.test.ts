import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { runCodexTypes } from "./codex-types.ts";

const execFileAsync = promisify(execFile);

test("isolated generation reports the installed and verified versions, experimental surface, and imported tree", async (context) => {
  const fixture = await protocolFixture(context);
  await runCodexTypes([], {
    repositoryRoot: fixture.root,
    environment: fixture.environment,
    log: fixture.logs.push.bind(fixture.logs),
  });

  assert.match(fixture.logs.join("\n"), /codex-cli 1\.2\.3.*完全一致.*experimental surface/);
  assert.match(fixture.logs.join("\n"), /已验证版本是 Codex CLI 1\.2\.3/);
  const invocations = await fixture.invocations();
  assert.deepEqual(invocations.map((entry) => entry.arguments), [
    ["--version"],
    ["app-server", "generate-ts", "--out", invocations[1]?.arguments[3], "--experimental"],
  ]);
  assert.notEqual(invocations[1]?.codexHome, fixture.environment.CODEX_HOME);
  assert.match(invocations[1]?.codexHome ?? "", /codex-remote-protocol-/);
});

test("a different installed CLI is allowed and identified", async (context) => {
  const fixture = await protocolFixture(context, { cliVersion: "1.2.4" });
  await runCodexTypes([], {
    repositoryRoot: fixture.root,
    environment: fixture.environment,
    log: fixture.logs.push.bind(fixture.logs),
  });
  assert.match(fixture.logs.join("\n"), /codex-cli 1\.2\.4/);
  assert.match(fixture.logs.join("\n"), /已验证版本是 Codex CLI 1\.2\.3/);
  const invocations = await fixture.invocations();
  assert.deepEqual(invocations.map((entry) => entry.arguments), [
    ["--version"],
    ["app-server", "generate-ts", "--out", invocations[1]?.arguments[3], "--experimental"],
  ]);
});

test("check reports generated additions, changes, and stale tracked files", async (context) => {
  const fixture = await protocolFixture(context);
  await writeFile(path.join(fixture.generatedSource, "Changed.ts"), "candidate\n", "utf8");
  await writeFile(path.join(fixture.generatedSource, "Added.ts"), "added\n", "utf8");
  await writeFile(path.join(fixture.outputDirectory, "Stale.ts"), "stale\n", "utf8");

  await assert.rejects(
    runCodexTypes([], {
      repositoryRoot: fixture.root,
      environment: fixture.environment,
    }),
    (error: unknown) => {
      assert.match(String(error), /A Added\.ts/);
      assert.match(String(error), /M Changed\.ts/);
      assert.match(String(error), /D Stale\.ts/);
      return true;
    },
  );
});

test("write replaces the exact generated tree and refuses unknown generated edits", async (context) => {
  const fixture = await protocolFixture(context);
  await initializeGitRepository(fixture.root);
  await writeFile(path.join(fixture.outputDirectory, "unknown.ts"), "do not overwrite\n", "utf8");
  await assert.rejects(
    runCodexTypes(["--write"], {
      repositoryRoot: fixture.root,
      environment: fixture.environment,
    }),
    /有未提交改动；--write 不会覆盖/,
  );

  await rm(path.join(fixture.outputDirectory, "unknown.ts"));
  await writeFile(path.join(fixture.generatedSource, "Changed.ts"), "new\n", "utf8");
  await writeFile(path.join(fixture.generatedSource, "OnlyNew.ts"), "new file\n", "utf8");
  await writeFile(path.join(fixture.outputDirectory, "OnlyOld.ts"), "old file\n", "utf8");
  await execFileAsync("git", ["add", "src/generated/OnlyOld.ts"], { cwd: fixture.root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "old generated"],
    { cwd: fixture.root },
  );

  await runCodexTypes(["--write"], {
    repositoryRoot: fixture.root,
    environment: fixture.environment,
  });
  assert.equal(await readFile(path.join(fixture.outputDirectory, "Changed.ts"), "utf8"), "new\n");
  assert.equal(await readFile(path.join(fixture.outputDirectory, "OnlyNew.ts"), "utf8"), "new file\n");
  await assert.rejects(readFile(path.join(fixture.outputDirectory, "OnlyOld.ts")), /ENOENT/);
});

type FixtureOptions = { cliVersion?: string };

async function protocolFixture(context: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-types-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "src/generated");
  const generatedSource = path.join(root, "candidate");
  const invocationFile = path.join(root, "invocations.jsonl");
  const fakeCodex = path.join(root, "fake-codex.mjs");
  await Promise.all([
    mkdir(outputDirectory, { recursive: true }),
    mkdir(generatedSource, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(outputDirectory, "Changed.ts"), "same\n", "utf8"),
    writeFile(path.join(generatedSource, "Changed.ts"), "same\n", "utf8"),
    writeFile(
      path.join(root, "codex-protocol.json"),
      JSON.stringify({
        verifiedCodexCliVersion: "1.2.3",
        outputDirectory: "src/generated",
        experimental: true,
      }, null, 2) + "\n",
      "utf8",
    ),
    writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFile, cp, mkdir } from "node:fs/promises";
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_INVOCATIONS, JSON.stringify({
  arguments: args,
  codexHome: process.env.CODEX_HOME
}) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  console.log("codex-cli ${options.cliVersion ?? "1.2.3"}");
  process.exit(0);
}
const outIndex = args.indexOf("--out");
if (args[0] !== "app-server" || args[1] !== "generate-ts" || outIndex < 0) process.exit(20);
if (!args.includes("--experimental")) process.exit(21);
const output = args[outIndex + 1];
await mkdir(output, { recursive: true });
await cp(process.env.FAKE_GENERATED_SOURCE, output, { recursive: true });
`, "utf8"),
  ]);
  await chmod(fakeCodex, 0o700);
  const logs: string[] = [];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_BIN: fakeCodex,
    CODEX_HOME: path.join(root, "must-not-be-used"),
    FAKE_GENERATED_SOURCE: generatedSource,
    FAKE_INVOCATIONS: invocationFile,
  };
  return {
    root,
    outputDirectory,
    generatedSource,
    environment,
    logs,
    async invocations(): Promise<Array<{ arguments: string[]; codexHome: string }>> {
      const source = await readFile(invocationFile, "utf8");
      return source.trim().split("\n").map((line) => JSON.parse(line));
    },
  };
}

async function initializeGitRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["add", "codex-protocol.json", "src/generated"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"],
    { cwd: root },
  );
}
