export type PublicToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type PublicToolResource = {
  address: string;
  label: string | null;
};

export type PublicToolEntry = {
  kind: Extract<PublicToolKind, "read" | "edit" | "delete" | "move" | "switch_mode">;
  title: string;
};

export type PublicToolView = {
  kind: PublicToolKind;
  title: string;
  status: string;
  input: string | null;
  query: string | null;
  resources: PublicToolResource[];
  output: string | null;
  outputTruncated: boolean;
  exitCode: number | null;
  entries: PublicToolEntry[];
};

export type PublicRawToolEvent = {
  phase: "started" | "completed";
  callId: string;
  tool: PublicToolView;
};

const ADDRESS_KEYS = new Set([
  "file_path",
  "filepath",
  "filename",
  "href",
  "output_file",
  "outputfile",
  "path",
  "resource_uri",
  "resourceuri",
  "saved_path",
  "savedpath",
  "target_directory",
  "targetdirectory",
  "target_file",
  "targetfile",
  "uri",
  "url",
]);
const MAX_ADDRESS_LENGTH = 2_048;
const MAX_RESOURCES = 50;
const MAX_QUERY_LENGTH = 4_096;
const MAX_TOOL_TEXT = 100_000;
const MAX_TITLE_LENGTH = 256;

/**
 * 把 App Server 的 ThreadItem 收成浏览器可以直接渲染的工具视图。
 * 未知 MCP / dynamic 工具保持为 other；只有原生 webSearch 才按 action
 * 细分 search / fetch，避免根据工具名字猜错语义。
 */
export function publicToolView(
  item: unknown,
  fallbackStatus: "inProgress" | "completed" = "inProgress",
): PublicToolView | null {
  const value = asObject(item);
  const type = stringField(value.type);
  if (!type) return null;
  const status = stringField(value.status) ?? fallbackStatus;

  if (type === "commandExecution") {
    const command = stringField(value.command) ?? "未知命令";
    const output = stringValue(value.aggregatedOutput);
    const clipped = clipOutput(output);
    return view({
      kind: "execute",
      title: command,
      status,
      input: command,
      output: clipped.text,
      outputTruncated: clipped.truncated,
      exitCode: numberField(value.exitCode),
    });
  }

  if (type === "fileChange") {
    const entries = Array.isArray(value.changes)
      ? value.changes.flatMap(fileChangeEntry)
      : [];
    const visibleEntries = entries.length > 0
      ? entries
      : [{ kind: "edit" as const, title: "文件改动" }];
    return view({
      kind: visibleEntries[0]!.kind,
      title: visibleEntries.length === 1
        ? visibleEntries[0]!.title
        : `${visibleEntries.length} 个文件`,
      status,
      entries: visibleEntries,
    });
  }

  if (type === "webSearch") {
    const action = asObject(value.action);
    const actionType = stringField(action.type);
    const query = webSearchQuery(value, action, actionType);
    const resources: PublicToolResource[] = [];
    const actionUrl = stringField(action.url);
    if (actionUrl) addResource(resources, actionUrl, null);
    collectResources(value.results, resources);
    const kind = actionType === "openPage" || actionType === "open_page"
      ? "fetch"
      : "search";
    return view({
      kind,
      title: kind === "fetch"
        ? actionUrl ?? "Open Page"
        : query ?? "Web Search",
      status,
      query: kind === "search" ? query : null,
      resources: mergeResources(resources),
    });
  }

  if (type === "imageView") {
    const path = stringField(value.path) ?? "图片";
    return view({
      kind: "read",
      title: path,
      status,
      entries: [{ kind: "read", title: path }],
    });
  }

  if (type === "reasoning" || type === "plan" || type === "contextCompaction" ||
    type === "hookPrompt") {
    return view({ kind: "think", title: type, status });
  }

  if (type === "enteredReviewMode") {
    return view({
      kind: "switch_mode",
      title: "Enter review mode",
      status,
      entries: [{ kind: "switch_mode", title: "Enter review mode" }],
    });
  }

  if (type === "mcpToolCall") {
    const context = asObject(value.appContext);
    const server = stringField(value.server);
    const tool = stringField(value.tool);
    const appName = stringField(context.appName);
    const actionName = stringField(context.actionName);
    const title = [appName ?? server, actionName ?? tool].filter(Boolean).join(" · ") ||
      "MCP Tool";
    return view({
      kind: "other",
      title,
      status,
      input: stringifyToolText(value.arguments),
      output: mcpOutput(value),
    });
  }

  if (type === "dynamicToolCall") {
    const namespace = stringField(value.namespace);
    const tool = stringField(value.tool);
    return view({
      kind: "other",
      title: [namespace, tool].filter(Boolean).join(" · ") || "Dynamic Tool",
      status,
      input: stringifyToolText(value.arguments),
      output: stringifyToolText(value.contentItems),
    });
  }

  if (type === "collabAgentToolCall") {
    const input = compactObject({
      prompt: value.prompt,
      model: value.model,
      reasoningEffort: value.reasoningEffort,
    });
    const output = compactObject({
      receiverThreadIds: value.receiverThreadIds,
      agentsStates: value.agentsStates,
    });
    return view({
      kind: "other",
      title: stringField(value.tool) ?? "Collaboration",
      status,
      input: stringifyToolText(input),
      output: stringifyToolText(output),
    });
  }

  if (type === "subAgentActivity") {
    return view({
      kind: "other",
      title: `Sub-agent ${stringField(value.kind) ?? "activity"}`,
      status,
      input: stringifyToolText(compactObject({
        agentPath: value.agentPath,
        agentThreadId: value.agentThreadId,
      })),
    });
  }

  if (type === "sleep") {
    const duration = numberField(value.durationMs);
    return view({
      kind: "other",
      title: "Sleep",
      status,
      input: duration === null ? null : `${duration} ms`,
    });
  }

  if (type === "imageGeneration") {
    return view({
      kind: "other",
      title: "Image Generation",
      status,
      input: stringField(value.revisedPrompt),
      output: stringField(value.savedPath) ?? stringField(value.result),
    });
  }

  return null;
}

/**
 * App Server 目前不会把 programmatic `exec` 调用提升为 ThreadItem，只会通过
 * rawResponseItem/completed 暴露原始的 custom_tool_call。这里仅补这一种缺口，
 * 不接管其它原始工具类型，以免和 item/started、item/completed 重复显示。
 */
export function publicRawToolView(
  item: unknown,
  startedTool: PublicToolView | null = null,
): PublicRawToolEvent | null {
  const value = asObject(item);
  const type = stringField(value.type);
  const callId = stringField(value.call_id);
  if (!callId) return null;

  if (type === "custom_tool_call") {
    const name = stringField(value.name);
    if (name !== "exec" || typeof value.input !== "string") return null;
    return {
      phase: "started",
      callId,
      tool: view({
        kind: "execute",
        title: programmaticToolTitle(value.input),
        status: "inProgress",
        input: value.input,
      }),
    };
  }

  if (type !== "custom_tool_call_output" || !startedTool) return null;
  return {
    phase: "completed",
    callId,
    tool: view({
      ...startedTool,
      status: "completed",
      output: functionCallOutputText(value.output),
    }),
  };
}

function view(fields: Partial<PublicToolView> & Pick<PublicToolView, "kind" | "title" | "status">): PublicToolView {
  const clippedOutput = clipOutput(fields.output ?? null);
  return {
    kind: fields.kind,
    title: clipTitle(fields.title),
    status: fields.status,
    input: fields.input == null ? null : clipInput(fields.input),
    query: fields.query == null ? null : fields.query.slice(0, MAX_QUERY_LENGTH),
    resources: fields.resources ?? [],
    output: clippedOutput.text,
    outputTruncated: fields.outputTruncated === true || clippedOutput.truncated,
    exitCode: fields.exitCode ?? null,
    entries: (fields.entries ?? []).map((entry) => ({
      kind: entry.kind,
      title: clipTitle(entry.title),
    })),
  };
}

function fileChangeEntry(value: unknown): PublicToolEntry[] {
  const change = asObject(value);
  const path = stringField(change.path) ?? "未知文件";
  const kind = asObject(change.kind);
  const type = stringField(kind.type);
  if (type === "delete") return [{ kind: "delete", title: path }];
  if (type === "update") {
    const destination = stringField(kind.move_path);
    return destination
      ? [{ kind: "move", title: `${path} → ${destination}` }]
      : [{ kind: "edit", title: path }];
  }
  return [{ kind: "edit", title: path }];
}

function webSearchQuery(
  item: Record<string, unknown>,
  action: Record<string, unknown>,
  actionType: string | null,
): string | null {
  if (actionType === "findInPage" || actionType === "find_in_page") {
    return stringField(action.pattern) ?? stringField(item.query);
  }
  const queries = stringArray(action.queries);
  return stringField(action.query) ?? (queries.length > 0 ? queries.join(", ") : null) ??
    stringField(item.query);
}

function mcpOutput(value: Record<string, unknown>): string | null {
  const error = asObject(value.error);
  const message = stringField(error.message);
  if (message) return message;
  return stringifyToolText(value.result);
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> | null {
  const compact = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
  return Object.keys(compact).length > 0 ? compact : null;
}

function collectResources(
  value: unknown,
  resources: PublicToolResource[],
  depth = 0,
): void {
  if (depth > 8 || resources.length >= MAX_RESOURCES) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectResources(entry, resources, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  const label = stringField(value.title) ?? stringField(value.label) ?? stringField(value.name);
  for (const [key, entry] of Object.entries(value)) {
    if (!ADDRESS_KEYS.has(key.toLowerCase())) continue;
    if (typeof entry === "string") addResource(resources, entry, label);
    if (Array.isArray(entry)) {
      for (const address of entry) {
        if (typeof address === "string") addResource(resources, address, label);
      }
    }
  }
  for (const entry of Object.values(value)) collectResources(entry, resources, depth + 1);
}

function addResource(
  resources: PublicToolResource[],
  address: string,
  label: string | null,
): void {
  const clean = address.trim();
  if (!clean || clean.length > MAX_ADDRESS_LENGTH || /[\u0000-\u001f\u007f]/.test(clean)) return;
  resources.push({
    address: clean,
    label: label?.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH) || null,
  });
}

function mergeResources(resources: PublicToolResource[]): PublicToolResource[] {
  const merged = new Map<string, PublicToolResource>();
  for (const resource of resources) {
    const existing = merged.get(resource.address);
    if (!existing || (!existing.label && resource.label)) merged.set(resource.address, resource);
    if (merged.size >= MAX_RESOURCES) break;
  }
  return [...merged.values()];
}

function stringifyToolText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return clipInput(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ? clipInput(serialized) : null;
  } catch {
    return null;
  }
}

function programmaticToolTitle(input: string): string {
  const tools = new Set<string>();
  for (const match of input.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    tools.add(match[1]!);
    if (tools.size >= 4) break;
  }
  return tools.size > 0 ? [...tools].join(" + ") : "exec";
}

function functionCallOutputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const text = value.flatMap((entry) => {
    const item = asObject(entry);
    return item.type === "input_text" && typeof item.text === "string"
      ? [item.text]
      : [];
  }).join("");
  return text || null;
}

function clipInput(value: string): string {
  return value.length <= MAX_TOOL_TEXT ? value : value.slice(0, MAX_TOOL_TEXT);
}

function clipOutput(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null || value.length <= MAX_TOOL_TEXT) return { text: value, truncated: false };
  return { text: value.slice(-MAX_TOOL_TEXT), truncated: true };
}

function clipTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim() || "Tool";
  return normalized.slice(0, MAX_TITLE_LENGTH);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      .map((entry) => entry.trim())
    : [];
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
