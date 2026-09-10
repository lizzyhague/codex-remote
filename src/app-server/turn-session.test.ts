import assert from "node:assert/strict";
import test from "node:test";

import type {
  AppServerMessageListener,
  JsonObject,
} from "./client.ts";
import { formatPrivateAttachmentPathsBlock } from "../attachments/private-paths.ts";
import {
  CodexTurnSession,
  PRIVATE_ATTACHMENT_INPUT_PREFIX,
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
      type: "tool_output_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      delta: "ok\n",
    },
  ]);
});

test("sends a path block for images, text, PDF and zip without reading file bytes", async () => {
  const transport = new FakeTransport();
  transport.nextResult = { turn: { id: "turn-attachment" } };
  const session = new CodexTurnSession(transport, "thread-1");
  const attachments = [
    {
      id: "image-id",
      originalName: "screen.png",
      kind: "image" as const,
      path: "/not-read/screen.png",
      detectedMime: "image/png",
      size: 12,
    },
    {
      id: "file-id",
      originalName: "notes.txt",
      kind: "file" as const,
      path: "/not-read/notes.txt",
      detectedMime: "text/plain",
      size: 11,
    },
    {
      id: "pdf-id",
      originalName: "report.pdf",
      kind: "file" as const,
      path: "/not-read/report.pdf",
      detectedMime: "application/pdf",
      size: 12,
    },
    {
      id: "zip-id",
      originalName: "archive.zip",
      kind: "file" as const,
      path: "/not-read/archive.zip",
      detectedMime: "application/zip",
      size: 2,
    },
  ];
  await session.startTextTurn("请检查", attachments);
  const expectedBlock = formatPrivateAttachmentPathsBlock(attachments.map((attachment) => ({
    id: attachment.id,
    originalName: attachment.originalName,
    path: attachment.path,
    mimeType: attachment.detectedMime,
    size: attachment.size,
  })));
  assert.deepEqual(transport.requests[0], {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: "请检查\n\n[附件：screen.png · image-id]\n[附件：notes.txt · file-id]\n[附件：report.pdf · pdf-id]\n[附件：archive.zip · zip-id]",
          text_elements: [],
        },
        {
          type: "text",
          text: expectedBlock,
          text_elements: [],
        },
      ],
    },
  });
  const input = (transport.requests[0]?.params as { input: Array<{ type: string; text?: string }> }).input;
  assert.equal(input.some((part) => part.type === "localImage"), false);
  assert.equal(JSON.stringify(input).includes("secret note"), false);
});

test("serializes attachment names that contain quotes, newlines and Chinese", async () => {
  const transport = new FakeTransport();
  transport.nextResult = { turn: { id: "turn-name" } };
  const session = new CodexTurnSession(transport, "thread-1");
  await session.startTextTurn("看这个", [{
    id: "id-1",
    originalName: "报\"告\n.pdf",
    kind: "file",
    path: "/uploads/blobs/ab/id-1.pdf",
    detectedMime: "application/pdf",
    size: 12,
  }]);
  const input = (transport.requests[0]?.params as { input: Array<{ type: string; text?: string }> }).input;
  const block = input[1]?.text ?? "";
  const jsonLine = block.split("\n").find((line) => line.startsWith("{\"attachments\":")) ?? "";
  const parsed = JSON.parse(jsonLine) as { attachments: Array<{ originalName: string }> };
  assert.equal(parsed.attachments[0]?.originalName, "报\"告\n.pdf");
});

test("keeps attachment-only messages sendable and still includes the path block", async () => {
  const transport = new FakeTransport();
  transport.nextResult = { turn: { id: "turn-attachment-only" } };
  const session = new CodexTurnSession(transport, "thread-1");
  await session.startTextTurn("", [{
    id: "zip-id",
    originalName: "archive.zip",
    kind: "file",
    path: "/not-read/archive.zip",
    detectedMime: "application/zip",
    size: 2,
  }]);
  const input = (transport.requests[0]?.params as { input: Array<{ type: string; text?: string }> }).input;
  assert.equal(input.length, 2);
  assert.equal(input[0]?.text, "[附件：archive.zip · zip-id]");
  assert.match(input[1]?.text ?? "", /\[AI_REMOTE_PRIVATE_ATTACHMENT_PATHS_V1\]/u);
});

test("hides both legacy inlined content and new path blocks from live user bubbles", () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");
  const events: CodexStreamEvent[] = [];
  session.onEvent((event) => events.push(event));
  const block = formatPrivateAttachmentPathsBlock([{
    id: "file-id",
    originalName: "notes.txt",
    path: "/private/notes.txt",
    mimeType: "text/plain",
    size: 11,
  }]);
  transport.emit({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        id: "user-1",
        content: [
          { type: "text", text: "检查附件\n\n[附件：notes.txt · file-id]", text_elements: [] },
          { type: "text", text: block, text_elements: [] },
          {
            type: "text",
            text: `${PRIVATE_ATTACHMENT_INPUT_PREFIX}\nsecret note`,
            text_elements: [],
          },
        ],
      },
    },
  });
  assert.deepEqual(events, [{
    type: "user_message_started",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "user-1",
    text: "检查附件\n\n[附件：notes.txt · file-id]",
  }]);
  assert.equal(JSON.stringify(events).includes("/private/notes.txt"), false);
  assert.equal(JSON.stringify(events).includes("secret note"), false);
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

test("interrupts a turn whose start response has not arrived yet", async () => {
  const transport = new FakeTransport();
  let finishStart!: (value: unknown) => void;
  transport.requestHandler = (method) => {
    if (method === "turn/start") {
      return new Promise((resolve) => {
        finishStart = resolve;
      });
    }
    return Promise.resolve({});
  };
  const session = new CodexTurnSession(transport, "thread-1");

  const start = session.startTextTurn("启动中停止");
  const first = session.interruptActiveTurn();
  const second = session.interruptActiveTurn();
  finishStart({ turn: { id: "turn-1" } });

  assert.equal(await start, "turn-1");
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(
    transport.requests.filter((item) => item.method === "turn/interrupt"),
    [{
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    }],
  );
  assert.equal(session.activeTurnId, "turn-1");
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
      item: {
        type: "commandExecution",
        id: "command-1",
        command: "npm test",
        status: "inProgress",
      },
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
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: null } },
          { path: "src/b.ts", kind: { type: "delete" } },
        ],
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
      type: "tool_started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      tool: {
        kind: "execute",
        title: "npm test",
        status: "inProgress",
        input: "npm test",
        query: null,
        resources: [],
        output: null,
        outputTruncated: false,
        exitCode: null,
        entries: [],
      },
    },
    {
      type: "assistant_text_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      text: "完成",
    },
    {
      type: "tool_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      tool: {
        kind: "execute",
        title: "npm test",
        status: "completed",
        input: "npm test",
        query: null,
        resources: [],
        output: "pass\n",
        outputTruncated: false,
        exitCode: 0,
        entries: [],
      },
    },
    {
      type: "tool_completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "change-1",
      tool: {
        kind: "edit",
        title: "2 个文件",
        status: "completed",
        input: null,
        query: null,
        resources: [],
        output: null,
        outputTruncated: false,
        exitCode: null,
        entries: [
          { kind: "edit", title: "src/a.ts" },
          { kind: "delete", title: "src/b.ts" },
        ],
      },
    },
  ]);
});

test("streams raw programmatic exec as one paired tool entry", () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");
  const events: CodexStreamEvent[] = [];
  session.onEvent((event) => events.push(event));

  transport.emit({
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "exec",
        input: "const result = await tools.exec_command({ cmd: \"npm test\" });",
      },
    },
  });
  transport.emit({
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call_output",
        call_id: "call-1",
        output: [{ type: "input_text", text: "pass\n" }],
      },
    },
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tool_started");
  assert.equal(events[1]?.type, "tool_completed");
  assert.equal(
    events[0]?.type === "tool_started" ? events[0].itemId : null,
    "raw-exec:call-1",
  );
  assert.equal(
    events[1]?.type === "tool_completed" ? events[1].itemId : null,
    "raw-exec:call-1",
  );
  assert.equal(
    events[1]?.type === "tool_completed" ? events[1].tool.output : null,
    "pass\n",
  );
});

test("ignores orphan raw exec outputs and unrelated custom calls", () => {
  const transport = new FakeTransport();
  const session = new CodexTurnSession(transport, "thread-1", "turn-1");
  const events: CodexStreamEvent[] = [];
  session.onEvent((event) => events.push(event));

  transport.emit({
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call",
        call_id: "call-other",
        name: "another_tool",
        input: "payload",
      },
    },
  });
  transport.emit({
    method: "rawResponseItem/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "custom_tool_call_output",
        call_id: "call-missing",
        output: "ignored",
      },
    },
  });

  assert.deepEqual(events, []);
});
