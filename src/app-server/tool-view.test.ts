import assert from "node:assert/strict";
import test from "node:test";

import { publicRawToolView, publicToolView } from "./tool-view.ts";

test("maps command execution to execute with its input and output", () => {
  const view = publicToolView({
    type: "commandExecution",
    command: "npm test",
    status: "completed",
    aggregatedOutput: "pass\n",
    exitCode: 0,
  }, "completed");

  assert.equal(view?.kind, "execute");
  assert.equal(view?.input, "npm test");
  assert.equal(view?.output, "pass\n");
  assert.equal(view?.exitCode, 0);
});

test("turns each file change into an exact inline edit, delete, or move entry", () => {
  const view = publicToolView({
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "src/new.ts", kind: { type: "add" }, diff: "private diff" },
      { path: "src/old.ts", kind: { type: "delete" }, diff: "private diff" },
      {
        path: "src/from.ts",
        kind: { type: "update", move_path: "src/to.ts" },
        diff: "private diff",
      },
    ],
  }, "completed");

  assert.deepEqual(view?.entries, [
    { kind: "edit", title: "src/new.ts" },
    { kind: "delete", title: "src/old.ts" },
    { kind: "move", title: "src/from.ts → src/to.ts" },
  ]);
  assert.equal(JSON.stringify(view).includes("private diff"), false);
});

test("keeps native web search queries and result URLs without result bodies", () => {
  const view = publicToolView({
    type: "webSearch",
    id: "search-1",
    query: "Codex App Server",
    action: { type: "search", queries: ["Codex App Server"] },
    results: [{
      title: "Official docs",
      url: "https://developers.openai.com/codex/app-server",
      body: "private page body",
    }],
  }, "completed");

  assert.equal(view?.kind, "search");
  assert.equal(view?.query, "Codex App Server");
  assert.deepEqual(view?.resources, [{
    address: "https://developers.openai.com/codex/app-server",
    label: "Official docs",
  }]);
  assert.equal(JSON.stringify(view).includes("private page body"), false);
});

test("maps open-page web search actions to fetch with only the page URL", () => {
  const view = publicToolView({
    type: "webSearch",
    id: "fetch-1",
    query: "",
    action: { type: "openPage", url: "https://example.com/article" },
    results: [{ body: "article text" }],
  }, "completed");

  assert.equal(view?.kind, "fetch");
  assert.deepEqual(view?.resources, [{
    address: "https://example.com/article",
    label: null,
  }]);
  assert.equal(JSON.stringify(view).includes("article text"), false);
});

test("keeps arbitrary MCP calls honest as other", () => {
  const view = publicToolView({
    type: "mcpToolCall",
    server: "calendar",
    tool: "create_event",
    status: "completed",
    arguments: { title: "Meeting" },
    appContext: { appName: "Calendar", actionName: "Create event" },
    result: { structuredContent: { eventId: "event-1" } },
  }, "completed");

  assert.equal(view?.kind, "other");
  assert.equal(view?.title, "Calendar · Create event");
  assert.equal(view?.input?.includes("Meeting"), true);
  assert.equal(view?.output?.includes("event-1"), true);
});

test("hides thinking items and renders stable inline item types", () => {
  assert.equal(publicToolView({ type: "reasoning" })?.kind, "think");
  assert.equal(publicToolView({ type: "plan" })?.kind, "think");
  assert.deepEqual(publicToolView({ type: "imageView", path: "/tmp/image.png" })?.entries, [
    { kind: "read", title: "/tmp/image.png" },
  ]);
  assert.deepEqual(publicToolView({ type: "enteredReviewMode" })?.entries, [
    { kind: "switch_mode", title: "Enter review mode" },
  ]);
});

test("maps raw programmatic exec calls and outputs to one execute view", () => {
  const started = publicRawToolView({
    type: "custom_tool_call",
    call_id: "call-1",
    name: "exec",
    status: "completed",
    input: "const result = await tools.exec_command({ cmd: \"npm test\" });\ntext(result.output);",
  });

  assert.equal(started?.phase, "started");
  assert.equal(started?.callId, "call-1");
  assert.equal(started?.tool.kind, "execute");
  assert.equal(started?.tool.title, "exec_command");
  assert.equal(started?.tool.status, "inProgress");
  assert.equal(started?.tool.input?.includes("npm test"), true);

  const completed = publicRawToolView({
    type: "custom_tool_call_output",
    call_id: "call-1",
    output: [
      { type: "input_text", text: "Script completed\n" },
      { type: "input_text", text: "pass\n" },
      { type: "encrypted_content", encrypted_content: "private" },
    ],
  }, started?.tool ?? null);

  assert.equal(completed?.phase, "completed");
  assert.equal(completed?.tool.status, "completed");
  assert.equal(completed?.tool.output, "Script completed\npass\n");
  assert.equal(completed?.tool.output?.includes("private"), false);
});

test("does not claim unrelated raw custom tools", () => {
  assert.equal(publicRawToolView({
    type: "custom_tool_call",
    call_id: "call-2",
    name: "another_tool",
    input: "payload",
  }), null);
});
