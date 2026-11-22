import { z } from "zod";
import type { ModelUsage } from "./types.ts";

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolObservation = { id: string; name: string; value: unknown; summaryAllowed?: true };
export type ToolMessage =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content: string; reasoning: string; calls: ToolCall[] }
  | { role: "tool"; observations: ToolObservation[] };

export interface ToolRequest {
  system: string;
  messages: ToolMessage[];
  tools: Array<{ name: string; description: string; inputSchema: z.ZodType }>;
  maxOutputTokens: number;
  guard?: () => void;
}

export interface ToolResponse {
  finishReason: "stop" | "tool-calls" | "length" | "error" | "other";
  text: string;
  reasoning: string;
  outputTokens: number;
  usage?: ModelUsage;
  calls: ToolCall[];
}

export interface ToolModel {
  complete(request: ToolRequest, signal: AbortSignal): Promise<ToolResponse>;
}

export type ToolDefinition<T> = {
  description: string;
  schema: z.ZodType;
  execute(input: unknown): T | Promise<T>;
};

export const TOOL_CORRECTION = "上一批工具调用已整体拒绝，未执行任何工具。请依据工具定义和结构诊断修正调用，不要声称已执行，也不要重复无关调用。";
export const INPUT_BUDGET = 56 * 1024;

export class ToolProtocolError extends Error {}

export function validateToolResponse(response: ToolResponse, seenIds: string[]): ToolResponse {
  if (![ "stop", "tool-calls" ].includes(response.finishReason)
    || !Number.isSafeInteger(response.outputTokens) || response.outputTokens < 0
    || typeof response.text !== "string" || typeof response.reasoning !== "string"
    || !Array.isArray(response.calls)
    || ((response.finishReason === "tool-calls") !== (response.calls.length > 0))) {
    throw new ToolProtocolError("模型工具响应没有正常结束");
  }
  const ids = new Set(seenIds);
  for (const call of response.calls) {
    if (typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
      || typeof call.name !== "string" || !call.name.trim()
      || !call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
      throw new ToolProtocolError("工具调用标识或对象无效");
    }
    ids.add(call.id);
  }
  return response;
}

export async function runToolStep<T>(options: {
  response: ToolResponse;
  tools: Record<string, ToolDefinition<T>>;
  guard(): void;
  signal: AbortSignal;
  canCorrect: boolean;
  beforeTools?(planned: ReadonlyArray<{ name: string; input: unknown }>): void;
  onResult(result: T): unknown;
  allowsSummary?(result: T, toolName: string): boolean;
}) {
  const { response, tools, guard, signal, canCorrect, beforeTools, onResult, allowsSummary } = options;
  const preflight = response.calls.map((call) => {
    const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined;
    if (!tool) {
      return { call, failure: "unknown_tool" } as const;
    }
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map(({ code, path }) => ({
        code, path: path.map(String).join(".").slice(0, 120),
      }));
      return { call, failure: "invalid_tool_input", issues } as const;
    }
    return { call, tool, input: parsed.data };
  });
  const invalid = preflight.some((item) => item.failure !== undefined);
  if (invalid && !canCorrect) {
    throw new ToolProtocolError("本次执行的工具修正额度已用完");
  }
  if (!invalid) {
    beforeTools?.(preflight.map(({ call, input }) => ({ name: call.name, input })));
  }
  const observations: ToolObservation[] = [];
  for (const item of preflight) {
    guard();
    const { id, name } = item.call;
    if (invalid) {
      observations.push({ id, name, value: {
        status: "failed", code: item.failure ?? "tool_batch_rejected", issues: item.issues,
      } });
      continue;
    }
    const result = await withAbort(Promise.resolve(item.tool!.execute(item.input)), signal);
    const value = onResult(result);
    guard();
    observations.push({ id, name, value, ...(allowsSummary?.(result, name) && { summaryAllowed: true }) });
  }
  const messages: ToolMessage[] = [{
    role: "assistant", content: response.text, reasoning: response.reasoning, calls: response.calls,
  }];
  if (observations.length) {
    messages.push({ role: "tool", observations });
  }
  return { messages, toolValidationFailed: invalid };
}

export function toolDefinitions(tools: ToolRequest["tools"]) {
  return tools.map(({ name, description, inputSchema }) => ({
    type: "function",
    function: { name, description, parameters: z.toJSONSchema(inputSchema, { unrepresentable: "any" }) },
  }));
}

/** 只裁掉完整的旧工具/结果组，当前原话及最新步骤始终保留。 */
export function fitToolHistory(request: ToolRequest, reserve = 0): {
  kept: ToolMessage[]; dropped: ToolMessage[]; insertAt: number;
} {
  const tools = toolDefinitions(request.tools);
  const kept = [...request.messages];
  const dropped: ToolMessage[] = [];
  let insertAt = kept.length;
  while (!fits(kept)) {
    const first = kept.findIndex((item) => item.role === "assistant");
    const last = kept.findLastIndex((item) => item.role === "assistant");
    if (first < 0 || first === last) {
      throw new Error("model_input_budget: 必要内容超出输入限制");
    }
    insertAt = Math.min(insertAt, first);
    dropped.push(...kept.splice(first, kept[first + 1]?.role === "tool" ? 2 : 1));
  }
  return { kept, dropped, insertAt };

  function fits(messages: ToolMessage[]): boolean {
    return Buffer.byteLength(JSON.stringify([request.system, tools, messages])) <= INPUT_BUDGET - reserve;
  }
}

export function isTransientToolModelError(error: unknown): boolean {
  if (!(error && typeof error === "object")) {
    return false;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return [408, 429].includes(error.statusCode) || (error.statusCode >= 500 && error.statusCode < 600);
  }
  if ("lastError" in error) {
    return isTransientToolModelError(error.lastError);
  }
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR.*)$/.test(code)
    || /fetch failed|network|socket hang up/i.test(message)
    || ("cause" in error && isTransientToolModelError(error.cause));
}

export async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
