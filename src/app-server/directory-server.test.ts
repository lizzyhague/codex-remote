import assert from "node:assert/strict";
import test from "node:test";

import type { InitializeParams } from "../generated/InitializeParams.ts";
import type { InitializeResponse } from "../generated/InitializeResponse.ts";
import type { RequestId } from "../generated/RequestId.ts";
import type {
  AppServerClientOptions,
  JsonObject,
} from "./client.ts";
import { DirectoryAppServer } from "./directory-server.ts";

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
  const runtime = new DirectoryAppServer({
    clientFactory: (options) => {
      const process = new FakeAppServerProcess(processes.length + 1, options);
      processes.push(process);
      return process;
    },
  });
  return { runtime, processes };
}

test("forwards notifications from the child and closes it on shutdown", async () => {
  const { runtime, processes } = setupRuntime();
  const notifications: JsonObject[] = [];
  runtime.onNotification((message) => notifications.push(message));

  await runtime.initialize(INITIALIZE_PARAMS);
  const read = await runtime.request<{ generation: number }>("test/read", {});
  assert.equal(read.generation, 1);
  processes[0]?.notify({ method: "test/notified" });
  assert.deepEqual(notifications.map((message) => message.method), ["test/notified"]);

  await runtime.close();
  assert.equal(processes[0]?.closed, true);
  assert.equal(processes.length, 1, "目录 App Server 不会在运行期间重建");
});

test("reports an unexpected child exit as fatal", async () => {
  const { runtime, processes } = setupRuntime();
  await runtime.initialize(INITIALIZE_PARAMS);
  processes[0]?.crash();
  await runtime.whenExited();
  await runtime.close();
});

test("a deliberate close is not reported as a fatal exit", async () => {
  // main.ts 用 whenExited() 决定要不要以退出码 1 结束进程；正常停止必须保持 0。
  const { runtime } = setupRuntime();
  await runtime.initialize(INITIALIZE_PARAMS);
  await runtime.close();
  const settled = await Promise.race([
    runtime.whenExited().then(() => "exited" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(settled, "pending");
});
