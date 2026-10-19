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
  /** Test-double injection point; production listens for SIGINT/SIGTERM on the current process. */
  signals?: SignalSource;
  startupTimeoutMs?: number;
  stopSignalGraceMs?: number;
};

/** Run the service and return its exit code: 0 for planned stops, 1 for startup failure or unexpected directory-process exit. */
export async function main(options: MainOptions = {}): Promise<number> {
  // Establish stop intent first so signals received during startup can interrupt it and count as planned stops.
  const stop = new StopIntent(options.signals);
  const grace = options.stopSignalGraceMs ?? STOP_SIGNAL_GRACE_MS;
  try {
    const outcome = await serve(stop, options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    if (outcome === "stopped") return 0;
    if (stop.stopRequested || await stop.arrivesWithin(grace)) return 0;
    console.error("codex app-server has ended; Codex Remote exits too so it can be restarted.");
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stop.stopRequested || await stop.arrivesWithin(grace)) {
      console.log(error instanceof StartupAbortedError
        ? message
        : `A stop signal arrived before startup finished: ${message}`);
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
    throw new Error("Set CODEX_REMOTE_TOKEN to at least 32 characters.");
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
  // Abandoned startup cleanup may still be finishing; await it before closing Worker state.
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
    // listen resolves quickly; do not race it, or it could succeed after abandonment once close() has already missed it.
    const address = await remote.listen(port);
    startup.check();
    startup.finish();
    workers.start();
    console.log(`Codex Remote is listening on http://${address.host}:${address.port}/`);

    // Once codex app-server disappears, this process cannot serve requests. Continuing would only return failures,
    // so exit and let the supervisor restart it. Signal handlers set stop intent synchronously; if the child exits
    // before Node handles its signal, main() checks once more during its grace window to preserve exit code 0.
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
      // Startup cleanup is stuck on a directory RPC; close the child so pending requests fail and cleanup can finish.
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
    console.log(`Trash recovery finished ${result.settled} interrupted moves or restores.`);
  }
  if (result.deleted > 0) {
    console.log(`Trash cleanup permanently deleted ${result.deleted} expired sessions.`);
  }
  for (const failure of result.failed) {
    console.error(`Trash cleanup could not delete session ${failure.sessionId}: ${failure.message}`);
  }
}

/** Browser Origin allowlist. When empty, accept only upgrade requests sharing the Host origin. */
function readAllowedOrigins(source: string | undefined): string[] {
  return (source ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPort(source: string): number {
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_REMOTE_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function readPositiveInteger(source: string | undefined): number | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = Number(source);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("The worker count must be a positive integer.");
  }
  return value;
}

function readNonnegativeInteger(source: string | undefined): number | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("The offline grace period must be a non-negative integer number of milliseconds.");
  }
  return value;
}

/** Offline grace uses a Node timer directly; reject at startup because Node clamps values above its limit to 1 ms. */
export function readOfflineGraceMs(source: string | undefined): number | undefined {
  if (source === undefined || source.trim() === "") return undefined;
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `CODEX_REMOTE_OFFLINE_GRACE_MS must be an integer number of milliseconds from 0 to ${MAX_TIMER_DELAY_MS} (about 24.8 days).`,
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
