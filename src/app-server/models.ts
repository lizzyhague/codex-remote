import type { AppServerTransport } from "./turn-session.ts";
import { asObject } from "../shared/json.ts";

export type ReasoningEffortSummary = {
  reasoningEffort: string;
  description: string;
};

export type ModelSummary = {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortSummary[];
};

export async function listModels(transport: AppServerTransport): Promise<ModelSummary[]> {
  const result: ModelSummary[] = [];
  let cursor: string | null = null;
  do {
    const response = asObject(await transport.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    }));
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Codex 返回了无法识别的模型列表。");
    }
    for (const value of response.data) {
      const model = asObject(value);
      if (!model || typeof model.id !== "string") continue;
      result.push({
        id: model.id,
        displayName: typeof model.displayName === "string" ? model.displayName : model.id,
        description: typeof model.description === "string" ? model.description : "",
        isDefault: model.isDefault === true,
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string"
          ? model.defaultReasoningEffort
          : "",
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.flatMap((value) => {
            const option = asObject(value);
            return option && typeof option.reasoningEffort === "string"
              ? [{
                reasoningEffort: option.reasoningEffort,
                description: typeof option.description === "string"
                  ? option.description
                  : "",
              }]
              : [];
          })
          : [],
      });
    }
    cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
  } while (cursor && result.length < 400);
  return result;
}
