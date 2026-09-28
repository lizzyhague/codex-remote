import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = { confirm: () => true };
const { SlashCommandMenu } = await import("./slash-menu.js");

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.value = "";
    this.children = [];
    this.parentElement = null;
    this._attributes = new Map();
    this._listeners = new Map();
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === "#fragment") {
        this.append(...node.children);
        continue;
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) ?? [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const listener of this._listeners.get(event.type) ?? []) listener(event);
    if (event.bubbles !== false) this.parentElement?.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(keyEvent("click", null));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this._attributes.get(name) ?? null;
  }

  scrollIntoView() {}
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createDocumentFragment() {
    return new FakeElement("#fragment", this);
  }
}

function keyEvent(type, key) {
  return {
    type,
    key,
    bubbles: true,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

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
        { name: "rename", action: "argument" },
        { name: "compact", action: "confirm" },
        { name: "rewind", action: "confirm" },
        { name: "model", action: "options" },
        { name: "permissions", action: "options" },
      ] } : {};
    },
    onResult() {}, onError: error => errors.push(error), onBusy() {}, onInputChanged() {},
    onRename: title => renamed.push(title),
  });
  return { menu, input, calls, errors, renamed };
}

function domSetup() {
  const document = new FakeDocument();
  globalThis.document = document;
  const calls = [];
  const input = document.createElement("textarea");
  input.value = "草稿";
  const element = document.createElement("div");
  element.hidden = true;
  const button = document.createElement("button");
  button.setAttribute("aria-expanded", "false");
  const menu = new SlashCommandMenu({
    input,
    element,
    button,
    request: async (type, args) => {
      calls.push({ type, args });
      return type === "commands.list" ? { commands: [
        { name: "rename", action: "argument", description: "重命名" },
        { name: "compact", action: "confirm", description: "压缩" },
        { name: "rewind", action: "confirm", description: "回退" },
      ] } : {};
    },
    onResult() {},
    onError: error => assert.fail(error),
    onBusy() {},
    onInputChanged() {},
  });
  button.addEventListener("click", () => menu.toggleAll());
  return { document, input, element, button, menu, calls };
}

test("commands with their own control are unavailable while the rest are retained", async () => {
  const { menu, calls, errors } = setup();
  await menu.load();
  assert.deepEqual(menu._commands.map(item => item.name), ["rename", "compact", "rewind"]);
  for (const command of ["model", "permissions"]) {
    assert.equal(await menu.submit(`/${command}`), true);
  }
  assert.equal(errors.length, 2);
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

test("plus menu moves focus with its selection and Escape restores the trigger", async () => {
  const { document, element, button, menu } = domSetup();
  await menu.load();

  button.focus();
  button.click();
  assert.equal(element.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement, menu._visibleItems[0]);
  assert.equal(menu._visibleItems[0].getAttribute("aria-selected"), "true");
  assert.equal(menu._visibleItems[0].tabIndex, 0);
  assert.equal(menu._visibleItems[1].tabIndex, -1);

  const down = keyEvent("keydown", "ArrowDown");
  document.activeElement.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(document.activeElement, menu._visibleItems[1]);
  assert.equal(menu._visibleItems[0].getAttribute("aria-selected"), "false");
  assert.equal(menu._visibleItems[1].getAttribute("aria-selected"), "true");

  const escape = keyEvent("keydown", "Escape");
  document.activeElement.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(element.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, button);
});

test("Enter executes the focused plus-menu option without replacing the draft", async () => {
  const { document, input, element, button, menu, calls } = domSetup();
  await menu.load();

  button.focus();
  button.click();
  document.activeElement.dispatchEvent(keyEvent("keydown", "ArrowDown"));
  const enter = keyEvent("keydown", "Enter");
  document.activeElement.dispatchEvent(enter);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(enter.defaultPrevented, true);
  assert.equal(element.hidden, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(input.value, "草稿");
  assert.equal(document.activeElement, input);
  assert.equal(calls.at(-1).args.command, "rewind");
});

test("typed slash keeps textarea focus and its Arrow and Enter path", async () => {
  const { document, input, element, button, menu, calls } = domSetup();
  await menu.load();
  input.value = "/";
  input.focus();

  menu.handleInput();
  assert.equal(element.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, input);
  assert.equal(menu._visibleItems[0].getAttribute("aria-selected"), "true");

  const down = keyEvent("keydown", "ArrowDown");
  assert.equal(menu.handleKeydown(down), true);
  assert.equal(document.activeElement, input);
  assert.equal(menu._visibleItems[1].getAttribute("aria-selected"), "true");
  const enter = keyEvent("keydown", "Enter");
  assert.equal(menu.handleKeydown(enter), true);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(input.value, "");
  assert.equal(document.activeElement, input);
  assert.equal(calls.at(-1).args.command, "compact");
});
