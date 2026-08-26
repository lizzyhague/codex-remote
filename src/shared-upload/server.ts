import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import {
  createConnection,
  type Socket,
} from "node:net";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import { SharedUploadStore } from "./store.ts";
import {
  isSharedUploadCaller,
  SharedUploadError,
} from "./types.ts";

const MAX_JSON_BODY_BYTES = 64 * 1_024;

export type SharedUploadServerOptions = {
  store: SharedUploadStore;
  socketPath: string;
};

/** Local-only HTTP API shared by Codex, Grok, and Claude Remote adapters. */
export class SharedUploadServer {
  readonly #store: SharedUploadStore;
  readonly #socketPath: string;
  readonly #http: Server;
  #listening = false;

  constructor(options: SharedUploadServerOptions) {
    this.#store = options.store;
    this.#socketPath = path.resolve(options.socketPath);
    this.#http = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        sendError(response, error);
      });
    });
    this.#http.headersTimeout = 15_000;
    this.#http.requestTimeout = 15 * 60 * 1_000;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async listen(): Promise<void> {
    if (this.#listening) throw new Error("共享上传服务已经启动。");
    await mkdir(path.dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.#socketPath), 0o700);
    await removeStaleSocket(this.#socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#http.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#http.off("error", onError);
        resolve();
      };
      this.#http.once("error", onError);
      this.#http.once("listening", onListening);
      this.#http.listen(this.#socketPath);
    });
    await chmod(this.#socketPath, 0o600);
    this.#listening = true;
  }

  async close(): Promise<void> {
    if (!this.#listening) return;
    this.#listening = false;
    await new Promise<void>((resolve, reject) => {
      this.#http.close((error) => error ? reject(error) : resolve());
      this.#http.closeAllConnections();
    });
    await rm(this.#socketPath, { force: true });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://shared-upload.local");
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/tickets") {
      const body = await readJsonObject(request);
      const caller = requireCaller(body.caller);
      sendJson(response, 201, this.#store.createTicket({
        caller,
        projectId: requireString(body.projectId, "项目 ID", 1_024),
        sessionId: requireString(body.sessionId, "会话 ID", 1_024),
        originalName: requireString(body.originalName, "文件名", 1_024),
        declaredMime: requireString(body.declaredMime, "MIME", 255, true),
        expectedSize: requireInteger(body.expectedSize, "文件大小"),
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/uploads") {
      const ticket = requireHeader(request, "x-upload-ticket");
      const expectedLength = parseContentLength(request.headers["content-length"]);
      if (expectedLength === null) {
        throw new SharedUploadError("content_length_required", "上传必须提供 Content-Length。", 411);
      }
      const attachment = await this.#store.receiveUpload(ticket, request);
      if (attachment.size !== expectedLength) {
        throw new SharedUploadError("content_length_mismatch", "HTTP Content-Length 与实际文件大小不一致。");
      }
      sendJson(response, 201, { attachment });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/leases") {
      const body = await readJsonObject(request);
      const lease = await this.#store.createLease({
        caller: requireCaller(body.caller),
        projectId: requireString(body.projectId, "项目 ID", 1_024),
        sessionId: requireString(body.sessionId, "会话 ID", 1_024),
      }, requireString(body.ownerId, "租约所有者", 1_024), requireStringArray(body.attachmentIds));
      sendJson(response, 201, { lease });
      return;
    }
    const leaseMatch = /^\/v1\/leases\/([0-9a-f-]{36})\/(renew|release)$/u.exec(url.pathname);
    if (request.method === "POST" && leaseMatch) {
      const body = await readJsonObject(request);
      const leaseId = leaseMatch[1]!;
      const ownerId = requireString(body.ownerId, "租约所有者", 1_024);
      if (leaseMatch[2] === "renew") {
        sendJson(response, 200, this.#store.renewLease(leaseId, ownerId));
      } else {
        this.#store.releaseLease(leaseId, ownerId);
        sendJson(response, 200, { released: true });
      }
      return;
    }
    throw new SharedUploadError("not_found", "共享上传接口不存在。", 404);
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let info;
  try {
    info = await lstat(socketPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  if (!info.isSocket()) {
    throw new Error(`共享上传 socket 路径已被其他文件占用：${socketPath}`);
  }
  const connected = await canConnect(socketPath);
  if (connected) throw new Error(`共享上传 socket 已有服务监听：${socketPath}`);
  await rm(socketPath);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: Socket | null = createConnection(socketPath);
    socket.once("connect", () => {
      socket?.destroy();
      socket = null;
      resolve(true);
    });
    socket.once("error", () => {
      socket?.destroy();
      socket = null;
      resolve(false);
    });
  });
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.byteLength;
    if (length > MAX_JSON_BODY_BYTES) {
      throw new SharedUploadError("json_too_large", "请求正文太大。", 413);
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SharedUploadError("invalid_json", "请求正文不是有效 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SharedUploadError("invalid_json", "请求正文必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function requireCaller(value: unknown) {
  if (!isSharedUploadCaller(value)) {
    throw new SharedUploadError("invalid_caller", "上传调用方无法识别。");
  }
  return value;
}

function requireString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) {
    throw new SharedUploadError("invalid_field", `${label}无效。`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SharedUploadError("invalid_field", `${label}无效。`);
  }
  return value;
}

function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SharedUploadError("invalid_attachments", "附件 ID 列表无效。");
  }
  return value;
}

function requireHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value) {
    throw new SharedUploadError("missing_ticket", "请求缺少上传票据。", 401);
  }
  return value;
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": randomUUID(),
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const known = error instanceof SharedUploadError
    ? error
    : new SharedUploadError("internal_error", "共享上传服务发生内部错误。", 500);
  if (!(error instanceof SharedUploadError)) console.error(error);
  sendJson(response, known.status, { error: { code: known.code, message: known.message } });
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
