import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelListResponse } from "../generated/v2/ModelListResponse.ts";
import type { PermissionProfileListResponse } from "../generated/v2/PermissionProfileListResponse.ts";
import { AppServerClient } from "./client.ts";
import { codexRemoteInitializeParams } from "./initialize.ts";

type ProtocolCheckOptions = {
  codexBinary?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

/**
 * 连接真实 App Server，但只执行初始化和只读目录查询；不会创建 thread 或调用模型。
 */
export async function runAppServerProtocolCheck(
  options: ProtocolCheckOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const codexBinary = options.codexBinary ?? (environment.CODEX_BIN?.trim() || "codex");
  const log = options.log ?? console.log;

  const workingDirectory = await mkdtemp(path.join(tmpdir(), "codex-remote-protocol-check-"));
  const client = new AppServerClient({ codexBinary, environment, workingDirectory });
  try {
    const initialized = await client.initialize(codexRemoteInitializeParams());
    const models = await client.request<ModelListResponse>("model/list", {
      cursor: null,
      limit: 1,
      includeHidden: false,
    });
    if (!models || !Array.isArray(models.data)) {
      throw new Error("model/list 返回了无法识别的结果。");
    }
    const permissionProfiles = await client.request<PermissionProfileListResponse>(
      "permissionProfile/list",
      { cursor: null, limit: 1, cwd: workingDirectory },
    );
    if (!permissionProfiles || !Array.isArray(permissionProfiles.data)) {
      throw new Error("permissionProfile/list 返回了无法识别的结果。");
    }
    log(
      `真实 App Server 协议检查通过：${initialized.userAgent}；` +
        "experimentalApi 初始化、model/list 和 permissionProfile/list 均可用；未调用模型。",
    );
  } finally {
    await client.close();
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runAppServerProtocolCheck().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
