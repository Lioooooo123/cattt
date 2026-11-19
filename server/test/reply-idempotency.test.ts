import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, messages, turns, users } from '../src/db/schema.ts';
import { createReplyTurn } from '../src/turns/create.ts';

// 检查真实事务与锁；不调用模型、不启动回复后台任务。
vi.mock('../src/turns/run.ts', () => ({ startTurn: vi.fn() }));
const owners: string[] = [];
const created: string[] = [];
async function fixture() {
  const [user] = await db.insert(users).values({ name: 'reply-idempotency-test' }).returning();
  owners.push(user!.id);
  const [cat] = await db.insert(cats).values({ userId: user!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const [conversation] = await db.insert(conversations).values({ catId: cat!.id }).returning();
  const [message] = await db.insert(messages).values({ conversationId: conversation!.id, role: 'user', text: '你好' }).returning();
  return { owner: { userId: user!.id, catId: cat!.id, conversationId: conversation!.id }, message: message!.id };
}
afterAll(async () => {
  for (const id of owners) await db.delete(users).where(eq(users.id, id));
  for (const id of created) { await sql`delete from turn_events where turn_id=${id}`; await sql`delete from turn_controls where turn_id=${id}`; }
  await sql.end();
});
it('并发重试同一个 request_id 只建一轮，新的点击才建新一轮', async () => {
  const { owner, message } = await fixture();
  const id = randomUUID(); created.push(id);
  const results = await Promise.all([createReplyTurn(owner, message, id), createReplyTurn(owner, message, id)]);
  expect(results).toEqual([{ turnId: id }, { turnId: id }]);
  expect(await db.select().from(turns).where(eq(turns.userMessageId, message))).toHaveLength(1);
  const next = randomUUID(); created.push(next);
  expect(await createReplyTurn(owner, message, next)).toEqual({ turnId: next });
  expect(await db.select().from(turns).where(eq(turns.userMessageId, message))).toHaveLength(2);
});
it('完成后的重试仍指向原轮次，且不能跨账号或跨用户消息复用 ID', async () => {
  const a = await fixture(); const b = await fixture();
  const id = randomUUID(); created.push(id);
  await createReplyTurn(a.owner, a.message, id);
  await db.update(turns).set({ status: 'completed' }).where(eq(turns.id, id));
  expect(await createReplyTurn(a.owner, a.message, id)).toEqual({ turnId: id });
  expect(await createReplyTurn(b.owner, b.message, id)).toBeNull();
  const [other] = await db.insert(messages).values({ conversationId: a.owner.conversationId, role: 'user', text: '另一句' }).returning();
  expect(await createReplyTurn(a.owner, other!.id, id)).toBeNull();
});
