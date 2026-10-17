import type { AppServerTransport } from "./turn-session.ts";
import { asObject } from "../shared/json.ts";

export type PermissionProfileSummary = {
  id: string;
  description: string;
  allowed: boolean;
};

/** Permission options for the settings dropdown; backend-provided labels and descriptions match `/permissions`. */
export type PermissionOption = PermissionProfileSummary & {
  label: string;
  fullAccess: boolean;
};

/**
 * Set permission profiles and approval policies together, matching Codex Desktop: Full access means
 * `danger-full-access` plus `never`; all other profiles use “需要时询问”. Otherwise, selecting a
 * restricted profile while config.toml specifies `never` would block out-of-bounds operations without
 * showing an approval card.
 */
export type PermissionSettings = {
  permissions: string;
  approvalPolicy: "never" | "on-request";
};

export function permissionSettings(profileId: string): PermissionSettings {
  return {
    permissions: profileId,
    approvalPolicy: isFullAccessProfile(profileId) ? "never" : "on-request",
  };
}

export async function listPermissionProfiles(
  transport: AppServerTransport,
  cwd?: string,
): Promise<PermissionProfileSummary[]> {
  const response = asObject(await transport.request("permissionProfile/list", {
    cursor: null,
    limit: 100,
    ...(cwd ? { cwd } : {}),
  }));
  if (!response || !Array.isArray(response.data)) {
    throw new Error("Codex 返回了无法识别的权限列表。");
  }
  return response.data.flatMap((value) => {
    const profile = asObject(value);
    if (!profile || typeof profile.id !== "string") return [];
    return [{
      id: profile.id,
      description: typeof profile.description === "string" ? profile.description : "",
      allowed: profile.allowed === true,
    }];
  });
}

export async function listPermissionOptions(
  transport: AppServerTransport,
): Promise<PermissionOption[]> {
  return (await listPermissionProfiles(transport)).map((profile) => ({
    ...profile,
    label: permissionLabel(profile.id),
    description: profile.description || permissionDescription(profile.id),
    fullAccess: isFullAccessProfile(profile.id),
  }));
}

export function permissionLabel(id: string): string {
  if (isFullAccessProfile(id)) return "完全访问";
  const normalized = id.toLowerCase();
  if (normalized.includes("read")) return "只读";
  if (normalized.includes("workspace") || normalized.includes("auto")) {
    return "自动（可修改项目）";
  }
  return id;
}

export function permissionDescription(id: string): string {
  if (isFullAccessProfile(id)) return "可以不受沙箱限制地操作主机，并且不再询问批准；请谨慎选择。";
  const normalized = id.toLowerCase();
  if (normalized.includes("read")) return "可以阅读和分析；修改文件或执行高权限操作前会受限。";
  if (normalized.includes("workspace") || normalized.includes("auto")) {
    return "可在项目目录内工作，超出范围或敏感操作仍会询问。";
  }
  return "由当前 Codex 配置提供的权限方案。";
}

/**
 * Permission profiles expose only an ID, description, and availability, with no field describing their
 * sandbox semantics, so profile selection must recognize names. Use `runtimeUsesFullAccess` in the runner
 * to determine whether the current runtime has full access; it has App Server's structured sandbox policy.
 */
export function isFullAccessProfile(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.includes("full") || normalized.includes("danger");
}

/**
 * Profile to use when disabling Full access. `permissions: null` resets to the deployment default, which
 * may itself grant full access, and App Server emits no `thread/settings/updated` for it. The client could
 * neither disable nor detect full access, so explicitly switch to a restricted profile instead.
 */
export function pickRestrictedProfile(
  profiles: PermissionProfileSummary[],
): PermissionProfileSummary | null {
  const restricted = profiles.filter(
    (profile) => profile.allowed && !isFullAccessProfile(profile.id),
  );
  const preferred = restricted.find((profile) => {
    const normalized = profile.id.toLowerCase();
    return normalized.includes("workspace") || normalized.includes("auto");
  });
  return preferred ?? restricted[0] ?? null;
}
