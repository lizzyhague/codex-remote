import type { JsonObject } from "../app-server/client.ts";
import { asObject } from "../shared/json.ts";
import { PublicError } from "../shared/public-error.ts";
import {
  normalizeMcpFormSchema,
  validateMcpFormAnswers,
} from "../../public/mcp-form.js";
import {
  type BrokerBaseResolution,
  ServerRequestBroker,
  type ServerRequestTransport,
} from "../app-server/server-request-broker.ts";

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

export type InteractionTransport = ServerRequestTransport;

/** 必须由用户回答的选择题、表单和登录授权；Full access 不会自动处理。 */
export class InteractionBroker extends ServerRequestBroker<
  WorkerInteractionRequest,
  WorkerInteractionEvent,
  "submitted"
> {
  constructor(transport: InteractionTransport) {
    super(transport);
  }

  answer(
    interactionId: string,
    action: "submit" | "cancel",
    answers: Record<string, string[]>,
  ): boolean {
    return this.respond(
      interactionId,
      (interaction) =>
        action === "cancel"
          ? this.cancelResponse(interaction)
          : submitResponse(interaction, answers),
      action === "cancel" ? "cancelled" : "submitted",
    );
  }

  cancelThread(threadId: string): number {
    return this.cancelWhere((interaction) => interaction.threadId === threadId);
  }

  protected override parse(
    method: string,
    params: JsonObject,
  ): Omit<WorkerInteractionRequest, "id"> | null {
    return method === "item/tool/requestUserInput"
      ? readUserInput(params)
      : method === "mcpServer/elicitation/request"
      ? readMcpElicitation(params)
      : null;
  }

  protected override cancelResponse(interaction: WorkerInteractionRequest): JsonObject {
    return interaction.kind === "user_input"
      ? { answers: {} }
      : { action: "cancel", content: null, _meta: null };
  }

  protected override requestedEvent(
    interaction: WorkerInteractionRequest,
  ): WorkerInteractionEvent {
    return { type: "interaction_requested", interaction };
  }

  protected override resolvedEvent(
    interactionId: string,
    resolution: "submitted" | BrokerBaseResolution,
  ): WorkerInteractionEvent {
    return { type: "interaction_resolved", interactionId, resolution };
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

function mcpFormContent(
  schema: JsonObject | null,
  answers: Record<string, string[]>,
): JsonObject {
  const form = normalizeMcpFormSchema(schema);
  const result = validateMcpFormAnswers(form, answers);
  if (!result.ok) {
    throw new PublicError(result.message);
  }
  return result.content;
}
