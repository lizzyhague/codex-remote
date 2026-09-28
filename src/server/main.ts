import path from "node:path";
import { pathToFileURL } from "node:url";

import { DirectoryAppServer } from "../app-server/directory-server.ts";
import { codexRemoteInitializeParams } from "../app-server/initialize.ts";
import { ProjectCatalog } from "../projects/catalog.ts";
import { CodexSessionService } from "../sessions/service.ts";
import { resolveTrashStatePath, TrashStore } from "../sessions/trash-store.ts";
import { resolveMarkStatePath, MarkStore } from "../sessions/mark-store.ts";
import {
  ApplicationSettingsStore,
  resolveSettingsStatePath,
} from "../settings/store.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import {
  type SignalSource,
  StartupAbortedError,
  StartupDeadline,
  STARTUP_TIMEOUT_MS,
  STOP_SIGNAL_GRACE_MS,
  StopIntent,
} from "./lifecycle.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import { buildViewableRoots, ensurePreviewRoot } from "./viewable-roots.ts";
import { AttachmentDisplayIndex } from "../workers/attachment-index.ts";
import {
  resolveWorkerStateDirectory,
  resolveWorkerStatePath,
  WorkerStateStore,
} from "../workers/state-store.ts";
import { MAX_TIMER_DELAY_MS, SessionWorkerManager } from "../workers/manager.ts";
import { SharedUploadClient } from "../shared-upload/client.ts";
import { resolveSharedUploadSocket } from "../shared-upload/paths.ts";

const TRASH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type MainOptions = {
  /** 测试替身入口；生产环境监听当前进程的 SIGINT/SIGTERM。 */
  signals?: SignalSource;
  startupTimeoutMs?: number;
  stopSignalGraceMs?: number;
};

/** 运行整个服务，返回进程退出码。计划内停止为 0，启动失败或目录进程意外退出为 1。 */
export async function main(options: MainOptions = {}): Promise<number> {
  // 停止意图必须最先建立：启动期间收到的信号也要能打断启动并按计划停止处理。
  const stop = new StopIntent(options.signals);
  const grace = options.stopSignalGraceMs ?? STOP_SIGNAL_GRACE_MS;
  try {
    const outcome = await serve(stop, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    if (outcome === "stopped") return 0;
    if (stop.stopRequested || await stop.arrivesWithin(grace)) return 0;
    console.error("codex app-server 已经结束，Codex Remote 一同退出以便重启。");
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stop.stopRequested || await stop.arrivesWithin(grace)) {
      console.log(error instanceof StartupAbortedError
        ? message
        : `收到停止信号，启动未完成：${message}`);
      return 0;
    }
    console.error(message);
    return 1;
  } finally {
    stop.dispose();
  }
}

async function serve(
  stop: StopIntent,
  startupTimeoutMs: number,
): Promise<"stopped" | "directory_exited"> {
  const startup = new StartupDeadline(stop, startupTimeoutMs);
  const token = process.env.CODEX_REMOTE_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("请设置至少 32 个字符的 CODEX_REMOTE_TOKEN。");
  }
  const port = readPort(process.env.CODEX_REMOTE_PORT ?? "3000");
  const configPath = process.env.CODEX_REMOTE_PROJECTS_CONFIG ??
    path.resolve("config/projects.json");
  const trash = await TrashStore.open(resolveTrashStatePath());
  const marks = await MarkStore.open(resolveMarkStatePath());
  const settings = await ApplicationSettingsStore.open(resolveSettingsStatePath());
  const workerState = await WorkerStateStore.open(resolveWorkerStatePath());
  let appServer: DirectoryAppServer | null = null;
  let remote: RemoteWebSocketServer | null = null;
  let workers: SessionWorkerManager | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  // 被放弃的启动清理仍可能在收尾；关闭 Worker 状态前要等它离开。
  let startupCleanup: Promise<unknown> | null = null;

  try {
    const attachmentIndex = await AttachmentDisplayIndex.open(resolveWorkerStateDirectory());
    const uploads = new SharedUploadClient(resolveSharedUploadSocket());
    const projects = await ProjectCatalog.fromConfigFile(configPath);
    const previewRoot = await ensurePreviewRoot();
    startup.check();

    appServer = new DirectoryAppServer({ workingDirectory: process.cwd() });
    await startup.guard(appServer.initialize(codexRemoteInitializeParams()));
    const locks = new ProjectTaskLocks();
    workers = new SessionWorkerManager({
      store: workerState,
      projects,
      trash,
      settings,
      locks,
      uploads,
      attachmentIndex,
      workingDirectory: process.cwd(),
      ...(process.env.CODEX_BIN ? { codexBinary: process.env.CODEX_BIN } : {}),
      ...optionalNumber(
        "maxWorkers",
        readPositiveInteger(process.env.CODEX_REMOTE_MAX_WORKERS),
      ),
      ...optionalNumber(
        "minAvailableMemoryBytes",
        readMebibytes(process.env.CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB),
      ),
      ...optionalNumber(
        "offlineGraceMs",
        readOfflineGraceMs(process.env.CODEX_REMOTE_OFFLINE_GRACE_MS),
      ),
    });
    const sessions = new CodexSessionService(appServer, projects, trash, {
      marks,
      settings,
      deletedSessionArtifacts: workers,
    });
    startupCleanup = cleanExpiredTrash(sessions);
    await startup.guard(startupCleanup);
    startupCleanup = null;
    cleanupTimer = setInterval(() => {
      void cleanExpiredTrash(sessions);
    }, TRASH_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    remote = new RemoteWebSocketServer({
      token,
      fileRoots: buildViewableRoots(projects.rootPaths(), [previewRoot]),
      allowedOrigins: readAllowedOrigins(process.env.CODEX_REMOTE_ALLOWED_ORIGINS),
      uploads,
      services: {
        projects,
        sessions,
        turnTransport: appServer,
        locks,
        workers,
        settings,
        uploads,
      },
    });
    // listen 本身很快就有结果；不去 race 它，免得放弃后它才监听成功、close() 已错过。
    const address = await remote.listen(port);
    startup.check();
    startup.finish();
    workers.start();
    console.log(`Codex Remote 正在监听 http://${address.host}:${address.port}/`);

    // codex app-server 一旦消失，这个进程就无法再服务任何请求。继续监听只会
    // 让浏览器一直收到失败响应，所以主动退出，交给进程管理器重启。
    // 停止意图在信号回调里同步置位；子进程先于 Node 处理信号退出时，由 main()
    // 的宽限窗口再确认一次，计划内停止的退出码保持 0。
    return await Promise.race([
      stop.whenRequested().then(() => "stopped" as const),
      appServer.whenExited().then(() =>
        stop.stopRequested ? "stopped" as const : "directory_exited" as const
      ),
    ]);
  } finally {
    startup.finish();
    if (cleanupTimer) clearInterval(cleanupTimer);
    await remote?.close();
    if (startupCleanup) {
      // 启动清理卡在目录 RPC 上：先关子进程让在途请求失败，清理才会收口。
      await appServer?.close();
      await startupCleanup.catch(() => {});
    }
    await workers?.close();
    await appServer?.close();
    workerState.close();
  }
}

async function cleanExpiredTrash(sessions: CodexSessionService): Promise<void> {
  const result = await sessions.purgeExpired();
  if (result.settled > 0) {
    console.log(`回收站续做完成了 ${result.settled} 个中断的移入或恢复。`);
  }
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

function readPositiveInteger(source: string | undefined): number | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = Number(source);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Worker 数量必须是正整数。");
  }
  return value;
}

function readNonnegativeInteger(source: string | undefined): number | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("离线宽限时间必须是非负整数毫秒。");
  }
  return value;
}

/** 离线宽限直接交给 Node 计时器，超过计时器上限会被 Node 改成 1 ms，启动时就拒绝。 */
export function readOfflineGraceMs(source: string | undefined): number | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `CODEX_REMOTE_OFFLINE_GRACE_MS 必须是 0 到 ${MAX_TIMER_DELAY_MS} 之间的整数毫秒（上限约 24.8 天）。`,
    );
  }
  return value;
}

function readMebibytes(source: string | undefined): number | undefined {
  const value = readNonnegativeInteger(source);
  return value === undefined ? undefined : value * 1_048_576;
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): { [Property in Key]?: number } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: number };
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
