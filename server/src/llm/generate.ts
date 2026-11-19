import type { z } from 'zod';
import { ModelHttpError, ModelOutputError } from './errors.ts';
import { emptyUsage, type FinishReason, type ModelClient, type ModelMessage, type ModelRequest, type ToolCall } from './types.ts';

export type GenerateOptions = { maxRetries?: number; retryDelayMs?: number };

function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof ModelHttpError) return error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500 && error.statusCode < 600;
  return error instanceof TypeError || error instanceof Error && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(String((error as NodeJS.ErrnoException).code));
}

export async function generateText(client: ModelClient, request: ModelRequest, options: GenerateOptions = {}) {
  const retries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    request.signal?.throwIfAborted();
    try {
      let text = '', reasoning = '';
      const toolCalls: ToolCall[] = [];
      let finishReason: FinishReason = 'other';
      let usage = emptyUsage();
      let finished = false;
      for await (const event of client.stream(request, request.signal)) {
        request.signal?.throwIfAborted();
        switch (event.type) {
          case 'text-delta': text += event.delta; break;
          case 'reasoning-delta': reasoning += event.delta; break;
          case 'tool-call': toolCalls.push(event); break;
          case 'finish': finishReason = event.finishReason; usage = event.usage; finished = true; break;
        }
      }
      if (!finished) throw new ModelOutputError('模型响应缺少结束事件');
      const responseMessages: ModelMessage[] = [{ role: 'assistant', content: [
        ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...toolCalls.map(call => ({ type: 'tool-call' as const, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input })),
      ] }];
      return { text, reasoning, toolCalls, finishReason, usage, responseMessages };
    } catch (error) {
      request.signal?.throwIfAborted();
      if (attempt >= retries || !retryable(error)) throw error;
      await backoff((options.retryDelayMs ?? 250) * 2 ** attempt, request.signal);
    }
  }
}

export async function generateObject<T>(client: ModelClient, request: ModelRequest, schema: z.ZodType<T>, options: GenerateOptions = {}) {
  const result = await generateText(client, { ...request, responseFormat: { type: 'json', schema } }, options);
  try {
    return { object: schema.parse(JSON.parse(result.text)), usage: result.usage };
  } catch (cause) { throw new ModelOutputError('模型输出不是合法 JSON 或不符合结构', { cause }); }
}
