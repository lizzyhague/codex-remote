/**
 * 从 app-server 和状态文件里读松散 JSON 时公用的两个判断。
 *
 * 此前这两个函数在后端被逐字抄了十几份，其中一份的失败返回值还不一样——同名不同
 * 契约最容易在以后咬人，所以统一放这里，失败一律是 `null`。
 */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}
