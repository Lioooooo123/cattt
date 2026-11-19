import { ModelAuthError, ModelHttpError, ModelOutputError } from './errors.ts';
import { jsonSchema } from './schema.ts';
import { emptyUsage, type FinishReason, type ModelClient, type ModelEvent, type ModelMessage, type ModelRequest, type ModelUsage } from './types.ts';

export type ClientOptions = {
  baseURL: string;
  modelId: string;
  apiKey?: string;
  provider?: string;
  requireApiKey?: boolean;
  fetch?: typeof fetch;
  extraBody?: Record<string, unknown>;
};

function messagesForWire(messages: ModelMessage[], modelId: string): Record<string, unknown>[] {
  return messages.flatMap((message): Record<string, unknown>[] => {
    if (message.role === 'tool') return message.content.map(part => ({
      role: 'tool', tool_call_id: part.toolCallId,
      content: part.output.type === 'execution-denied' ? part.output.reason ?? 'Tool call execution denied.'
        : part.output.type === 'text' || part.output.type === 'error-text' ? part.output.value : JSON.stringify(part.output.value),
    }));
    if (typeof message.content === 'string') return [{ ...message,
      ...(message.role === 'assistant' && modelId.includes('deepseek-v4') ? { reasoning_content: '' } : {}),
    }];
    if (message.role === 'user') return [{ role: 'user', content: message.content }];
    const parts = message.content;
    const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
    const calls = parts.filter(p => p.type === 'tool-call').map(p => ({
      id: p.toolCallId, type: 'function', function: { name: p.toolName, arguments: JSON.stringify(p.input) },
    }));
    return [{ role: 'assistant', content: parts.filter(p => p.type === 'text').map(p => p.text).join(''),
      ...(reasoning || modelId.includes('deepseek-v4') ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls } : {}),
    }];
  });
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  function line(value: string): string | undefined {
    if (value === '') {
      if (!data.length) return;
      const result = data.join('\n'); data = []; return result;
    }
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = buffer.search(/[\r\n]/)) !== -1) {
        if (!done && buffer[index] === '\r' && index === buffer.length - 1) break;
        const result = line(buffer.slice(0, index));
        const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(index + length);
        if (result !== undefined) yield result;
      }
      if (done) break;
    }
    if (buffer) { const result = line(buffer); if (result !== undefined) yield result; }
    if (data.length) yield data.join('\n');
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function finishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop': case 'length': case 'error': return reason;
    case 'tool_calls': case 'function_call': return 'tool-calls';
    case 'content_filter': return 'content-filter';
    default: return 'other';
  }
}

export function createOpenAICompatible(options: ClientOptions): ModelClient {
  const provider = options.provider ?? 'openai-compatible';
  return {
    provider, modelId: options.modelId,
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
      if (options.requireApiKey && !options.apiKey?.trim()) throw new ModelAuthError();
      const signals = [request.signal, signal].filter((s): s is AbortSignal => s !== undefined);
      const abortSignal = signals.length ? AbortSignal.any(signals) : undefined;
      abortSignal?.throwIfAborted();
      const format = request.responseFormat;
      const schema = format?.schema ? jsonSchema(format.schema) : undefined;
      const messages = messagesForWire(request.messages, options.modelId);
      if (request.system) messages.unshift({ role: 'system', content: request.system });
      if (provider === 'deepseek' && format) messages.unshift({ role: 'system', content: schema
        ? 'Return JSON that conforms to the following schema: ' + JSON.stringify(schema) : 'Return JSON.' });
      const response = await (options.fetch ?? fetch)(`${options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal: abortSignal,
        headers: { 'Content-Type': 'application/json', ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ ...options.extraBody, ...request.extraBody,
          model: options.modelId, messages, stream: true, stream_options: { include_usage: true },
          max_tokens: request.maxOutputTokens,
          tools: request.tools?.map(tool => ({ type: 'function', function: {
            name: tool.name, description: tool.description, parameters: jsonSchema(tool.inputSchema),
          } })),
          tool_choice: request.toolChoice,
          response_format: format ? provider !== 'deepseek' && schema
            ? { type: 'json_schema', json_schema: { schema, strict: true, name: format.name ?? 'response', description: format.description } }
            : { type: 'json_object' } : undefined,
        }),
      });
      if (!response.ok) {
        const snippet = (await response.text()).slice(0, 2048);
        throw new ModelHttpError(response.status, `模型请求失败：${response.status} ${response.statusText}`, snippet);
      }
      if (!response.body) throw new ModelOutputError('模型返回了空响应流');
      const calls = new Map<number, { id: string; name: string; input: string }>();
      let usage: ModelUsage = emptyUsage();
      let reason: FinishReason = 'other';
      let finished = false;
      for await (const data of sse(response.body)) {
        abortSignal?.throwIfAborted();
        if (data.trim() === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(data); } catch (cause) { throw new ModelOutputError('模型 SSE 不是合法 JSON', { cause }); }
        if (chunk.error) throw new ModelOutputError(`模型流错误：${JSON.stringify(chunk.error)}`);
        if (chunk.usage) {
          const u = chunk.usage;
          usage = { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null,
            cacheReadTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null };
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason != null) { reason = finishReason(choice.finish_reason); finished = true; }
        const delta = choice?.delta;
        if (delta?.content) yield { type: 'text-delta', delta: delta.content };
        if (delta?.reasoning_content ?? delta?.reasoning) yield { type: 'reasoning-delta', delta: delta.reasoning_content ?? delta.reasoning };
        for (const part of delta?.tool_calls ?? []) {
          const call = calls.get(part.index) ?? { id: '', name: '', input: '' };
          call.id += part.id ?? ''; call.name += part.function?.name ?? ''; call.input += part.function?.arguments ?? '';
          calls.set(part.index, call);
        }
      }
      if (!finished) throw new ModelOutputError('模型响应流在结束原因之前中断');
      for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
        let input: unknown;
        try { input = JSON.parse(call.input); } catch (cause) { throw new ModelOutputError('工具参数不是合法 JSON', { cause }); }
        if (!call.id || !call.name || input === null || typeof input !== 'object' || Array.isArray(input)) throw new ModelOutputError('工具调用缺少名称、标识或对象参数');
        yield { type: 'tool-call', toolCallId: call.id, toolName: call.name, input: input as Record<string, unknown>, rawInput: call.input };
      }
      yield { type: 'finish', finishReason: reason, usage };
    },
  };
}

export function createDeepSeek(options: Omit<ClientOptions, 'baseURL' | 'provider' | 'requireApiKey'> & {
  baseURL?: string; thinking?: 'enabled' | 'disabled';
}): ModelClient {
  return createOpenAICompatible({ ...options, baseURL: options.baseURL ?? 'https://api.deepseek.com',
    provider: 'deepseek', requireApiKey: true,
    extraBody: { ...(options.thinking ? { thinking: { type: options.thinking } } : {}), ...options.extraBody },
  });
}
