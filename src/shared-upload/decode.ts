import path from "node:path";

import {
  type AttachmentBinding,
  type AttachmentLease,
  MAX_UPLOAD_BYTES,
  type PublicAttachment,
  type ResolvedAttachment,
  SHARED_UPLOAD_CALLERS,
  SharedUploadError,
  type SharedUploadCaller,
  type UploadTicket,
} from "./types.ts";

/**
 * 共享上传服务是另一个仓库。这里把它的 `/v1` 响应当作不可信输入：逐字段解码、只投影
 * 已声明字段，并核对与请求的绑定。任何不一致都在进入浏览器、SQLite 或 Codex 之前失败。
 */
export class SharedUploadProtocolError extends SharedUploadError {
  readonly detail: string;

  constructor(detail: string) {
    super("invalid_response", "共享上传服务返回了无效响应。", 502);
    this.detail = detail;
  }
}

export function decodeTicket(
  value: unknown,
  expected: AttachmentBinding & { expectedSize: number },
): UploadTicket {
  const object = record(value, "ticket");
  const attachment = record(object.attachment, "ticket.attachment");
  const decoded: UploadTicket = {
    ticket: nonEmptyString(object.ticket, "ticket.ticket"),
    expiresAtMs: timestamp(object.expiresAtMs, "ticket.expiresAtMs"),
    attachment: {
      ...binding(attachment, "ticket.attachment"),
      originalName: nonEmptyString(attachment.originalName, "ticket.attachment.originalName"),
      declaredMime: nonEmptyString(attachment.declaredMime, "ticket.attachment.declaredMime"),
      expectedSize: size(attachment.expectedSize, "ticket.attachment.expectedSize"),
    },
  };
  assertBinding(decoded.attachment, expected, "ticket.attachment");
  if (decoded.attachment.expectedSize !== expected.expectedSize) {
    throw new SharedUploadProtocolError("ticket.attachment.expectedSize 与请求不一致");
  }
  return decoded;
}

export function decodeUploadResponse(value: unknown): PublicAttachment {
  return decodePublicAttachment(record(value, "upload").attachment, "upload.attachment");
}

/** 公开附件只保留这些字段；未声明的字段（包括任何路径别名）一律丢弃。 */
export function decodePublicAttachment(value: unknown, label = "attachment"): PublicAttachment {
  const object = record(value, label);
  const kind = object.kind;
  if (kind !== "image" && kind !== "file") {
    throw new SharedUploadProtocolError(`${label}.kind 无效`);
  }
  const sha256 = nonEmptyString(object.sha256, `${label}.sha256`);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new SharedUploadProtocolError(`${label}.sha256 无效`);
  }
  return {
    id: nonEmptyString(object.id, `${label}.id`),
    ...binding(object, label),
    originalName: nonEmptyString(object.originalName, `${label}.originalName`),
    declaredMime: nonEmptyString(object.declaredMime, `${label}.declaredMime`),
    detectedMime: nonEmptyString(object.detectedMime, `${label}.detectedMime`),
    kind,
    size: size(object.size, `${label}.size`),
    sha256,
    createdAtMs: timestamp(object.createdAtMs, `${label}.createdAtMs`),
    expiresAtMs: timestamp(object.expiresAtMs, `${label}.expiresAtMs`),
  };
}

/** 在已经解码的 lease 之外，本仓库其他地方也用它把私有附件投影成公开对象。 */
export function publicAttachmentOf(attachment: PublicAttachment): PublicAttachment {
  return {
    id: attachment.id,
    caller: attachment.caller,
    projectId: attachment.projectId,
    sessionId: attachment.sessionId,
    originalName: attachment.originalName,
    declaredMime: attachment.declaredMime,
    detectedMime: attachment.detectedMime,
    kind: attachment.kind,
    size: attachment.size,
    sha256: attachment.sha256,
    createdAtMs: attachment.createdAtMs,
    expiresAtMs: attachment.expiresAtMs,
  };
}

/** 只读出 leaseId，供解码失败时释放这份租约。 */
export function leaseIdOf(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.lease)) return null;
  const leaseId = value.lease.leaseId;
  return typeof leaseId === "string" && leaseId ? leaseId : null;
}

export function decodeLeaseResponse(
  value: unknown,
  expected: AttachmentBinding,
  ownerId: string,
  attachmentIds: readonly string[],
): AttachmentLease {
  const lease = record(record(value, "lease response").lease, "lease");
  const leaseOwner = nonEmptyString(lease.ownerId, "lease.ownerId");
  if (leaseOwner !== ownerId) throw new SharedUploadProtocolError("lease.ownerId 与请求不一致");
  if (!Array.isArray(lease.attachments)) {
    throw new SharedUploadProtocolError("lease.attachments 不是数组");
  }
  const byId = new Map<string, ResolvedAttachment>();
  lease.attachments.forEach((entry, index) => {
    const label = `lease.attachments[${index}]`;
    const publicValue = decodePublicAttachment(entry, label);
    assertBinding(publicValue, expected, label);
    if (byId.has(publicValue.id)) {
      throw new SharedUploadProtocolError(`${label}.id 重复`);
    }
    const attachmentPath = nonEmptyString(record(entry, label).path, `${label}.path`);
    if (!path.isAbsolute(attachmentPath)) {
      throw new SharedUploadProtocolError(`${label}.path 不是绝对路径`);
    }
    byId.set(publicValue.id, { ...publicValue, path: attachmentPath });
  });
  // 服务端按首次出现去重；这里要求返回的 ID 集合与请求完全相同，并按请求顺序排列。
  const requested = [...new Set(attachmentIds)];
  if (byId.size !== requested.length || requested.some((id) => !byId.has(id))) {
    throw new SharedUploadProtocolError("lease.attachments 与请求的附件 ID 集合不一致");
  }
  return {
    leaseId: nonEmptyString(lease.leaseId, "lease.leaseId"),
    ownerId: leaseOwner,
    expiresAtMs: timestamp(lease.expiresAtMs, "lease.expiresAtMs"),
    attachments: requested.map((id) => byId.get(id)!),
  };
}

export function decodeRenewResponse(
  value: unknown,
  leaseId: string,
): { leaseId: string; expiresAtMs: number } {
  const object = record(value, "renew");
  if (object.leaseId !== leaseId) {
    throw new SharedUploadProtocolError("renew.leaseId 与请求不一致");
  }
  return { leaseId, expiresAtMs: timestamp(object.expiresAtMs, "renew.expiresAtMs") };
}

export function decodeHealth(value: unknown): { status: string } {
  return { status: nonEmptyString(record(value, "health").status, "health.status") };
}

function binding(object: Record<string, unknown>, label: string): AttachmentBinding {
  const caller = object.caller;
  if (typeof caller !== "string" ||
      !(SHARED_UPLOAD_CALLERS as readonly string[]).includes(caller)) {
    throw new SharedUploadProtocolError(`${label}.caller 无效`);
  }
  return {
    caller: caller as SharedUploadCaller,
    projectId: nonEmptyString(object.projectId, `${label}.projectId`),
    sessionId: nonEmptyString(object.sessionId, `${label}.sessionId`),
  };
}

function assertBinding(actual: AttachmentBinding, expected: AttachmentBinding, label: string): void {
  for (const key of ["caller", "projectId", "sessionId"] as const) {
    if (actual[key] !== expected[key]) {
      throw new SharedUploadProtocolError(`${label}.${key} 与请求不一致`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SharedUploadProtocolError(`${label} 不是对象`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new SharedUploadProtocolError(`${label} 不是非空字符串`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SharedUploadProtocolError(`${label} 不是有效时间`);
  }
  return value;
}

function size(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < 0 || value > MAX_UPLOAD_BYTES) {
    throw new SharedUploadProtocolError(`${label} 不是有效大小`);
  }
  return value;
}
