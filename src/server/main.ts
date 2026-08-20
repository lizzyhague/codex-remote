import path from "node:path";
import { pathToFileURL } from "node:url";

import { AppServerClient } from "../app-server/client.ts";
import { ApprovalBroker } from "../approvals/broker.ts";
import { ProjectCatalog } from "../projects/catalog.ts";
import { CodexSessionService } from "../sessions/service.ts";
import { resolveTrashStatePath, TrashStore } from "../sessions/trash-store.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { ProjectTaskLocks } from "./project-locks.ts";

const TRASH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export async function main(): Promise<void> {
  const token = process.env.CODEX_REMOTE_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("请设置至少 32 个字符的 CODEX_REMOTE_TOKEN。");
  }
  const port = readPort(process.env.CODEX_REMOTE_PORT ?? "8787");
  const configPath = process.env.CODEX_REMOTE_PROJECTS_CONFIG ??
    path.resolve("config/projects.json");
  const trash = await TrashStore.open(resolveTrashStatePath());

  const projects = await ProjectCatalog.fromConfigFile(configPath);
  const appServer = new AppServerClient({ workingDirectory: process.cwd() });
  let approvals: ApprovalBroker | null = null;
  let remote: RemoteWebSocketServer | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;

  try {
    await appServer.initialize({
      clientInfo: {
        name: "codex_remote",
        title: "Codex Remote",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    approvals = new ApprovalBroker(appServer);
    const sessions = new CodexSessionService(appServer, projects, trash);
    await cleanExpiredTrash(sessions);
    cleanupTimer = setInterval(() => {
      void cleanExpiredTrash(sessions);
    }, TRASH_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    remote = new RemoteWebSocketServer({
      token,
      allowedOrigins: readAllowedOrigins(process.env.CODEX_REMOTE_ALLOWED_ORIGINS),
      services: {
        projects,
        sessions,
        turnTransport: appServer,
        approvals,
        locks: new ProjectTaskLocks(),
      },
    });
    const address = await remote.listen(port);
    console.log(`Codex Remote 正在监听 http://${address.host}:${address.port}/`);

    // codex app-server 一旦消失，这个进程就无法再服务任何请求。继续监听只会
    // 让浏览器一直收到失败响应，所以主动退出，交给 systemd 重启。
    // 正常收到停止信号时，子进程稍后也会退出，那不算故障，退出码必须保持 0。
    let stopping = false;
    await Promise.race([
      waitForShutdownSignal().then(() => {
        stopping = true;
      }),
      appServer.whenExited().then(() => {
        if (stopping) return;
        console.error("codex app-server 已经结束，Codex Remote 一同退出以便重启。");
        process.exitCode = 1;
      }),
    ]);
  } finally {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await remote?.close();
    try {
      approvals?.cancelAll();
    } finally {
      approvals?.dispose();
      await appServer.close();
    }
  }
}

async function cleanExpiredTrash(sessions: CodexSessionService): Promise<void> {
  const result = await sessions.purgeExpired();
  if (result.deleted > 0) {
    console.log(`回收站自动清除了 ${result.deleted} 个过期会话。`);
  }
  for (const failure of result.failed) {
    console.error(`回收站无法清除会话 ${failure.sessionId}：${failure.message}`);
  }
}

/** 浏览器 Origin 白名单。留空时只接受与 Host 同源的升级请求。 */
function readAllowedOrigins(source: string | undefined): string[] {
  return (source ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPort(source: string): number {
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_REMOTE_PORT 必须是 1 到 65535 之间的整数。");
  }
  return port;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
