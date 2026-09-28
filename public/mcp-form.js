const MAX_FIELDS = 50;
const MAX_CHOICES = 50;
const MAX_FIELD_ID_LENGTH = 128;
const MAX_ANSWER_CODE_UNITS = 4_096;

/**
 * 把 MCP 的 typed form schema 收紧成浏览器和后端共同支持的子集。
 * 返回 null 表示整张表单只能取消，不能只呈现其中一部分。
 */
export function normalizeMcpFormSchema(schema) {
  if (!isRecord(schema) || !hasOnlyKeys(schema, ["$schema", "type", "properties", "required"])) {
    return null;
  }
  if (schema.type !== "object" || !isRecord(schema.properties)) return null;
  if (schema.$schema !== undefined && typeof schema.$schema !== "string") return null;

  const propertyEntries = Object.entries(schema.properties);
  if (propertyEntries.length === 0 || propertyEntries.length > MAX_FIELDS) return null;

  const propertyIds = new Set(propertyEntries.map(([fieldId]) => fieldId));
  if (propertyIds.size !== propertyEntries.length) return null;
  const requiredValues = schema.required === undefined ? [] : schema.required;
  if (
    !Array.isArray(requiredValues) ||
    requiredValues.some((fieldId) => typeof fieldId !== "string" || !propertyIds.has(fieldId))
  ) return null;
  const required = new Set(requiredValues);
  if (required.size !== requiredValues.length) return null;

  const fields = [];
  for (const [fieldId, rawField] of propertyEntries) {
    if (
      !fieldId || fieldId.length > MAX_FIELD_ID_LENGTH || fieldId === "__proto__" ||
      !isRecord(rawField)
    ) return null;
    const field = normalizeField(fieldId, rawField, required.has(fieldId));
    if (!field) return null;
    fields.push(field);
  }
  return { fields };
}

/** 后端最终边界和浏览器提交前都调用这一份答案校验。 */
export function validateMcpFormAnswers(form, answers) {
  if (!form || !Array.isArray(form.fields) || !isRecord(answers)) {
    return invalid(null, "这个 MCP 表单暂时不受支持，只能取消本轮。");
  }
  const fieldsById = new Map(form.fields.map((field) => [field.id, field]));
  for (const [fieldId, values] of Object.entries(answers)) {
    if (!fieldsById.has(fieldId) || !Array.isArray(values) || values.some((value) => typeof value !== "string")) {
      return invalid(fieldId, "MCP 表单回答包含无法识别的字段或值。");
    }
  }

  const contentEntries = [];
  for (const field of form.fields) {
    const values = answers[field.id] ?? [];
    const result = validateFieldAnswer(field, values);
    if (!result.ok) return result;
    if (result.present) contentEntries.push([field.id, result.value]);
  }
  return { ok: true, content: Object.fromEntries(contentEntries) };
}

function normalizeField(id, schema, required) {
  if (!optionalString(schema.title) || !optionalString(schema.description)) return null;
  const common = {
    id,
    title: typeof schema.title === "string" && schema.title ? schema.title : id,
    description: typeof schema.description === "string" ? schema.description : "",
    required,
  };

  let field = null;
  if (schema.type === "string") field = normalizeStringField(common, schema);
  else if (schema.type === "number" || schema.type === "integer") {
    field = normalizeNumberField(common, schema);
  } else if (schema.type === "boolean") field = normalizeBooleanField(common, schema);
  else if (schema.type === "array") field = normalizeArrayField(common, schema);
  if (!field) return null;

  if (Object.hasOwn(schema, "default")) {
    const values = defaultAnswerValues(field, schema.default);
    if (!values) return null;
    const result = validateFieldAnswer({ ...field, required: false }, values);
    if (!result.ok || !result.present) return null;
    field.default = schema.default;
  }
  return field;
}

function normalizeStringField(common, schema) {
  const hasEnum = Object.hasOwn(schema, "enum") || Object.hasOwn(schema, "oneOf") ||
    Object.hasOwn(schema, "enumNames");
  if (hasEnum) {
    if (!hasOnlyKeys(schema, ["type", "title", "description", "enum", "enumNames", "oneOf", "default"])) {
      return null;
    }
    const choices = normalizeChoices(schema);
    return choices ? { ...common, type: "string", choices } : null;
  }
  if (!hasOnlyKeys(schema, ["type", "title", "description", "minLength", "maxLength", "default"])) {
    // format/pattern 等约束没有完整实现时，整张表单保持只能取消。
    return null;
  }
  const minLength = nonnegativeSafeInteger(schema.minLength, 0);
  const maxLength = nonnegativeSafeInteger(schema.maxLength, Infinity);
  if (minLength === null || maxLength === null || minLength > maxLength) return null;
  return { ...common, type: "string", minLength, maxLength };
}

function normalizeNumberField(common, schema) {
  if (!hasOnlyKeys(schema, ["type", "title", "description", "minimum", "maximum", "default"])) {
    return null;
  }
  const minimum = finiteNumber(schema.minimum, -Infinity);
  const maximum = finiteNumber(schema.maximum, Infinity);
  if (minimum === null || maximum === null || minimum > maximum) return null;
  return { ...common, type: schema.type, minimum, maximum };
}

function normalizeBooleanField(common, schema) {
  if (!hasOnlyKeys(schema, ["type", "title", "description", "default"])) return null;
  if (schema.default !== undefined && typeof schema.default !== "boolean") return null;
  return { ...common, type: "boolean" };
}

function normalizeArrayField(common, schema) {
  if (!hasOnlyKeys(schema, ["type", "title", "description", "items", "minItems", "maxItems", "default"])) {
    return null;
  }
  if (!isRecord(schema.items)) return null;
  const itemKeys = Object.hasOwn(schema.items, "anyOf")
    ? ["anyOf"]
    : ["type", "enum"];
  if (!hasOnlyKeys(schema.items, itemKeys)) return null;
  if (itemKeys.includes("type") && schema.items.type !== "string") return null;
  const choices = normalizeChoices(schema.items);
  if (!choices) return null;
  const minItems = nonnegativeSafeInteger(schema.minItems, 0);
  const maxItems = nonnegativeSafeInteger(schema.maxItems, Infinity);
  if (
    minItems === null || maxItems === null || minItems > maxItems ||
    minItems > choices.length
  ) return null;
  return { ...common, type: "array", choices, minItems, maxItems };
}

function normalizeChoices(schema) {
  let choices;
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    if (schema.enum !== undefined || schema.enumNames !== undefined) return null;
    const source = schema.oneOf ?? schema.anyOf;
    choices = source.map((value) => {
      if (!isRecord(value) || !hasOnlyKeys(value, ["const", "title"])) return null;
      return typeof value.const === "string" && typeof value.title === "string"
        ? { value: value.const, title: value.title }
        : null;
    });
  } else if (Array.isArray(schema.enum)) {
    if (schema.oneOf !== undefined || schema.anyOf !== undefined) return null;
    const names = schema.enumNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.length !== schema.enum.length ||
        names.some((value) => typeof value !== "string"))
    ) return null;
    choices = schema.enum.map((value, index) =>
      typeof value === "string"
        ? { value, title: names?.[index] ?? value }
        : null
    );
  } else {
    return null;
  }
  if (
    choices.length === 0 || choices.length > MAX_CHOICES || choices.some((choice) => !choice) ||
    choices.some((choice) =>
      choice.value.length === 0 || choice.value.length > MAX_ANSWER_CODE_UNITS
    ) || new Set(choices.map((choice) => choice.value)).size !== choices.length
  ) return null;
  return choices;
}

function validateFieldAnswer(field, values) {
  const label = `“${field.title}”`;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    return invalid(field.id, `${label}的回答格式无法识别。`);
  }
  if (values.length === 0) {
    return field.required
      ? invalid(field.id, `请填写${label}。`)
      : { ok: true, present: false };
  }
  if (values.some((value) => value.length === 0 || value.length > MAX_ANSWER_CODE_UNITS)) {
    return invalid(field.id, `${label}不能为空，并且不能超过 ${MAX_ANSWER_CODE_UNITS} 个代码单元。`);
  }

  if (field.type === "array") {
    if (new Set(values).size !== values.length || values.some((value) => !choiceValues(field).has(value))) {
      return invalid(field.id, `${label}包含无法识别或重复的选项。`);
    }
    if (values.length < field.minItems) {
      return invalid(field.id, `${label}至少要选择 ${field.minItems} 项。`);
    }
    if (values.length > field.maxItems) {
      return invalid(field.id, `${label}最多只能选择 ${field.maxItems} 项。`);
    }
    return { ok: true, present: true, value: [...values] };
  }

  if (values.length !== 1) return invalid(field.id, `${label}只能填写一个值。`);
  const value = values[0];
  if (field.type === "boolean") {
    if (value !== "true" && value !== "false") {
      return invalid(field.id, `${label}不是有效的布尔值。`);
    }
    return { ok: true, present: true, value: value === "true" };
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
      return invalid(field.id, `${label}不是有效的${field.type === "integer" ? "整数" : "数字"}。`);
    }
    if (number < field.minimum) return invalid(field.id, `${label}不能小于 ${field.minimum}。`);
    if (number > field.maximum) return invalid(field.id, `${label}不能大于 ${field.maximum}。`);
    return { ok: true, present: true, value: number };
  }

  if (field.choices && !choiceValues(field).has(value)) {
    return invalid(field.id, `${label}的选项无法识别。`);
  }
  const length = [...value].length;
  if (length < field.minLength) return invalid(field.id, `${label}至少需要 ${field.minLength} 个字符。`);
  if (length > field.maxLength) return invalid(field.id, `${label}最多允许 ${field.maxLength} 个字符。`);
  return { ok: true, present: true, value };
}

function choiceValues(field) {
  return new Set(field.choices.map((choice) => choice.value));
}

function defaultAnswerValues(field, value) {
  if (field.type === "array") {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : null;
  }
  if (field.type === "boolean") return typeof value === "boolean" ? [String(value)] : null;
  if (field.type === "number" || field.type === "integer") {
    return typeof value === "number" ? [String(value)] : null;
  }
  return typeof value === "string" ? [value] : null;
}

function invalid(fieldId, message) {
  return { ok: false, fieldId, message };
}

function optionalString(value) {
  return value === undefined || typeof value === "string";
}

function nonnegativeSafeInteger(value, fallback) {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value, fallback) {
  return value === undefined ? fallback : Number.isFinite(value) ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}
