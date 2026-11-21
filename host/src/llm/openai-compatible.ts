import { z } from "zod";
import { ModelAuthError, ModelHttpError, ModelOutputError } from "./errors.ts";
import type { ModelClient, ModelEvent } from "./types.ts";

export interface ClientOptions {
  baseURL: string;
  modelId?: string;
  apiKey?: string;
  provider?: string;
  requireApiKey?: boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  extraBody?: Record<string, unknown>;
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  function line(value: string): string | undefined {
    if (!value) {
      if (!data.length) { return; }
      const result = data.join("\n"); data = []; return result;
    }
    if (value.startsWith("data:")) { data.push(value.slice(5).replace(/^ /, "")); }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
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
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    delta: z.object({
      content: z.string().nullish(), reasoning_content: z.string().nullish(), reasoning: z.string().nullish(),
      tool_calls: z.array(z.unknown()).optional(),
    }).optional(),
  })).optional(),
});

export function createOpenAICompatible(options: ClientOptions): ModelClient {
  return {
    provider: options.provider ?? "openai-compatible", modelId: options.modelId ?? "未配置",
    async *stream(request, signal): AsyncGenerator<ModelEvent> {
      if (!options.modelId || options.requireApiKey && !options.apiKey?.trim()) { throw new ModelAuthError(); }
      const signals = [request.signal, signal].filter((s): s is AbortSignal => s !== undefined);
      const abortSignal = signals.length ? AbortSignal.any(signals) : undefined;
      abortSignal?.throwIfAborted();
      const response = await (options.fetch ?? fetch)(`${options.baseURL.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", signal: abortSignal,
        headers: { "Content-Type": "application/json", ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ ...options.extraBody, ...request.extraBody, model: options.modelId,
          messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages.map((message) => ({
            ...message, ...(message.role === "assistant" && options.modelId!.includes("deepseek-v4") ? { reasoning_content: "" } : {}),
          }))], stream: true, stream_options: { include_usage: true }, max_tokens: request.maxOutputTokens,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelHttpError(response.status);
      }
      if (!response.body) { throw new ModelOutputError(); }
      let reason: Extract<ModelEvent, { type: "finish" }>["finishReason"] = "other";
      let finished = false;
      for await (const data of sse(response.body)) {
        abortSignal?.throwIfAborted();
        if (data.trim() === "[DONE]") { break; }
        let json: unknown;
        try { json = JSON.parse(data); } catch { throw new ModelOutputError(); }
        const parsed = chunkSchema.safeParse(json);
        if (!parsed.success || parsed.data.error) { throw new ModelOutputError(); }
        const choice = parsed.data.choices?.[0];
        if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) {
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
      yield { type: "finish", finishReason: reason };
    },
  };
}

export function createDeepSeek(options: Omit<ClientOptions, "baseURL" | "provider" | "requireApiKey"> & { baseURL?: string }): ModelClient {
  return createOpenAICompatible({ ...options, baseURL: options.baseURL ?? "https://api.deepseek.com", provider: "deepseek", requireApiKey: true });
}
