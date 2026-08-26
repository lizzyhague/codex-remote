export const SHARED_UPLOAD_CALLERS = ["codex", "grok", "claude"] as const;

export type SharedUploadCaller = typeof SHARED_UPLOAD_CALLERS[number];

export const MAX_UPLOAD_BYTES = 25 * 1_048_576;
export const DEFAULT_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_PART_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_MIN_FREE_BYTES = 1_024 * 1_048_576;

export type AttachmentBinding = {
  caller: SharedUploadCaller;
  projectId: string;
  sessionId: string;
};

export type AttachmentKind = "image" | "file";

/** Safe to return to a browser. Deliberately excludes every server path. */
export type PublicAttachment = AttachmentBinding & {
  id: string;
  originalName: string;
  declaredMime: string;
  detectedMime: string;
  kind: AttachmentKind;
  size: number;
  sha256: string;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Only local Remote adapters receive this shape. Never serialize it to a browser. */
export type ResolvedAttachment = PublicAttachment & {
  path: string;
};

export type UploadTicket = {
  ticket: string;
  expiresAtMs: number;
  attachment: Pick<
    PublicAttachment,
    "caller" | "projectId" | "sessionId" | "originalName" | "declaredMime"
  > & { expectedSize: number };
};

export type AttachmentLease = {
  leaseId: string;
  ownerId: string;
  expiresAtMs: number;
  attachments: ResolvedAttachment[];
};

export class SharedUploadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SharedUploadError";
    this.code = code;
    this.status = status;
  }
}

export function isSharedUploadCaller(value: unknown): value is SharedUploadCaller {
  return typeof value === "string" &&
    (SHARED_UPLOAD_CALLERS as readonly string[]).includes(value);
}
