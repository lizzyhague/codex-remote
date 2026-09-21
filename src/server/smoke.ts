import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { AppServerClient } from "../app-server/client.ts";
import { ProjectCatalog } from "../projects/catalog.ts";
import { CodexSessionService } from "../sessions/service.ts";
import { resolveTrashStatePath, TrashStore } from "../sessions/trash-store.ts";
import { SessionWorkerManager } from "../workers/manager.ts";
import { WorkerStateStore } from "../workers/state-store.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import { buildViewableRoots, ensurePreviewRoot } from "./viewable-roots.ts";

const token = "codex-remote-smoke-token-not-a-secret";
const appServer = new AppServerClient({ workingDirectory: process.cwd() });
// 这个脚本只读项目和会话列表，不启动任何任务，所以状态库放在临时目录，
// 不碰主机上真正的 work.sqlite。
const stateDirectory = await mkdtemp(path.join(tmpdir(), "codex-remote-smoke-"));
let workerState: WorkerStateStore | null = null;
let workers: SessionWorkerManager | null = null;
let remote: RemoteWebSocketServer | null = null;
let webSocket: WebSocket | null = null;

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
  const projects = await ProjectCatalog.fromConfigFile("config/projects.json");
  const previewRoot = await ensurePreviewRoot();
  const trash = await TrashStore.open(resolveTrashStatePath());
  const locks = new ProjectTaskLocks();
  workerState = await WorkerStateStore.open(path.join(stateDirectory, "work.sqlite"));
  workers = new SessionWorkerManager({ store: workerState, projects, trash, locks });
  remote = new RemoteWebSocketServer({
    token,
    fileRoots: buildViewableRoots(projects.rootPaths(), [previewRoot]),
    services: {
      projects,
      sessions: new CodexSessionService(appServer, projects, trash),
      turnTransport: appServer,
      locks,
      workers,
    },
  });
  const address = await remote.listen(0);
  const login = await fetch(`http://${address.host}:${address.port}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!login.ok || !cookie) throw new Error("HTTP 登录没有签发 cookie。");
  webSocket = new WebSocket(`ws://${address.host}:${address.port}/ws`, {
    headers: { cookie },
  });
  await once(webSocket, "open");
  const projectResponse = await sendRequest(webSocket, {
    type: "projects.list",
    requestId: "projects",
  });
  const projectList = asObject(projectResponse.data)?.projects;
  if (!Array.isArray(projectList)) {
    throw new Error("WebSocket 没有返回项目列表。");
  }
  const project = projectList.find((value) => asObject(value)?.name === "codex-remote");
  const projectId = asObject(project)?.id;
  if (typeof projectId !== "string") {
    throw new Error("项目列表里没有 codex-remote。");
  }

  const sessionResponse = await sendRequest(webSocket, {
    type: "sessions.list",
    requestId: "sessions",
    projectId,
  });
  const sessionList = asObject(sessionResponse.data)?.sessions;
  if (!Array.isArray(sessionList)) {
    throw new Error("WebSocket 没有返回会话列表。");
  }
  console.log(
    `真实 WebSocket 联调成功：${projectList.length} 个项目，codex-remote 有 ${sessionList.length} 个会话。`,
  );
} finally {
  if (webSocket && webSocket.readyState !== WebSocket.CLOSED) {
    const closed = once(webSocket, "close");
    webSocket.close();
    await closed;
  }
  await remote?.close();
  await workers?.close();
  workerState?.close();
  await appServer.close();
  await rm(stateDirectory, { recursive: true, force: true });
}

async function sendRequest(
  socket: WebSocket,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = once(socket, "message");
  socket.send(JSON.stringify(request));
  const value = JSON.parse(String((await response)[0]));
  if (!isObject(value) || value.type !== "response" || value.ok !== true) {
    throw new Error("WebSocket 请求失败。");
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
