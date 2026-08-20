import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BROWSER_MESSAGE_BYTES,
  parseBrowserRequest,
  ProtocolError,
} from "./protocol.ts";

test("parses the small stable browser protocol", () => {
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "sessions.list",
    requestId: "sessions-1",
    projectId: "projects/demo",
    view: "archived",
    searchTerm: "测试",
  })), {
    type: "sessions.list",
    requestId: "sessions-1",
    projectId: "projects/demo",
    cursor: null,
    view: "archived",
    searchTerm: "测试",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "sessions.mutate",
    requestId: "sessions-2",
    projectId: "projects/demo",
    sessionIds: ["session-1", "session-1", "session-2"],
    action: "trash-active",
  })), {
    type: "sessions.mutate",
    requestId: "sessions-2",
    projectId: "projects/demo",
    sessionIds: ["session-1", "session-2"],
    action: "trash-active",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "history.older",
    requestId: "history-1",
  })), {
    type: "history.older",
    requestId: "history-1",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "session.resume",
    requestId: "r1",
    projectId: "projects/demo",
    sessionId: "session-1",
  })), {
    type: "session.resume",
    requestId: "r1",
    projectId: "projects/demo",
    sessionId: "session-1",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "command.run",
    requestId: "command-1",
    command: "usage",
    option: "daily",
    argument: null,
  })), {
    type: "command.run",
    requestId: "command-1",
    command: "usage",
    option: "daily",
    argument: null,
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "command.run",
    requestId: "rewind-1",
    command: "rewind",
    option: null,
    argument: null,
  })), {
    type: "command.run",
    requestId: "rewind-1",
    command: "rewind",
    option: null,
    argument: null,
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "permissions.full-access.toggle",
    requestId: "permissions-toggle-1",
  })), {
    type: "permissions.full-access.toggle",
    requestId: "permissions-toggle-1",
  });
});

test("rejects arbitrary paths and unknown operations", () => {
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "session.start",
      requestId: "r1",
      cwd: "/tmp/not-allowed",
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({ type: "shell.exec", requestId: "r2" })),
    (error: unknown) => error instanceof ProtocolError && error.code === "unknown_message_type",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "command.run",
      requestId: "bad-command",
      command: "not-real",
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "unknown_command",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "sessions.mutate",
      requestId: "bad-session-action",
      projectId: "projects/demo",
      sessionIds: [],
      action: "delete-now",
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
});

test("rejects a message that is too long instead of dropping the connection", () => {
  // 40 万个汉字在 UTF-8 下超过 1 MiB，但整帧仍小于 ws 的 2 MiB 上限，
  // 所以浏览器应该收到一条可读的错误，而不是被直接断开。
  const source = JSON.stringify({
    type: "message.send",
    requestId: "too-long",
    text: "字".repeat(400_000),
  });
  assert.ok(Buffer.byteLength(source, "utf8") < MAX_BROWSER_MESSAGE_BYTES);
  assert.throws(
    () => parseBrowserRequest(source),
    (error: unknown) => error instanceof ProtocolError && error.code === "message_too_large",
  );

  const accepted = parseBrowserRequest(JSON.stringify({
    type: "message.send",
    requestId: "ok",
    text: "字".repeat(1_000),
  }));
  assert.equal(accepted.type, "message.send");
});
