import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users, cats, conversations, messages, tickets, runs, mailboxLetters, workerReports } from '../src/db/schema.ts';
import { startErrand, appendTicketInput, scanErrands } from '../src/agent/errands.ts';
import { cancelTicket } from '../src/agent/tickets.ts';
import { processErrand } from '../src/agent/executor.ts';
import { deliverReports } from './report-pipeline.ts';
import { mockWorkerModel } from '../src/runtime/mock.ts';
import { closeQueues } from '../src/queue.ts';

const now = new Date('2026-11-17T04:00:00Z');
const traits = { energy: 1, initiative: 1, directness: 1, closeness: 1 };
const owners: string[] = [];
let userId: string, catId: string, conversationId: string, sourceId: string;
beforeEach(async () => {
  const [u] = await db.insert(users).values({}).returning(); userId = u!.id; owners.push(userId);
  const [c] = await db.insert(cats).values({ userId, name: '团子', appearance: 'orange', temperament: 'slow', traits }).returning(); catId = c!.id;
  const [v] = await db.insert(conversations).values({ catId }).returning(); conversationId = v!.id;
  const [m] = await db.insert(messages).values({ conversationId, role: 'user', text: '帮我想想周末' }).returning(); sourceId = m!.id;
});
afterAll(async () => {
  for (const id of owners) {
    await sql`delete from async_jobs where object_id in(select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id}) or object_id in(select w.id from worker_reports w join cats c on c.id=w.cat_id where c.user_id=${id})`;
    await db.delete(workerReports).where(inArray(workerReports.catId, db.select({ id: cats.id }).from(cats).where(eq(cats.userId, id))));
    await db.delete(users).where(eq(users.id, id));
  }
  await closeQueues();  await sql.end();
});
const runFor = async (id: string) => (await db.select().from(runs).where(eq(runs.ticketId, id)))[0]!;
const ticketFor = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;

it.each(['message', 'append', 'zone', 'withdraw', 'cancel'] as const)('预算耗尽后%s变化仍收敛，不重算或重复发布', async change => {
  const t = await startErrand(catId, sourceId, '[output-budget] 周末建议', now), r = await runFor(t.ticket_id);
  let calls = 0;
  const model = mockWorkerModel({ onRequest: () => { calls++; } });
  await processErrand(r.id, { now: () => now, model });
  expect((await runFor(t.ticket_id)).outputTokens).toBe(8000);
  expect((await runFor(t.ticket_id)).report.active?.status).toBe('failed');
  const callsBefore = calls;
  if (change === 'message') {
    await db.insert(messages).values({ conversationId, role: 'user', text: '我还想问别的事' });
    await db.update(conversations).set({ version: 1 }).where(eq(conversations.id, conversationId));
  } else if (change === 'append') await appendTicketInput(catId, t.ticket_id, '想待在家');
  else if (change === 'zone') await db.update(users).set({ timeZone: 'Asia/Tokyo' }).where(eq(users.id, userId));
  else if (change === 'withdraw') await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, sourceId));
  else await cancelTicket(catId, t.ticket_id);
  // 同时覆盖过期报告、恢复扫描和重复投递；预算用完后不能再调用 worker 模型。
  for (let i = 0; i < 3; i++) {
    await deliverReports(r.id, now);
    await scanErrands(now, catId);
    await processErrand(r.id, { now: () => now, model });
  }
  const tAfter = await ticketFor(t.ticket_id);
  expect(tAfter.status).toBe('ended');
  expect(tAfter.stage).toBe(change === 'withdraw' ? 'dropped' : change === 'cancel' ? 'cancelled' : 'failed');
  if (change !== 'cancel') expect((await runFor(t.ticket_id)).status).toBe('ended');
  expect(calls).toBe(callsBefore);
  const said = await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'cat')));
  expect(said).toHaveLength(change === 'withdraw' || change === 'cancel' ? 0 : 1);
  if (said.length) expect(said[0]!.text).toContain('没能办好');
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, catId))).toHaveLength(0);
});

it('模型自己的failed汇报仍须通过新鲜度检查', async () => {
  const t = await startErrand(catId, sourceId, '[failed] 周末建议', now), r = await runFor(t.ticket_id);
  await processErrand(r.id, { now: () => now });
  expect((await runFor(t.ticket_id)).report.active?.status).toBe('failed');
  await db.update(conversations).set({ version: 1 }).where(eq(conversations.id, conversationId));
  await deliverReports(r.id, now);
  expect((await ticketFor(t.ticket_id)).status).toBe('open');
  expect((await runFor(t.ticket_id)).report.active).toBeUndefined();
  expect(await db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'cat')))).toHaveLength(0);
});

it('全局扫描越过500条长期等待事项，释放容量的排队托付会启动', async () => {
  const first = await startErrand(catId, sourceId, '第一件', now);
  const second = await startErrand(catId, sourceId, '第二件', now);
  const queued = await startErrand(catId, sourceId, '第三件', now);
  expect(queued.queued).toBe(true);
  await cancelTicket(catId, first.ticket_id); await cancelTicket(catId, second.ticket_id);
  const old = new Date('2026-10-01T00:00:00Z');
  const us = await db.insert(users).values(Array.from({ length: 250 }, () => ({ id: randomUUID() }))).returning();
  owners.push(...us.map(u => u.id));
  const cs = await db.insert(cats).values(us.map(u => ({ userId: u.id, name: '等待中的猫', appearance: 'orange', temperament: 'slow', traits }))).returning();
  const waiting = await db.insert(tickets).values(cs.flatMap(c => Array.from({ length: 2 }, () => ({
    catId: c.id, kind: 'errand', goal: '等待补充', mandate: { kind: 'explicit' as const, source_message_id: randomUUID() },
    stage: 'quiet_waiting', createdAt: old, updatedAt: old,
  })))).returning();
  await db.insert(runs).values(waiting.map(t => ({ ticketId: t.id })));
  await scanErrands(now);
  expect((await ticketFor(queued.ticket_id)).stage).toBe('thinking');
  expect((await runFor(queued.ticket_id)).status).toBe('pending');
  expect((await db.select().from(tickets).where(inArray(tickets.id, waiting.map(t => t.id)))).every(t => t.stage === 'quiet_waiting')).toBe(true);
}, 20000);
