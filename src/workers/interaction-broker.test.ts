import assert from "node:assert/strict";
import test from "node:test";

import type { RequestId } from "../generated/RequestId.ts";
import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import {
  InteractionBroker,
  type InteractionTransport,
  type WorkerInteractionEvent,
} from "./interaction-broker.ts";

class FakeTransport implements InteractionTransport {
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  readonly #requestListeners = new Set<AppServerMessageListener>();
  readonly #notificationListeners = new Set<AppServerMessageListener>();

  onServerRequest(listener: AppServerMessageListener): () => void {
    this.#requestListeners.add(listener);
    return () => this.#requestListeners.delete(listener);
  }
  onNotification(listener: AppServerMessageListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }
  respondToServerRequest(id: RequestId, result: unknown): void {
    this.responses.push({ id, result });
  }
  request(message: JsonObject): void {
    for (const listener of this.#requestListeners) listener(message);
  }
}

test("forwards request_user_input choices and returns structured answers", () => {
  const transport = new FakeTransport();
  const broker = new InteractionBroker(transport);
  const events: WorkerInteractionEvent[] = [];
  broker.onEvent((event) => events.push(event));
  transport.request({
    id: "input-1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{
        id: "choice",
        header: "方案",
        question: "选择哪一个？",
        isOther: true,
        isSecret: false,
        options: [
          { label: "A", description: "第一种" },
          { label: "B", description: "第二种" },
        ],
      }],
    },
  });
  const requested = events[0];
  assert.equal(requested?.type, "interaction_requested");
  if (requested?.type !== "interaction_requested") return;
  assert.equal(broker.answer(requested.interaction.id, "submit", { choice: ["B"] }), true);
  assert.deepEqual(transport.responses, [{
    id: "input-1",
    result: { answers: { choice: { answers: ["B"] } } },
  }]);
  assert.equal(events[1]?.type, "interaction_resolved");
});

test("cancels MCP login instead of inventing an answer", () => {
  const transport = new FakeTransport();
  const broker = new InteractionBroker(transport);
  const events: WorkerInteractionEvent[] = [];
  broker.onEvent((event) => events.push(event));
  transport.request({
    id: 2,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "url",
      message: "请登录",
      url: "https://example.test/login",
      elicitationId: "login-1",
    },
  });
  const requested = events[0];
  assert.equal(requested?.type, "interaction_requested");
  if (requested?.type !== "interaction_requested") return;
  assert.equal(broker.cancelThread("thread-1"), 1);
  assert.deepEqual(transport.responses, [{
    id: 2,
    result: { action: "cancel", content: null, _meta: null },
  }]);
});

test("validates and types standard MCP form answers", () => {
  const transport = new FakeTransport();
  const broker = new InteractionBroker(transport);
  const events: WorkerInteractionEvent[] = [];
  broker.onEvent((event) => events.push(event));
  transport.request({
    id: "form-1",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      message: "填写参数",
      requestedSchema: {
        type: "object",
        required: ["name", "count", "enabled"],
        properties: {
          name: { type: "string", title: "名称" },
          count: { type: "integer", title: "数量" },
          enabled: { type: "boolean", title: "启用" },
          tags: { type: "array", items: { type: "string", enum: ["A", "B"] } },
        },
      },
    },
  });
  const requested = events[0];
  assert.equal(requested?.type, "interaction_requested");
  if (requested?.type !== "interaction_requested") return;
  assert.deepEqual(
    requested.interaction.kind === "mcp_elicitation"
      ? requested.interaction.schema?.required
      : null,
    ["name", "count", "enabled"],
  );
  assert.equal(broker.answer(requested.interaction.id, "submit", {
    name: ["测试"],
    count: ["2"],
    enabled: ["true"],
    tags: ["A", "B"],
  }), true);
  assert.deepEqual(transport.responses, [{
    id: "form-1",
    result: {
      action: "accept",
      content: { name: "测试", count: 2, enabled: true, tags: ["A", "B"] },
      _meta: null,
    },
  }]);
});
