import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_ATTACHMENT_RETENTION_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MIN_FREE_BYTES,
  DEFAULT_PART_TTL_MS,
  DEFAULT_TICKET_TTL_MS,
  MAX_UPLOAD_BYTES,
  type AttachmentBinding,
  type AttachmentLease,
  type PublicAttachment,
  type ResolvedAttachment,
  SharedUploadError,
  type SharedUploadCaller,
  type UploadTicket,
} from "./types.ts";
import type { SharedUploadPaths } from "./paths.ts";

export type SharedUploadStoreOptions = {
  paths: SharedUploadPaths;
  maxUploadBytes?: number;
  minFreeBytes?: number;
  retentionMs?: number;
  ticketTtlMs?: number;
  partTtlMs?: number;
  leaseTtlMs?: number;
  now?: () => number;
};

type ClaimedTicket = AttachmentBinding & {
  originalName: string;
  declaredMime: string;
  expectedSize: number;
};

export type CleanupResult = {
  attachments: number;
  orphans: number;
  parts: number;
  tickets: number;
  leases: number;
};

export class SharedUploadStore {
  readonly #paths: SharedUploadPaths;
  readonly #database: DatabaseSync;
  readonly #maxUploadBytes: number;
  readonly #minFreeBytes: number;
  readonly #retentionMs: number;
  readonly #ticketTtlMs: number;
  readonly #partTtlMs: number;
  readonly #leaseTtlMs: number;
  readonly #now: () => number;

  private constructor(options: Required<SharedUploadStoreOptions>, database: DatabaseSync) {
    this.#paths = options.paths;
    this.#database = database;
    this.#maxUploadBytes = options.maxUploadBytes;
    this.#minFreeBytes = options.minFreeBytes;
    this.#retentionMs = options.retentionMs;
    this.#ticketTtlMs = options.ticketTtlMs;
    this.#partTtlMs = options.partTtlMs;
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#now = options.now;
  }

  static async open(options: SharedUploadStoreOptions): Promise<SharedUploadStore> {
    const resolved: Required<SharedUploadStoreOptions> = {
      paths: options.paths,
      maxUploadBytes: positiveInteger(options.maxUploadBytes, MAX_UPLOAD_BYTES),
      minFreeBytes: nonnegativeInteger(options.minFreeBytes, DEFAULT_MIN_FREE_BYTES),
      retentionMs: positiveInteger(options.retentionMs, DEFAULT_ATTACHMENT_RETENTION_MS),
      ticketTtlMs: positiveInteger(options.ticketTtlMs, DEFAULT_TICKET_TTL_MS),
      partTtlMs: positiveInteger(options.partTtlMs, DEFAULT_PART_TTL_MS),
      leaseTtlMs: positiveInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS),
      now: options.now ?? Date.now,
    };
    await mkdir(resolved.paths.root, { recursive: true, mode: 0o700 });
    await mkdir(resolved.paths.blobs, { recursive: true, mode: 0o700 });
    await mkdir(resolved.paths.parts, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(resolved.paths.root, 0o700),
      chmod(resolved.paths.blobs, 0o700),
      chmod(resolved.paths.parts, 0o700),
    ]);
    await Promise.all([
      assertPrivateDirectory(resolved.paths.root),
      assertPrivateDirectory(resolved.paths.blobs),
      assertPrivateDirectory(resolved.paths.parts),
    ]);

    const database = new DatabaseSync(resolved.paths.database);
    await chmod(resolved.paths.database, 0o600);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS upload_tickets (
        token_hash TEXT PRIMARY KEY,
        caller TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        declared_mime TEXT NOT NULL,
        expected_size INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        claimed_at_ms INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS upload_tickets_expiry
        ON upload_tickets(expires_at_ms);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        caller TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL UNIQUE,
        declared_mime TEXT NOT NULL,
        detected_mime TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachments_binding
        ON attachments(caller, project_id, session_id, id);
      CREATE INDEX IF NOT EXISTS attachments_expiry
        ON attachments(expires_at_ms);
      CREATE TABLE IF NOT EXISTS attachment_leases (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        caller TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachment_leases_expiry
        ON attachment_leases(expires_at_ms);
      CREATE TABLE IF NOT EXISTS attachment_lease_items (
        lease_id TEXT NOT NULL REFERENCES attachment_leases(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        PRIMARY KEY (lease_id, attachment_id)
      ) STRICT;
    `);
    return new SharedUploadStore(resolved, database);
  }

  get paths(): SharedUploadPaths {
    return this.#paths;
  }

  createTicket(input: AttachmentBinding & {
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }): UploadTicket {
    requireIdentifier(input.projectId, "项目 ID");
    requireIdentifier(input.sessionId, "会话 ID");
    if (!Number.isInteger(input.expectedSize) || input.expectedSize < 0) {
      throw new SharedUploadError("invalid_size", "文件大小必须是非负整数。");
    }
    if (input.expectedSize > this.#maxUploadBytes) {
      throw new SharedUploadError("file_too_large", "单个文件不能超过 25 MiB。", 413);
    }
    const originalName = safeOriginalName(input.originalName);
    const declaredMime = safeMime(input.declaredMime);
    const nowMs = this.#now();
    const expiresAtMs = nowMs + this.#ticketTtlMs;
    const ticket = randomBytes(32).toString("base64url");
    this.#database.prepare(`
      INSERT INTO upload_tickets (
        token_hash, caller, project_id, session_id, original_name, declared_mime,
        expected_size, created_at_ms, expires_at_ms, claimed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      ticketHash(ticket),
      input.caller,
      input.projectId,
      input.sessionId,
      originalName,
      declaredMime,
      input.expectedSize,
      nowMs,
      expiresAtMs,
    );
    return {
      ticket,
      expiresAtMs,
      attachment: {
        caller: input.caller,
        projectId: input.projectId,
        sessionId: input.sessionId,
        originalName,
        declaredMime,
        expectedSize: input.expectedSize,
      },
    };
  }

  async receiveUpload(ticket: string, source: IncomingMessage | AsyncIterable<Uint8Array>): Promise<PublicAttachment> {
    const claimed = this.#claimTicket(ticket);
    await this.#assertDiskAvailable(claimed.expectedSize);
    const attachmentId = randomUUID();
    const partPath = path.join(this.#paths.parts, `${attachmentId}.part`);
    const handle = await open(partPath, "wx", 0o600);
    const hash = createHash("sha256");
    const headerChunks: Buffer[] = [];
    let headerBytes = 0;
    let received = 0;
    try {
      for await (const rawChunk of source) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        received += chunk.byteLength;
        if (received > claimed.expectedSize || received > this.#maxUploadBytes) {
          throw new SharedUploadError("file_too_large", "收到的文件超过声明大小或 25 MiB 上限。", 413);
        }
        if (headerBytes < 512) {
          const slice = chunk.subarray(0, 512 - headerBytes);
          headerChunks.push(slice);
          headerBytes += slice.byteLength;
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
          if (result.bytesWritten <= 0) throw new Error("附件临时文件写入没有取得进展。");
          offset += result.bytesWritten;
        }
      }
      if (received !== claimed.expectedSize) {
        throw new SharedUploadError("size_mismatch", "实际收到的文件大小与上传票据不一致。", 400);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(partPath, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();

    const detected = detectFileType(Buffer.concat(headerChunks), claimed.originalName, claimed.declaredMime);
    const shard = attachmentId.slice(0, 2);
    const blobDirectory = path.join(this.#paths.blobs, shard);
    await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    await chmod(blobDirectory, 0o700);
    await assertPrivateDirectory(blobDirectory);
    const storedPath = path.join(blobDirectory, `${attachmentId}${detected.extension}`);
    await rename(partPath, storedPath);
    await chmod(storedPath, 0o600);

    const createdAtMs = this.#now();
    const attachment: ResolvedAttachment = {
      id: attachmentId,
      caller: claimed.caller,
      projectId: claimed.projectId,
      sessionId: claimed.sessionId,
      originalName: claimed.originalName,
      path: storedPath,
      declaredMime: claimed.declaredMime,
      detectedMime: detected.mime,
      kind: detected.kind,
      size: received,
      sha256: hash.digest("hex"),
      createdAtMs,
      expiresAtMs: createdAtMs + this.#retentionMs,
    };
    try {
      this.#database.prepare(`
        INSERT INTO attachments (
          id, caller, project_id, session_id, original_name, stored_path,
          declared_mime, detected_mime, kind, size, sha256, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachment.id,
        attachment.caller,
        attachment.projectId,
        attachment.sessionId,
        attachment.originalName,
        attachment.path,
        attachment.declaredMime,
        attachment.detectedMime,
        attachment.kind,
        attachment.size,
        attachment.sha256,
        attachment.createdAtMs,
        attachment.expiresAtMs,
      );
    } catch (error) {
      await rm(storedPath, { force: true }).catch(() => {});
      throw error;
    }
    return publicAttachment(attachment);
  }

  async createLease(
    binding: AttachmentBinding,
    ownerId: string,
    attachmentIds: string[],
  ): Promise<AttachmentLease> {
    requireIdentifier(ownerId, "租约所有者");
    const ids = uniqueAttachmentIds(attachmentIds);
    if (ids.length === 0) {
      throw new SharedUploadError("attachments_required", "附件列表不能为空。");
    }
    const nowMs = this.#now();
    const attachments = ids.map((id) => {
      const row = this.#database.prepare(`
        SELECT * FROM attachments
        WHERE id = ? AND caller = ? AND project_id = ? AND session_id = ?
          AND expires_at_ms > ?
      `).get(id, binding.caller, binding.projectId, binding.sessionId, nowMs);
      if (!row) {
        throw new SharedUploadError(
          "attachment_unavailable",
          `附件 ${id} 不存在、已过期或不属于当前会话。`,
          404,
        );
      }
      return readAttachment(row);
    });
    for (const attachment of attachments) await assertSafeStoredFile(this.#paths.blobs, attachment.path);

    const leaseId = randomUUID();
    const expiresAtMs = nowMs + this.#leaseTtlMs;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO attachment_leases (
          id, owner_id, caller, project_id, session_id, created_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        leaseId,
        ownerId,
        binding.caller,
        binding.projectId,
        binding.sessionId,
        nowMs,
        expiresAtMs,
      );
      const insert = this.#database.prepare(`
        INSERT INTO attachment_lease_items (lease_id, attachment_id) VALUES (?, ?)
      `);
      for (const id of ids) insert.run(leaseId, id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return { leaseId, ownerId, expiresAtMs, attachments };
  }

  renewLease(leaseId: string, ownerId: string): { leaseId: string; expiresAtMs: number } {
    const expiresAtMs = this.#now() + this.#leaseTtlMs;
    const result = this.#database.prepare(`
      UPDATE attachment_leases SET expires_at_ms = ?
      WHERE id = ? AND owner_id = ? AND expires_at_ms > ?
    `).run(expiresAtMs, leaseId, ownerId, this.#now());
    if (Number(result.changes) !== 1) {
      throw new SharedUploadError("lease_unavailable", "附件租约不存在或已经过期。", 404);
    }
    return { leaseId, expiresAtMs };
  }

  releaseLease(leaseId: string, ownerId: string): void {
    this.#database.prepare(
      "DELETE FROM attachment_leases WHERE id = ? AND owner_id = ?",
    ).run(leaseId, ownerId);
  }

  async cleanup(): Promise<CleanupResult> {
    const nowMs = this.#now();
    const expiredLeaseCount = Number(this.#database.prepare(
      "DELETE FROM attachment_leases WHERE expires_at_ms <= ?",
    ).run(nowMs).changes);
    const ticketCount = Number(this.#database.prepare(
      "DELETE FROM upload_tickets WHERE expires_at_ms <= ? OR claimed_at_ms IS NOT NULL",
    ).run(nowMs).changes);
    const expiredRows = this.#database.prepare(`
      SELECT * FROM attachments AS attachment
      WHERE attachment.expires_at_ms <= ?
        AND NOT EXISTS (
          SELECT 1 FROM attachment_lease_items AS item
          JOIN attachment_leases AS lease ON lease.id = item.lease_id
          WHERE item.attachment_id = attachment.id AND lease.expires_at_ms > ?
        )
    `).all(nowMs, nowMs).map(readAttachment);
    let attachments = 0;
    for (const attachment of expiredRows) {
      try {
        await assertSafeStoredFile(this.#paths.blobs, attachment.path);
        await rm(attachment.path, { force: true });
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      this.#database.prepare("DELETE FROM attachments WHERE id = ?").run(attachment.id);
      attachments += 1;
    }

    let parts = 0;
    const entries = await readdir(this.#paths.parts, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
      const partPath = path.join(this.#paths.parts, entry.name);
      const info = await stat(partPath);
      if (info.mtimeMs + this.#partTtlMs > nowMs) continue;
      await rm(partPath, { force: true });
      parts += 1;
    }
    const orphans = await this.#cleanupOrphanedBlobs(nowMs);
    return { attachments, orphans, parts, tickets: ticketCount, leases: expiredLeaseCount };
  }

  close(): void {
    this.#database.close();
  }

  #claimTicket(ticket: string): ClaimedTicket {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(ticket)) {
      throw new SharedUploadError("invalid_ticket", "上传票据无效。", 401);
    }
    const nowMs = this.#now();
    const hash = ticketHash(ticket);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`
        SELECT * FROM upload_tickets
        WHERE token_hash = ? AND claimed_at_ms IS NULL AND expires_at_ms > ?
      `).get(hash, nowMs);
      if (!row) {
        throw new SharedUploadError("ticket_unavailable", "上传票据不存在、已使用或已过期。", 401);
      }
      this.#database.prepare(
        "UPDATE upload_tickets SET claimed_at_ms = ? WHERE token_hash = ?",
      ).run(nowMs, hash);
      this.#database.exec("COMMIT");
      const value = asRow(row);
      return {
        caller: requireCaller(value.caller),
        projectId: String(value.project_id),
        sessionId: String(value.session_id),
        originalName: String(value.original_name),
        declaredMime: String(value.declared_mime),
        expectedSize: Number(value.expected_size),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async #assertDiskAvailable(expectedSize: number): Promise<void> {
    const info = await statfs(this.#paths.root);
    const available = Number(info.bavail) * Number(info.bsize);
    if (available - expectedSize < this.#minFreeBytes) {
      throw new SharedUploadError(
        "disk_low",
        "主机可用磁盘空间低于安全门槛，暂时停止新上传。",
        507,
      );
    }
  }

  async #cleanupOrphanedBlobs(nowMs: number): Promise<number> {
    let removed = 0;
    const shards = await readdir(this.#paths.blobs, { withFileTypes: true });
    for (const shard of shards) {
      if (!shard.isDirectory() || shard.isSymbolicLink()) continue;
      const directory = path.join(this.#paths.blobs, shard.name);
      await assertPrivateDirectory(directory);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const filePath = path.join(directory, entry.name);
        const tracked = this.#database.prepare(
          "SELECT 1 FROM attachments WHERE stored_path = ?",
        ).get(filePath);
        if (tracked) continue;
        const info = await stat(filePath);
        if (info.mtimeMs + this.#partTtlMs > nowMs) continue;
        await assertSafeStoredFile(this.#paths.blobs, filePath);
        await rm(filePath, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

function readAttachment(value: unknown): ResolvedAttachment {
  const row = asRow(value);
  return {
    id: String(row.id),
    caller: requireCaller(row.caller),
    projectId: String(row.project_id),
    sessionId: String(row.session_id),
    originalName: String(row.original_name),
    path: String(row.stored_path),
    declaredMime: String(row.declared_mime),
    detectedMime: String(row.detected_mime),
    kind: row.kind === "image" ? "image" : "file",
    size: Number(row.size),
    sha256: String(row.sha256),
    createdAtMs: Number(row.created_at_ms),
    expiresAtMs: Number(row.expires_at_ms),
  };
}

function publicAttachment(attachment: ResolvedAttachment): PublicAttachment {
  const { path: _path, ...publicValue } = attachment;
  return publicValue;
}

function safeOriginalName(value: string): string {
  if (typeof value !== "string") {
    throw new SharedUploadError("invalid_filename", "文件名无效。");
  }
  const name = path.basename(value.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .normalize("NFC")
    .trim();
  if (!name || name === "." || name === "..") {
    throw new SharedUploadError("invalid_filename", "文件名不能为空。");
  }
  return [...name].slice(0, 255).join("");
}

function safeMime(value: string): string {
  const mime = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime)
    ? mime.slice(0, 255)
    : "application/octet-stream";
}

function detectFileType(
  header: Buffer,
  originalName: string,
  declaredMime: string,
): { mime: string; extension: string; kind: "image" | "file" } {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mime: "image/png", extension: ".png", kind: "image" };
  }
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { mime: "image/jpeg", extension: ".jpg", kind: "image" };
  }
  const signature = header.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") {
    return { mime: "image/gif", extension: ".gif", kind: "image" };
  }
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", extension: ".webp", kind: "image" };
  }
  if (header.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { mime: "application/pdf", extension: ".pdf", kind: "file" };
  }
  const extension = safeExtension(originalName);
  const seemsText = !header.includes(0) &&
    (declaredMime.startsWith("text/") || TEXT_EXTENSIONS.has(extension));
  return {
    mime: seemsText ? detectedTextMime(declaredMime, extension) : "application/octet-stream",
    extension,
    kind: "file",
  };
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".log", ".xml", ".yaml",
  ".yml", ".toml", ".ini", ".cfg", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".html", ".htm", ".sh", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".sql",
]);

function detectedTextMime(declaredMime: string, extension: string): string {
  if (declaredMime !== "application/octet-stream") return declaredMime;
  if (extension === ".json" || extension === ".jsonl") return "application/json";
  if (extension === ".xml") return "application/xml";
  return "text/plain";
}

function safeExtension(originalName: string): string {
  const extension = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
}

function ticketHash(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function uniqueAttachmentIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw new SharedUploadError("invalid_attachments", "一次最多附加 100 个文件。");
  }
  const ids = values.map((value) => {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/u.test(value)) {
      throw new SharedUploadError("invalid_attachment_id", "附件 ID 格式无效。");
    }
    return value;
  });
  return [...new Set(ids)];
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 1_024 || /[\u0000-\u001f]/u.test(value)) {
    throw new SharedUploadError("invalid_binding", `${label}无效。`);
  }
}

function requireCaller(value: unknown): SharedUploadCaller {
  if (value === "codex" || value === "grok" || value === "claude") return value;
  throw new SharedUploadError("invalid_caller", "上传调用方无法识别。");
}

async function assertSafeStoredFile(root: string, filePath: string): Promise<void> {
  await assertPathInside(root, filePath);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SharedUploadError("attachment_unavailable", "附件落盘文件不是普通文件。", 404);
  }
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new SharedUploadError("unsafe_attachment_path", "附件路径超出了存储根目录。", 500);
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SharedUploadError(
      "unsafe_storage_directory",
      "附件存储目录不能是符号链接或普通文件。",
      500,
    );
  }
}

async function assertPathInside(root: string, filePath: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SharedUploadError("unsafe_attachment_path", "附件路径超出了存储根目录。", 500);
  }
}

function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SharedUploadError("invalid_state", "共享上传数据库包含无效记录。", 500);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function nonnegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? value! : fallback;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
