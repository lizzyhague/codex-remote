import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RequestId } from "../generated/RequestId.ts";
import { AppServerClient, type JsonObject } from "./client.ts";

test("responds to a server-initiated request over JSONL", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "codex-remote-client-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const fakeServer = path.join(temporaryDirectory, "fake-app-server.mjs");
  await writeFile(fakeServer, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: "/tmp/fake-codex",
        platformFamily: "unix",
        platformOs: "linux"
      }
    }));
  } else if (message.method === "initialized") {
    console.log(JSON.stringify({
      id: "server-approval",
      method: "item/fileChange/requestApproval",
      params: {}
    }));
  } else if (message.id === "server-approval") {
    console.log(JSON.stringify({
      method: "test/received",
      params: { result: message.result }
    }));
  }
});
`, "utf8");
  await chmod(fakeServer, 0o700);

  let client!: AppServerClient;
  let resolveReceived!: (message: JsonObject) => void;
  const received = new Promise<JsonObject>((resolve) => {
    resolveReceived = resolve;
  });
  client = new AppServerClient({
    codexBinary: fakeServer,
    onServerRequest: (message) => {
      client.respondToServerRequest(message.id as RequestId, {
        decision: "accept",
      });
    },
    onNotification: (message) => {
      if (message.method === "test/received") {
        resolveReceived(message);
      }
    },
  });

  try {
    await client.initialize({
      clientInfo: {
        name: "codex_remote_test",
        title: "Codex Remote Test",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    const message = await Promise.race([
      received,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("等待双向 JSONL 响应超时。")), 2_000);
      }),
    ]);
    assert.deepEqual(message.params, {
      result: { decision: "accept" },
    });
  } finally {
    await client.close();
  }
});
