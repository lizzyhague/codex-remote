import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

class FakeClassList {
  #values = new Set();

  constructor(...values) {
    for (const value of values) this.#values.add(value);
  }

  add(value) { this.#values.add(value); }
  remove(value) { this.#values.delete(value); }
  contains(value) { return this.#values.has(value); }
}

function assistantStream(taskId, target, frame = null) {
  const replacements = [];
  return {
    stream: {
      element: {
        classList: new FakeClassList("pending"),
        replaceChildren: (...children) => replacements.push(children),
      },
      textElement: { textContent: "" },
      shown: target.slice(0, 1),
      target,
      completed: false,
      markdownRendered: false,
      frame,
      taskId,
      taskTerminal: false,
    },
    replacements,
  };
}

function harness() {
  const cancelledFrames = [];
  const renderedTools = [];
  const scheduledStreams = [];
  const state = { assistantStreams: new Map(), commands: new Map() };
  const context = vm.createContext({
    state,
    renderMarkdown: (text) => ({ markdown: text }),
    cancelAnimationFrame: (frame) => cancelledFrames.push(frame),
    isNearBottom: () => false,
    scrollToBottom() {},
    scheduleAssistantFrame: (stream) => scheduledStreams.push(stream),
    assistantStreamFor: (itemId, taskId) => {
      const stream = state.assistantStreams.get(itemId);
      if (stream && !stream.taskId && taskId) stream.taskId = taskId;
      return stream ?? null;
    },
    isRunningTool: (command) => ["inProgress", "in_progress", "pending"].includes(command.status),
    renderToolEntry: (command) => renderedTools.push({ taskId: command.taskId, status: command.status }),
  });
  vm.runInContext([
    section("function sealAssistantStreams(", "function scheduleAssistantFrame("),
    section("function completeTool(", "function finalizeTaskProjection("),
    section("function finalizeTaskProjection(", "function renderToolEntry("),
  ].join("\n"), context);
  return { context, state, cancelledFrames, renderedTools, scheduledStreams };
}

test("task terminal seals only its partial streams and open tools immediately", () => {
  const h = harness();
  const current = assistantStream("task-1", "半截回复", 17);
  const next = assistantStream("task-2", "下一轮", 23);
  h.state.assistantStreams.set("message-1", current.stream);
  h.state.assistantStreams.set("message-2", next.stream);
  h.state.commands.set("tool-1", {
    mode: "card",
    taskId: "task-1",
    status: "inProgress",
    taskTerminalStatus: null,
  });
  h.state.commands.set("tool-2", {
    mode: "inline",
    taskId: "task-1",
    status: "pending",
    taskTerminalStatus: null,
  });
  h.state.commands.set("tool-next", {
    mode: "card",
    taskId: "task-2",
    status: "inProgress",
    taskTerminalStatus: null,
  });

  h.context.finalizeTaskProjection("task-1", "interrupted");

  assert.equal(current.stream.completed, true);
  assert.equal(current.stream.taskTerminal, true);
  assert.equal(current.stream.shown, "半截回复");
  assert.equal(current.stream.frame, null);
  assert.equal(current.stream.markdownRendered, true);
  assert.equal(current.stream.element.classList.contains("pending"), false);
  assert.deepEqual(current.replacements, [[{ markdown: "半截回复" }]]);
  assert.deepEqual(h.cancelledFrames, [17]);
  assert.equal(next.stream.completed, false);
  assert.equal(next.stream.frame, 23);
  assert.equal(h.state.commands.get("tool-1").status, "interrupted");
  assert.equal(h.state.commands.get("tool-2").status, "interrupted");
  assert.equal(h.state.commands.get("tool-next").status, "inProgress");
  assert.deepEqual(h.renderedTools, [
    { taskId: "task-1", status: "interrupted" },
    { taskId: "task-1", status: "interrupted" },
  ]);

  h.context.finalizeTaskProjection("task-1", "interrupted");
  assert.equal(current.replacements.length, 1);
  assert.equal(h.renderedTools.length, 2);
});

test("late item completions cannot reopen a task-terminal stream or tool", () => {
  const h = harness();
  const current = assistantStream("task-1", "半截", null);
  h.state.assistantStreams.set("message-1", current.stream);
  h.state.commands.set("tool-1", {
    mode: "inline",
    kind: "execute",
    title: "命令",
    entries: [],
    taskId: "task-1",
    status: "inProgress",
    taskTerminalStatus: null,
  });
  h.context.publicTool = (value) => value;
  h.context.normalizeToolKind = (kind) => kind;
  h.context.publicToolEntries = () => [];
  h.context.publicResources = () => [];
  h.context.startTool = () => assert.fail("existing tool must be reused");
  h.context.MAX_COMMAND_OUTPUT = 1000;

  h.context.finalizeTaskProjection("task-1", "failed");
  h.context.completeAssistant("message-1", "完整但迟到的正文", "task-1");
  h.context.completeAssistant("message-1", "完整但迟到的正文", "task-1");
  h.context.completeTool({
    itemId: "tool-1",
    taskId: "task-1",
    tool: { kind: "execute", status: "completed", entries: [] },
  });

  assert.equal(current.stream.completed, true);
  assert.equal(current.stream.target, "完整但迟到的正文");
  assert.equal(current.stream.element.classList.contains("pending"), false);
  assert.equal(current.replacements.length, 2);
  assert.deepEqual(h.scheduledStreams, []);
  assert.equal(h.state.commands.size, 1);
  assert.equal(h.state.commands.get("tool-1").status, "failed");
  assert.equal(h.state.commands.get("tool-1").taskTerminalStatus, "failed");
});

test("a normally completed task closes a missing tool completion as completed", () => {
  const h = harness();
  h.state.commands.set("tool-1", {
    mode: "card",
    taskId: "task-1",
    status: "in_progress",
    taskTerminalStatus: null,
  });

  h.context.finalizeTaskProjection("task-1", "completed");

  assert.equal(h.state.commands.get("tool-1").status, "completed");
  assert.equal(h.state.commands.get("tool-1").taskTerminalStatus, "completed");
});
