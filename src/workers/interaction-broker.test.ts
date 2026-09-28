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

test("keeps an MCP form pending when the server rejects constrained answers", () => {
  const transport = new FakeTransport();
  const broker = new InteractionBroker(transport);
  const events: WorkerInteractionEvent[] = [];
  broker.onEvent((event) => events.push(event));
  transport.request({
    id: "form-constrained",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      message: "填写参数",
      requestedSchema: {
        type: "object",
        required: ["name", "count", "tags"],
        properties: {
          name: { type: "string", title: "名称", minLength: 2, maxLength: 4 },
          count: { type: "integer", title: "数量", minimum: 1, maximum: 3 },
          color: { type: "string", title: "颜色", enum: ["red", "blue"], default: "blue" },
          tags: {
            type: "array",
            title: "标签",
            minItems: 1,
            maxItems: 2,
            items: { type: "string", enum: ["A", "B", "C"] },
          },
        },
      },
    },
  });
  const requested = events[0];
  assert.equal(requested?.type, "interaction_requested");
  if (requested?.type !== "interaction_requested") return;

  const valid = { name: ["测试"], count: ["2"], color: ["blue"], tags: ["A"] };
  assert.throws(
    () => broker.answer(requested.interaction.id, "submit", { ...valid, name: [] }),
    /请填写“名称”/u,
  );
  assert.throws(
    () => broker.answer(requested.interaction.id, "submit", { ...valid, name: ["太长的名字"] }),
    /最多允许 4 个字符/u,
  );
  assert.throws(
    () => broker.answer(requested.interaction.id, "submit", { ...valid, count: ["4"] }),
    /不能大于 3/u,
  );
  assert.throws(
    () => broker.answer(requested.interaction.id, "submit", { ...valid, color: ["green"] }),
    /选项无法识别/u,
  );
  assert.throws(
    () => broker.answer(requested.interaction.id, "submit", { ...valid, tags: ["A", "B", "C"] }),
    /最多只能选择 2 项/u,
  );
  assert.equal(transport.responses.length, 0);
  assert.equal(events.length, 1);

  assert.equal(broker.answer(requested.interaction.id, "submit", valid), true);
  assert.deepEqual(transport.responses[0], {
    id: "form-constrained",
    result: {
      action: "accept",
      content: { name: "测试", count: 2, color: "blue", tags: ["A"] },
      _meta: null,
    },
  });
  assert.equal(events[1]?.type, "interaction_resolved");
});

test("an unsupported MCP form can only be cancelled", () => {
  const transport = new FakeTransport();
  const broker = new InteractionBroker(transport);
  const events: WorkerInteractionEvent[] = [];
  broker.onEvent((event) => events.push(event));
  transport.request({
    id: "form-unsupported",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      message: "填写邮箱",
      requestedSchema: {
        type: "object",
        properties: { email: { type: "string", format: "email" } },
      },
    },
  });
  const requested = events[0];
  assert.equal(requested?.type, "interaction_requested");
  if (requested?.type !== "interaction_requested") return;
  assert.throws(
    () => broker.answer(requested.interaction.id, "submit", { email: ["person@example.com"] }),
    /暂时不受支持/u,
  );
  assert.equal(transport.responses.length, 0);
  assert.equal(broker.answer(requested.interaction.id, "cancel", {}), true);
  assert.deepEqual(transport.responses, [{
    id: "form-unsupported",
    result: { action: "cancel", content: null, _meta: null },
  }]);
});
