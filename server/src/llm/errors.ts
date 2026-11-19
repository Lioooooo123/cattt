export class ModelHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly responseBody: string) {
    super(message);
    this.name = 'ModelHttpError';
  }
  static isInstance(error: unknown): error is ModelHttpError { return error instanceof ModelHttpError; }
}
export class ModelAuthError extends Error {
  constructor(message = '模型尚未配置 API key') { super(message); this.name = 'ModelAuthError'; }
  static isInstance(error: unknown): error is ModelAuthError { return error instanceof ModelAuthError; }
}
export class ModelOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ModelOutputError'; }
  static isInstance(error: unknown): error is ModelOutputError { return error instanceof ModelOutputError; }
}
