import type { InitializeParams } from "../generated/InitializeParams.ts";

export function codexRemoteInitializeParams(): InitializeParams {
  return {
    clientInfo: {
      name: "codex_remote",
      title: "Codex Remote",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
    },
  };
}
