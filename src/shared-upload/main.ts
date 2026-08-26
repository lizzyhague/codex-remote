import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveSharedUploadPaths } from "./paths.ts";
import { SharedUploadServer } from "./server.ts";
import { SharedUploadStore } from "./store.ts";
import {
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_MIN_FREE_BYTES,
} from "./types.ts";

export async function main(): Promise<void> {
  const paths = resolveSharedUploadPaths();
  const store = await SharedUploadStore.open({
    paths,
    minFreeBytes: readMebibytes(
      process.env.AI_REMOTE_UPLOAD_MIN_FREE_MIB,
      DEFAULT_MIN_FREE_BYTES,
    ),
  });
  const server = new SharedUploadServer({ store, socketPath: paths.socket });
  let cleanupTimer: NodeJS.Timeout | null = null;
  try {
    const startupCleanup = await store.cleanup();
    logCleanup("启动", startupCleanup);
    await server.listen();
    cleanupTimer = setInterval(() => {
      void store.cleanup().then((result) => logCleanup("定时", result)).catch((error) => {
        console.error(`共享上传服务清理失败：${errorMessage(error)}`);
      });
    }, DEFAULT_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    console.log(`共享上传服务正在监听 Unix socket：${paths.socket}`);
    await waitForShutdownSignal();
  } finally {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await server.close().catch(() => {});
    store.close();
  }
}

function readMebibytes(value: string | undefined, fallbackBytes: number): number {
  if (value === undefined || !value.trim()) return fallbackBytes;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("AI_REMOTE_UPLOAD_MIN_FREE_MIB 必须是非负整数。");
  }
  return parsed * 1_048_576;
}

function logCleanup(
  label: string,
  result: { attachments: number; orphans: number; parts: number; tickets: number; leases: number },
): void {
  const total = result.attachments + result.orphans + result.parts + result.tickets + result.leases;
  if (total === 0) return;
  console.log(
    `${label}清理完成：附件 ${result.attachments}，孤立文件 ${result.orphans}，` +
      `临时文件 ${result.parts}，` +
      `票据 ${result.tickets}，租约 ${result.leases}。`,
  );
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
