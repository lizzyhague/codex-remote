import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readCodexProtocolManifest } from "../maintenance/codex-types.ts";
import { runAppServerProtocolCheck } from "./protocol-check.ts";

test("real-protocol check opts into experimental methods without starting a turn", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "protocol-check-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  const requestLog = path.join(directory, "requests.jsonl");
  const manifest = await readCodexProtocolManifest();
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log(${JSON.stringify(`codex-cli ${manifest.codexCliVersion}`)});
  process.exit(0);
}
if (args[0] !== "app-server" || args[1] !== "--stdio") process.exit(20);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_REQUEST_LOG, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      userAgent: "fake-codex",
      codexHome: "/private/fake",
      platformFamily: "unix",
      platformOs: "linux"
    }}));
  } else if (message.method === "model/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
  } else if (message.method === "permissionProfile/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
  }
});
`, "utf8");
  await chmod(fakeCodex, 0o700);
  const logs: string[] = [];
  await runAppServerProtocolCheck({
    codexBinary: fakeCodex,
    environment: { ...process.env, FAKE_REQUEST_LOG: requestLog },
    log: logs.push.bind(logs),
  });

  const requests = (await readFile(requestLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), [
    "initialize",
    "initialized",
    "model/list",
    "permissionProfile/list",
  ]);
  assert.equal(requests[0]?.params?.capabilities?.experimentalApi, true);
  assert.equal(requests.some((request) => request.method === "thread/start"), false);
  assert.equal(requests.some((request) => request.method === "turn/start"), false);
  assert.match(logs.join("\n"), /未调用模型/);
});
