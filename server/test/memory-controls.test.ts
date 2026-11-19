/** 真 PG，合成账号；不调用付费模型。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, memories, messages, turns, users } from '../src/db/schema.ts';
import { applyCandidate, deleteMemory } from '../src/worker/memory.ts';
import { changeSettings, editMemory, lockMemory, settings, sourceImpact, withdrawSources } from '../src/memory/control.ts';
import { buildTurnContext } from '../src/runtime/context.ts';
import { adjustSoul, getSoul, setRuntimeState } from '../src/soul/service.ts';
import { commitOutcome } from '../src/turns/store.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { closeQueues } from '../src/queue.ts';
const ids: string[] = [];
const candidate = { subject: '用户', predicate: '咖啡偏好', value: '不喝咖啡', kind: 'preference' as const, confidence: .95, sensitivity: 'low' as const, explicit: true, correction: false };
let catId: string, convId: string, sourceId: string, token: string;
async function source(text = '记住，我不喝咖啡', role: 'user' | 'cat' = 'user', eligible = true) {
  return (await db.insert(messages).values({ conversationId: convId, role, text, memoryEligible: eligible }).returning())[0]!;
}
async function list() { return db.select().from(memories).where(and(eq(memories.catId, catId), eq(memories.status, 'active'))); }
async function request(path: string, method = 'GET', body?: object) {
  return app.request(`/v1/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
beforeEach(async () => {
  token = `memory-test-${randomUUID()}`;
  const [u] = await db.insert(users).values({ name: 'memory-controls-test', devTokenHash: hashToken(token) }).returning(); ids.push(u!.id);
  const [cat] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning(); catId = cat!.id;
  const [conv] = await db.insert(conversations).values({ catId }).returning(); convId = conv!.id;
  sourceId = (await source()).id;
});
afterAll(async () => { for (const id of ids) await db.delete(users).where(eq(users.id, id)); await closeQueues();  await sql.end(); });
it('列表返回真实原话，编辑后新值生效；旧候选迟到不覆盖', async () => {
  await applyCandidate(catId, sourceId, candidate);
  const late = await source('旧说法');
  const memory = (await list())[0]!;
  expect((await (await request('memories')).json()).memories[0].source_text).toContain('不喝咖啡');
  expect((await request(`memories/${memory.id}`, 'PATCH', { value: '只喝无咖啡因咖啡', revision: 0 })).status).toBe(200);
  expect(await applyCandidate(catId, late.id, candidate)).toBe(false);
  expect((await list())[0]!.value).toBe('只喝无咖啡因咖啡');
  // 第二批只在相关话题召回；先明确问起咖啡，再检查新值。
  await source('我现在喝哪种咖啡？');
  expect((await buildTurnContext(catId, convId)).instructions).toContain('只喝无咖啡因咖啡');
  expect((await request(`memories/${memory.id}`, 'PATCH', { value: '旧页面覆盖', revision: 0 })).status).toBe(409);
  expect((await request(`memories/${memory.id}`, 'PATCH', { value: '只喝无咖啡因咖啡', revision: 0 })).status).toBe(200);
});
it('删除后老任务不能复活；只删除记忆仍保留原话', async () => {
  await applyCandidate(catId, sourceId, candidate);
  const late = await source();
  await deleteMemory(catId, (await list())[0]!.id);
  expect(await applyCandidate(catId, late.id, candidate)).toBe(false);
  expect(await list()).toHaveLength(0);
  expect(JSON.stringify((await buildTurnContext(catId, convId)).messages)).toContain('不喝咖啡');
});
it('撤回整段原话，同时停用派生回复、记忆、Soul 和状态；聊天还在', async () => {
  await applyCandidate(catId, sourceId, candidate);
  await adjustSoul(catId, { sourceMessageId: sourceId, adjustment: { kind: 'response_length', value: 'brief' }, reason: '测试' });
  await setRuntimeState(catId, { sourceMessageId: sourceId, energy: 'resting', willingness: 'quiet', durationMinutes: 10 });
  const [t] = await db.insert(turns).values({ conversationId: convId, userMessageId: sourceId, inputVersion: 0, contextSourceIds: [sourceId], memoryIds: [(await list())[0]!.id] }).returning();
  await commitOutcome(t!.id, { status: 'completed', text: '那我以后不提咖啡' });
  const impact = await db.transaction(tx => sourceImpact(tx, catId, [sourceId]));
  expect(impact.messages).toHaveLength(2);
  await db.transaction(async tx => { await lockMemory(tx, catId); await withdrawSources(tx, catId, [sourceId]); });
  expect(await list()).toHaveLength(0);
  expect((await db.select().from(messages).where(eq(messages.conversationId, convId)))).toHaveLength(2);
  const context = await buildTurnContext(catId, convId);
  expect(context.messages).toHaveLength(0);
  expect(context.instructions).not.toContain('不喝咖啡');
  expect((await getSoul(catId)).soul.entries).toHaveLength(0);
  expect((await getSoul(catId)).runtime.state.energy).toBe('baseline');
  expect(await applyCandidate(catId, sourceId, candidate)).toBe(false);
});
it('修改设置、撤回以后，旧上下文不能提交猫的回复', async () => {
  const ctx = await buildTurnContext(catId, convId);
  const [t] = await db.insert(turns).values({ conversationId: convId, userMessageId: sourceId, inputVersion: 0, status: 'generating', contextRevision: ctx.revision, contextSourceIds: ctx.sourceIds }).returning();
  await changeSettings(catId, { use: false, revision: (await settings(catId)).revision });
  const result = await commitOutcome(t!.id, { status: 'completed', text: '旧上下文答案' });
  expect(result.turn!.status).toBe('failed');
  expect(result.catMessageId).toBeNull();
});
it('关闭整理期间的原话永不补记，关闭前未完成的候选也作废', async () => {
  await changeSettings(catId, { learn: false, revision: 0 });
  const during = await source('我喜欢茶', 'user', false);
  expect(await applyCandidate(catId, sourceId, candidate)).toBe(false);
  await changeSettings(catId, { learn: true, revision: (await settings(catId)).revision });
  expect(await applyCandidate(catId, during.id, candidate)).toBe(false);
  expect(await applyCandidate(catId, sourceId, candidate)).toBe(false);
  expect(await applyCandidate(catId, (await source()).id, candidate)).toBe(true);
});
it('不参考已有记忆时不注入长期记忆或来源习惯，开关互不改变', async () => {
  await applyCandidate(catId, sourceId, candidate);
  await adjustSoul(catId, { sourceMessageId: sourceId, adjustment: { kind: 'response_length', value: 'brief' }, reason: '测试' });
  await changeSettings(catId, { use: false, revision: (await settings(catId)).revision });
  expect((await settings(catId)).learn).toBe(true);
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.memoryIds).toHaveLength(0);
  expect(ctx.instructions).not.toContain('你记得的事');
  expect(ctx.messages).toHaveLength(1);
  expect(await list()).toHaveLength(1);
});
it('跨账号的列表、修改、撤回和提取全部隔离；猫说的话不能提取', async () => {
  await applyCandidate(catId, sourceId, candidate);
  const m = (await list())[0]!;
  const foreign = randomUUID();
  expect((await request(`messages/${foreign}/withdraw`, 'POST', { revision: 0, watermark: 0 })).status).toBe(404);
  const [otherUser] = await db.insert(users).values({ name: 'other' }).returning(); ids.push(otherUser!.id);
  const [other] = await db.insert(cats).values({ userId: otherUser!.id, name: '别的猫', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  await db.insert(conversations).values({ catId: other!.id });
  expect(await applyCandidate(other!.id, sourceId, candidate)).toBe(false);
  await expect(editMemory(other!.id, m.id, '篡改', 0)).rejects.toThrow();
  expect(await applyCandidate(catId, (await source('猫说的', 'cat')).id, candidate)).toBe(false);
});
it('边界只接受猫消息，可以撤销；撤销不恢复停用原话', async () => {
  expect((await request(`messages/${sourceId}/boundary`, 'POST')).status).toBe(404);
  const cat = await source('咖啡的事', 'cat');
  expect((await request(`messages/${cat.id}/boundary`, 'POST')).status).toBe(200);
  const data = await (await request('boundaries')).json();
  expect(data.boundaries).toHaveLength(1);
  await db.transaction(async tx => { await lockMemory(tx, catId); await withdrawSources(tx, catId, [cat.id]); });
  expect((await request(`boundaries/${data.boundaries[0].id}`, 'DELETE')).status).toBe(200);
  expect((await db.select().from(messages).where(eq(messages.id, cat.id)))[0]!.contextAllowed).toBe(false);
});
it('影响预览版本过期要重新确认；一段原话多件事都列出', async () => {
  await applyCandidate(catId, sourceId, candidate);
  await applyCandidate(catId, sourceId, { ...candidate, predicate: '周末安排', value: '周末去图书馆' });
  const preview = await (await request(`messages/${sourceId}/usage`)).json();
  expect(preview.memories).toHaveLength(2);
  await changeSettings(catId, { use: false, revision: preview.revision });
  expect((await request(`messages/${sourceId}/withdraw`, 'POST', { revision: preview.revision, watermark: preview.watermark })).status).toBe(409);
  expect(await list()).toHaveLength(2);
});
it('删除且停用相关原话在同一事务完成，重复请求不复活', async () => {
  await applyCandidate(catId, sourceId, candidate);
  const m = (await list())[0]!;
  const preview = await (await request(`memories/${m.id}/impact`)).json();
  const url = `memories/${m.id}?withdraw_sources=true&revision=${preview.revision}&watermark=${preview.watermark}`;
  expect((await request(url, 'DELETE')).status).toBe(200);
  expect((await request(url, 'DELETE')).status).toBe(200);
  expect((await buildTurnContext(catId, convId)).messages).toHaveLength(0);
});
it('历史无来源跟踪的回复保守停用；后来无关联的新话仍可用', async () => {
  const [t] = await db.insert(turns).values({ conversationId: convId, userMessageId: sourceId, inputVersion: 0 }).returning();
  await commitOutcome(t!.id, { status: 'completed', text: '旧版回复' });
  const fresh = await source('今天晴天');
  await db.transaction(async tx => { await lockMemory(tx, catId); await withdrawSources(tx, catId, [sourceId]); });
  const ctx = await buildTurnContext(catId, convId);
  expect(ctx.sourceIds).toEqual([fresh.id]);
});

it('预览之后又产生新聊天，停用前必须重新核对范围', async () => {
  const preview = await (await request(`messages/${sourceId}/usage`)).json();
  await source('刚刚收到的新话');
  expect((await request(`messages/${sourceId}/withdraw`, 'POST', { revision: preview.revision, watermark: preview.watermark })).status).toBe(409);
});
