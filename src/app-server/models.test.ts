import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerMessageListener, JsonObject } from "./client.ts";
import type { AppServerTransport } from "./turn-session.ts";
import { listModels } from "./models.ts";

class FakeTransport implements AppServerTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    const cursor = (params as JsonObject).cursor;
    return (cursor === null
      ? {
        data: [{
          id: "gpt-a",
          displayName: "GPT A",
          description: "模型 A",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "较快" },
            { ignored: true },
          ],
        }],
        nextCursor: "page-2",
      }
      : {
        data: [{
          id: "gpt-b",
          displayName: "GPT B",
          description: "模型 B",
          isDefault: false,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [],
        }],
        nextCursor: null,
      }) as Result;
  }

  onNotification(_listener: AppServerMessageListener): () => void {
    return () => {};
  }
}

test("reads every visible model page into the shared picker shape", async () => {
  const transport = new FakeTransport();
  assert.deepEqual(await listModels(transport), [
    {
      id: "gpt-a",
      displayName: "GPT A",
      description: "模型 A",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "较快" }],
    },
    {
      id: "gpt-b",
      displayName: "GPT B",
      description: "模型 B",
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [],
    },
  ]);
  assert.deepEqual(transport.requests, [
    {
      method: "model/list",
      params: { cursor: null, limit: 100, includeHidden: false },
    },
    {
      method: "model/list",
      params: { cursor: "page-2", limit: 100, includeHidden: false },
    },
  ]);
});
