const RECOVERY_VERSION = 1;

export class RecoveryStateError extends Error {
  constructor(code, message, { key = null, raw = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RecoveryStateError";
    this.code = code;
    this.key = key;
    this.raw = raw;
  }
}

export class RecoveryStateStore {
  #storage;
  #key;
  #legacy;
  #loaded = false;
  #state = null;
  #persisted = true;
  #lastError = null;

  constructor(storage, { key, legacy = {} }) {
    this.#storage = storage;
    this.#key = key;
    this.#legacy = legacy;
  }

  get persisted() {
    return this.#persisted;
  }

  get lastError() {
    return this.#lastError;
  }

  load() {
    return cloneRecoveryState(this.#loadInternal());
  }

  update(mutator, { retainOnFailure = true } = {}) {
    const previous = cloneRecoveryState(this.#loadInternal());
    const previousPersisted = this.#persisted;
    const next = cloneRecoveryState(previous);
    mutator(next);
    const normalized = normalizeRecoveryState(next);
    this.#state = normalized;
    try {
      this.#write(normalized);
      this.#persisted = true;
      this.#lastError = null;
      this.#removeLegacy();
      return { state: cloneRecoveryState(this.#state), persisted: true, committed: true };
    } catch (error) {
      if (!retainOnFailure) this.#state = previous;
      this.#persisted = retainOnFailure ? false : previousPersisted;
      this.#lastError = storageError(this.#key, error);
      return {
        state: cloneRecoveryState(this.#state),
        persisted: this.#persisted,
        committed: false,
      };
    }
  }

  ensurePersisted() {
    const state = this.#loadInternal();
    if (this.#persisted && !this.#lastError) return true;
    try {
      this.#write(state);
      this.#persisted = true;
      this.#lastError = null;
      this.#removeLegacy();
      return true;
    } catch (error) {
      this.#lastError = storageError(this.#key, error);
      return false;
    }
  }

  #loadInternal() {
    if (this.#loaded) {
      if (!this.#state) throw this.#lastError;
      return this.#state;
    }
    this.#loaded = true;

    let raw;
    try {
      raw = this.#storage.getItem(this.#key);
    } catch (error) {
      this.#lastError = storageError(this.#key, error);
      throw this.#lastError;
    }

    if (raw !== null) {
      try {
        this.#state = decodeRecoveryState(raw, this.#key);
        return this.#state;
      } catch (error) {
        this.#lastError = error;
        throw error;
      }
    }

    try {
      const migrated = this.#loadLegacy();
      this.#state = migrated.state;
      if (migrated.found) {
        try {
          this.#write(this.#state);
          this.#removeLegacy();
        } catch (error) {
          this.#persisted = false;
          this.#lastError = storageError(this.#key, error);
        }
      }
      return this.#state;
    } catch (error) {
      this.#lastError = error;
      throw error;
    }
  }

  #loadLegacy() {
    const state = emptyRecoveryState();
    let found = false;
    const messages = this.#readLegacy(this.#legacy.messages);
    if (messages !== null) {
      found = true;
      state.messages = decodeMessages(parseJson(messages, this.#legacy.messages), {
        legacy: true,
        key: this.#legacy.messages,
        raw: messages,
      });
    }
    const rewinds = this.#readLegacy(this.#legacy.rewinds);
    if (rewinds !== null) {
      found = true;
      state.rewinds = decodeRewinds(parseJson(rewinds, this.#legacy.rewinds), {
        key: this.#legacy.rewinds,
        raw: rewinds,
      });
    }
    const drafts = this.#readLegacy(this.#legacy.attachmentDrafts);
    if (drafts !== null) {
      found = true;
      const parsed = parseJson(drafts, this.#legacy.attachmentDrafts);
      if (!isRecord(parsed)) {
        throw corruptError(this.#legacy.attachmentDrafts, drafts);
      }
      for (const [key, attachments] of Object.entries(parsed)) {
        assertTargetKey(key, this.#legacy.attachmentDrafts, drafts);
        state.drafts[key] = {
          text: "",
          attachments: decodeAttachments(attachments, this.#legacy.attachmentDrafts, drafts),
        };
      }
    }
    return { state, found };
  }

  #readLegacy(key) {
    if (!key) return null;
    try {
      return this.#storage.getItem(key);
    } catch (error) {
      throw storageError(key, error);
    }
  }

  #write(state) {
    const raw = JSON.stringify(state);
    this.#storage.setItem(this.#key, raw);
  }

  #removeLegacy() {
    for (const key of Object.values(this.#legacy)) {
      if (!key) continue;
      try {
        this.#storage.removeItem(key);
      } catch {
        // 新格式已经确认写入；残留旧键不会再成为恢复权威。
      }
    }
  }
}

export function emptyRecoveryState() {
  return { version: RECOVERY_VERSION, drafts: {}, messages: [], rewinds: [] };
}

export function recoveryTargetKey(projectId, sessionId) {
  return `${projectId}\n${sessionId}`;
}

export function composerDraft(state, projectId, sessionId) {
  const draft = state.drafts[recoveryTargetKey(projectId, sessionId)];
  return draft ? cloneDraft(draft) : { text: "", attachments: [] };
}

export function setComposerDraft(state, projectId, sessionId, draft) {
  const key = recoveryTargetKey(projectId, sessionId);
  const normalized = decodeDraft(draft, key, null);
  if (!normalized.text && normalized.attachments.length === 0) delete state.drafts[key];
  else state.drafts[key] = normalized;
}

export function beginMessageDelivery(state, entry) {
  const message = decodeMessage(entry, { legacy: false, key: null, raw: null });
  state.messages = state.messages.filter((candidate) =>
    candidate.clientMessageId !== message.clientMessageId
  );
  state.messages.push(message);
  delete state.drafts[recoveryTargetKey(message.projectId, message.sessionId)];
}

export function acceptMessageDelivery(state, clientMessageId) {
  state.messages = state.messages.filter((entry) => entry.clientMessageId !== clientMessageId);
}

export function recoverMessageDelivery(state, entry) {
  acceptMessageDelivery(state, entry.clientMessageId);
  recoverPayload(state, entry.projectId, entry.sessionId, entry.text, entry.attachments);
}

export function beginRewind(state, entry) {
  const rewind = decodeRewind(entry, { key: null, raw: null });
  state.rewinds = state.rewinds.filter((candidate) =>
    candidate.projectId !== rewind.projectId || candidate.sessionId !== rewind.sessionId
  );
  state.rewinds.push(rewind);
}

export function completeRewind(state, entry, restoreDraft) {
  state.rewinds = state.rewinds.filter((candidate) =>
    candidate.projectId !== entry.projectId ||
    candidate.sessionId !== entry.sessionId ||
    candidate.targetTurnId !== entry.targetTurnId
  );
  if (restoreDraft) {
    recoverPayload(state, entry.projectId, entry.sessionId, entry.text || "", entry.attachments);
  }
}

function recoverPayload(state, projectId, sessionId, text, attachments) {
  const current = composerDraft(state, projectId, sessionId);
  const recoveredText = typeof text === "string" ? text : "";
  setComposerDraft(state, projectId, sessionId, {
    text: recoveredText && current.text
      ? `${recoveredText}\n\n${current.text}`
      : recoveredText || current.text,
    attachments: mergeAttachments(attachments, current.attachments),
  });
}

function normalizeRecoveryState(value) {
  if (!isRecord(value) || value.version !== RECOVERY_VERSION || !isRecord(value.drafts)) {
    throw new TypeError("恢复状态格式无效。");
  }
  const drafts = {};
  for (const [key, draft] of Object.entries(value.drafts)) {
    assertTargetKey(key, null, null);
    drafts[key] = decodeDraft(draft, null, null);
  }
  const messages = decodeMessages(value.messages, { legacy: false, key: null, raw: null });
  const rewinds = decodeRewinds(value.rewinds, { key: null, raw: null });
  return { version: RECOVERY_VERSION, drafts, messages, rewinds };
}

function decodeRecoveryState(raw, key) {
  try {
    return normalizeRecoveryState(parseJson(raw, key));
  } catch (error) {
    if (error instanceof RecoveryStateError) throw error;
    throw corruptError(key, raw, error);
  }
}

function decodeMessages(value, options) {
  if (!Array.isArray(value)) throw corruptError(options.key, options.raw);
  const messages = value.map((entry) => decodeMessage(entry, options));
  if (new Set(messages.map((entry) => entry.clientMessageId)).size !== messages.length) {
    throw corruptError(options.key, options.raw);
  }
  return messages;
}

function decodeMessage(entry, { legacy, key, raw }) {
  if (!isRecord(entry) || !isString(entry.clientMessageId) || !isString(entry.projectId) ||
      !isString(entry.sessionId) || typeof entry.text !== "string") {
    throw corruptError(key, raw);
  }
  const attachmentIds = entry.attachmentIds === undefined && legacy ? [] : entry.attachmentIds;
  if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => !isString(id))) {
    throw corruptError(key, raw);
  }
  const attachments = entry.attachments === undefined && legacy
    ? []
    : decodeAttachments(entry.attachments, key, raw);
  return {
    clientMessageId: entry.clientMessageId,
    projectId: entry.projectId,
    sessionId: entry.sessionId,
    text: entry.text,
    attachmentIds: [...attachmentIds],
    attachments,
    createdAtMs: finiteOrZero(entry.createdAtMs),
  };
}

function decodeRewinds(value, options) {
  if (!Array.isArray(value)) throw corruptError(options.key, options.raw);
  const rewinds = value.map((entry) => decodeRewind(entry, options));
  const keys = rewinds.map((entry) =>
    `${entry.projectId}\n${entry.sessionId}\n${entry.targetTurnId}`
  );
  if (new Set(keys).size !== keys.length) throw corruptError(options.key, options.raw);
  return rewinds;
}

function decodeRewind(entry, { key, raw }) {
  if (!isRecord(entry) || !isString(entry.projectId) || !isString(entry.sessionId) ||
      !isString(entry.targetTurnId) || (entry.text !== null && typeof entry.text !== "string")) {
    throw corruptError(key, raw);
  }
  return {
    projectId: entry.projectId,
    sessionId: entry.sessionId,
    targetTurnId: entry.targetTurnId,
    text: entry.text,
    attachments: decodeAttachments(entry.attachments, key, raw),
    createdAtMs: finiteOrZero(entry.createdAtMs),
  };
}

function decodeDraft(value, key, raw) {
  if (!isRecord(value) || typeof value.text !== "string") throw corruptError(key, raw);
  return {
    text: value.text,
    attachments: decodeAttachments(value.attachments, key, raw),
  };
}

function decodeAttachments(value, key, raw) {
  if (!Array.isArray(value)) throw corruptError(key, raw);
  return value.map((attachment) => {
    if (!isRecord(attachment) || !isString(attachment.id) || attachment.id.length > 128 ||
        typeof attachment.originalName !== "string" || attachment.originalName.length > 1_024) {
      throw corruptError(key, raw);
    }
    return {
      id: attachment.id,
      originalName: attachment.originalName,
      size: Number.isFinite(attachment.size) ? attachment.size : null,
      declaredMime: typeof attachment.declaredMime === "string" ? attachment.declaredMime : "",
      detectedMime: typeof attachment.detectedMime === "string" ? attachment.detectedMime : "",
      kind: attachment.kind === "image" ? "image" : "file",
      expiresAtMs: Number.isFinite(attachment.expiresAtMs) ? attachment.expiresAtMs : null,
    };
  });
}

function mergeAttachments(first, second) {
  const merged = [];
  const seen = new Set();
  for (const attachment of [...decodeAttachments(first, null, null), ...second]) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    merged.push({ ...attachment });
  }
  return merged;
}

function cloneRecoveryState(state) {
  return {
    version: RECOVERY_VERSION,
    drafts: Object.fromEntries(Object.entries(state.drafts).map(([key, draft]) =>
      [key, cloneDraft(draft)]
    )),
    messages: state.messages.map((entry) => ({
      ...entry,
      attachmentIds: [...entry.attachmentIds],
      attachments: entry.attachments.map((attachment) => ({ ...attachment })),
    })),
    rewinds: state.rewinds.map((entry) => ({
      ...entry,
      attachments: entry.attachments.map((attachment) => ({ ...attachment })),
    })),
  };
}

function cloneDraft(draft) {
  return {
    text: draft.text,
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  };
}

function parseJson(raw, key) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw corruptError(key, raw, error);
  }
}

function assertTargetKey(key, storageKey, raw) {
  const split = key.indexOf("\n");
  if (split <= 0 || split === key.length - 1 || key.indexOf("\n", split + 1) !== -1) {
    throw corruptError(storageKey, raw);
  }
}

function corruptError(key, raw, cause = null) {
  return new RecoveryStateError(
    "recovery_corrupt",
    "浏览器中的恢复记录已损坏。",
    { key, raw, cause },
  );
}

function storageError(key, cause) {
  return new RecoveryStateError(
    "recovery_unavailable",
    "浏览器无法读写恢复记录。",
    { key, cause },
  );
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}
