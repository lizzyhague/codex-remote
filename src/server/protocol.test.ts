import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DEVELOPER_INSTRUCTIONS_LENGTH } from "../settings/store.ts";
import {
  MAX_BROWSER_MESSAGE_BYTES,
  parseBrowserRequest,
  ProtocolError,
} from "./protocol.ts";

const SESSION_TARGET = { projectId: "projects/demo", sessionId: "session-1" };

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
    type: "message.send",
    requestId: "send-1",
    ...SESSION_TARGET,
    clientMessageId: "018-message",
    text: "后台执行",
  })), {
    type: "message.send",
    requestId: "send-1",
    ...SESSION_TARGET,
    clientMessageId: "018-message",
    text: "后台执行",
    attachmentIds: [],
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "attachment.ticket.create",
    requestId: "ticket-1",
    ...SESSION_TARGET,
    originalName: "screen.png",
    declaredMime: "image/png",
    expectedSize: 123,
  })), {
    type: "attachment.ticket.create",
    requestId: "ticket-1",
    ...SESSION_TARGET,
    originalName: "screen.png",
    declaredMime: "image/png",
    expectedSize: 123,
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "message.send",
    requestId: "send-attachment",
    ...SESSION_TARGET,
    clientMessageId: "message-attachment",
    text: "",
    attachmentIds: ["attachment-1", "attachment-1"],
  })), {
    type: "message.send",
    requestId: "send-attachment",
    ...SESSION_TARGET,
    clientMessageId: "message-attachment",
    text: "",
    attachmentIds: ["attachment-1"],
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "interaction.answer",
    requestId: "answer-1",
    interactionId: "interaction-1",
    action: "submit",
    answers: { choice: ["A"] },
  })), {
    type: "interaction.answer",
    requestId: "answer-1",
    interactionId: "interaction-1",
    action: "submit",
    answers: { choice: ["A"] },
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "session.mark",
    requestId: "mark-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    marked: true,
  })), {
    type: "session.mark",
    requestId: "mark-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    marked: true,
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "session.rename",
    requestId: "rename-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    title: "新名字",
  })), {
    type: "session.rename",
    requestId: "rename-1",
    projectId: "projects/demo",
    sessionId: "session-1",
    title: "新名字",
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
    type: "sessions.mutate",
    requestId: "sessions-3",
    projectId: "projects/demo",
    sessionIds: ["session-1"],
    action: "delete-trash",
  })), {
    type: "sessions.mutate",
    requestId: "sessions-3",
    projectId: "projects/demo",
    sessionIds: ["session-1"],
    action: "delete-trash",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "history.older",
    requestId: "history-1",
    ...SESSION_TARGET,
  })), {
    type: "history.older",
    requestId: "history-1",
    ...SESSION_TARGET,
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
    type: "session.resume",
    requestId: "r2",
    projectId: "projects/demo",
    sessionId: "session-1",
    acceptLoadingStates: true,
  })), {
    type: "session.resume",
    requestId: "r2",
    projectId: "projects/demo",
    sessionId: "session-1",
    acceptLoadingStates: true,
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "command.run",
    requestId: "command-1",
    ...SESSION_TARGET,
    command: "model",
    option: "gpt-test",
    argument: null,
  })), {
    type: "command.run",
    requestId: "command-1",
    ...SESSION_TARGET,
    command: "model",
    option: "gpt-test",
    argument: null,
    targetTurnId: null,
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "command.run",
    requestId: "rewind-1",
    ...SESSION_TARGET,
    command: "rewind",
    option: null,
    argument: null,
    targetTurnId: "turn-last",
  })), {
    type: "command.run",
    requestId: "rewind-1",
    ...SESSION_TARGET,
    command: "rewind",
    option: null,
    argument: null,
    targetTurnId: "turn-last",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "settings.get",
    requestId: "settings-1",
  })), {
    type: "settings.get",
    requestId: "settings-1",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "settings.models",
    requestId: "settings-models",
  })), {
    type: "settings.models",
    requestId: "settings-models",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "settings.update",
    requestId: "settings-2",
    developerInstructions: "",
  })), {
    type: "settings.update",
    requestId: "settings-2",
    developerInstructions: "",
  });
  assert.deepEqual(parseBrowserRequest(JSON.stringify({
    type: "settings.update",
    requestId: "settings-3",
    developerInstructions: "始终用中文回复。",
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
  })), {
    type: "settings.update",
    requestId: "settings-3",
    developerInstructions: "始终用中文回复。",
    defaultModel: "gpt-test",
    defaultReasoningEffort: "high",
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
  const projected = parseBrowserRequest(JSON.stringify({
    type: "message.send",
    requestId: "path-extra",
    ...SESSION_TARGET,
    text: "hello",
    cwd: "/home/private/project",
    path: "/home/private/project/note.txt",
  }));
  assert.equal("cwd" in projected, false);
  assert.equal("path" in projected, false);
  assert.doesNotMatch(JSON.stringify(projected), /\/home\/private/u);
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({ type: "shell.exec", requestId: "r2" })),
    (error: unknown) => error instanceof ProtocolError && error.code === "unknown_message_type",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "permissions.full-access.toggle",
      requestId: "removed-full-access-toggle",
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "unknown_message_type",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "command.run",
      requestId: "bad-command",
      ...SESSION_TARGET,
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
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "session.rename",
      requestId: "rename-too-long",
      projectId: "projects/demo",
      sessionId: "session-1",
      title: "名".repeat(161),
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "settings.update",
      requestId: "settings-too-long",
      developerInstructions: "字".repeat(MAX_DEVELOPER_INSTRUCTIONS_LENGTH + 1),
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "settings.update",
      requestId: "settings-unpaired",
      defaultModel: "gpt-test",
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "settings.update",
      requestId: "settings-invalid-default",
      defaultModel: null,
      defaultReasoningEffort: "high",
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
});

test("requires an explicit project and session on every current-session request", () => {
  const requests = [
    { type: "session.metrics" },
    { type: "history.older" },
    { type: "command.options", command: "model" },
    { type: "command.run", command: "compact" },
    {
      type: "attachment.ticket.create",
      originalName: "note.txt",
      declaredMime: "text/plain",
      expectedSize: 1,
    },
    { type: "message.send", text: "hello" },
    { type: "task.stop" },
  ];
  for (const [index, request] of requests.entries()) {
    for (const missing of ["projectId", "sessionId"] as const) {
      const target: Partial<typeof SESSION_TARGET> = { ...SESSION_TARGET };
      delete target[missing];
      assert.throws(
        () => parseBrowserRequest(JSON.stringify({
          ...request,
          requestId: `target-${index}-${missing}`,
          ...target,
        })),
        (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
      );
    }
  }
});

test("rejects a message that is too long instead of dropping the connection", () => {
  // 40 万个汉字在 UTF-8 下超过 1 MiB，但整帧仍小于 ws 的 2 MiB 上限，
  // 所以浏览器应该收到一条可读的错误，而不是被直接断开。
  const source = JSON.stringify({
    type: "message.send",
    requestId: "too-long",
    ...SESSION_TARGET,
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
    ...SESSION_TARGET,
    text: "字".repeat(1_000),
  }));
  assert.equal(accepted.type, "message.send");
  assert.throws(
    () => parseBrowserRequest(JSON.stringify({
      type: "message.send",
      requestId: "empty",
      ...SESSION_TARGET,
      text: "  ",
      attachmentIds: [],
    })),
    (error: unknown) => error instanceof ProtocolError && error.code === "invalid_field",
  );
});


test("rejects removed usage and status commands", () => {
  for (const command of ["usage", "status"]) {
    for (const type of ["command.run", "command.options"]) {
      assert.throws(() => parseBrowserRequest(JSON.stringify({
        type, requestId: "removed-command", ...SESSION_TARGET, command,
      })));
    }
  }
});
