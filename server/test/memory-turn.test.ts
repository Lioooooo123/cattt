import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, memories, messages, tickets, turns, users } from '../src/db/schema.ts';
import { createSendTurn, loadOwner } from '../src/turns/create.ts';
import { drainTurns } from '../src/turns/run.ts';
import { changeSettings, lockMemory, settings, withdrawSources } from '../src/memory/control.ts';
import { closeQueues } from '../src/queue.ts';
import { config } from '../src/config.ts';
import { runtimeCalls } from '../src/db/schema-runtime.ts';
config.MODEL_PROVIDER = 'mock'; config.MOCK_DELAY_MS = 1;
const ids: string[] = [];
async function owner() {
  const [u] = await db.insert(users).values({ name: 'memory-turn-test' }).returning(); ids.push(u!.id);
  const [c] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  await db.insert(conversations).values({ catId: c!.id });
  return (await loadOwner(u!.id))!;
}
afterAll(async () => { await drainTurns(5000); for (const id of ids) await db.delete(users).where(eq(users.id, id)); await closeQueues();  await sql.end(); });
it('真正经过回复执行器：明确记住先保存，回复引用有来源记录', async () => {
  const o = await owner();
  const sent = await createSendTurn(o, randomUUID(), '记住，我不喝咖啡。');
  await drainTurns(10000);
  const [t] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
  expect(t!.status).toBe('completed');
  expect(t!.contextSourceIds).toContain(sent.userMessageId);
  expect(await db.select().from(memories).where(eq(memories.catId, o.catId))).toHaveLength(1);
});
it.each(['请记住','请帮我记住','麻烦记住'])('显式记忆%s：模型误调托付也不建事项，仍走本轮记忆保存', async prefix => {
  const o = await owner();
  const sent = await createSendTurn(o, randomUUID(), `${prefix}，我不喝咖啡。[errand:保存用户不喝咖啡的长期信息]`);
  await drainTurns(10000);
  const [t] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
  expect(t!.status).toBe('completed');
  expect(await db.select().from(memories).where(eq(memories.catId, o.catId))).toHaveLength(1);
  expect(await db.select().from(tickets).where(and(eq(tickets.catId, o.catId), eq(tickets.kind, 'errand')))).toHaveLength(0);
  const [call] = await db.select().from(runtimeCalls).where(and(eq(runtimeCalls.turnId, sent.turnId), eq(runtimeCalls.tool, 'start_errand')));
  expect(call!.status).toBe('failed');
});
it('真实消息入口快照记录关闭状态，重新开启也不能补写', async () => {
  const o = await owner();
  await changeSettings(o.catId, { learn: false, revision: 0 });
  const sent = await createSendTurn(o, randomUUID(), '记住，我喜欢茶。[errand:保存用户喜欢茶的长期信息]');
  await drainTurns(10000);
  const [m] = await db.select().from(messages).where(eq(messages.id, sent.userMessageId));
  expect(m!.memoryEligible).toBe(false);
  await changeSettings(o.catId, { learn: true, revision: (await settings(o.catId)).revision });
  expect(await db.select().from(memories).where(eq(memories.catId, o.catId))).toHaveLength(0);
  expect(await db.select().from(tickets).where(and(eq(tickets.catId, o.catId), eq(tickets.kind, 'errand')))).toHaveLength(0);
});
it('正在流式回复时停用原话，后续输出中止且不保存旧回复', async () => {
  const o = await owner();
  const sent = await createSendTurn(o, randomUUID(), '[slow] 这是一段用于停用验收的话。');
  for (let i = 0; i < 80; i++) {
    const [t] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
    if (t?.firstTokenAt) break;
    await new Promise(r => setTimeout(r, 50));
  }
  await db.transaction(async tx => { await lockMemory(tx, o.catId); await withdrawSources(tx, o.catId, [sent.userMessageId]); });
  await drainTurns(10000);
  const [t] = await db.select().from(turns).where(eq(turns.id, sent.turnId));
  expect(t!.status).toBe('failed');
  expect(t!.catMessageId).toBeNull();
  expect(await db.select().from(messages).where(and(eq(messages.conversationId, o.conversationId), eq(messages.role, 'cat')))).toHaveLength(0);
});
