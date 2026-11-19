import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDeepSeek, createOpenAICompatible, emptyUsage, generateObject, generateText, ModelAuthError, ModelHttpError, ModelOutputError, type ModelEvent, type ModelRequest } from '../src/llm/index.ts';
import { scriptedClient } from '../src/llm/testing.ts';

const request: ModelRequest = { messages: [{ role: 'user', content: '你好' }] };
const finish: ModelEvent = { type: 'finish', finishReason: 'stop', usage: emptyUsage() };
function chunk(delta: object, finish_reason: string | null = null) { return { choices: [{ delta, finish_reason }] }; }
function response(chunks: object[], split = 7) {
  const bytes = new TextEncoder().encode(': ping\r\n\r\n' + chunks.map(c => 'data: ' + JSON.stringify(c) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n');
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split));
    controller.close();
  } }));
}
function fixture(deepseek = false, chunks: object[] = [chunk({ content: '好' }, 'stop')]) {
  const bodies: Record<string, any>[] = [];
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    urls.push(String(url)); bodies.push(JSON.parse(String(init?.body))); return response(chunks);
  };
  const options = { modelId: 'deepseek-v4-flash', apiKey: 'fixture', fetch: fakeFetch };
  const client = deepseek ? createDeepSeek({ ...options, thinking: 'disabled' })
    : createOpenAICompatible({ ...options, baseURL: 'http://localhost/v1/' });
  return { client, bodies, urls };
}

describe('流式模型客户端', () => {
  it('按单字节解码中文、CRLF、注释、多行 data 和 DONE，保留最后用量', async () => {
    const fetcher: typeof fetch = async () => {
      const text = 'data: {"choices":\r\ndata: [{"delta":{"content":"猫","reasoning_content":"想"},"finish_reason":"stop"}]}\r\n\r\n'
        + 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":6,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":2}}}\n\ndata: [DONE]\n\ndata: invalid\n\n';
      const bytes = new TextEncoder().encode(text);
      return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }));
    };
    const client = createOpenAICompatible({ baseURL: 'http://fixture', modelId: 'm', fetch: fetcher });
    const result = await generateText(client, request);
    expect(result.text).toBe('猫'); expect(result.reasoning).toBe('想');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 6, cacheReadTokens: 4, reasoningTokens: 2 });
  });
  it('按 index 拼接交错工具参数，保留原文与 DeepSeek 缓存用量', async () => {
    const f = fixture(true, [
      chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{' } }, { index: 0, id: 'a', function: { name: 'first', arguments: '{"x":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '}' } }] }, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 8, prompt_cache_hit_tokens: 3, completion_tokens: 4 } },
    ]);
    const result = await generateText(f.client, request);
    expect(result.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'a', toolName: 'first', input: { x: 1 }, rawInput: '{"x":1}' },
      { type: 'tool-call', toolCallId: 'b', toolName: 'second', input: {}, rawInput: '{}' },
    ]);
    expect(result.finishReason).toBe('tool-calls'); expect(result.usage.cacheReadTokens).toBe(3);
    expect(result.responseMessages[0]?.content).toHaveLength(2);
  });
  it('保留 none 的工具定义、历史检查点与 reasoning_content', async () => {
    const f = fixture(true);
    await generateText(f.client, { system: '猫', messages: [
      { role: 'system', content: '系统' }, { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '查' }, { type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: {} }] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'c', toolName: 'lookup', output: { type: 'json', value: { ok: true } } },
        { type: 'tool-result', toolCallId: 'd', toolName: 'lookup', output: { type: 'error-text', value: '失败' } },
        { type: 'tool-result', toolCallId: 'e', toolName: 'lookup', output: { type: 'execution-denied' } },
      ] }, { role: 'assistant', content: '结束' },
    ], tools: [{ name: 'lookup', description: '查询', inputSchema: z.object({}) }], toolChoice: 'none', maxOutputTokens: 30 });
    const body = f.bodies[0]!;
    expect(f.urls).toEqual(['https://api.deepseek.com/chat/completions']);
    expect(body).toMatchObject({ thinking: { type: 'disabled' }, tool_choice: 'none', max_tokens: 30, stream_options: { include_usage: true } });
    expect(body.tools[0].function.name).toBe('lookup');
    expect(body.messages[3]).toMatchObject({ reasoning_content: '思考', tool_calls: [{ function: { arguments: '{}' } }] });
    expect(body.messages.slice(4, 7).map((m: any) => m.content)).toEqual(['{"ok":true}', '失败', 'Tool call execution denied.']);
    expect(body.messages[7].reasoning_content).toBe('');
  });
  it.each([{ reasoning_effort: 'none' }, { chat_template_kwargs: { enable_thinking: false } }])('兼容思考参数直接上网线 %j', async extraBody => {
    const f = fixture(); await generateText(f.client, { ...request, extraBody });
    expect(f.bodies[0]).toMatchObject(extraBody); expect(f.urls[0]).toBe('http://localhost/v1/chat/completions');
  });
  it.each([false, true])('结构化输出 deepseek=%s', async deepseek => {
    const f = fixture(deepseek, [chunk({ content: '{"answer":"好"}' }, 'stop')]);
    const result = await generateObject(f.client, request, z.object({ answer: z.string() }));
    expect(result.object).toEqual({ answer: '好' });
    if (deepseek) {
      expect(f.bodies[0]!.response_format).toEqual({ type: 'json_object' });
      expect(f.bodies[0]!.messages[0].content).toContain('Return JSON that conforms to the following schema:');
    } else expect(f.bodies[0]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, name: 'response', schema: { type: 'object' } } });
  });
  it('结构化输出按 draft-07 输入语义保留默认字段可选，解析时再补默认值', async () => {
    const f = fixture(false, [chunk({ content: '{"memories":[{"value":"不喝咖啡"}]}' }, 'stop')]);
    const schema = z.object({ clarification: z.string().default(''), memories: z.array(z.object({
      value: z.string(), explicit: z.boolean().default(false),
    })) });
    const result = await generateObject(f.client, request, schema);
    expect(result.object).toEqual({ clarification: '', memories: [{ value: '不喝咖啡', explicit: false }] });
    expect(f.bodies[0]!.response_format).toEqual({ type: 'json_schema', json_schema: {
      name: 'response', strict: true, schema: {
        $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
        properties: { clarification: { type: 'string', default: '' }, memories: { type: 'array', items: {
          type: 'object', additionalProperties: false, properties: {
            value: { type: 'string' }, explicit: { type: 'boolean', default: false },
          }, required: ['value'],
        } } }, required: ['memories'],
      },
    } });
  });
  it('工具 schema 保留字典约束和嵌套默认值，JSON Schema 输入不改写', async () => {
    const f = fixture();
    const raw = { type: 'object', properties: {}, additionalProperties: true };
    await generateText(f.client, { ...request, tools: [
      { name: 'lookup', inputSchema: z.object({ options: z.object({ count: z.number().default(1) }), labels: z.record(z.string(), z.string()) }) },
      { name: 'empty', inputSchema: z.object({}) },
      { name: 'passthrough', inputSchema: z.object({}).passthrough() },
      { name: 'raw', inputSchema: raw },
    ] });
    const parameters = f.bodies[0]!.tools.map((tool: any) => tool.function.parameters);
    expect(parameters[0].properties.options.required ?? []).not.toContain('count');
    expect(parameters[0].properties.options.additionalProperties).toBe(false);
    expect(parameters[0].properties.labels.additionalProperties).toEqual({ type: 'string' });
    expect(parameters[1].additionalProperties).toBe(false);
    expect(parameters[2].additionalProperties).toEqual({});
    expect(parameters[3]).toEqual(raw);
  });
  it.each(['bad', '{"answer":1}', ''])('JSON 或 schema 错误不重试 %s', async text => {
    const f = fixture(false, [chunk({ content: text }, 'stop')]);
    await expect(generateObject(f.client, request, z.object({ answer: z.string() }))).rejects.toBeInstanceOf(ModelOutputError);
    expect(f.bodies).toHaveLength(1);
  });
  it('缺少 key 在请求前失败；兼容本机不要求 key', async () => {
    const fetcher = vi.fn();
    await expect(generateText(createDeepSeek({ modelId: 'm', fetch: fetcher }), request)).rejects.toBeInstanceOf(ModelAuthError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 402, 403, 408, 422, 429, 500, 503])('HTTP %s 保留状态和片段', async status => {
    const client = createOpenAICompatible({ baseURL: 'http://fixture', modelId: 'm', fetch: async () => new Response('错误'.repeat(2000), { status }) });
    try { await generateText(client, request, { maxRetries: 0 }); throw new Error('未失败'); }
    catch (error) { expect(ModelHttpError.isInstance(error)).toBe(true); expect(error).toMatchObject({ statusCode: status }); expect((error as ModelHttpError).responseBody).toHaveLength(2048); }
  });
  it.each(['[]', '{', 'null'])('非法工具参数 %s', async args => {
    const f = fixture(false, [chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: args } }] }, 'tool_calls')]);
    await expect(generateText(f.client, request)).rejects.toBeInstanceOf(ModelOutputError);
  });
  it('截断和错误 SSE 拒绝', async () => {
    for (const body of ['data: nope\n\n', 'data: {"choices":[]}\n\n', 'data: {"error":{"message":"失败"}}\n\n']) {
      const client = createOpenAICompatible({ baseURL: 'http://fixture', modelId: 'm', fetch: async () => new Response(body) });
      await expect(generateText(client, request)).rejects.toBeInstanceOf(ModelOutputError);
    }
  });
});

describe('生成与重试', () => {
  it.each([408, 429, 500, 503])('可重试 HTTP %s', async status => {
    const client = scriptedClient([new ModelHttpError(status, '失败', ''), [{ type: 'text-delta', delta: '好' }, finish]]);
    expect((await generateText(client, request, { retryDelayMs: 0 })).text).toBe('好'); expect(client.requests).toHaveLength(2);
  });
  it.each([400, 401, 402, 403, 404, 422])('不重试 HTTP %s', async status => {
    const client = scriptedClient([new ModelHttpError(status, '失败', ''), [finish]]);
    await expect(generateText(client, request, { retryDelayMs: 0 })).rejects.toBeInstanceOf(ModelHttpError); expect(client.requests).toHaveLength(1);
  });
  it('网络失败重试至上限，空结果用量可空，记录请求', async () => {
    const client = scriptedClient([new TypeError('fetch failed'), new TypeError('fetch failed'), [finish]]);
    await expect(generateText(client, request, { maxRetries: 1, retryDelayMs: 0 })).rejects.toThrow('fetch failed');
    expect(client.requests).toHaveLength(2);
    const result = await generateText(client, request);
    expect(result.text).toBe(''); expect(result.usage).toEqual(emptyUsage()); expect(client.requests[0]).toEqual(request);
  });
  it('退避指数增加并支持取消', async () => {
    vi.useFakeTimers();
    try {
      const client = scriptedClient([new TypeError('网络'), new TypeError('网络'), [finish]]);
      const promise = generateText(client, request, { retryDelayMs: 100 });
      await vi.advanceTimersByTimeAsync(99); expect(client.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(client.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200); await promise; expect(client.requests).toHaveLength(3);
    } finally { vi.useRealTimers(); }
    const controller = new AbortController();
    const client = scriptedClient([new TypeError('网络'), [finish]]);
    const promise = generateText(client, { ...request, signal: controller.signal }, { retryDelayMs: 10000 });
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejection; expect(client.requests.length).toBeLessThanOrEqual(1);
  });
});
