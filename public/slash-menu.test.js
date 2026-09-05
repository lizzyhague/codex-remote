import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = { confirm: () => true };
const { SlashCommandMenu } = await import("./slash-menu.js");

function setup() {
  const calls = [];
  const errors = [];
  const renamed = [];
  const input = { value: "草稿", focus() {} };
  const menu = new SlashCommandMenu({
    input, element: { hidden: true, replaceChildren() {} },
    request: async (type, args) => {
      calls.push({ type, args });
      return type === "commands.list" ? { commands: [
        { name: "review", action: "immediate" },
        { name: "rename", action: "argument" },
        { name: "compact", action: "confirm" },
        { name: "rewind", action: "confirm" },
        { name: "plan", action: "immediate" },
        { name: "model", action: "options" },
        { name: "permissions", action: "options" },
      ] } : {};
    },
    onResult() {}, onError: error => errors.push(error), onBusy() {}, onInputChanged() {},
    onRename: title => renamed.push(title),
  });
  return { menu, input, calls, errors, renamed };
}

test("removed commands are unavailable while remaining commands are retained", async () => {
  const { menu, calls, errors } = setup();
  await menu.load();
  assert.deepEqual(menu._commands.map(item => item.name), ["rename", "compact", "rewind", "plan"]);
  for (const command of ["review", "model", "permissions"]) {
    assert.equal(await menu.submit(`/${command}`), true);
  }
  assert.equal(errors.length, 3);
  assert.equal(calls.filter(call => call.type === "command.run").length, 0);
});

test("plus menu opens without replacing the draft and command execution preserves it", async () => {
  const { menu, input, calls } = setup();
  await menu.load();
  let rendered;
  menu._renderCommands = (commands, actions) => { rendered = { commands, actions }; };
  menu.toggleAll();
  assert.equal(input.value, "草稿");
  assert.equal(rendered.actions, true);
  assert.ok(!rendered.commands.some(command => command.name === "rename"));
  await menu._chooseCommand({ name: "compact", action: "confirm" });
  assert.equal(input.value, "草稿");
  assert.equal(calls.at(-1).args.command, "compact");
});

test("rename opens a dialog callback instead of running a command", async () => {
  const { menu, input, calls, renamed } = setup();
  await menu.load();
  await menu.submit("/rename 新标题");
  assert.deepEqual(renamed, ["新标题"]);
  assert.equal(input.value, "");
  assert.equal(calls.filter(call => call.type === "command.run").length, 0);
});
