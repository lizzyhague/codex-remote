import { localText, type LocalText } from "../shared/local-text.ts";

export const PUBLIC_TURN_ERROR_TEXT: LocalText = localText("error.turnFailed");

export function publicTurnErrorMessage(
  message: string | null | undefined,
  context: string,
): LocalText | null {
  if (message === null || message === undefined) return null;
  console.error(`${context}: ${message}`);
  return PUBLIC_TURN_ERROR_TEXT;
}
