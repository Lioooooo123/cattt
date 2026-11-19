import { describe, expect, it } from 'vitest';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { config, modelConfigProblems, slotSpec } from '../src/config.ts';
import { OPENAI_COMPAT_NAME, thinkingOptions } from '../src/runtime/model.ts';
import { runCatAgent, type RuntimeTool } from '../src/runtime/agent.ts';

const base = {
  MODEL_PROVIDER: 'openai-compatible', OPENAI_COMPAT_MODEL: 'qwen3:8b', MAOMAO_DEEPSEEK_API_KEY: undefined,
  CHAT_PROVIDER: undefined, CHAT_MODEL: undefined, CHAT_THINKING: 'disabled',
  EXTRACT_PROVIDER: undefined, EXTRACT_MODEL: undefined, EXTRACT_THINKING: 'disabled',
  ROUTER_PROVIDER: undefined, ROUTER_MODEL: undefined, ROUTER_THINKING: 'disabled',
  WORKER_PROVIDER: undefined, WORKER_MODEL: undefined, WORKER_THINKING: 'enabled',
} satisfies Parameters<typeof modelConfigProblems>[0];

describe('模型来源配置', () => {
  it('兼容来源各槽位默认共用 OPENAI_COMPAT_MODEL，槽位可单独改来源与模型', () => {
    expect(slotSpec('chat', base)).toEqual({ name: 'chat', provider: 'openai-compatible', model: 'qwen3:8b', thinking: 'disabled' });
    const mixed = { ...base, WORKER_PROVIDER: 'deepseek', EXTRACT_MODEL: 'qwen3:4b', MAOMAO_DEEPSEEK_API_KEY: 'sk-test' } as const;
    expect(slotSpec('worker', mixed)).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', thinking: 'enabled' });
    expect(slotSpec('extract', mixed)).toMatchObject({ provider: 'openai-compatible', model: 'qwen3:4b' });
    expect(modelConfigProblems(mixed)).toEqual([]);
  });
  it('mock 盖过所有槽位设置', () => {
    expect(slotSpec('worker', { ...base, MODEL_PROVIDER: 'mock', WORKER_PROVIDER: 'deepseek' }).provider).toBe('mock');
  });
  it('缺模型名或缺 DeepSeek key 时说清楚缺什么', () => {
    const problems = modelConfigProblems({ ...base, OPENAI_COMPAT_MODEL: undefined, CHAT_MODEL: 'qwen3:8b', ROUTER_PROVIDER: 'deepseek' });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('MAOMAO_DEEPSEEK_API_KEY');
    expect(problems[1]).toContain('EXTRACT_MODEL、WORKER_MODEL');
  });
  it('思考开关按来源与参数风格映射', () => {
    expect(thinkingOptions('deepseek', 'disabled')).toEqual({ deepseek: { thinking: { type: 'disabled' } } });
    expect(thinkingOptions('openai-compatible', 'disabled', 'reasoning_effort')).toEqual({ [OPENAI_COMPAT_NAME]: { reasoningEffort: 'none' } });
    expect(thinkingOptions('openai-compatible', 'enabled', 'reasoning_effort')).toEqual({});
    expect(thinkingOptions('openai-compatible', 'disabled', 'chat_template_kwargs')).toEqual({ [OPENAI_COMPAT_NAME]: { chat_template_kwargs: { enable_thinking: false } } });
    expect(thinkingOptions('openai-compatible', 'disabled', 'none')).toEqual({});
  });
  it('默认来源是本机 OpenAI 兼容服务，不内置任何 key', () => {
    expect(config.OPENAI_COMPAT_BASE_URL).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
  });
});

type Request = { model: string; stream?: boolean; tools?: { function: { name: string } }[]; tool_choice?: unknown;
  response_format?: { type: string; json_schema?: { schema: unknown } }; reasoning_effort?: string; chat_template_kwargs?: unknown; stream_options?: unknown };
/** 按 Ollama / LM Studio / llama.cpp 的 /v1/chat/completions 流式格式应答 */
function fakeServer(reply: (request: Request, index: number) => object[]) {
  const requests: Request[] = []; const urls: string[] = [];
  const provider = createOpenAICompatible({ name: OPENAI_COMPAT_NAME, baseURL: 'http://127.0.0.1:11434/v1', includeUsage: true, supportsStructuredOutputs: true,
    fetch: async (url, init) => {
      const request = JSON.parse(String(init?.body)) as Request;
      requests.push(request); urls.push(String(url));
      const deltas = reply(request, requests.length - 1);
      const chunk = (delta: object, finish_reason: string | null, usage?: object) => ({
        id: 'local', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
      });
      const last = deltas.some(d => 'tool_calls' in d) ? 'tool_calls' : 'stop';
      if (!request.stream) {
        const message = Object.assign({ role: 'assistant' }, ...deltas);
        return Response.json({ id: 'local', object: 'chat.completion', created: 0, model: request.model,
          choices: [{ index: 0, message, finish_reason: last }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } });
      }
      const parts = [...deltas.map(d => chunk(d, null)), chunk({}, last, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })];
      return new Response(parts.map(p => `data: ${JSON.stringify(p)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
  return { provider, requests, urls };
}

const observation = { status: 'succeeded' as const, source: 'fixture', observed_at: '2026-11-19T00:00:00Z', data: { weather: '晴' } };
const lookup: RuntimeTool = { description: '查天气', inputSchema: z.object({ city: z.string() }), execute: async () => observation };

describe('OpenAI 兼容来源与现有调用方式', () => {
  it('聊天工具循环：调工具、终答 tool_choice=none、思考内容不进正文、关思考的参数到达请求', async () => {
    const call = (id: string, name: string, args: string) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] });
    const server = fakeServer((request, i) => i === 0
      ? [{ reasoning_content: '用户问天气，我查一下。' }, call('call-1', 'lookup', '{"city":"杭州"}')]
      : i === 1 ? [call('call-2', 'finish_tools', '{}')]
      : [{ reasoning: '查到了。' }, { content: request.tool_choice === 'none' ? '杭州今天晴，喵。' : '<tool_call>' }]);
    let text = ''; const tools: string[] = []; const usage: (number | undefined)[] = [];
    await runCatAgent({ model: server.provider.chatModel('qwen3:8b'), providerOptions: thinkingOptions('openai-compatible', 'disabled', 'reasoning_effort'),
      instructions: '猫', messages: [{ role: 'user', content: '杭州天气怎么样' }], tools: { lookup },
      signal: new AbortController().signal, guard: async () => {}, onText: async t => { text += t; },
      onTool: async t => { if (t.output) tools.push(`${t.tool}:${t.output.status}`); },
      onStep: async s => { usage.push(s.usage?.inputTokens); } });
    expect(server.urls[0]).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(server.requests).toHaveLength(3);
    expect(server.requests[0]!.tools?.map(t => t.function.name)).toEqual(['lookup', 'finish_tools']);
    expect(server.requests.every(r => r.reasoning_effort === 'none')).toBe(true);
    expect(server.requests[0]!.stream_options).toEqual({ include_usage: true });
    expect(server.requests.map(r => r.tool_choice)).toEqual(['auto', 'auto', 'none']);
    expect(server.requests[2]!.tools?.map(t => t.function.name)).toEqual(['lookup', 'finish_tools']);
    expect(tools).toEqual(['lookup:succeeded', 'finish_tools:succeeded']);
    expect(text).toBe('杭州今天晴，喵。');
    expect(usage).toEqual([12, 12, 12]);
  });
  it('结构化输出走 json_schema，chat_template_kwargs 原样透传', async () => {
    const schema = z.object({ terms: z.array(z.string()) });
    const server = fakeServer(() => [{ content: '{"terms":["饮食","口味"]}' }]);
    const { output, usage } = await generateText({ model: server.provider.chatModel('qwen3:8b'), prompt: '晚饭吃什么',
      output: Output.object({ schema }), providerOptions: thinkingOptions('openai-compatible', 'disabled', 'chat_template_kwargs'), maxRetries: 0 });
    expect(output).toEqual({ terms: ['饮食', '口味'] });
    expect(usage.inputTokens).toBe(12);
    const request = server.requests[0]!;
    expect(request.response_format?.type).toBe('json_schema');
    expect(request.response_format?.json_schema?.schema).toMatchObject({ type: 'object', required: ['terms'] });
    expect(request.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(request.reasoning_effort).toBeUndefined();
  });
  it('后台执行者 toolChoice=required 能发到兼容服务', async () => {
    const server = fakeServer(() => [{ tool_calls: [{ index: 0, id: 'r', type: 'function', function: { name: 'report', arguments: '{"status":"ready"}' } }] }]);
    const { tool } = await import('ai');
    const result = await generateText({ model: server.provider.chatModel('qwen3:8b'), prompt: '想一想', maxRetries: 0, toolChoice: 'required',
      tools: { report: tool({ description: '报告', inputSchema: z.object({ status: z.string() }), execute: async () => 'ok' }) } });
    expect(server.requests[0]!.tool_choice).toBe('required');
    expect(result.toolCalls.map(c => c.input)).toEqual([{ status: 'ready' }]);
  });
});
