import type { AppServerTransport } from "./turn-session.ts";
import { asObject } from "../shared/json.ts";

export type PermissionProfileSummary = {
  id: string;
  description: string;
  allowed: boolean;
};

/** 设置页下拉框用的权限选项；标签和说明由后端统一给出，与 `/permissions` 一致。 */
export type PermissionOption = PermissionProfileSummary & {
  label: string;
  fullAccess: boolean;
};

/**
 * 权限方案和批准方式成对设置，与 Codex 桌面端一致：Full access 等于
 * `danger-full-access` 加 `never`；其他方案一律“需要时询问”。否则 config.toml
 * 写了 `never` 又选了受限方案时，越界操作既做不了也弹不出批准卡。
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
 * 权限方案只有 id、说明和是否可选，没有任何字段说明它意味着什么沙箱，所以挑方案
 * 时只能认名字。判断"当前是不是完全访问"要用 runner 里的 `runtimeUsesFullAccess`，
 * 那里有 App Server 给的结构化沙箱策略可用。
 */
export function isFullAccessProfile(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.includes("full") || normalized.includes("danger");
}

/**
 * 关闭 Full access 时要落到的方案。`permissions: null` 会清成部署默认，而默认本身
 * 可能就是完全访问，且 App Server 对它不发 `thread/settings/updated`，客户端既关不掉
 * 也看不出来，所以改成显式切到一个受限方案。
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
