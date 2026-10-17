import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";

import {
  decodeHealth,
  decodeLeaseResponse,
  decodeRenewResponse,
  decodeTicket,
  decodeUploadResponse,
  leaseIdOf,
  SharedUploadProtocolError,
} from "./decode.ts";
import { resolveSharedUploadSocket } from "./paths.ts";
import {
  type AttachmentBinding,
  type AttachmentLease,
  type PublicAttachment,
  SharedUploadError,
  type UploadTicket,
} from "./types.ts";

const MAX_RESPONSE_BYTES = 1_048_576;

/** Total deadline for a regular JSON request, from sending it through receiving the complete response. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Total streaming upload deadline, matching the shared service ticket lifetime; uploads cannot succeed after expiry. */
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** Maximum time with no bytes in either socket direction during upload, including while awaiting the response. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export type SharedUploadClientOptions = {
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  idleTimeoutMs?: number;
};

/** Public messages for shared-service error codes. Original downstream text is written only to service logs. */
const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
  content_length_required: "上传必须提供 Content-Length。",
  content_length_mismatch: "上传大小与声明不一致。",
  size_mismatch: "实际收到的文件大小与上传票据不一致。",
  invalid_size: "文件大小无效。",
  file_too_large: "单个文件不能超过 25 MiB。",
  invalid_filename: "文件名无效。",
  missing_ticket: "请求缺少上传票据。",
  invalid_ticket: "上传票据无效。",
  ticket_unavailable: "上传票据不存在、已使用或已过期。",
  attachments_required: "附件列表不能为空。",
  invalid_attachments: "附件列表无效。",
  invalid_attachment_id: "附件 ID 格式无效。",
  attachment_unavailable: "附件不存在、已过期或不属于当前会话。",
  lease_unavailable: "附件租约不存在或已经过期。",
  disk_low: "主机可用磁盘空间不足，暂时不能上传。",
};

export class SharedUploadClient {
  readonly #socketPath: string;
  readonly #requestTimeoutMs: number;
  readonly #uploadTimeoutMs: number;
  readonly #idleTimeoutMs: number;

  constructor(
    socketPath = resolveSharedUploadSocket(),
    options: SharedUploadClientOptions = {},
  ) {
    this.#socketPath = socketPath;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async createTicket(input: AttachmentBinding & {
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }): Promise<UploadTicket> {
    const value = await this.#jsonRequest("POST", "/v1/tickets", input);
    return decoded(() => decodeTicket(value, input));
  }

  /**
   * Streams the browser request body to the shared service. A body interruption, `signal` cancellation,
   * idle timeout, or total deadline destroys the same downstream request and ends with `SharedUploadError`.
   */
  async upload(
    ticket: string,
    contentLength: number,
    source: IncomingMessage,
    signal?: AbortSignal,
  ): Promise<PublicAttachment> {
    const value = await this.#send({
      method: "POST",
      route: "/v1/uploads",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": contentLength,
        "x-upload-ticket": ticket,
      },
      source,
      signal,
      totalTimeoutMs: this.#uploadTimeoutMs,
    });
    return decoded(() => decodeUploadResponse(value));
  }

  async createLease(
    binding: AttachmentBinding,
    ownerId: string,
    attachmentIds: string[],
  ): Promise<AttachmentLease> {
    const value = await this.#jsonRequest(
      "POST",
      "/v1/leases",
      { ...binding, ownerId, attachmentIds },
    );
    try {
      return decoded(() => decodeLeaseResponse(value, binding, ownerId, attachmentIds));
    } catch (error) {
      // The server has already created the lease. If it cannot be passed to Codex, release it promptly;
      // if release fails, rely on its natural 15-minute expiry.
      const leaseId = leaseIdOf(value);
      if (leaseId) await this.releaseLease(leaseId, ownerId).catch(() => {});
      throw error;
    }
  }

  async renewLease(leaseId: string, ownerId: string): Promise<{ leaseId: string; expiresAtMs: number }> {
    const value = await this.#jsonRequest(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/renew`,
      { ownerId },
    );
    return decoded(() => decodeRenewResponse(value, leaseId));
  }

  async releaseLease(leaseId: string, ownerId: string): Promise<void> {
    await this.#jsonRequest("POST", `/v1/leases/${encodeURIComponent(leaseId)}/release`, { ownerId });
  }

  async health(): Promise<{ status: string }> {
    const value = await this.#jsonRequest("GET", "/healthz", undefined);
    return decoded(() => decodeHealth(value));
  }

  #jsonRequest(method: string, route: string, value: unknown): Promise<unknown> {
    const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
    return this.#send({
      method,
      route,
      headers: body
        ? { "content-type": "application/json", "content-length": body.byteLength }
        : undefined,
      body,
      totalTimeoutMs: this.#requestTimeoutMs,
    });
  }

  #send(options: {
    method: string;
    route: string;
    headers?: Record<string, string | number> | undefined;
    body?: Buffer | null;
    source?: IncomingMessage;
    signal?: AbortSignal | undefined;
    totalTimeoutMs: number;
  }): Promise<unknown> {
    const { source, signal } = options;
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | null = null;
      const finish = (error: SharedUploadError | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        signal?.removeEventListener("abort", onAbort);
        source?.off("error", onSourceError);
        source?.off("close", onSourceClose);
        if (error) {
          if (request) {
            source?.unpipe(request);
            request.destroy();
          }
          reject(error);
        } else {
          resolve(value);
        }
      };
      const onAbort = () => {
        const reason: unknown = signal?.reason;
        finish(reason instanceof SharedUploadError
          ? reason
          : new SharedUploadError("upload_cancelled", "上传已取消。", 400));
      };
      const onSourceError = () => finish(interruptedError());
      const onSourceClose = () => {
        if (!source?.complete) finish(interruptedError());
      };
      const totalTimer = setTimeout(() => {
        console.error(`共享上传服务请求超过总时限：${options.method} ${options.route}`);
        finish(timeoutError());
      }, options.totalTimeoutMs);

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      request = httpRequest({
        socketPath: this.#socketPath,
        path: options.route,
        method: options.method,
        headers: options.headers,
      }, (response) => {
        void collectResponse(response).then(
          (value) => finish(null, value),
          (error: unknown) => {
            if (settled) return;
            finish(error instanceof SharedUploadError
              ? error
              : connectionError(error instanceof Error ? error : new Error(String(error))));
          },
        );
      });
      // Another error may arrive after destroy(), so this cannot use once.
      request.on("error", (error) => {
        if (!settled) finish(connectionError(error));
      });
      request.setTimeout(this.#idleTimeoutMs, () => {
        if (settled) return;
        console.error(`共享上传服务请求长时间没有进展：${options.method} ${options.route}`);
        finish(timeoutError());
      });
      if (source) {
        source.once("error", onSourceError);
        source.once("close", onSourceClose);
        source.pipe(request);
      } else {
        request.end(options.body ?? undefined);
      }
    });
  }
}

function decoded<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof SharedUploadProtocolError) {
      console.error(`共享上传服务响应不符合 /v1 协议：${error.detail}`);
    }
    throw error;
  }
}

async function collectResponse(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      console.error("共享上传服务响应超过 1 MiB。");
      throw new SharedUploadError("response_too_large", "共享上传服务返回了过大的响应。", 502);
    }
    chunks.push(chunk);
  }
  let value: unknown = null;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Handle each status code below.
  }
  const status = response.statusCode ?? 502;
  if (status >= 400) throw downstreamError(value, status);
  if (status < 200 || status >= 300 || typeof value !== "object" || value === null ||
      Array.isArray(value)) {
    console.error(`共享上传服务返回了无效响应：HTTP ${status}`);
    throw new SharedUploadError("invalid_response", "共享上传服务返回了无效响应。", 502);
  }
  return value;
}

/** Keeps only the stable machine code; this repository defines public messages and logs the original text. */
function downstreamError(value: unknown, status: number): SharedUploadError {
  const error = typeof value === "object" && value !== null &&
      "error" in value && typeof value.error === "object" && value.error !== null
    ? value.error as Record<string, unknown>
    : null;
  const rawCode = typeof error?.code === "string" ? error.code : "";
  const code = /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode) ? rawCode : "upload_service_error";
  console.error(
    `共享上传服务返回错误 ${code}（HTTP ${status}）：${
      typeof error?.message === "string" ? error.message : "(无说明)"
    }`,
  );
  return new SharedUploadError(
    code,
    PUBLIC_ERROR_MESSAGES[code] ?? "共享上传服务拒绝了请求。",
    status >= 400 && status <= 599 ? status : 502,
  );
}

function timeoutError(): SharedUploadError {
  return new SharedUploadError("upload_service_timeout", "共享上传服务响应超时。", 504);
}

function interruptedError(): SharedUploadError {
  return new SharedUploadError("upload_interrupted", "浏览器中断了上传。", 400);
}

function connectionError(error: Error): SharedUploadError {
  console.error(`无法连接共享上传服务：${error.message}`);
  return new SharedUploadError(
    "upload_service_unavailable",
    "共享上传服务暂时不可用。",
    503,
  );
}
