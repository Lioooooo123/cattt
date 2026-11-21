export class ModelHttpError extends Error {
  constructor(public readonly statusCode: number) {
    super(`模型请求失败：${statusCode}`);
    this.name = "ModelHttpError";
  }
}
export class ModelAuthError extends Error {
  constructor() { super("模型尚未配置模型名或密钥"); this.name = "ModelAuthError"; }
}
export class ModelOutputError extends Error {
  constructor() { super("模型响应无效或意外中断"); this.name = "ModelOutputError"; }
}

const nonRetryable = new Set(["model_auth", "model_quota", "model_bad_request", "model_input_budget", "model_daily_budget"]);

export function retryableModelCode(code: string): boolean { return !nonRetryable.has(code); }

export function classifyModelError(error: unknown): { code: string; retryable: boolean } {
  const e = error && typeof error === "object" && "lastError" in error ? error.lastError : error;
  let code = "model_error";
  if (error instanceof Error && error.name === "ModelBudgetExceeded" || e instanceof Error && e.name === "ModelBudgetExceeded") {
    code = "model_daily_budget";
  } else if (e instanceof ModelAuthError) {
    code = "model_auth";
  } else if (e instanceof Error && e.message.startsWith("model_input_budget:")) {
    code = "model_input_budget";
  } else if (e instanceof ModelHttpError) {
    if (e.statusCode === 402) { code = "model_quota"; }
    else if ([401, 403].includes(e.statusCode)) { code = "model_auth"; }
    else if ([400, 422].includes(e.statusCode)) { code = "model_bad_request"; }
  }
  return { code, retryable: retryableModelCode(code) };
}

export class ModelReplyError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ModelReplyError"; }
}
