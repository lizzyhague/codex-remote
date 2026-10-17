export const PUBLIC_TURN_ERROR_MESSAGE = "Codex 处理任务时出错，请查看服务日志。";

/** App Server error text is not public protocol; preserve the original only in service logs. */
export function publicTurnErrorMessage(
  message: string | null | undefined,
  context: string,
): string | null {
  if (message === null || message === undefined) return null;
  console.error(`${context}：${message}`);
  return PUBLIC_TURN_ERROR_MESSAGE;
}
