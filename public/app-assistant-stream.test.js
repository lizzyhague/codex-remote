import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const STREAMS = source.slice(
  source.indexOf("function assistantStreamFor(itemId)"),
  source.indexOf("function scheduleAssistantFrame(stream)"),
);

function streamContext({ onPage = [] } = {}) {
  const added = [];
  const context = vm.createContext({
    state: { assistantStreams: new Map() },
    CSS: { escape: (value) => value },
    elements: {
      timeline: {
        querySelector: (selector) =>
          onPage.some((id) => selector.includes(`"${id}"`)) ? { id: selector } : null,
      },
    },
    addMessage: (role, text, id) => {
      added.push({ role, id });
      context.state.assistantStreams.set(id, {
        element: { classList: { add() {} } },
        textElement: { textContent: "" },
        shown: "",
        target: text,
        completed: false,
        markdownRendered: false,
        frame: null,
      });
    },
    scheduleAssistantFrame: () => {},
  });
  vm.runInContext(STREAMS, context);
  return { context, added };
}

test("a replayed reply already drawn from history is dropped instead of doubled", () => {
  const { context, added } = streamContext({ onPage: ["item-1"] });

  context.appendAssistantDelta("item-1", "半截");
  context.completeAssistant("item-1", "半截回复");

  assert.deepEqual(added, []);
  assert.equal(context.state.assistantStreams.size, 0);
});

test("a reply the page has never drawn still opens its own bubble", () => {
  const { context, added } = streamContext();

  context.appendAssistantDelta("item-2", "你好");
  assert.deepEqual(added, [{ role: "assistant", id: "item-2" }]);
  assert.equal(context.state.assistantStreams.get("item-2").target, "你好");

  context.completeAssistant("item-2", "你好，世界");
  assert.equal(added.length, 1);
  const stream = context.state.assistantStreams.get("item-2");
  assert.equal(stream.target, "你好，世界");
  assert.equal(stream.completed, true);
});

test("an open stream is reused without consulting the page", () => {
  const { context, added } = streamContext({ onPage: ["item-3"] });
  context.state.assistantStreams.set("item-3", {
    element: { classList: { add() {} } },
    textElement: { textContent: "" },
    shown: "",
    target: "已经",
    completed: false,
    markdownRendered: false,
    frame: null,
  });

  context.appendAssistantDelta("item-3", "在写");

  assert.deepEqual(added, []);
  assert.equal(context.state.assistantStreams.get("item-3").target, "已经在写");
});
