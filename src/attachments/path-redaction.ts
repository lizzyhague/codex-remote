export type AttachmentDisplayMapping = {
  id: string;
  originalName: string;
  path: string;
};

type Replacement = {
  variant: string;
  label: string;
};

const INCOMPLETE_FLUSH_MIN_LENGTH = 16;
const HOST_PATH_LABEL = "‹主机路径›";
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/[^\s<>"'`]+/giu;
const FILE_URL_START_PATTERN = /file:\/\/(?:localhost)?/giu;
const ENCODED_PATH_PATTERN = /(?:file%3a(?:%2f){2,3}|%2f)(?=(?:(?:%[0-9a-f]{2}|[a-z0-9._~!$&'()*+,:;=@-])+%2f))(?:(?:%[0-9a-f]{2}|[a-z0-9._~!$&'()*+,:;=@-])+)/giu;
const RAW_POSIX_PATH_START_PATTERN = /(?<![\p{L}\p{N}._~:/-])\/(?!\/)/gu;
const RAW_WINDOWS_PATH_PATTERN = /\b[A-Z]:\\(?=[^\s\r\n\t<>"'`\[\]{}|,;，。！？；]*\\)[^\s\r\n\t<>"'`\[\]{}|,;，。！？；]+/giu;
const STREAM_BOUNDARY_PATTERN = /[\r\n\t<>"'`\[\]{}|,;，。！？；()]/u;

export function attachmentDisplayLabel(
  mapping: AttachmentDisplayMapping,
  duplicateName: boolean,
): string {
  if (!duplicateName) return `附件：${mapping.originalName}`;
  return `附件：${mapping.originalName} (${mapping.id.slice(0, 8)})`;
}

export function redactKnownAttachmentPaths(
  text: string,
  mappings: readonly AttachmentDisplayMapping[],
): string {
  const replacements = replacementsFor(mappings);
  if (replacements.length === 0 || text.length === 0) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const matched = matchAt(text, index, replacements);
    if (matched) {
      result += matched.label;
      index += matched.variant.length;
    } else {
      result += text[index];
      index += 1;
    }
  }
  return result;
}

/**
 * 遮盖宿主绝对路径，同时保留 HTTP(S) 等普通 URL、相对项目路径和公开路由。
 * 只替换识别出的路径片段，不丢弃路径周围的用户或工具文字。
 */
export function redactHostPaths(text: string): string {
  if (!text) return text;
  let redacted = redactFileUrls(text);
  redacted = redacted.replace(ENCODED_PATH_PATTERN, HOST_PATH_LABEL);
  const currentProtectedUrls = protectedUrlRanges(redacted);
  redacted = replaceOutsideRanges(
    redacted,
    RAW_WINDOWS_PATH_PATTERN,
    currentProtectedUrls,
    () => HOST_PATH_LABEL,
  );
  return redactRawPosixPaths(redacted, currentProtectedUrls);
}

/** 已知附件先换成友好名称，剩余宿主绝对路径再统一隐藏。 */
export function redactPublicText(
  text: string,
  mappings: readonly AttachmentDisplayMapping[] = [],
): string {
  return redactHostPaths(redactKnownAttachmentPaths(text, mappings));
}

/** 递归替换对象里的已知附件路径；只改显示副本，不改原值。 */
export function redactKnownAttachmentPathsDeep<T>(
  value: T,
  mappings: readonly AttachmentDisplayMapping[],
): T {
  if (mappings.length === 0) return value;
  return redactValue(value, mappings) as T;
}

/** 递归建立浏览器显示副本；不修改输入对象。 */
export function redactPublicTextDeep<T>(
  value: T,
  mappings: readonly AttachmentDisplayMapping[] = [],
): T {
  return redactPublicValue(value, mappings) as T;
}

/**
 * 流式输出时先扣住可能构成已知附件或其他宿主路径的尾部，确认安全后再发给页面。
 * flush 用于完成、失败或中断，避免丢字、重复或一直缓冲。
 */
export class BrowserPathStreamRedactor {
  #mappings: AttachmentDisplayMapping[];
  #replacements: Replacement[];
  #buffer = "";

  constructor(mappings: readonly AttachmentDisplayMapping[] = []) {
    this.#mappings = [...mappings];
    this.#replacements = replacementsFor(this.#mappings);
  }

  setMappings(mappings: readonly AttachmentDisplayMapping[]): void {
    this.#mappings = [...mappings];
    this.#replacements = replacementsFor(this.#mappings);
  }

  push(delta: string): string {
    if (!delta) return "";
    this.#buffer += delta;
    return this.#emit(false);
  }

  flush(): string {
    if (!this.#buffer) return "";
    const emitted = this.#emit(true);
    this.#buffer = "";
    return emitted;
  }

  #emit(flushing: boolean): string {
    const replacements = this.#replacements;
    let index = 0;
    let emitted = "";
    const source = this.#buffer;
    while (index < source.length) {
      const matched = matchAt(source, index, replacements);
      if (matched) {
        emitted += matched.label;
        index += matched.variant.length;
        continue;
      }
      const rest = source.slice(index);
      if (!flushing && isIncompleteVariantPrefix(rest, replacements)) {
        this.#buffer = rest;
        return emitted;
      }
      if (flushing) {
        const incomplete = incompleteSuffixLabel(rest, replacements);
        if (incomplete) {
          emitted += incomplete;
          break;
        }
      }
      if (isPossibleHostPathStart(source, index)) {
        const boundary = findStreamBoundary(source, index + 1);
        if (boundary === -1 && !flushing) {
          this.#buffer = rest;
          return emitted;
        }
        const end = boundary === -1 ? source.length : boundary;
        const candidate = source.slice(index, end);
        const redacted = redactHostPaths(candidate);
        if (redacted !== candidate) {
          emitted += redacted;
          index = end;
          continue;
        }
      }
      emitted += source[index];
      index += 1;
    }
    this.#buffer = "";
    return emitted;
  }
}

function redactValue(value: unknown, mappings: readonly AttachmentDisplayMapping[]): unknown {
  if (typeof value === "string") return redactKnownAttachmentPaths(value, mappings);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, mappings));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactValue(entry, mappings),
      ]),
    );
  }
  return value;
}

function redactPublicValue(value: unknown, mappings: readonly AttachmentDisplayMapping[]): unknown {
  if (typeof value === "string") return redactPublicText(value, mappings);
  if (Array.isArray(value)) return value.map((entry) => redactPublicValue(entry, mappings));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactPublicValue(entry, mappings),
      ]),
    );
  }
  return value;
}

function replacementsFor(mappings: readonly AttachmentDisplayMapping[]): Replacement[] {
  const nameCounts = new Map<string, number>();
  for (const mapping of mappings) {
    nameCounts.set(mapping.originalName, (nameCounts.get(mapping.originalName) ?? 0) + 1);
  }
  const replacements: Replacement[] = [];
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping.path) continue;
    const label = attachmentDisplayLabel(
      mapping,
      (nameCounts.get(mapping.originalName) ?? 0) > 1,
    );
    for (const variant of pathVariants(mapping.path)) {
      if (!variant || seen.has(variant)) continue;
      seen.add(variant);
      replacements.push({ variant, label });
    }
  }
  replacements.sort((left, right) => right.variant.length - left.variant.length);
  return replacements;
}

function pathVariants(filePath: string): string[] {
  const jsonInner = JSON.stringify(filePath).slice(1, -1);
  const fileUrl = `file://${filePath}`;
  const variants = [
    filePath,
    jsonInner,
    filePath.replaceAll("/", "\\/"),
    encodeURI(filePath),
    encodeURIComponent(filePath),
    formEncode(filePath),
    fileUrl,
    `file://localhost${filePath}`,
    encodeURI(fileUrl),
    encodeURIComponent(fileUrl),
    formEncode(fileUrl),
    unicodeJsonEscape(jsonInner, false),
    unicodeJsonEscape(jsonInner, true),
    unicodeJsonEscape(jsonInner.replaceAll("/", "\\/"), false),
    unicodeJsonEscape(jsonInner.replaceAll("/", "\\/"), true),
  ];
  return variants;
}

function matchAt(text: string, index: number, replacements: readonly Replacement[]): Replacement | null {
  for (const replacement of replacements) {
    const candidate = text.slice(index, index + replacement.variant.length);
    if (variantEquals(candidate, replacement.variant)) return replacement;
  }
  return null;
}

function isIncompleteVariantPrefix(text: string, replacements: readonly Replacement[]): boolean {
  return replacements.some((replacement) =>
    variantStartsWith(replacement.variant, text) && replacement.variant.length > text.length
  );
}

function incompleteSuffixLabel(text: string, replacements: readonly Replacement[]): string | null {
  if (text.length < INCOMPLETE_FLUSH_MIN_LENGTH) return null;
  const matches = replacements.filter((replacement) => variantStartsWith(replacement.variant, text));
  if (matches.length === 0) return null;
  const labels = new Set(matches.map((match) => match.label));
  return labels.size === 1 ? matches[0]?.label ?? "附件" : "附件";
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replaceAll("%20", "+");
}

function unicodeJsonEscape(value: string, uppercase: boolean): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      escaped += value[index];
      continue;
    }
    const hex = code.toString(16).padStart(4, "0");
    escaped += `\\u${uppercase ? hex.toUpperCase() : hex}`;
  }
  return escaped;
}

function variantEquals(left: string, right: string): boolean {
  return left.length === right.length && variantStartsWith(left, right);
}

function variantStartsWith(value: string, prefix: string): boolean {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    const left = value[index]!;
    const right = prefix[index]!;
    if (left === right) continue;
    if (
      isPercentHexAt(value, index) &&
      isPercentHexAt(prefix, index) &&
      left.toLowerCase() === right.toLowerCase()
    ) continue;
    return false;
  }
  return true;
}

function isPercentHexAt(value: string, index: number): boolean {
  if (!/[0-9a-f]/iu.test(value[index] ?? "")) return false;
  return value[index - 1] === "%" ||
    (value[index - 2] === "%" && /[0-9a-f]/iu.test(value[index - 1] ?? ""));
}

type TextRange = { start: number; end: number };

function protectedUrlRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match[1]?.toLowerCase() === "file" || match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function replaceOutsideRanges(
  text: string,
  pattern: RegExp,
  ranges: readonly TextRange[],
  replacement: (match: string) => string,
): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, (match: string, ...args: unknown[]) => {
    const offset = args.at(-2);
    if (typeof offset === "number" && ranges.some((range) => offset >= range.start && offset < range.end)) {
      return match;
    }
    return replacement(match);
  });
}

function redactFileUrls(text: string): string {
  FILE_URL_START_PATTERN.lastIndex = 0;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(FILE_URL_START_PATTERN)) {
    if (match.index === undefined || match.index < cursor) continue;
    const pathStart = match.index + match[0].length;
    if (text[pathStart] !== "/") continue;
    const pathEnd = rawPosixPathEnd(text, pathStart);
    if (!isHostPathCandidate(text.slice(pathStart, pathEnd))) continue;
    result += text.slice(cursor, match.index) + `file://${HOST_PATH_LABEL}`;
    cursor = pathEnd;
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}

function redactRawPosixPaths(text: string, protectedRanges: readonly TextRange[]): string {
  RAW_POSIX_PATH_START_PATTERN.lastIndex = 0;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(RAW_POSIX_PATH_START_PATTERN)) {
    if (match.index === undefined || match.index < cursor) continue;
    if (protectedRanges.some((range) => match.index >= range.start && match.index < range.end)) {
      continue;
    }
    const end = rawPosixPathEnd(text, match.index);
    const candidate = text.slice(match.index, end);
    if (!isHostPathCandidate(candidate) || looksLikePublicRoute(candidate)) continue;
    result += text.slice(cursor, match.index) + HOST_PATH_LABEL;
    cursor = end;
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}

function rawPosixPathEnd(text: string, start: number): number {
  let index = start + 1;
  let lastSlash = start;
  while (index < text.length) {
    const character = text[index]!;
    if (STREAM_BOUNDARY_PATTERN.test(character)) return index;
    if (character === "/") {
      lastSlash = index;
      index += 1;
      continue;
    }
    if (!/\s/u.test(character)) {
      index += 1;
      continue;
    }
    let nextStart = index;
    while (nextStart < text.length && /[ ]/u.test(text[nextStart]!)) nextStart += 1;
    let nextEnd = nextStart;
    while (
      nextEnd < text.length &&
      !/\s/u.test(text[nextEnd]!) &&
      !STREAM_BOUNDARY_PATTERN.test(text[nextEnd]!)
    ) nextEnd += 1;
    const nextToken = text.slice(nextStart, nextEnd);
    const currentComponent = text.slice(lastSlash + 1, index);
    const continuesDirectory = nextToken.indexOf("/") > 0;
    const continuesFileName = !currentComponent.includes(".") && /\.[\p{L}\p{N}]{1,16}$/u.test(nextToken);
    if (!continuesDirectory && !continuesFileName) return index;
    index = nextStart;
  }
  return index;
}

function isHostPathCandidate(value: string): boolean {
  return value.slice(1).includes("/");
}

function isPossibleHostPathStart(source: string, index: number): boolean {
  const rest = source.slice(index);
  const lower = rest.toLowerCase();
  if (lower.startsWith("file:") || lower.startsWith("file%3a")) return true;
  if (lower.startsWith("%2f") || "%2f".startsWith(lower)) return true;
  if (/^[a-z]:\\/iu.test(rest) || /^[a-z]:$/iu.test(rest)) return true;
  if (source[index] !== "/") return false;
  if (
    source[index + 1] === "/" ||
    source[index - 1] === "/" ||
    source[index - 1] === ":" ||
    (source[index - 1] !== undefined && /[\p{L}\p{N}._~\/-]/u.test(source[index - 1]!))
  ) {
    return false;
  }
  return !protectedUrlRanges(source).some((range) => index >= range.start && index < range.end);
}

function findStreamBoundary(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if (STREAM_BOUNDARY_PATTERN.test(source[index]!)) return index;
  }
  return -1;
}

function looksLikePublicRoute(value: string): boolean {
  return /^\/(?:api|docs|v\d+)(?:\/|$)/u.test(value.trimEnd());
}
