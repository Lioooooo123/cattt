import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.ts';
import { sql } from '../src/db/client.ts';
import * as models from '../src/runtime/model.ts';
import { expandRecallQuery } from '../src/memory/query.ts';
const original = { mode: config.MEMORY_RECALL_MODE, timeout: config.MEMORY_RECALL_TIMEOUT_MS };
let day = Date.UTC(2030, 0, 1);
beforeEach(() => {
  vi.restoreAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(day += 86400000);
  config.MEMORY_RECALL_MODE = 'hybrid'; config.MEMORY_RECALL_TIMEOUT_MS = 100;
  vi.spyOn(models, 'recordModelCall').mockResolvedValue();
});
afterAll(async () => { vi.useRealTimers(); config.MEMORY_RECALL_MODE = original.mode; config.MEMORY_RECALL_TIMEOUT_MS = original.timeout; await sql.end(); });
function slot(doGenerate: (options: LanguageModelV4CallOptions) => Promise<ReturnType<typeof result>>) {
  const model = new MockLanguageModelV4({ doGenerate });
  const spy = vi.spyOn(models, 'recallSlot').mockReturnValue({ model, modelId: 'query-test', thinking: 'disabled', providerOptions: { deepseek: { thinking: { type: 'disabled' } } } });
  return spy;
}
function result(text: string) {
  return { content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 180, noCache: 180, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } } };
}
it('复用结构化模型，只传当前查询；输出去重并记录独立成本', async () => {
  slot(async options => {
    const user = options.prompt.find(m => m.role === 'user');
    expect(JSON.stringify(user)).toContain('烧脑的读物');
    expect(options.maxOutputTokens).toBe(192);
    return result('{"terms":["阅读","科幻","阅读"]}');
  });
  expect(await expandRecallQuery('找本烧脑的读物')).toEqual(['阅读', '科幻']);
  expect(models.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'memory_recall', modelId: 'query-test' }));
});
it('local模式不访问模型', async () => {
  const called = slot(async () => result('{"terms":[]}'));
  config.MEMORY_RECALL_MODE = 'local';
  expect(await expandRecallQuery('晚饭吃什么')).toEqual([]); expect(called).not.toHaveBeenCalled();
});
it('无效结构不带入模型生成的文字，直接退回本地', async () => {
  slot(async () => result('{"terms":["用户从不吃肉","x"]}'));
  expect(await expandRecallQuery('晚饭吃什么')).toEqual([]);
});
it('超时可退回本地；请求不重试', async () => {
  const called = vi.fn(async (options: LanguageModelV4CallOptions) => {
    await new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true }));
    return result('{"terms":[]}');
  });
  slot(called);
  expect(await expandRecallQuery('晚饭吃什么')).toEqual([]);
  expect(called).toHaveBeenCalledTimes(1);
});
it('认证失败后暂不重复请求，避免每轮都拖慢聊天', async () => {
  const called = vi.fn(async () => { throw new APICallError({ message: 'invalid test credential', url: 'https://invalid.example', requestBodyValues: {}, statusCode: 401, isRetryable: false }); });
  slot(called);
  expect(await expandRecallQuery('晚饭吃什么')).toEqual([]);
  expect(await expandRecallQuery('找本小说')).toEqual([]);
  expect(called).toHaveBeenCalledTimes(1);
});
it('整轮取消会向上传播，不能当成普通检索降级后继续回复', async () => {
  slot(async () => result('{"terms":[]}'));
  const abort = new AbortController(); abort.abort(new Error('turn cancelled'));
  await expect(expandRecallQuery('晚饭吃什么', undefined, abort.signal)).rejects.toThrow('turn cancelled');
});
