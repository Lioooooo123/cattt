import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { sql } from '../src/db/client.ts';
import { acquire, admissionLane, admissionModel } from '../src/runtime/admission.ts';
import { slotFrom } from '../src/runtime/model.ts';
import { config } from '../src/config.ts';

const resources: string[] = [];
const resource = () => { const r = `test:${randomUUID()}`; resources.push(r); return r; };
const options: LanguageModelV4CallOptions = { prompt: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] };
async function waiting(r: string, count: number) {
  await vi.waitFor(async () => {
    const [row] = await sql`select count(*)::int as n from model_admissions where resource = ${r} and state = 'waiting'`;
    expect(row!.n).toBe(count);
  });
}
afterEach(async () => { for (const r of resources) await sql`delete from model_admissions where resource = ${r}`; vi.restoreAllMocks(); });
afterAll(async () => { await sql.end(); });

test('单并发先聊天，车道内先到先服务，释放幂等', async () => {
  const r = resource(); const release = await acquire(r, 'background', 'holder', 1);
  const order: string[] = [];
  const b = acquire(r, 'background', 'B', 1).then(async done => { order.push('B'); await done(); });
  await waiting(r, 1);
  const c = acquire(r, 'chat', 'C', 1).then(async done => { order.push('C'); await done(); });
  await waiting(r, 2);
  await Promise.all([release(), release()]); await Promise.all([b, c]);
  expect(order).toEqual(['C', 'B']);
});

test('槽位包装：慢后台流结束后，聊天越过第二个后台', async () => {
  const old = config.MODEL_MOCK_CONCURRENCY;
  config.MODEL_MOCK_CONCURRENCY = 1;
  resources.push('mock');
  try {
    const spec = { name: 'chat' as const, provider: 'mock' as const, model: 'mock-chat', thinking: 'disabled' as const };
    const background = slotFrom(spec, 'cat_diary').model as LanguageModelV4;
    const chat = slotFrom(spec, 'chat').model as LanguageModelV4;
    const first = await background.doStream({ ...options, prompt: [{ role: 'user', content: [{ type: 'text', text: '[slow] 你好' }] }] });
    const order: string[] = [];
    const consume = async (model: LanguageModelV4, label: string) => {
      const result = await model.doStream(options); order.push(label); await result.stream.cancel();
    };
    const b = consume(background, 'B'); await waiting('mock', 1);
    const c = consume(chat, 'C'); await waiting('mock', 2);
    const reader = first.stream.getReader(); await reader.read(); await reader.cancel();
    await Promise.all([b, c]); expect(order).toEqual(['C', 'B']);
  } finally { config.MODEL_MOCK_CONCURRENCY = old; }
});

test('崩溃持有者过期后回收', async () => {
  const r = resource();
  await sql`insert into model_admissions (id,resource,lane,purpose,state,lease_expires_at)
    values (${randomUUID()},${r},'background','dead','running',now() - interval '1 second')`;
  const done = await acquire(r, 'chat', 'chat', 1);
  const rows = await sql`select * from model_admissions where resource = ${r}`;
  expect(rows).toHaveLength(1); expect(rows[0]!.state).toBe('running'); await done();
});

test('等候时取消删除行，已经取消不入队', async () => {
  const r = resource(); const done = await acquire(r, 'background', 'holder', 1);
  const abort = new AbortController();
  const pending = acquire(r, 'chat', 'chat', 1, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  await waiting(r, 1); abort.abort(); await rejected; await waiting(r, 0);
  await expect(acquire(r, 'chat', 'chat', 1, abort.signal)).rejects.toThrow(); await done();
});

test('流取消、正常结束、流错误和调用抛错均释放', async () => {
  for (const mode of ['cancel', 'finish', 'error', 'throw', 'part-error']) {
    const r = resource();
    const base = new MockLanguageModelV4({ doStream: async () => {
      if (mode === 'throw') throw new Error('failed');
      return { warnings: [], stream: new ReadableStream({ start(c) {
        if (mode === 'finish') c.close();
        if (mode === 'error') c.error(new Error('failed'));
        if (mode === 'part-error') c.enqueue({ type: 'error', error: new Error('failed') });
      } }) };
    } });
    const model = admissionModel(base, 'chat', r, 1) as LanguageModelV4;
    if (mode === 'throw') await expect(model.doStream(options)).rejects.toThrow('failed');
    else {
      const result = await model.doStream(options);
      if (mode === 'cancel') await result.stream.cancel();
      else { const reader = result.stream.getReader(); if (mode === 'error') await expect(reader.read()).rejects.toThrow('failed'); else await reader.read(); await reader.cancel().catch(() => {}); }
    }
    expect(await sql`select id from model_admissions where resource = ${r}`).toHaveLength(0);
  }
});

test('非流调用成功或失败都释放；关闭准入不访问数据库', async () => {
  const r = resource();
  const base = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('provider_failed'); } });
  const model = admissionModel(base, 'chat', r, 1) as LanguageModelV4;
  await expect(model.doGenerate(options)).rejects.toThrow('provider_failed');
  const success = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: 'text', text: '好' }], warnings: [], finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  }) });
  await (admissionModel(success, 'chat', r, 1) as LanguageModelV4).doGenerate(options);
  expect(await sql`select id from model_admissions where resource = ${r}`).toHaveLength(0);
  const debug = sql.options.debug;
  const queries = vi.fn(); sql.options.debug = queries;
  try {
    await sql`select 1`; expect(queries).toHaveBeenCalled(); queries.mockClear();
    expect(admissionModel(base, 'chat', r, 0)).toBe(base);
    await (await acquire(r, 'chat', 'chat', 0))();
    await expect((admissionModel(base, 'chat', r, 0) as LanguageModelV4).doGenerate(options)).rejects.toThrow('provider_failed');
    expect(queries).not.toHaveBeenCalled();
  } finally { sql.options.debug = debug; }
});

test('同步记忆保存和检索走聊天，其余用途后台', () => {
  for (const purpose of ['chat', 'memory_recall', 'memory_extract_chat']) expect(admissionLane(purpose)).toBe('chat');
  for (const purpose of ['memory_extract', 'route', 'errand', 'diary_read', 'cat_diary', 'boundary_summarize']) expect(admissionLane(purpose)).toBe('background');
});
