import assert from "node:assert/strict";
import test from "node:test";

import type { InitializeParams } from "../generated/InitializeParams.ts";
import type { InitializeResponse } from "../generated/InitializeResponse.ts";
import type { RequestId } from "../generated/RequestId.ts";
import type {
  AppServerClientOptions,
  JsonObject,
} from "./client.ts";
import { RestartableAppServer } from "./runtime.ts";

const INITIALIZE_PARAMS: InitializeParams = {
  clientInfo: {
    name: "codex_remote_test",
    title: "Codex Remote Test",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
  },
};

class FakeAppServerProcess {
  readonly generation: number;
  readonly #options: AppServerClientOptions;
  readonly #exited: Promise<void>;
  #resolveExited!: () => void;
  closed = false;

  constructor(generation: number, options: AppServerClientOptions) {
    this.generation = generation;
    this.#options = options;
    this.#exited = new Promise((resolve) => {
      this.#resolveExited = resolve;
    });
  }

  async initialize(_params: InitializeParams): Promise<InitializeResponse> {
    return {
      userAgent: `fake-${this.generation}`,
      codexHome: "/tmp/fake-codex",
      platformFamily: "unix",
      platformOs: "linux",
    };
  }

  async request<Result>(_method: string, _params: unknown): Promise<Result> {
    return { generation: this.generation } as Result;
  }

  respondToServerRequest(_id: RequestId, _result: unknown): void {}

  whenExited(): Promise<void> {
    return this.#exited;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.#resolveExited();
  }

  crash(): void {
    this.#resolveExited();
  }

  notify(message: JsonObject): void {
    this.#options.onNotification?.(message);
  }
}

function setupRuntime() {
  const processes: FakeAppServerProcess[] = [];
  const runtime = new RestartableAppServer({
    clientFactory: (options) => {
      const process = new FakeAppServerProcess(processes.length + 1, options);
      processes.push(process);
      return process;
    },
  });
  return { runtime, processes };
}

test("rebuilds the child process and keeps listeners attached", async () => {
  const { runtime, processes } = setupRuntime();
  const notifications: JsonObject[] = [];
  runtime.onNotification((message) => notifications.push(message));

  await runtime.initialize(INITIALIZE_PARAMS);
  const before = await runtime.request<{ generation: number }>("test/read", {});
  assert.equal(before.generation, 1);
  processes[0]?.notify({ method: "test/before" });

  const releasing = runtime.releaseWriters();
  // 这个请求在 releaseWriters 之后发出，必须等待第二个子进程，而不是写入旧 stdin。
  const during = runtime.request<{ generation: number }>("test/read", {});
  await releasing;
  assert.equal((await during).generation, 2);
  assert.equal(processes[0]?.closed, true);
  assert.equal(processes.length, 2);

  processes[1]?.notify({ method: "test/after" });
  assert.deepEqual(notifications.map((message) => message.method), [
    "test/before",
    "test/after",
  ]);

  await runtime.close();
  assert.equal(processes[1]?.closed, true);
});

test("reports only unexpected child exits as fatal", async () => {
  const { runtime, processes } = setupRuntime();
  await runtime.initialize(INITIALIZE_PARAMS);
  processes[0]?.crash();
  await runtime.whenExited();
  await runtime.close();
});
