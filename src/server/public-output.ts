export const PUBLIC_TURN_ERROR_MESSAGE = "Codex 处理任务时出错，请查看服务日志。";

/** App Server 的错误文字不是公开协议；原文只进服务日志。 */
export function publicTurnErrorMessage(
  message: string | null | undefined,
  context: string,
): string | null {
  if (message === null || message === undefined) return null;
  console.error(`${context}：${message}`);
  return PUBLIC_TURN_ERROR_MESSAGE;
}
