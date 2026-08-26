import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SharedUploadClient } from "../shared-upload/client.ts";
import { MAX_UPLOAD_BYTES, SharedUploadError } from "../shared-upload/types.ts";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import {
  BrowserConnection,
  type BrowserConnectionServices,
  type BrowserSocket,
} from "./connection.ts";
import { MAX_BROWSER_MESSAGE_BYTES } from "./protocol.ts";

export type RemoteServerAddress = {
  host: "127.0.0.1";
  port: number;
};

export type RemoteWebSocketServerOptions = {
  token: string;
  services: BrowserConnectionServices;
  /** 最后一个使用过 thread writer 的浏览器完成断线清理后调用。 */
  onWritersIdle?: () => Promise<void>;
  authTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** 额外允许的浏览器 Origin。与 Host 同源的请求始终允许。 */
  allowedOrigins?: string[];
  webRoot?: string;
  uploads?: Pick<SharedUploadClient, "upload">;
};

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../public/", import.meta.url));

/** 没有回 pong 的连接会被判定为已断开，用于准确执行离线审批宽限规则。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** 浏览器长时间不读数据时的发送缓冲上限，超过就断开，避免后端内存无界增长。 */
const MAX_OUTBOUND_BUFFER_BYTES = 16 * 1_048_576;

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/boot.js": { file: "boot.js", contentType: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", contentType: "text/javascript; charset=utf-8" },
  "/slash-menu.js": { file: "slash-menu.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/manifest.webmanifest": {
    file: "manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  },
  "/icon.svg": { file: "icon.svg", contentType: "image/svg+xml; charset=utf-8" },
  "/sw.js": { file: "sw.js", contentType: "text/javascript; charset=utf-8" },
};

/** 浏览器入口。它只绑定回环地址，公网/Tailscale 配置不属于这一层。 */
export class RemoteWebSocketServer {
  readonly #token: string;
  readonly #services: BrowserConnectionServices;
  readonly #onWritersIdle: (() => Promise<void>) | null;
  readonly #authTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #webRoot: string;
  readonly #uploads: RemoteWebSocketServerOptions["uploads"];
  readonly #http: Server;
  readonly #webSockets: WebSocketServer;
  readonly #connections = new Map<WebSocket, BrowserConnection>();
  #disconnecting = 0;
  #writerReleaseNeeded = false;
  #idleTransition: Promise<void> = Promise.resolve();
  #listening = false;

  constructor(options: RemoteWebSocketServerOptions) {
    if (!options.token) {
      throw new Error("WebSocket 访问令牌不能为空。");
    }
    this.#token = options.token;
    this.#services = options.services;
    this.#onWritersIdle = options.onWritersIdle ?? null;
    this.#authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.#webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
    this.#uploads = options.uploads;
    this.#http = createServer((request, response) => {
      void this.#serveHttp(request, response);
    });
    this.#webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BROWSER_MESSAGE_BYTES,
      perMessageDeflate: false,
    });

    this.#http.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      // WebSocket 不受同源策略保护：没有这一步，用户浏览的任何网站都能向
      // 本机或 tailnet 上的这个端口发起连接。令牌仍是主要防线，这是第二层。
      if (!this.#originAllowed(request)) {
        console.warn(
          `拒绝了来源不匹配的 WebSocket 升级请求：origin=${
            String(request.headers.origin)
          } host=${String(request.headers.host)}。` +
            "如果这是你自己的入口，请把它加入 CODEX_REMOTE_ALLOWED_ORIGINS。",
        );
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#webSockets.emit("connection", webSocket, request);
      });
    });
    this.#webSockets.on("connection", (webSocket) => {
      this.#accept(webSocket);
    });
  }

  async #serveHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"status":"ok"}\n');
      return;
    }
    if (pathname === "/attachments/upload") {
      await this.#receiveUpload(request, response);
      return;
    }
    await this.#serveWebFile(request, response);
  }

  async #receiveUpload(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      response.end('{"error":{"code":"method_not_allowed","message":"只允许 POST 上传。"}}\n');
      return;
    }
    if (!this.#originAllowed(request)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":{"code":"origin_forbidden","message":"上传来源不匹配。"}}\n');
      return;
    }
    if (!this.#uploads) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":{"code":"uploads_unavailable","message":"附件服务没有启用。"}}\n');
      return;
    }
    const ticket = request.headers["x-upload-ticket"];
    const contentLength = parseUploadLength(request.headers["content-length"]);
    if (typeof ticket !== "string" || !ticket) {
      sendUploadError(response, new SharedUploadError("missing_ticket", "请求缺少上传票据。", 401));
      return;
    }
    if (contentLength === null) {
      sendUploadError(response, new SharedUploadError(
        "invalid_content_length",
        "上传必须提供有效的 Content-Length。",
        411,
      ));
      return;
    }
    if (contentLength > MAX_UPLOAD_BYTES) {
      sendUploadError(response, new SharedUploadError("file_too_large", "单个文件不能超过 25 MiB。", 413));
      return;
    }
    try {
      const attachment = await this.#uploads.upload(ticket, contentLength, request);
      const body = Buffer.from(`${JSON.stringify({ attachment })}\n`);
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
        "content-length": body.byteLength,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
    } catch (error) {
      sendUploadError(response, error);
    }
  }

  async #serveWebFile(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        "allow": "GET, HEAD",
      });
      response.end("Method not allowed\n");
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const asset = STATIC_FILES[pathname];
    if (!asset) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    try {
      const body = await readFile(path.join(this.#webRoot, asset.file));
      response.writeHead(200, {
        "content-type": asset.contentType,
        "content-length": body.byteLength,
        "cache-control": pathname === "/sw.js" ? "no-cache" : "no-cache, must-revalidate",
        "content-security-policy": [
          "default-src 'self'",
          "connect-src 'self' ws: wss:",
          "img-src 'self' data:",
          "style-src 'self'",
          "script-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
        "x-content-type-options": "nosniff",
        ...(pathname === "/sw.js" ? { "service-worker-allowed": "/" } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    }
  }

  listen(port: number): Promise<RemoteServerAddress> {
    if (this.#listening) {
      return Promise.reject(new Error("WebSocket 服务已经启动。"));
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.#http.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#http.off("error", onError);
        this.#listening = true;
        const address = this.#http.address() as AddressInfo;
        resolve({ host: "127.0.0.1", port: address.port });
      };
      this.#http.once("error", onError);
      this.#http.once("listening", onListening);
      this.#http.listen(port, "127.0.0.1");
    });
  }

  async close(): Promise<void> {
    if (!this.#listening) {
      return;
    }
    this.#listening = false;

    const httpClosed = new Promise<void>((resolve, reject) => {
      this.#http.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([...this.#connections.values()].map((connection) =>
      connection.disconnect()
    ));
    for (const webSocket of this.#connections.keys()) {
      webSocket.terminate();
    }
    this.#connections.clear();
    await new Promise<void>((resolve) => this.#webSockets.close(() => resolve()));
    await httpClosed;
  }

  #originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    // 冒烟脚本和命令行客户端不会发 Origin；只有浏览器才发。
    if (typeof origin !== "string" || !origin) {
      return true;
    }
    if (this.#allowedOrigins.has(origin)) {
      return true;
    }

    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (!originHost) {
      return false;
    }
    // Tailscale Serve 这类反向代理会保留 Host，或者用 X-Forwarded-Host 传递。
    return [request.headers.host, request.headers["x-forwarded-host"]]
      .flatMap((value) => typeof value === "string" ? value.split(",") : [])
      .map((value) => value.trim().toLowerCase())
      .includes(originHost);
  }

  #accept(webSocket: WebSocket): void {
    const socket: BrowserSocket = {
      send: (data) => {
        if (webSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        // 手机锁屏或网络极慢时，浏览器可能长时间不读数据。放任 ws 无界缓冲
        // 会把后端内存吃光，这里宁可断开让前端重连。
        if (webSocket.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
          webSocket.close(1013, "Client too slow");
          return;
        }
        webSocket.send(data);
      },
      close: (code, reason) => webSocket.close(code, reason),
    };
    const connection = new BrowserConnection(
      randomUUID(),
      socket,
      this.#token,
      this.#services,
    );
    this.#connections.set(webSocket, connection);

    const authTimer = setTimeout(() => {
      if (!connection.authenticated) {
        webSocket.close(1008, "Authentication timeout");
      }
    }, this.#authTimeoutMs);
    authTimer.unref();

    // 手机换网络或息屏时 TCP 常常只是半开：不发心跳的话，后端要等到内核超时
    // 才会发现连接已死，也就无法准确判断何时进入离线审批宽限期。
    let responsive = true;
    webSocket.on("pong", () => {
      responsive = true;
    });
    const heartbeatTimer = setInterval(() => {
      if (!responsive) {
        webSocket.terminate();
        return;
      }
      responsive = false;
      webSocket.ping();
    }, this.#heartbeatIntervalMs);
    heartbeatTimer.unref();

    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        webSocket.close(1003, "Text messages only");
        return;
      }
      connection.receiveText(rawDataToString(data));
    });
    webSocket.once("close", () => {
      clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      this.#connections.delete(webSocket);
      this.#disconnecting += 1;
      void connection.disconnect().then((result) => {
        this.#writerReleaseNeeded ||= result.usedThreadWriter;
      }).catch((error: unknown) => {
        console.error(
          `浏览器断线清理失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        this.#disconnecting -= 1;
        this.#scheduleWriterRelease();
      });
    });
  }

  #scheduleWriterRelease(): void {
    if (
      !this.#listening || !this.#onWritersIdle || !this.#writerReleaseNeeded ||
      this.#connections.size > 0 || this.#disconnecting > 0
    ) {
      return;
    }

    this.#writerReleaseNeeded = false;
    const transition = this.#idleTransition.then(async () => {
      // 排队期间如果浏览器已经重连，保留标记，等下一次真正空闲再释放。
      if (!this.#listening) return;
      if (this.#connections.size > 0 || this.#disconnecting > 0) {
        this.#writerReleaseNeeded = true;
        return;
      }
      await this.#onWritersIdle?.();
    });
    this.#idleTransition = transition.catch((error: unknown) => {
      console.error(
        `释放 Codex 会话 writer 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

function parseUploadLength(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sendUploadError(response: ServerResponse, error: unknown): void {
  const known = error instanceof SharedUploadError
    ? error
    : new SharedUploadError("upload_failed", "附件上传失败。", 500);
  if (!(error instanceof SharedUploadError)) console.error(error);
  const body = Buffer.from(`${JSON.stringify({
    error: { code: known.code, message: known.message },
  })}\n`);
  response.writeHead(known.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
