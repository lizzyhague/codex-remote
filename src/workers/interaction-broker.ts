import { randomUUID } from "node:crypto";

import type { RequestId } from "../generated/RequestId.ts";
import type { AppServerMessageListener, JsonObject } from "../app-server/client.ts";

export type WorkerInteractionQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

export type WorkerInteractionRequest = {
  id: string;
  threadId: string;
  turnId: string | null;
} & (
  | { kind: "user_input"; questions: WorkerInteractionQuestion[] }
  | {
    kind: "mcp_elicitation";
    mode: string;
    serverName: string;
    message: string;
    url: string | null;
    schema: JsonObject | null;
  }
);

export type WorkerInteractionEvent =
  | { type: "interaction_requested"; interaction: WorkerInteractionRequest }
  | { type: "interaction_resolved"; interactionId: string; resolution: "submitted" | "cancelled" | "cleared" };

type PendingInteraction = {
  requestId: RequestId;
  interaction: WorkerInteractionRequest;
};

export interface InteractionTransport {
  onServerRequest(listener: AppServerMessageListener): () => void;
  onNotification(listener: AppServerMessageListener): () => void;
  respondToServerRequest(id: RequestId, result: unknown): void;
}

/** 必须由用户回答的选择题、表单和登录授权；Full access 不会自动处理。 */
export class InteractionBroker {
  readonly #transport: InteractionTransport;
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #idByRequestId = new Map<RequestId, string>();
  readonly #listeners = new Set<(event: WorkerInteractionEvent) => void>();
  readonly #unsubscribeRequests: () => void;
  readonly #unsubscribeNotifications: () => void;

  constructor(transport: InteractionTransport) {
    this.#transport = transport;
    this.#unsubscribeRequests = transport.onServerRequest((message) =>
      this.#handleRequest(message));
    this.#unsubscribeNotifications = transport.onNotification((message) =>
      this.#handleNotification(message));
  }

  onEvent(listener: (event: WorkerInteractionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pendingForThread(threadId: string): WorkerInteractionRequest[] {
    return [...this.#pending.values()]
      .map((entry) => entry.interaction)
      .filter((interaction) => interaction.threadId === threadId);
  }

  answer(
    interactionId: string,
    action: "submit" | "cancel",
    answers: Record<string, string[]>,
  ): boolean {
    const pending = this.#pending.get(interactionId);
    if (!pending) return false;
    const response = action === "cancel"
      ? cancelResponse(pending.interaction)
      : submitResponse(pending.interaction, answers);
    this.#transport.respondToServerRequest(pending.requestId, response);
    this.#remove(interactionId, action === "cancel" ? "cancelled" : "submitted");
    return true;
  }

  cancelThread(threadId: string): number {
    const matches = [...this.#pending.entries()].filter(([, pending]) =>
      pending.interaction.threadId === threadId);
    for (const [interactionId, pending] of matches) {
      this.#transport.respondToServerRequest(
        pending.requestId,
        cancelResponse(pending.interaction),
      );
      this.#remove(interactionId, "cancelled");
    }
    return matches.length;
  }

  dispose(): void {
    this.#unsubscribeRequests();
    this.#unsubscribeNotifications();
    this.#listeners.clear();
  }

  #handleRequest(message: JsonObject): void {
    const requestId = readRequestId(message.id);
    const params = asObject(message.params);
    if (requestId === null || !params || this.#idByRequestId.has(requestId)) return;
    const interaction = message.method === "item/tool/requestUserInput"
      ? readUserInput(params)
      : message.method === "mcpServer/elicitation/request"
      ? readMcpElicitation(params)
      : null;
    if (!interaction) return;
    const id = randomUUID();
    const browserInteraction = { ...interaction, id } as WorkerInteractionRequest;
    this.#pending.set(id, { requestId, interaction: browserInteraction });
    this.#idByRequestId.set(requestId, id);
    this.#emit({ type: "interaction_requested", interaction: browserInteraction });
  }

  #handleNotification(message: JsonObject): void {
    if (message.method !== "serverRequest/resolved") return;
    const params = asObject(message.params);
    const requestId = readRequestId(params?.requestId);
    if (requestId === null) return;
    const id = this.#idByRequestId.get(requestId);
    if (id) this.#remove(id, "cleared");
  }

  #remove(
    interactionId: string,
    resolution: Extract<WorkerInteractionEvent, { type: "interaction_resolved" }>["resolution"],
  ): void {
    const pending = this.#pending.get(interactionId);
    if (!pending) return;
    this.#pending.delete(interactionId);
    this.#idByRequestId.delete(pending.requestId);
    this.#emit({ type: "interaction_resolved", interactionId, resolution });
  }

  #emit(event: WorkerInteractionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function readUserInput(
  params: JsonObject,
): Omit<Extract<WorkerInteractionRequest, { kind: "user_input" }>, "id"> | null {
  if (
    typeof params.threadId !== "string" || typeof params.turnId !== "string" ||
    !Array.isArray(params.questions)
  ) return null;
  const questions = params.questions.flatMap((value) => {
    const question = asObject(value);
    if (
      !question || typeof question.id !== "string" ||
      typeof question.header !== "string" || typeof question.question !== "string"
    ) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((value) => {
        const option = asObject(value);
        return option && typeof option.label === "string"
          ? [{
            label: option.label,
            description: typeof option.description === "string" ? option.description : "",
          }]
          : [];
      })
      : null;
    return [{
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options,
    }];
  });
  if (questions.length === 0) return null;
  return {
    kind: "user_input",
    threadId: params.threadId,
    turnId: params.turnId,
    questions,
  };
}

function readMcpElicitation(
  params: JsonObject,
): Omit<Extract<WorkerInteractionRequest, { kind: "mcp_elicitation" }>, "id"> | null {
  if (
    typeof params.threadId !== "string" || typeof params.serverName !== "string" ||
    typeof params.mode !== "string" || typeof params.message !== "string"
  ) return null;
  return {
    kind: "mcp_elicitation",
    threadId: params.threadId,
    turnId: typeof params.turnId === "string" ? params.turnId : null,
    mode: params.mode,
    serverName: params.serverName,
    message: params.message,
    url: typeof params.url === "string" ? params.url : null,
    schema: asObject(params.requestedSchema)
      ? structuredClone(asObject(params.requestedSchema)!)
      : null,
  };
}

function submitResponse(
  interaction: WorkerInteractionRequest,
  answers: Record<string, string[]>,
): JsonObject {
  if (interaction.kind === "user_input") {
    return {
      answers: Object.fromEntries(interaction.questions.map((question) => [
        question.id,
        { answers: Array.isArray(answers[question.id]) ? answers[question.id] : [] },
      ])),
    };
  }
  if (interaction.mode === "url") {
    return { action: "accept", content: null, _meta: null };
  }
  return {
    action: "accept",
    content: mcpFormContent(interaction.schema, answers),
    _meta: null,
  };
}

function cancelResponse(interaction: WorkerInteractionRequest): JsonObject {
  return interaction.kind === "user_input"
    ? { answers: {} }
    : { action: "cancel", content: null, _meta: null };
}

function readRequestId(value: unknown): RequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function mcpFormContent(
  schema: JsonObject | null,
  answers: Record<string, string[]>,
): JsonObject {
  const properties = asObject(schema?.properties);
  if (!properties) throw new Error("这个 MCP 表单没有可识别的字段定义。");
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const content: JsonObject = {};
  for (const [fieldId, rawSchema] of Object.entries(properties)) {
    const fieldSchema = asObject(rawSchema);
    if (!fieldSchema) continue;
    const values = answers[fieldId] ?? [];
    if (values.length === 0) {
      if (required.has(fieldId)) throw new Error(`MCP 表单字段 ${fieldId} 不能为空。`);
      continue;
    }
    const allowed = enumValues(fieldSchema);
    if (allowed && values.some((value) => !allowed.has(value))) {
      throw new Error(`MCP 表单字段 ${fieldId} 的选项无法识别。`);
    }
    if (fieldSchema.type === "array") {
      content[fieldId] = values;
    } else if (fieldSchema.type === "boolean") {
      if (values[0] !== "true" && values[0] !== "false") {
        throw new Error(`MCP 表单字段 ${fieldId} 不是有效的布尔值。`);
      }
      content[fieldId] = values[0] === "true";
    } else if (fieldSchema.type === "number" || fieldSchema.type === "integer") {
      const number = Number(values[0]);
      if (!Number.isFinite(number) || (fieldSchema.type === "integer" && !Number.isInteger(number))) {
        throw new Error(`MCP 表单字段 ${fieldId} 不是有效的数字。`);
      }
      content[fieldId] = number;
    } else if (fieldSchema.type === "string") {
      content[fieldId] = values[0]!;
    } else {
      throw new Error(`MCP 表单字段 ${fieldId} 的类型暂不支持。`);
    }
  }
  return content;
}

function enumValues(schema: JsonObject): Set<string> | null {
  const direct = Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === "string")
    : [];
  const oneOf = Array.isArray(schema.oneOf)
    ? schema.oneOf.flatMap((value) => {
      const option = asObject(value);
      return option && typeof option.const === "string" ? [option.const] : [];
    })
    : [];
  const items = asObject(schema.items);
  const itemEnum = Array.isArray(items?.enum)
    ? items.enum.filter((value): value is string => typeof value === "string")
    : [];
  const anyOf = Array.isArray(items?.anyOf)
    ? items.anyOf.flatMap((value) => {
      const option = asObject(value);
      return option && typeof option.const === "string" ? [option.const] : [];
    })
    : [];
  const values = [...direct, ...oneOf, ...itemEnum, ...anyOf];
  return values.length > 0 ? new Set(values) : null;
}
