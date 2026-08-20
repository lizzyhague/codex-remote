import type { InitializeParams } from "../generated/InitializeParams.ts";

import { AppServerClient } from "./client.ts";

const initializeParams: InitializeParams = {
  clientInfo: {
    name: "codex_remote",
    title: "Codex Remote",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
  },
};

const client = new AppServerClient({ workingDirectory: process.cwd() });

try {
  const server = await client.initialize(initializeParams);
  console.log(`连接成功：${server.userAgent} · ${server.platformOs}`);
} finally {
  await client.close();
}
