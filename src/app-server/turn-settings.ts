import type { TurnStartParams } from "../generated/v2/TurnStartParams.ts";
import { asObject } from "../shared/json.ts";
import { permissionSettings } from "./permissions.ts";

/**
 * 会话运行中选定、还没交给 Codex 的模型和权限。下一轮 `turn/start` 时一起带上，
 * Codex 按 “for this turn and subsequent turns” 生效；正在跑的这一轮不受影响。
 * 没选过的一项不出现，沿用会话当前设置。
 */
export type PendingTurnSettings = {
  model?: { id: string; effort: string | null };
  permissions?: string;
};

export type TurnSettingsOverride = Pick<
  TurnStartParams,
  "model" | "effort" | "permissions" | "approvalPolicy"
>;

export function turnSettingsOverride(
  pending: PendingTurnSettings | null,
): TurnSettingsOverride {
  if (!pending) return {};
  return {
    ...(pending.model ? { model: pending.model.id, effort: pending.model.effort } : {}),
    ...(pending.permissions ? permissionSettings(pending.permissions) : {}),
  };
}

export function hasPendingTurnSettings(pending: PendingTurnSettings | null): boolean {
  return Boolean(pending?.model || pending?.permissions);
}

/** 读回持久化的待生效设置；认不出的部分丢掉，不让一条坏记录卡住下一轮。 */
export function parsePendingTurnSettings(value: unknown): PendingTurnSettings | null {
  const object = asObject(value);
  if (!object) return null;
  const pending: PendingTurnSettings = {};
  const model = asObject(object.model);
  if (
    model && typeof model.id === "string" && model.id &&
    (typeof model.effort === "string" || model.effort === null)
  ) {
    pending.model = { id: model.id, effort: model.effort };
  }
  if (typeof object.permissions === "string" && object.permissions) {
    pending.permissions = object.permissions;
  }
  return hasPendingTurnSettings(pending) ? pending : null;
}
