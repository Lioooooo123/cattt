import type { z } from 'zod';

export type TextPart = { type: 'text'; text: string };
export type ReasoningPart = { type: 'reasoning'; text: string };
export type ToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };
export type ToolOutput = { type: 'json' | 'error-json' | 'content'; value: unknown }
  | { type: 'text' | 'error-text'; value: string }
  | { type: 'execution-denied'; reason?: string };
export type ToolResultPart = { type: 'tool-result'; toolCallId: string; toolName: string; output: ToolOutput };
export type ModelMessage = { role: 'system'; content: string }
  | { role: 'user'; content: string | TextPart[] }
  | { role: 'assistant'; content: string | (TextPart | ReasoningPart | ToolCallPart)[] }
  | { role: 'tool'; content: ToolResultPart[] };
export type InputSchema = z.ZodType | Record<string, unknown>;
export type ModelRequest = {
  stream?: boolean;
  system?: string;
  messages: ModelMessage[];
  tools?: { name: string; description?: string; inputSchema: InputSchema }[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxOutputTokens?: number;
  responseFormat?: { type: 'json'; schema?: InputSchema; name?: string; description?: string };
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
};
export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other';
export type ModelUsage = { inputTokens: number | null; cacheReadTokens: number | null; outputTokens: number | null; reasoningTokens: number | null };
export const emptyUsage = (): ModelUsage => ({ inputTokens: null, cacheReadTokens: null, outputTokens: null, reasoningTokens: null });
export type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown>; rawInput: string };
export type ModelEvent = { type: 'text-delta' | 'reasoning-delta'; delta: string }
  | ({ type: 'tool-call' } & ToolCall)
  | { type: 'finish'; finishReason: FinishReason; usage: ModelUsage };
export interface ModelClient {
  readonly provider: string;
  readonly modelId: string;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
