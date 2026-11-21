import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { budgetMessages, createContextSummarizer, createOpenAICompatible, emptyUsage, estimateRequest, INPUT_BUDGET,
  runCatAgent, runModelStep, SUMMARY_INSTRUCTIONS, SUMMARY_LABEL, SUMMARY_RESERVE, summaryInput, toolSchemas,
  type ModelEvent, type ModelMessage } from '../src/llm/index.ts';
import { scriptedClient } from '../src/llm/testing.ts';

const usage = { ...emptyUsage(), inputTokens: 20, outputTokens: 7 };
const answer = (text = '好'): ModelEvent[] => [{ type: 'text-delta', delta: text }, { type: 'finish', finishReason: 'stop', usage }];
const messages: ModelMessage[] = [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧事实'.repeat(15000) }, { role: 'user', content: '当前问题' }];
const base = () => ({ instructions: '', messages, tools: {}, signal: new AbortController().signal, guard: async () => {} });

it('未启用摘要沿用裁剪；预算内不调用摘要器', async () => {
  const client = scriptedClient([answer(), answer()]);
  await runModelStep({ ...base(), client });
  expect(client.requests[0]!.messages).toEqual(budgetMessages('', messages, {}));
  const summarize = vi.fn(async () => '摘要');
  const short: ModelMessage[] = [{ role: 'user', content: '当前问题' }];
  await runModelStep({ ...base(), messages: short, client, contextSummarizer: summarize });
  expect(summarize).not.toHaveBeenCalled(); expect(client.requests[1]!.messages).toEqual(short);
});

it('前台超预算插入有界数据摘要，保留当前问题和完整工具配对', async () => {
  const chain: ModelMessage[] = [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'lookup', toolCallId: 'keep', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'lookup', toolCallId: 'keep', output: { type: 'json', value: { status: 'succeeded' } } }] }];
  const client = scriptedClient([answer()]);
  const summarize = vi.fn(async (_dropped: ModelMessage[], _signal: AbortSignal) => '用户更正为不喝咖啡。');
  await runCatAgent({ ...base(), messages: [...messages, ...chain], client, contextSummarizer: summarize,
    onText: async () => {}, onTool: async () => {}, onStep: async () => {} });
  expect(summarize).toHaveBeenCalledTimes(1);
  expect(summarize.mock.calls[0]![0]).toEqual(messages.slice(0, 2));
  const request = client.requests[0]!;
  expect(request.messages[0]).toEqual({ role: 'user', content: SUMMARY_LABEL + '用户更正为不喝咖啡。' });
  expect(request.messages).toContain(messages[2]); expect(request.messages.slice(-2)).toEqual(chain);
  expect(estimateRequest(request.system!, request.messages, toolSchemas({ finish_tools: { inputSchema: z.object({}) } }))).toBeLessThanOrEqual(INPUT_BUDGET);
});

it('相同丢弃前缀在多步循环只产生一次摘要模型调用', async () => {
  const summaries = scriptedClient([answer('旧事实摘要')]); const onUsage = vi.fn();
  const summarize = createContextSummarizer({ client: summaries, onUsage });
  const client = scriptedClient([[
    { type: 'tool-call', toolCallId: 'one', toolName: 'lookup', input: {}, rawInput: '{}' },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ], answer()]);
  await runCatAgent({ ...base(), client, contextSummarizer: summarize, tools: { lookup: { description: '', inputSchema: z.object({}),
    execute: async () => ({ status: 'succeeded', source: 'test', observed_at: '', data: {} }) } },
    onText: async () => {}, onTool: async () => {}, onStep: async () => {} });
  expect(client.requests).toHaveLength(2); expect(summaries.requests).toHaveLength(1); expect(onUsage).toHaveBeenCalledTimes(1);
  expect(summaries.requests[0]).toMatchObject({ stream: false, maxOutputTokens: 800, toolChoice: 'none', system: SUMMARY_INSTRUCTIONS });
});

it('摘要失败不泄漏内容，回退普通裁剪', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const client = scriptedClient([answer()]);
    await runModelStep({ ...base(), client, contextSummarizer: async () => { throw new Error('private content'); } });
    expect(client.requests[0]!.messages).toEqual(budgetMessages('', messages, {}));
    expect(warning).toHaveBeenCalledWith('context_summary_failed');
  } finally { warning.mockRestore(); }
});

it('摘要期间取消或权限撤回均阻止后续模型请求', async () => {
  const controller = new AbortController(), client = scriptedClient([answer()]);
  await expect(runModelStep({ ...base(), client, signal: controller.signal, contextSummarizer: async () => {
    controller.abort(new Error('stopped')); return '旧内容';
  } })).rejects.toThrow('stopped');
  let revoked = false;
  await expect(runModelStep({ ...base(), client, guard: async () => { if (revoked) throw new Error('withdrawn'); },
    contextSummarizer: async () => { revoked = true; return '旧内容'; } })).rejects.toThrow('withdrawn');
  expect(client.requests).toHaveLength(0);
});

it('超长含转义符摘要按码点与序列化字节限额截断', async () => {
  const client = scriptedClient([answer()]);
  await runModelStep({ ...base(), client, contextSummarizer: async () => '🐈\n"'.repeat(10000) });
  const request = client.requests[0]!, summary = request.messages[0]!;
  expect(Buffer.byteLength(JSON.stringify(summary)) + 1).toBeLessThanOrEqual(SUMMARY_RESERVE);
  expect(estimateRequest('', request.messages, {})).toBeLessThanOrEqual(INPUT_BUDGET);
  expect(JSON.stringify(summary)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
});

it('必要尾部无法容纳时保持预算错误且不调用摘要器', async () => {
  const summarize = vi.fn(async () => '摘要'), client = scriptedClient([answer()]);
  await expect(runModelStep({ ...base(), client, messages: [{ role: 'user', content: '猫'.repeat(30000) }], contextSummarizer: summarize })).rejects.toThrow('model_input_budget');
  expect(summarize).not.toHaveBeenCalled(); expect(client.requests).toHaveLength(0);
});

it('摘要输入有界并优先保留最近片段；空或异常输出不缓存', async () => {
  const input = summaryInput(Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `${i}:` + '猫'.repeat(3000) })));
  expect(Buffer.byteLength(input)).toBeLessThanOrEqual(40 * 1024); expect(input).toContain('49:'); expect(input).not.toContain('user: 0:');
  const client = scriptedClient([answer(''), answer('已更正')]), onUsage = vi.fn();
  const summarize = createContextSummarizer({ client, onUsage });
  await expect(summarize(messages, new AbortController().signal)).rejects.toThrow('上下文摘要无效');
  expect(await summarize(messages, new AbortController().signal)).toBe('已更正');
  expect(onUsage).toHaveBeenCalledTimes(2);
});

it('OpenAI 兼容摘要请求使用非流式 wire 并记录用量', async () => {
  const bodies: Record<string, unknown>[] = [];
  const client = createOpenAICompatible({ modelId: 'local', baseURL: 'http://localhost/v1', fetch: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: '用户不喝咖啡。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 7 } });
  } });
  const onUsage = vi.fn();
  expect(await createContextSummarizer({ client, onUsage })(messages, new AbortController().signal)).toBe('用户不喝咖啡。');
  expect(bodies[0]).toMatchObject({ stream: false, max_tokens: 800 }); expect(bodies[0]).not.toHaveProperty('stream_options');
  expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 20, outputTokens: 7 }), expect.any(Number));
});

it.each(['not-json', '{}', '{"error":{"message":"provider error"}}'])('非流式错误响应严格失败且不隐藏重试：%s', async body => {
  const fetcher = vi.fn(async () => new Response(body));
  const client = createOpenAICompatible({ modelId: 'local', baseURL: 'http://localhost/v1', fetch: fetcher });
  const onUsage = vi.fn();
  await expect(createContextSummarizer({ client, onUsage })(messages, new AbortController().signal)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(onUsage).toHaveBeenCalledWith(null, expect.any(Number));
});

it('摘要用量持久化失败保持致命错误，不继续主请求', async () => {
  const client = scriptedClient([answer()]), summary = scriptedClient([answer('摘要')]);
  await expect(runModelStep({ ...base(), client, contextSummarizer: createContextSummarizer({ client: summary,
    onUsage: () => { throw new Error('accounting failed'); } }) })).rejects.toThrow('accounting failed');
  expect(client.requests).toHaveLength(0);
});
