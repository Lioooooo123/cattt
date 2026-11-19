/** 第二批：真实 PG 的使用门与上下文，扩词结果受控，不以 mock 充当语义质量验收。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { boundaries, cats, conversations, memories, memoryBlocks, memoryReceipts, messages, turns, users } from '../src/db/schema.ts';
import { memoryFingerprint } from '../src/runtime/fingerprint.ts';
import { buildTurnContext } from '../src/runtime/context.ts';
import { changeSettings, editMemory, lockMemory, settings, withdrawSources } from '../src/memory/control.ts';
import { deleteMemory } from '../src/worker/memory.ts';
import { closeQueues } from '../src/queue.ts';
import { createSendTurn, loadOwner } from '../src/turns/create.ts';
import { drainTurns } from '../src/turns/run.ts';
import * as expansion from '../src/memory/query.ts';
import * as diary from '../src/diary/service.ts';
import { recallPermissions } from '../src/memory/recall.ts';
const expand = vi.spyOn(expansion, 'expandRecallQuery');
const userIds: string[] = [];
let catId: string, convId: string, userId: string;
async function account() {
  const [u] = await db.insert(users).values({ name: 'recall-test' }).returning(); userIds.push(u!.id);
  const [c] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const [conv] = await db.insert(conversations).values({ catId: c!.id }).returning();
  return { catId: c!.id, convId: conv!.id, userId: u!.id };
}
async function source(text: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  return (await db.insert(messages).values({ conversationId: convId, role: 'user', text, ...extra }).returning())[0]!;
}
async function memory(predicate: string, value: string, extra: Partial<typeof memories.$inferInsert> = {}, sourceExtra: Partial<typeof messages.$inferInsert> = {}) {
  const msg = await source(value, sourceExtra);
  return (await db.insert(memories).values({ catId, subject: '用户', predicate, value, confidence: .9, sensitivity: 'low',
    fingerprint: memoryFingerprint('用户', predicate), sourceMessageId: msg.id, extractorVersion: 'test', lastConfirmedAt: new Date('2026-01-01'), ...extra }).returning())[0]!;
}
beforeEach(async () => {
  ({ catId, convId, userId } = await account());
  expand.mockReset().mockResolvedValue([]);
});
afterAll(async () => { await drainTurns(10000); for (const id of userIds) await db.delete(users).where(eq(users.id, id)); await closeQueues();  await sql.end(); });
it('没有边界时许可抑制集合和话题为空', async () => {
  const expected = {suppressedSources:new Set(),suppressedMemories:new Set(),boundaryTopics:[]};
  expect(await recallPermissions(catId)).toEqual(expected);
  await db.transaction(async tx => { expect(await recallPermissions(catId, tx)).toEqual(expected); });
});
it('边界许可合并轮次记忆与已接受的问题凭证，事务内也读取当前边界', async () => {
  const question = await source('不要再提那件事');
  const accepted = await memory('旧事', '旧记忆');
  const duplicate = await memory('旧事', '另一条相同指纹记忆');
  const rejected = await memory('未接受', '不应抑制');
  const unrelated = await memory('无关问题', '也不应抑制');
  const turnMemoryId = randomUUID();
  const [turn] = await db.insert(turns).values({conversationId:convId,userMessageId:question.id,inputVersion:0,memoryIds:[turnMemoryId,accepted.id]}).returning();
  const reply = await source('猫的旧回复', {role:'cat',turnId:turn!.id});
  const hidden = await source('不允许的原话', {contextAllowed:false});
  await db.insert(memoryReceipts).values([
    {catId,questionId:reply.id,sourceMessageId:accepted.sourceMessageId,fingerprint:accepted.fingerprint,accepted:true},
    {catId,questionId:reply.id,sourceMessageId:rejected.sourceMessageId,fingerprint:rejected.fingerprint,accepted:false},
    {catId,questionId:question.id,sourceMessageId:unrelated.sourceMessageId,fingerprint:unrelated.fingerprint,accepted:true},
  ]);
  const expected = {suppressedSources:new Set([reply.id,hidden.id,question.id]),
    suppressedMemories:new Set([turnMemoryId,accepted.id,duplicate.id]),boundaryTopics:['猫的旧回复']};
  await db.transaction(async tx => {
    await tx.insert(boundaries).values([{catId,sourceMessageId:reply.id}, {catId,sourceMessageId:hidden.id,description:'隐藏话题'}]);
    expect(await recallPermissions(catId, tx)).toEqual(expected);
  });
  expect(await recallPermissions(catId)).toEqual(expected);
  await db.update(boundaries).set({description:'明确边界'}).where(eq(boundaries.sourceMessageId,reply.id));
  expect((await recallPermissions(catId)).boundaryTopics).toEqual(['明确边界']);
  const other = await account();
  expect(await recallPermissions(other.catId)).toEqual({suppressedSources:new Set(),suppressedMemories:new Set(),boundaryTopics:[]});
});
it('旧相关记忆超过旧50条窗口仍能被找到，近期无关内容不挤占', async () => {
  const old = await memory('忌口', '不吃香菜');
  const sources = await db.insert(messages).values(Array.from({ length: 65 }, (_, i) => ({ conversationId: convId, role: 'user' as const, text: `收藏蓝石编号${i}` }))).returning();
  await db.insert(memories).values(sources.map((m, i) => ({ catId, subject: '用户', predicate: `收藏${i}`, value: m.text, confidence: 1, explicit: true, sensitivity: 'low' as const, sourceMessageId: m.id, fingerprint: `noise-${i}`, extractorVersion: 'test' })));
  await source('帮我想想晚饭吃什么');
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.memoryIds).toEqual([old.id]);
  expect(ctx.instructions).toContain('不吃香菜');
  expect(ctx.sourceIds).toContain(old.sourceMessageId);
  expect(ctx.instructions).not.toContain('收藏蓝石');
});
it('带相对时间的旧记忆标明用户原话的当地日期', async () => {
  await db.update(users).set({ timeZone: 'Asia/Kuala_Lumpur' }).where(eq(users.id, userId));
  await memory('面试结果', '今天的面试没有通过', {}, { createdAt: new Date('2026-01-17T16:30:00Z') });
  await source('那次面试结果呢？');
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.instructions).toContain('〔原话日期 2026-01-18〕用户的面试结果：今天的面试没有通过');
});
it('当前轮次用自己的消息为查询锚点，不拿稍后到来的新问题混入', async () => {
  const old = await memory('饮食习惯', '偏爱素食');
  const input = await source('晚饭吃什么');
  const [t] = await db.insert(turns).values({ conversationId: convId, userMessageId: input.id, inputVersion: 0 }).returning();
  await source('换个话题，聊聊电影');
  const ctx = await buildTurnContext(catId, convId, t!.id);
  expect(ctx.memoryIds).toContain(old.id);
  expect(JSON.stringify(ctx.messages)).not.toContain('聊聊电影');
  expect(expand).toHaveBeenCalledWith('晚饭吃什么', t!.id, undefined);
});
it('语义扩词只返回主题，实际注入必须是数据库已有正文', async () => {
  const book = await memory('阅读偏好', '偏爱硬科幻小说');
  expand.mockResolvedValue(['阅读', '科幻', '虚构的用户事实']);
  await source('找本烧脑的读物');
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.memoryIds).toEqual([book.id]);
  expect(ctx.instructions).not.toContain('虚构的用户事实');
});
it('关闭使用开关时不查询、不扩词；重新打开只查当前有效内容', async () => {
  await memory('忌口', '不吃香菜'); await source('晚饭吃什么');
  await changeSettings(catId, { use: false, revision: (await settings(catId)).revision });
  expect((await buildTurnContext(catId, convId)).memoryIds).toEqual([]);
  expect(expand).not.toHaveBeenCalled();
  await changeSettings(catId, { use: true, revision: (await settings(catId)).revision });
  expect((await buildTurnContext(catId, convId)).memoryIds).toHaveLength(1);
});
it('更正以后只用新值；删除和停用的来源不能被语义搜索找回', async () => {
  const old = await memory('忌口', '不吃香菜'); await source('晚饭吃什么');
  await editMemory(catId, old.id, '现在可以吃香菜，但不吃辣椒', old.revision);
  let ctx = await buildTurnContext(catId, convId);
  expect(ctx.instructions).toContain('现在可以吃香菜');
  expect(ctx.instructions).not.toContain('：不吃香菜');
  await deleteMemory(catId, old.id);
  expect((await buildTurnContext(catId, convId)).memoryIds).toEqual([]);
  const next = await memory('饮食习惯', '偏爱素食');
  await db.transaction(async tx => { await lockMemory(tx, catId); await withdrawSources(tx, catId, [next.sourceMessageId]); });
  await source('晚饭吃什么');
  expect((await buildTurnContext(catId, convId)).memoryIds).toEqual([]);
});
it('候选先过滤账号、来源角色、许可、scope、置信度、冲突与删除阻断', async () => {
  const foreign = await account();
  await memory('饮食A', '素食', {}, { conversationId: foreign.convId });
  await memory('饮食B', '素食', {}, { role: 'cat' });
  await memory('饮食C', '素食', {}, { contextAllowed: false });
  await memory('饮食D', '素食', { scope: 'other' });
  await memory('饮食E', '素食', { confidence: .3 });
  await memory('饮食F', '素食', { status: 'conflicted' });
  await memory('饮食G', '素食', { status: 'superseded' });
  const blocked = await memory('饮食H', '素食');
  await db.insert(memoryBlocks).values({ catId, fingerprint: blocked.fingerprint });
  await source('晚饭吃什么');
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.memoryIds).toEqual([]);
  expect(expand).not.toHaveBeenCalled();
});
it('回避话题既排除原轮关联，也保守排除相关旧记忆', async () => {
  const coffee = await memory('咖啡偏好', '无咖啡因咖啡');
  const msg = await source('聊聊咖啡？', { role: 'cat' });
  await db.insert(boundaries).values({ catId, sourceMessageId: msg.id, description: '咖啡' });
  await source('想喝点什么');
  expand.mockResolvedValue(['咖啡']);
  expect((await buildTurnContext(catId, convId)).memoryIds).not.toContain(coffee.id);
  expect(expand).not.toHaveBeenCalled();
});
it('搜索异常时保留普通聊天，不降级成全量旧记忆注入', async () => {
  await memory('饮食习惯', '素食'); await source('晚饭吃什么');
  expand.mockRejectedValue(new Error('search unavailable'));
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.memoryIds).toEqual([]);
  expect(JSON.stringify(ctx.messages)).toContain('晚饭吃什么');
});
it('日记读取与记忆查找并行，空日记不改变来源', async () => {
  await memory('饮食习惯', '素食');
  const msg = await source('晚饭吃什么', { diaryEntryId: randomUUID() });
  const [turn] = await db.insert(turns).values({conversationId:convId,userMessageId:msg.id,inputVersion:0}).returning();
  let entered = false;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const read = vi.spyOn(diary, 'readableDiary').mockImplementation(async () => { entered = true; await barrier; return undefined; });
  expand.mockImplementationOnce(async () => { expect(entered).toBe(true); release(); return ['饮食']; });
  try {
    const ctx = await buildTurnContext(catId, convId, turn!.id);
    expect(ctx.diarySourceIds).toEqual([]);
    expect(JSON.stringify(ctx.messages)).toContain('晚饭吃什么');
    expect(expand).toHaveBeenCalled();
  } finally { release(); read.mockRestore(); }
});
it('上下文记忆查找取消时仍抛出取消原因', async () => {
  await memory('饮食习惯', '素食'); await source('晚饭吃什么');
  const controller = new AbortController();
  const reason = new Error('取消上下文');
  expand.mockImplementationOnce(async () => { controller.abort(reason); throw reason; });
  await expect(buildTurnContext(catId, convId, undefined, controller.signal)).rejects.toBe(reason);
});
it('停用发生在扩词期间，实际回复执行器不输出旧上下文', async () => {
  const old = await memory('饮食习惯', '素食');
  expand.mockImplementationOnce(async () => {
    await db.transaction(async tx => { await lockMemory(tx, catId); await withdrawSources(tx, catId, [old.sourceMessageId]); });
    return ['饮食'];
  });
  const o = (await loadOwner(userId))!;
  const sent = await createSendTurn(o, randomUUID(), '晚饭吃什么');
  await drainTurns(10000);
  const [t] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
  expect(t!.status).toBe('failed'); expect(t!.catMessageId).toBeNull(); expect(t!.firstTokenAt).toBeNull();
});

it('查找辅助路径报错，正式回复仍能完成且没有旧记忆注入', async () => {
  await memory('饮食习惯', '素食');
  expand.mockRejectedValue(new Error('search unavailable'));
  const o = (await loadOwner(userId))!;
  const sent = await createSendTurn(o, randomUUID(), '晚饭吃什么');
  await drainTurns(10000);
  const [t] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
  expect(t!.status).toBe('completed'); expect(t!.memoryIds).toEqual([]); expect(t!.catMessageId).not.toBeNull();
});
