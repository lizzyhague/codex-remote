export type McpFormChoice = { value: string; title: string };

export type McpFormField = {
  id: string;
  title: string;
  description: string;
  required: boolean;
  type: "string" | "number" | "integer" | "boolean" | "array";
  choices?: McpFormChoice[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: string | number | boolean | string[];
};

export type McpForm = { fields: McpFormField[] };

export type McpFormValidation =
  | { ok: true; content: Record<string, string | number | boolean | string[]> }
  | { ok: false; fieldId: string | null; message: string };

export function normalizeMcpFormSchema(schema: unknown): McpForm | null;
export function validateMcpFormAnswers(
  form: McpForm | null,
  answers: Record<string, string[]>,
): McpFormValidation;
