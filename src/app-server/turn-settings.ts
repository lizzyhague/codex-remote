import type { TurnStartParams } from "../generated/v2/TurnStartParams.ts";
import { asObject } from "../shared/json.ts";
import { permissionSettings } from "./permissions.ts";

/**
 * Model and permission choices made during a session but not yet sent to Codex. They accompany the
 * next `turn/start` and take effect “for this turn and subsequent turns”; the active turn is unchanged.
 * Unselected fields are omitted so the session's current settings remain in effect.
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

/** Read persisted pending settings, discarding unknown fields so a bad record cannot block the next turn. */
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
