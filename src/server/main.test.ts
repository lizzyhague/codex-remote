import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { TrashStore } from "../sessions/trash-store.ts";
import { MAX_TIMER_DELAY_MS } from "../workers/manager.ts";
import { readOfflineGraceMs } from "./main.ts";

const MAIN_URL = pathToFileURL(path.resolve(import.meta.dirname, "main.ts")).href;

/**
 * 假的 `codex app-server --stdio`：`hang` 从不回 initialize，`ready` 只回 initialize、
 * 其余请求永不回答。stdin 结束就退出，模拟真实子进程的正常关闭。
 */
const FAKE_CODEX = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.FAKE_CODEX_PID_FILE, process.pid + "\\n");
const mode = process.env.FAKE_CODEX_MODE;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (mode === "ready" && message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      userAgent: "fake", codexHome: "/fake", platformFamily: "unix", platformOs: "linux",
    } }) + "\\n");
  }
});
lines.on("close", () => process.exit(0));
`;

type Service = {
  child: ChildProcess;
  root: string;
  output: () => { stdout: string; stderr: string };
  exit: Promise<number | null>;
};

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

async function prepare(mode: "hang" | "ready"): Promise<{
  root: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-remote-main-"));
  const projects = path.join(root, "projects");
  await mkdir(projects);
  await mkdir(path.join(root, "home"));
  const config = path.join(root, "projects.json");
  await writeFile(config, JSON.stringify({ roots: [{ id: "projects", path: projects }] }));
  const fakeScript = path.join(root, "fake-codex.mjs");
  await writeFile(fakeScript, FAKE_CODEX);
  const fakeBinary = path.join(root, "codex");
  await writeFile(
    fakeBinary,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`,
  );
  await chmod(fakeBinary, 0o755);
  return {
    root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(root, "home"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_DATA_HOME: path.join(root, "data"),
      CODEX_BIN: fakeBinary,
      CODEX_REMOTE_TOKEN: "t".repeat(40),
      CODEX_REMOTE_PORT: String(await freePort()),
      CODEX_REMOTE_PROJECTS_CONFIG: config,
      FAKE_CODEX_MODE: mode,
      FAKE_CODEX_PID_FILE: path.join(root, "fake-codex.pids"),
    },
  };
}

function startService(
  prepared: { root: string; env: NodeJS.ProcessEnv },
  options: { startupTimeoutMs: number; stopSignalGraceMs: number },
): Service {
  const source = `import { main } from ${JSON.stringify(MAIN_URL)};\n` +
    `const code = await main(${JSON.stringify(options)});\n` +
    `if (typeof code === "number") process.exitCode = code;\n`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: prepared.root,
    env: prepared.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = once(child, "exit").then(([code]) => code as number | null);
  return { child, root: prepared.root, output: () => ({ stdout, stderr }), exit };
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`等待超时：${what}`);
}

async function fakePids(root: string): Promise<number[]> {
  const source = await readFile(path.join(root, "fake-codex.pids"), "utf8").catch(() => "");
  return source.split("\n").filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function directoryPid(service: Service): Promise<number> {
  await waitFor(async () => (await fakePids(service.root)).length > 0, "目录子进程启动");
  const [pid] = await fakePids(service.root);
  assert.ok(pid);
  return pid;
}

async function waitForReady(service: Service): Promise<void> {
  await waitFor(() => service.output().stdout.includes("正在监听"), "服务开始监听");
}

/** 等服务退出，记下仍存活的目录子进程，再强制清掉测试残留。 */
async function finish(
  service: Service,
  inspect?: () => Promise<void>,
): Promise<{ code: number | null; leftovers: number[] }> {
  try {
    const code = await Promise.race([
      service.exit,
      delay(15_000, undefined, { ref: false }).then(() => "timeout" as const),
    ]);
    assert.notEqual(code, "timeout", `进程没有退出：${JSON.stringify(service.output())}`);
    const leftovers = (await fakePids(service.root)).filter(alive);
    await inspect?.();
    return { code: code as number | null, leftovers };
  } finally {
    if (service.child.exitCode === null) service.child.kill("SIGKILL");
    for (const pid of await fakePids(service.root)) {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    await rm(service.root, { recursive: true, force: true });
  }
}

test("an initialize that never answers ends startup with a failure", async () => {
  const service = startService(await prepare("hang"), {
    startupTimeoutMs: 300,
    stopSignalGraceMs: 50,
  });
  await directoryPid(service);
  const { code, leftovers } = await finish(service);
  assert.equal(code, 1);
  assert.match(service.output().stderr, /启动超过/);
  assert.doesNotMatch(service.output().stdout, /正在监听/);
  assert.deepEqual(leftovers, [], "半成品目录子进程已被清理");
});

test("a stop signal during startup ends the half-started service successfully", async () => {
  const service = startService(await prepare("hang"), {
    startupTimeoutMs: 60_000,
    stopSignalGraceMs: 50,
  });
  await directoryPid(service);
  service.child.kill("SIGTERM");
  const { code, leftovers } = await finish(service);
  assert.equal(code, 0);
  assert.match(service.output().stdout, /启动期间收到停止信号/);
  assert.deepEqual(leftovers, []);
});

test("startup cleanup that never finishes is bounded and stays resumable", async () => {
  const prepared = await prepare("ready");
  const trash = await TrashStore.open(path.join(prepared.root, "state", "codex-remote", "trash.json"));
  await trash.put({
    threadId: "thread-stuck",
    projectId: "projects",
    deletedAt: 1,
    origin: "archived",
    state: "deleting",
  });
  const service = startService(prepared, { startupTimeoutMs: 400, stopSignalGraceMs: 50 });
  await directoryPid(service);
  let reopened: TrashStore | null = null;
  const { code, leftovers } = await finish(service, async () => {
    reopened = await TrashStore.open(
      path.join(prepared.root, "state", "codex-remote", "trash.json"),
    );
  });
  assert.equal(code, 1);
  assert.match(service.output().stderr, /启动超过/);
  assert.deepEqual(leftovers, []);
  assert.equal(
    (reopened as TrashStore | null)?.get("thread-stuck")?.state,
    "deleting",
    "删除凭据留给下次启动续做",
  );
});

test("a planned stop after ready exits successfully", async () => {
  const service = startService(await prepare("ready"), {
    startupTimeoutMs: 10_000,
    stopSignalGraceMs: 50,
  });
  await waitForReady(service);
  await directoryPid(service);
  service.child.kill("SIGTERM");
  const { code, leftovers } = await finish(service);
  assert.equal(code, 0);
  assert.deepEqual(leftovers, []);
  assert.doesNotMatch(service.output().stderr, /已经结束/);
});

test("Node handling the stop signal first keeps a planned stop successful", async () => {
  const service = startService(await prepare("ready"), {
    startupTimeoutMs: 10_000,
    stopSignalGraceMs: 50,
  });
  await waitForReady(service);
  const pid = await directoryPid(service);
  // 进程管理器向整组发信号：Node 先收到，目录子进程紧接着自行退出。
  service.child.kill("SIGTERM");
  process.kill(pid, "SIGTERM");
  assert.equal((await finish(service)).code, 0);
  assert.doesNotMatch(service.output().stderr, /已经结束/);
});

test("the directory child exiting before Node sees the signal is still a planned stop", async () => {
  const service = startService(await prepare("ready"), {
    startupTimeoutMs: 10_000,
    stopSignalGraceMs: 3_000,
  });
  await waitForReady(service);
  const pid = await directoryPid(service);
  // 子进程先死并已被 Node 回收，Node 的停止信号随后才到。
  process.kill(pid, "SIGTERM");
  await waitFor(() => !alive(pid), "目录子进程被回收");
  service.child.kill("SIGTERM");
  assert.equal((await finish(service)).code, 0);
  assert.doesNotMatch(service.output().stderr, /已经结束/);
});

test("an unexpected directory exit without a stop signal is still a failure", async () => {
  const service = startService(await prepare("ready"), {
    startupTimeoutMs: 10_000,
    stopSignalGraceMs: 100,
  });
  await waitForReady(service);
  const pid = await directoryPid(service);
  process.kill(pid, "SIGKILL");
  assert.equal((await finish(service)).code, 1);
  assert.match(service.output().stderr, /codex app-server 已经结束/);
});

test("the offline grace accepts exactly the range a Node timer can hold", () => {
  assert.equal(readOfflineGraceMs(undefined), undefined);
  assert.equal(readOfflineGraceMs("  "), undefined);
  assert.equal(readOfflineGraceMs("0"), 0);
  assert.equal(readOfflineGraceMs("10000"), 10_000);
  assert.equal(readOfflineGraceMs(String(MAX_TIMER_DELAY_MS)), MAX_TIMER_DELAY_MS);
  for (const source of [
    String(MAX_TIMER_DELAY_MS + 1),
    "2592000000",
    "9007199254740993",
    "1e21",
    "-1",
    "1.5",
    "Infinity",
    "abc",
  ]) {
    assert.throws(
      () => readOfflineGraceMs(source),
      new RegExp(`CODEX_REMOTE_OFFLINE_GRACE_MS 必须是 0 到 ${MAX_TIMER_DELAY_MS}`),
      source,
    );
  }
});

test("an offline grace beyond the timer limit fails startup with the allowed range", async () => {
  const prepared = await prepare("ready");
  prepared.env.CODEX_REMOTE_OFFLINE_GRACE_MS = "2592000000";
  const service = startService(prepared, { startupTimeoutMs: 10_000, stopSignalGraceMs: 50 });
  const { code, leftovers } = await finish(service);
  assert.equal(code, 1);
  assert.match(service.output().stderr, /CODEX_REMOTE_OFFLINE_GRACE_MS 必须是 0 到 2147483647/);
  assert.doesNotMatch(service.output().stderr, /TimeoutOverflowWarning/);
  assert.doesNotMatch(service.output().stdout, /正在监听/);
  assert.deepEqual(leftovers, [], "目录子进程已被清理");
});
