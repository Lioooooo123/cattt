import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { boundaries, cats, conversations, memories, messages, users } from '../src/db/schema.ts';
import { recallPermissions } from '../src/memory/recall.ts';
import { extractSource } from '../src/worker/memory.ts';
import { changeSettings, lockMemory, withdrawSources } from '../src/memory/control.ts';
import * as models from '../src/runtime/model.ts';
import { closeQueues } from '../src/queue.ts';
const ids: string[] = [];
async function fixture() {
  const [u] = await db.insert(users).values({ name: 'extract-test' }).returning(); ids.push(u!.id);
  const [cat] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const [conv] = await db.insert(conversations).values({ catId: cat!.id }).returning();
  const add = async (text: string) => (await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text }).returning())[0]!.id;
  return { catId: cat!.id, conversationId: conv!.id, add };
}
function extractor(output: object, inspect?: (prompt: string) => void) {
  const model = new MockLanguageModelV4({ doGenerate: async options => {
    inspect?.(JSON.stringify(options.prompt));
    return { content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
  } });
  vi.spyOn(models, 'extractSlot').mockReturnValue({ model, modelId: 'controlled-test', thinking: 'disabled', providerOptions: { deepseek: { thinking: { type: 'disabled' } } } });
}
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { for (const id of ids) await db.delete(users).where(eq(users.id, id)); await closeQueues();  await sql.end(); });
const base = { subject: '用户', predicate: '咖啡偏好', value: '不喝咖啡', kind: 'preference', confidence: .95, sensitivity: 'low', explicit: true, correction: false };
it('模型提取保存真实来源，更正沿用同方面并让旧值失效', async () => {
  const f = await fixture(); const a = await f.add('记住，我不喝咖啡');
  extractor({ memories: [base] });
  expect((await extractSource(f.catId, a, randomUUID())).remembered).toBe(true);
  vi.restoreAllMocks();
  const b = await f.add('更正，只喝无咖啡因咖啡');
  extractor({ memories: [{ ...base, value: '只喝无咖啡因咖啡', correction: true }] }, prompt => { expect(prompt).toContain('咖啡偏好'); });
  expect((await extractSource(f.catId, b, randomUUID())).note).toContain('成功保存');
  const stored = await db.select().from(memories).where(eq(memories.catId, f.catId));
  expect(stored.find(m => m.status === 'active')!.sourceMessageId).toBe(b);
  expect(stored.find(m => m.sourceMessageId === a)!.status).toBe('superseded');
});
it('用相邻的猫追问理解简答，记忆来源仍是用户的回答', async () => {
  const f = await fixture();
  const question = '面试怎么样？那个产品题现场拆解，还顺吗？';
  const [asked] = await db.insert(messages).values({ conversationId: f.conversationId, role: 'cat', text: question, memoryEligible: false }).returning();
  const answer = '没过，今天先不聊了。';
  const source = await f.add(answer);
  const later = '回复之后的消息';
  await f.add(later);
  extractor({ memories: [{ ...base, predicate: '面试结果', value: '没过', kind: 'fact', explicit: false }] }, prompt => {
    const input = JSON.parse(prompt);
    expect(input.filter((m: { role: string }) => m.role !== 'system').map((m: { role: string }) => m.role)).toEqual(['assistant', 'user']);
    expect(input.at(-2).content).toEqual([{ type: 'text', text: question }]);
    expect(input.at(-1).content).toEqual([{ type: 'text', text: answer }]);
    expect(prompt).not.toContain(later);
  });
  await extractSource(f.catId, source, randomUUID());
  const stored = await db.select().from(memories).where(eq(memories.catId, f.catId));
  expect(stored).toMatchObject([{ value: '没过', sourceMessageId: source, explicit: false }]);
  await db.insert(boundaries).values({ catId: f.catId, sourceMessageId: asked!.id });
  expect((await recallPermissions(f.catId)).suppressedMemories.has(stored[0]!.id)).toBe(true);
  await db.transaction(async tx => { await lockMemory(tx, f.catId); await withdrawSources(tx, f.catId, [asked!.id]); });
  expect(await db.select().from(memories).where(eq(memories.catId, f.catId))).toHaveLength(0);
});

it.each(['withdrawn', 'boundary', 'intervening user'] as const)('不取被停用、设边界或被隔开的追问：%s', async reason => {
  const f = await fixture();
  const question = '那份实习的笔试怎么样？';
  await db.insert(messages).values({ conversationId: f.conversationId, role: 'cat', text: '更早的追问' });
  const [q] = await db.insert(messages).values({ conversationId: f.conversationId, role: 'cat', text: question,
    contextAllowed: reason !== 'withdrawn' }).returning();
  if (reason === 'boundary') await db.insert(boundaries).values({ catId: f.catId, sourceMessageId: q!.id });
  if (reason === 'intervening user') await f.add('另外一件事');
  const source = await f.add('过了');
  extractor({ memories: [] }, prompt => {
    expect(prompt).not.toContain(question);
    expect(prompt).not.toContain('更早的追问');
    expect(prompt).not.toContain('另外一件事');
  });
  await extractSource(f.catId, source, randomUUID());
});
it('含糊更正返回澄清，不虚构保存结果', async () => {
  const f = await fixture(); const a = await f.add('那个不是这样的');
  extractor({ memories: [], clarification: '你想改的是哪件事？' });
  const result = await extractSource(f.catId, a, randomUUID());
  expect(result).toEqual({ remembered: false, note: '你想改的是哪件事？' });
  expect(await db.select().from(memories).where(eq(memories.catId, f.catId))).toHaveLength(0);
});
it('关闭整理或停用原话后，连提取模型也不调用', async () => {
  const f = await fixture(); const a = await f.add('记住，我喜欢茶');
  extractor({ memories: [base] }); const spy = vi.mocked(models.extractSlot);
  await changeSettings(f.catId, { learn: false, revision: 0 });
  expect((await extractSource(f.catId, a, randomUUID())).remembered).toBe(false);
  const g = await fixture(); const b = await g.add('不再使用的原话');
  await db.transaction(async tx => { await lockMemory(tx, g.catId); await withdrawSources(tx, g.catId, [b]); });
  expect((await extractSource(g.catId, b, randomUUID())).remembered).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});
it('提取期间撤回原话，迟到的模型结果不能写入', async () => {
  const f = await fixture(); const a = await f.add('记住，我不喝咖啡');
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    await db.transaction(async tx => { await lockMemory(tx, f.catId); await withdrawSources(tx, f.catId, [a]); });
    return { content: [{ type: 'text', text: JSON.stringify({ memories: [base] }) }], finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
  } });
  vi.spyOn(models, 'extractSlot').mockReturnValue({ model, modelId: 'controlled-test', thinking: 'disabled', providerOptions: { deepseek: { thinking: { type: 'disabled' } } } });
  expect((await extractSource(f.catId, a, randomUUID())).remembered).toBe(false);
  expect(await db.select().from(memories).where(eq(memories.catId, f.catId))).toHaveLength(0);
});
