import assert from "node:assert/strict";
import test from "node:test";

import type {
  AppServerMessageListener,
  JsonObject,
} from "./client.ts";
import {
  CodexTurnSession,
  type CodexStreamEvent,
} from "./turn-session.ts";

class FakeTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly #listeners = new Set<AppServerMessageListener>();
  nextResult: unknown = undefined;
  requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;

  async request<Result>(method: string, params: unknown): Promise<Result> {
    this.requests.push({ method, params });
    if (this.requestHandler) {
      return await this.requestHandler(method, params) as Result;
    }
    return this.nextResult as Result;
  }

  onNotification(listener: AppServerMessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(message: JsonObject): void {
    for (const listener of this.#listeners) {
      listener(message);
    }
  }
}

test("streams assistant text and command output for its own thread", async () => {
  const transport = new FakeTransport();
  transport.nextResult = { turn: { id: "turn-1" } };
  const session = new CodexTurnSession(transport, "thread-1");
  const events: CodexStreamEvent[] = [];
  session.onEvent((event) => events.push(event));

  assert.equal(await session.startTextTurn("你好"), "turn-1");
  assert.deepEqual(transport.requests[0], {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "你好", text_elements: [] }],
    },
  });

  transport.emit({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "你",
    },
  });
  transport.emit({
    method: "item/commandExecution/outputDelta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      delta: "ok\n",
    },
  });
  transport.emit({
    method: "item/agentMessage/delta",
    params: {
      threadId: "another-thread",
      turnId: "turn-x",
      itemId: "message-x",
      delta: "不应收到",
    },
  });

  assert.deepEqual(events, [
    {
      type: "assistant_text_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "你",
    },
    {
      type: "command_output_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      delta: "ok\n",
    },
  ]);
});

test("interrupts the active turn and clears it only after completion", async () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");

  transport.nextResult = {};
  assert.equal(await session.interruptActiveTurn(), true);
  assert.deepEqual(transport.requests[0], {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" },
  });
  assert.equal(session.activeTurnId, "turn-1");

  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "interrupted", error: null },
    },
  });
  assert.equal(session.activeTurnId, null);
  assert.equal(await session.interruptActiveTurn(), false);
});

test("rejects a second message while a turn is active", async () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");

  await assert.rejects(
    session.startTextTurn("第二条"),
    /已有任务正在运行/,
  );
  assert.equal(transport.requests.length, 0);
});

test("rejects a second message while the first start request is pending", async () => {
  const transport = new FakeTransport();
  let finishStart!: (value: unknown) => void;
  transport.requestHandler = () => new Promise((resolve) => {
    finishStart = resolve;
  });
  const session = new CodexTurnSession(transport, "thread-1");

  const firstStart = session.startTextTurn("第一条");
  await assert.rejects(
    session.startTextTurn("第二条"),
    /已有任务正在运行/,
  );
  finishStart({ turn: { id: "turn-1" } });
  assert.equal(await firstStart, "turn-1");
  assert.equal(transport.requests.length, 1);
});

test("does not restore a turn that completed before start response", async () => {
  const transport = new FakeTransport();
  let finishStart!: (value: unknown) => void;
  transport.requestHandler = () => new Promise((resolve) => {
    finishStart = resolve;
  });
  const session = new CodexTurnSession(transport, "thread-1");

  const start = session.startTextTurn("很快完成");
  transport.emit({
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    },
  });
  transport.emit({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", error: null },
    },
  });
  finishStart({ turn: { id: "turn-1" } });

  assert.equal(await start, "turn-1");
  assert.equal(session.activeTurnId, null);
});

test("sends only one interrupt request for repeated stop clicks", async () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");
  let finishInterrupt!: (value: unknown) => void;
  transport.requestHandler = () => new Promise((resolve) => {
    finishInterrupt = resolve;
  });

  const first = session.interruptActiveTurn();
  const second = session.interruptActiveTurn();
  finishInterrupt({});

  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(transport.requests.length, 1);
  assert.equal(await session.interruptActiveTurn(), true);
  assert.equal(transport.requests.length, 1);
});

test("emits authoritative completed message, command, and file summaries", () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");
  const events: CodexStreamEvent[] = [];
  session.onEvent((event) => events.push(event));

  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "user-1",
        content: [{ type: "text", text: "开始检查", text_elements: [] }],
      },
    },
  });
  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "commandExecution", id: "command-1", command: "npm test" },
    },
  });
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "message-1", text: "完成" },
    },
  });
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "npm test",
        status: "completed",
        aggregatedOutput: "pass\n",
        exitCode: 0,
        durationMs: 20,
      },
    },
  });
  transport.emit({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: "change-1",
        status: "completed",
        changes: [{}, {}],
      },
    },
  });

  assert.deepEqual(events, [
    {
      type: "user_message_started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      text: "开始检查",
    },
    {
      type: "command_started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      command: "npm test",
    },
    {
      type: "assistant_text_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "完成",
    },
    {
      type: "command_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      command: "npm test",
      status: "completed",
      output: "pass\n",
      exitCode: 0,
      durationMs: 20,
    },
    {
      type: "file_change_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "change-1",
      status: "completed",
      changedFiles: 2,
    },
  ]);
});
