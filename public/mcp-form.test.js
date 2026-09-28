import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMcpFormSchema, validateMcpFormAnswers } from "./mcp-form.js";

function schema() {
  return {
    type: "object",
    required: ["name", "count", "enabled", "tags"],
    properties: {
      name: {
        type: "string",
        title: "名称",
        minLength: 2,
        maxLength: 4,
        default: "默认",
      },
      count: {
        type: "integer",
        title: "数量",
        minimum: 1,
        maximum: 3,
        default: 2,
      },
      enabled: { type: "boolean", title: "启用", default: false },
      color: {
        type: "string",
        title: "颜色",
        enum: ["red", "blue"],
        enumNames: ["红", "蓝"],
        default: "blue",
      },
      tags: {
        type: "array",
        title: "标签",
        minItems: 1,
        maxItems: 2,
        items: {
          anyOf: [
            { const: "A", title: "甲" },
            { const: "B", title: "乙" },
            { const: "C", title: "丙" },
          ],
        },
        default: ["A"],
      },
    },
  };
}

test("normalizes the supported MCP form subset and keeps valid defaults", () => {
  const form = normalizeMcpFormSchema(schema());
  assert.ok(form);
  assert.deepEqual(form.fields.map((field) => ({
    id: field.id,
    required: field.required,
    default: field.default,
  })), [
    { id: "name", required: true, default: "默认" },
    { id: "count", required: true, default: 2 },
    { id: "enabled", required: true, default: false },
    { id: "color", required: false, default: "blue" },
    { id: "tags", required: true, default: ["A"] },
  ]);

  assert.deepEqual(validateMcpFormAnswers(form, {
    name: ["测试"],
    count: ["3"],
    enabled: ["false"],
    color: ["red"],
    tags: ["A", "B"],
  }), {
    ok: true,
    content: { name: "测试", count: 3, enabled: false, color: "red", tags: ["A", "B"] },
  });
});

test("rejects required, numeric, length, enum, and array-count violations", () => {
  const form = normalizeMcpFormSchema(schema());
  assert.ok(form);
  const valid = {
    name: ["测试"],
    count: ["2"],
    enabled: ["true"],
    color: ["blue"],
    tags: ["A"],
  };
  const cases = [
    [{ ...valid, name: [] }, /请填写“名称”/u],
    [{ ...valid, name: ["长名字超过"] }, /最多允许 4 个字符/u],
    [{ ...valid, count: ["0"] }, /不能小于 1/u],
    [{ ...valid, count: ["4"] }, /不能大于 3/u],
    [{ ...valid, count: ["1.5"] }, /不是有效的整数/u],
    [{ ...valid, color: ["green"] }, /选项无法识别/u],
    [{ ...valid, tags: [] }, /请填写“标签”/u],
    [{ ...valid, tags: ["A", "B", "C"] }, /最多只能选择 2 项/u],
    [{ ...valid, tags: ["A", "A"] }, /重复/u],
    [{ ...valid, extra: ["x"] }, /无法识别的字段/u],
  ];
  for (const [answers, message] of cases) {
    const result = validateMcpFormAnswers(form, answers);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, message);
  }
});

test("an unsupported or internally inconsistent schema cannot be partially accepted", () => {
  const unsupported = [
    { ...schema(), extraConstraint: true },
    {
      type: "object",
      properties: { address: { type: "string", format: "email" } },
    },
    {
      type: "object",
      properties: { count: { type: "number", minimum: 5, maximum: 4 } },
    },
    {
      type: "object",
      properties: { color: { type: "string", enum: ["red"], default: "blue" } },
    },
    {
      type: "object",
      properties: { tags: { type: "array", minItems: 2, items: { type: "string", enum: ["A"] } } },
    },
    {
      type: "object",
      required: ["missing"],
      properties: { name: { type: "string" } },
    },
    {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [`field-${index}`, { type: "string" }]),
      ),
    },
  ];
  for (const value of unsupported) assert.equal(normalizeMcpFormSchema(value), null);
  assert.match(
    validateMcpFormAnswers(null, {}).message,
    /只能取消/u,
  );
});
