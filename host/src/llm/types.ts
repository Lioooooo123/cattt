export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  guard?: () => void;
}
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
}
export type ModelEvent = { type: "text-delta" | "reasoning-delta"; delta: string }
  | { type: "finish"; finishReason: "stop" | "length" | "content-filter" | "error" | "other"; usage?: ModelUsage };
export interface ModelClient {
  readonly provider: string;
  readonly modelId: string;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
