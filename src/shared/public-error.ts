/**
 * 只有明确由 Remote 写下、可以原样给浏览器看的业务错误才使用这个基类。
 * 外部服务、操作系统和未知异常不得为了保留原文而临时包装成 PublicError。
 */
export class PublicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicError";
  }
}

export function isPublicError(error: unknown): error is PublicError {
  return error instanceof PublicError;
}
