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

/** 递归替换对象里的已知附件路径；只改显示副本，不改原值。 */
export function redactKnownAttachmentPathsDeep<T>(
  value: T,
  mappings: readonly AttachmentDisplayMapping[],
): T {
  if (mappings.length === 0) return value;
  return redactValue(value, mappings) as T;
}

/**
 * 流式输出时先扣住可能构成已知附件路径的尾部前缀，完整匹配后再发给页面。
 * flush 用于完成、失败或中断，避免丢字、重复或一直缓冲。
 */
export class AttachmentPathStreamRedactor {
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
  return [
    filePath,
    jsonInner,
    filePath.replaceAll("/", "\\/"),
    encodeURI(filePath),
    encodeURIComponent(filePath),
    fileUrl,
    `file://localhost${filePath}`,
    encodeURI(fileUrl),
    encodeURIComponent(fileUrl),
  ];
}

function matchAt(text: string, index: number, replacements: readonly Replacement[]): Replacement | null {
  for (const replacement of replacements) {
    if (text.startsWith(replacement.variant, index)) return replacement;
  }
  return null;
}

function isIncompleteVariantPrefix(text: string, replacements: readonly Replacement[]): boolean {
  return replacements.some((replacement) =>
    replacement.variant.startsWith(text) && replacement.variant.length > text.length
  );
}

function incompleteSuffixLabel(text: string, replacements: readonly Replacement[]): string | null {
  if (text.length < INCOMPLETE_FLUSH_MIN_LENGTH) return null;
  const matches = replacements.filter((replacement) => replacement.variant.startsWith(text));
  if (matches.length === 0) return null;
  const labels = new Set(matches.map((match) => match.label));
  return labels.size === 1 ? matches[0]?.label ?? "附件" : "附件";
}
