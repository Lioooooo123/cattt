import { z } from "zod";
import { isLoopback } from "./config.ts";
import { ModelAuthError, ModelHttpError, ModelOutputError } from "./errors.ts";
import { toolDefinitions } from "./tool-loop.ts";
import type { ToolMessage, ToolModel } from "./tool-loop.ts";
import type { ModelClient, ModelEvent, ModelMessage, ModelUsage } from "./types.ts";

export interface ClientOptions {
  baseURL: string;
  modelId?: string;
  apiKey?: string;
  provider?: string;
  requireApiKey?: boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  extraBody?: Record<string, unknown>;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let dataSize = 0;
  function line(value: string): string | undefined {
    if (!value) {
      if (!data.length) { return; }
      const result = data.join("\n"); data = []; dataSize = 0; return result;
    }
    if (value.startsWith("data:")) {
      dataSize += value.length + 1;
      if (dataSize > MAX_RESPONSE_BYTES) { throw new ModelOutputError(); }
      data.push(value.slice(5).replace(/^ /, ""));
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > MAX_RESPONSE_BYTES) { throw new ModelOutputError(); }
      let index: number;
      while ((index = buffer.search(/[\r\n]/)) !== -1) {
        if (!done && buffer[index] === "\r" && index === buffer.length - 1) { break; }
        const result = line(buffer.slice(0, index));
        const length = buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(index + length);
        if (result !== undefined) { yield result; }
      }
      if (done) { break; }
    }
    if (buffer) { const result = line(buffer); if (result !== undefined) { yield result; } }
    if (data.length) { yield data.join("\n"); }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

const chunkSchema = z.object({
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    delta: z.object({
      content: z.string().nullish(), reasoning_content: z.string().nullish(), reasoning: z.string().nullish(),
      tool_calls: z.array(z.unknown()).optional(),
    }).optional(),
  })).optional(),
});

const tokenCount = z.number().int().nonnegative();
const usageSchema = z.object({
  completion_tokens: tokenCount,
  prompt_tokens: tokenCount.optional(),
  prompt_cache_hit_tokens: tokenCount.optional(),
  prompt_tokens_details: z.object({ cached_tokens: tokenCount.optional() }).nullish(),
  completion_tokens_details: z.object({ reasoning_tokens: tokenCount.optional() }).nullish(),
});
const completionSchema = z.object({
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
  choices: z.tuple([z.object({
    finish_reason: z.string(),
    message: z.object({
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      reasoning: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: z.string().min(1), type: z.literal("function"),
        function: z.object({ name: z.string().min(1), arguments: z.string() }),
      })).nullish(),
    }),
  })]),
});

function readUsage(raw: unknown): ModelUsage | undefined {
  const { success, data } = usageSchema.safeParse(raw);
  if (!success) { return; }
  return {
    inputTokens: data.prompt_tokens ?? null,
    outputTokens: data.completion_tokens,
    reasoningTokens: data.completion_tokens_details?.reasoning_tokens ?? null,
    cacheReadTokens: data.prompt_tokens_details?.cached_tokens ?? data.prompt_cache_hit_tokens ?? null,
  };
}

function parseJSON(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new ModelOutputError(); }
}

async function readJSON(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  let length = 0;
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    signal.throwIfAborted();
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) { throw new ModelOutputError(); }
    text += decoder.decode(chunk, { stream: true });
  }
  signal.throwIfAborted();
  return parseJSON(text + decoder.decode());
}

export function createOpenAICompatible(options: ClientOptions): ModelClient & ToolModel {
  const provider = options.provider ?? "openai-compatible";
  const deepseekV4 = provider === "deepseek" || !!options.modelId?.includes("deepseek-v4");

  function encodeMessages(system: string | undefined, messages: readonly (ModelMessage | ToolMessage)[]) {
    return [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages.flatMap<Record<string, unknown>>((message) => {
        if (message.role === "tool") {
          return message.observations.map(({ id, value }) => ({
            role: "tool", tool_call_id: id, content: JSON.stringify(value) ?? "null",
          }));
        }
        if (message.role !== "assistant") { return [{ role: message.role, content: message.content }]; }
        const toolCalls = "calls" in message && message.calls.length ? message.calls.map(({ id, name, input }) => ({
          id, type: "function", function: { name, arguments: JSON.stringify(input) },
        })) : undefined;
        const reasoning = "reasoning" in message ? message.reasoning : "";
        return [{
          role: "assistant", content: message.content, tool_calls: toolCalls,
          ...(deepseekV4 && { reasoning_content: reasoning }),
        }];
      }),
    ];
  }

  async function send(body: Record<string, unknown>, signal?: AbortSignal) {
    if (!options.modelId || options.requireApiKey && !options.apiKey?.trim()) { throw new ModelAuthError(); }
    signal?.throwIfAborted();
    const response = await (options.fetch ?? fetch)(`${options.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", signal, redirect: "manual", ...(isLoopback(options.baseURL) && { proxy: false }),
      headers: { "Content-Type": "application/json", ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({ ...options.extraBody, ...body, model: options.modelId }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelHttpError(response.status);
    }
    if (!response.body) { throw new ModelOutputError(); }
    return response.body;
  }

  return {
    provider, modelId: options.modelId ?? "未配置",
    async *stream(request, signal): AsyncGenerator<ModelEvent> {
      const signals = [request.signal, signal].filter((s): s is AbortSignal => s !== undefined);
      const abortSignal = signals.length ? AbortSignal.any(signals) : undefined;
      abortSignal?.throwIfAborted();
      request.guard?.();
      const body = await send({
        ...request.extraBody, messages: encodeMessages(request.system, request.messages),
        stream: true, stream_options: { include_usage: true }, max_tokens: request.maxOutputTokens,
      }, abortSignal);
      let reason: Extract<ModelEvent, { type: "finish" }>["finishReason"] = "other";
      let finished = false;
      let usage: ModelUsage | undefined;
      for await (const data of sse(body)) {
        abortSignal?.throwIfAborted();
        if (data.trim() === "[DONE]") { break; }
        const parsed = chunkSchema.safeParse(parseJSON(data));
        if (!parsed.success || parsed.data.error) { throw new ModelOutputError(); }
        usage = readUsage(parsed.data.usage) ?? usage;
        const choice = parsed.data.choices?.[0];
        if (choice?.finish_reason != null) {
          finished = true;
          const raw = choice.finish_reason;
          reason = raw === "stop" || raw === "length" || raw === "error" ? raw : raw === "content_filter" ? "content-filter" : "other";
        }
        const delta = choice?.delta;
        if (delta?.tool_calls?.length) { throw new ModelOutputError(); }
        if (delta?.content) { yield { type: "text-delta", delta: delta.content }; }
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoning) { yield { type: "reasoning-delta", delta: reasoning }; }
      }
      abortSignal?.throwIfAborted();
      if (!finished) { throw new ModelOutputError(); }
      yield { type: "finish", finishReason: reason, ...(usage && { usage }) };
    },
    async complete(request, signal) {
      signal.throwIfAborted();
      request.guard?.();
      const body = await send({
        messages: encodeMessages(request.system, request.messages), stream: false,
        ...(request.tools.length > 0 && { tools: toolDefinitions(request.tools), tool_choice: "auto" }),
        max_tokens: request.maxOutputTokens,
      }, signal);
      const result = completionSchema.safeParse(await readJSON(body, signal));
      if (!result.success || result.data.error) { throw new ModelOutputError(); }
      const { finish_reason: raw, message } = result.data.choices[0];
      const finishReason = raw === "tool_calls" ? "tool-calls"
        : raw === "stop" || raw === "length" || raw === "error" ? raw : "other";
      const usage = readUsage(result.data.usage);
      return {
        finishReason, text: message.content ?? "", reasoning: message.reasoning_content ?? message.reasoning ?? "",
        outputTokens: usage?.outputTokens ?? request.maxOutputTokens, usage,
        calls: (message.tool_calls ?? []).map(({ id, function: fn }) => ({
          id, name: fn.name, input: parseJSON(fn.arguments),
        })),
      };
    },
  };
}

export function createDeepSeek(options: Omit<ClientOptions, "baseURL" | "provider" | "requireApiKey"> & { baseURL?: string }) {
  return createOpenAICompatible({ ...options, baseURL: options.baseURL ?? "https://api.deepseek.com", provider: "deepseek", requireApiKey: true });
}
