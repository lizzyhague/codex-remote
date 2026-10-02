import assert from "node:assert/strict";
import test from "node:test";

import {
  redactBrowserStreamEvent,
  toBrowserStreamEvent,
} from "./stream-events.ts";
import { PUBLIC_TURN_ERROR_MESSAGE } from "./public-output.ts";

test("realtime turn failures use the same stable browser message as history", (context) => {
  context.mock.method(console, "error", () => {});
  const raw = "sandbox failed at /home/private/project/secret.txt";
  const completed = toBrowserStreamEvent({
    type: "turn_completed",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "failed",
    error: raw,
  });
  const retrying = toBrowserStreamEvent({
    type: "turn_error",
    threadId: "thread-1",
    turnId: "turn-1",
    message: raw,
    willRetry: true,
  });

  assert.equal(completed.error, PUBLIC_TURN_ERROR_MESSAGE);
  assert.equal(retrying.message, PUBLIC_TURN_ERROR_MESSAGE);
  assert.equal(JSON.stringify([completed, retrying]).includes(raw), false);
});

test("event projection preserves host paths in user and server text", () => {
  const user = redactBrowserStreamEvent({
    type: "message.user",
    text: "用户原文 /home/example/kept.txt 和 /api/v1",
  }, []);
  const assistant = redactBrowserStreamEvent({
    type: "message.completed",
    text: "src/server/main.ts https://example.com/docs/setup /home/private/project/file.ts",
  }, []);

  assert.equal(user.text, "用户原文 /home/example/kept.txt 和 /api/v1");
  assert.ok(assistant.text.includes("src/server/main.ts"));
  assert.ok(assistant.text.includes("https://example.com/docs/setup"));
  assert.ok(assistant.text.includes("/home/private/project/file.ts"));
});
