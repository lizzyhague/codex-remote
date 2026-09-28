import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { normalizeMcpFormSchema, validateMcpFormAnswers } from "./mcp-form.js";

const [source, styles] = await Promise.all([
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.selected = false;
    this.validationMessage = "";
    this.focused = false;
    this.reported = false;
  }

  append(...children) {
    this.children.push(...children);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  setCustomValidity(message) {
    this.validationMessage = message;
  }

  focus() {
    this.focused = true;
  }

  reportValidity() {
    this.reported = true;
    return !this.validationMessage;
  }

  get selectedOptions() {
    const options = this.children.filter((child) => child.tagName === "OPTION");
    const selected = options.filter((option) => option.selected);
    return selected.length > 0 ? selected : options.slice(0, 1);
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap((child) => descendants(child))];
}

function interactionHarness() {
  const calls = [];
  const approvalList = new FakeElement("aside");
  approvalList.querySelector = () => null;
  const context = vm.createContext({
    elements: { approvalList },
    document: { createElement: (tagName) => new FakeElement(tagName) },
    CSS: { escape: (value) => value },
    pendingRequestSessionLabel: () => "会话 · session-",
    answerInteraction: (...args) => calls.push(args),
    sanitizeHref: () => null,
    normalizeMcpFormSchema,
    validateMcpFormAnswers,
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function addInteraction("),
      source.indexOf("async function answerInteraction("),
    ),
    context,
  );
  return { context, approvalList, calls };
}

function formSchema() {
  return {
    type: "object",
    required: ["name", "count", "enabled", "tags"],
    properties: {
      name: { type: "string", title: "名称", minLength: 2, maxLength: 4, default: "默认" },
      count: { type: "integer", title: "数量", minimum: 1, maximum: 3, default: 2 },
      enabled: { type: "boolean", title: "启用", default: false },
      color: { type: "string", title: "颜色", enum: ["red", "blue"], default: "blue" },
      tags: {
        type: "array",
        title: "标签",
        minItems: 1,
        maxItems: 2,
        items: { type: "string", enum: ["A", "B", "C"] },
        default: ["A"],
      },
    },
  };
}

test("the MCP card applies defaults and blocks an invalid answer before sending", () => {
  const h = interactionHarness();
  h.context.addInteraction({
    id: "interaction-1",
    kind: "mcp_elicitation",
    mode: "form",
    serverName: "example",
    message: "填写参数",
    schema: formSchema(),
  }, { id: "session-1", title: "会话" }, "session-1");

  const card = h.approvalList.children[0];
  const controls = descendants(card).filter((element) =>
    element.tagName === "INPUT" || element.tagName === "SELECT"
  );
  const [name, count, enabled, color, tags] = controls;
  assert.equal(name.value, "默认");
  assert.equal(count.value, "2");
  assert.equal(enabled.selectedOptions[0].value, "false");
  assert.equal(color.selectedOptions[0].value, "blue");
  assert.deepEqual(tags.selectedOptions.map((option) => option.value), ["A"]);

  name.value = "太长的名字";
  const submit = descendants(card).find((element) => element.textContent === "提交回答");
  submit.listeners.get("click")();
  assert.equal(h.calls.length, 0);
  assert.match(name.validationMessage, /最多允许 4 个字符/u);
  assert.equal(name.focused, true);
  assert.equal(name.reported, true);
  const error = descendants(card).find((element) => element.className === "interaction-validation");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /“名称”/u);

  name.value = "测试";
  name.listeners.get("input")();
  assert.equal(error.hidden, true);
  submit.listeners.get("click")();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].slice(1))), ["interaction-1", "submit", {
    name: ["测试"],
    count: ["2"],
    enabled: ["false"],
    color: ["blue"],
    tags: ["A"],
  }]);
});

test("unsupported schema shows cancellation without a submit action", () => {
  const h = interactionHarness();
  h.context.addInteraction({
    id: "interaction-unsupported",
    kind: "mcp_elicitation",
    mode: "form",
    serverName: "example",
    message: "填写邮箱",
    schema: { type: "object", properties: { email: { type: "string", format: "email" } } },
  }, { id: "session-1", title: "会话" }, "session-1");
  const card = h.approvalList.children[0];
  const text = descendants(card).map((element) => element.textContent).join("\n");
  const buttons = descendants(card).filter((element) => element.tagName === "BUTTON");
  assert.match(text, /只能取消本轮/u);
  assert.deepEqual(buttons.map((button) => button.textContent), ["取消本轮"]);
});

test("a 50-field card keeps native actions after every field", () => {
  const h = interactionHarness();
  h.context.addInteraction({
    id: "interaction-long",
    kind: "mcp_elicitation",
    mode: "form",
    serverName: "example",
    message: "长表单",
    schema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          `field-${index}`,
          { type: "string", title: `字段 ${index}` },
        ]),
      ),
    },
  }, { id: "session-1", title: "会话" }, "session-1");
  const card = h.approvalList.children[0];
  assert.equal(card.children.filter((child) => child.tagName === "LABEL").length, 50);
  const actions = card.children.at(-1);
  assert.equal(actions.className, "approval-card-actions");
  assert.deepEqual(actions.children.map((button) => button.textContent), ["取消本轮", "提交回答"]);
  assert.ok(actions.children.every((button) => button.type === "button"));
});

test("the pending area is bounded and scrollable while its action row stays visible", () => {
  assert.match(styles, /\.approval-list\s*\{[^}]*min-height:\s*0;[^}]*max-height:\s*min\(50dvh, 32rem\);[^}]*overflow-y:\s*auto;/su);
  assert.match(styles, /\.approval-list\s*\{[^}]*overscroll-behavior-y:\s*contain;/su);
  assert.match(styles, /\.approval-card-actions\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/su);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.approval-card-actions > button\s*\{[^}]*flex:\s*1 1 8rem;/u);
});
