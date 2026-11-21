export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}
export type ModelEvent = { type: "text-delta" | "reasoning-delta"; delta: string }
  | { type: "finish"; finishReason: "stop" | "length" | "content-filter" | "error" | "other" };
export interface ModelClient {
  readonly provider: string;
  readonly modelId: string;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
