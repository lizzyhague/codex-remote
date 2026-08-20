import assert from "node:assert/strict";
import test from "node:test";

import type { RequestId } from "../generated/RequestId.ts";
import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";
import {
  ApprovalBroker,
  type ApprovalEvent,
  type ApprovalTransport,
} from "./broker.ts";

class FakeTransport implements ApprovalTransport {
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
    for (const listener of this.#requestListeners) {
      listener(message);
    }
  }

  notify(message: JsonObject): void {
    for (const listener of this.#notificationListeners) {
      listener(message);
    }
  }
}

function commandRequest(id: RequestId, turnId = "turn-1"): JsonObject {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId,
      itemId: "command-1",
      startedAtMs: 123,
      reason: "需要访问网络",
      command: "npm install",
      cwd: "/private/path",
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
    },
  };
}

function fileRequest(id: RequestId, turnId = "turn-1"): JsonObject {
  return {
    id,
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1",
      turnId,
      itemId: "change-1",
      startedAtMs: 456,
      reason: "需要修改文件",
      grantRoot: "/private/path",
    },
  };
}

test("translates command approval and accepts only once", () => {
  const transport = new FakeTransport();
  const broker = new ApprovalBroker(transport);
  const events: ApprovalEvent[] = [];
  broker.onEvent((event) => events.push(event));

  transport.request(commandRequest(7));
  const requested = events[0];
  assert.equal(requested?.type, "approval_requested");
  if (requested?.type !== "approval_requested") {
    return;
  }
  assert.deepEqual(requested.approval, {
    id: requested.approval.id,
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "command-1",
    reason: "需要访问网络",
    startedAtMs: 123,
    command: "npm install",
    network: { host: "registry.npmjs.org", protocol: "https" },
  });
  assert.equal(broker.answer(requested.approval.id, "approve_once"), true);
  assert.equal(broker.answer(requested.approval.id, "approve_once"), false);
  assert.deepEqual(transport.responses, [{ id: 7, result: { decision: "accept" } }]);
  assert.deepEqual(events[1], {
    type: "approval_resolved",
    approvalId: requested.approval.id,
    resolution: "approved",
  });
});

test("declines a file change without exposing a path or diff", () => {
  const transport = new FakeTransport();
  const broker = new ApprovalBroker(transport);
  const events: ApprovalEvent[] = [];
  broker.onEvent((event) => events.push(event));

  transport.request(fileRequest("request-file"));
  const requested = events[0];
  assert.equal(requested?.type, "approval_requested");
  if (requested?.type !== "approval_requested") {
    return;
  }
  assert.deepEqual(Object.keys(requested.approval).sort(), [
    "id",
    "itemId",
    "kind",
    "reason",
    "startedAtMs",
    "threadId",
    "turnId",
  ]);
  assert.equal(broker.answer(requested.approval.id, "decline"), true);
  assert.deepEqual(transport.responses, [
    { id: "request-file", result: { decision: "decline" } },
  ]);
});

test("cancels pending approvals for a disconnected turn", () => {
  const transport = new FakeTransport();
  const broker = new ApprovalBroker(transport);
  transport.request(commandRequest(1, "turn-1"));
  transport.request(fileRequest(2, "turn-1"));
  transport.request(commandRequest(3, "turn-2"));

  assert.equal(broker.cancelTurn("thread-1", "turn-1"), 2);
  assert.deepEqual(transport.responses, [
    { id: 1, result: { decision: "cancel" } },
    { id: 2, result: { decision: "cancel" } },
  ]);
  assert.equal(broker.cancelThread("thread-1"), 1);
});

test("clears stale UI when app-server resolves a request", () => {
  const transport = new FakeTransport();
  const broker = new ApprovalBroker(transport);
  const events: ApprovalEvent[] = [];
  broker.onEvent((event) => events.push(event));
  transport.request(commandRequest("rpc-1"));
  const requested = events[0];
  assert.equal(requested?.type, "approval_requested");
  if (requested?.type !== "approval_requested") {
    return;
  }

  transport.notify({
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "rpc-1" },
  });

  assert.deepEqual(events[1], {
    type: "approval_resolved",
    approvalId: requested.approval.id,
    resolution: "cleared",
  });
  assert.equal(broker.answer(requested.approval.id, "approve_once"), false);
  assert.equal(transport.responses.length, 0);
});

test("ignores unrelated and malformed server requests", () => {
  const transport = new FakeTransport();
  const broker = new ApprovalBroker(transport);
  const events: ApprovalEvent[] = [];
  broker.onEvent((event) => events.push(event));

  transport.request({ id: 1, method: "item/tool/requestUserInput", params: {} });
  transport.request({
    id: 2,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1" },
  });
  assert.equal(events.length, 0);
});
