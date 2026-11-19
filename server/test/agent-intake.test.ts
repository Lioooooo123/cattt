import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users, cats, conversations, messages, tickets, ticketInputs, triggers, decisions, runs } from '../src/db/schema.ts';
import { startErrand, appendTicketInput } from '../src/agent/errands.ts';
import { scheduleFollowup, updateTicket, parseFollowupTime } from '../src/agent/tickets.ts';
import { catTools } from '../src/runtime/tools.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { closeQueues } from '../src/queue.ts';

const now = new Date('2026-11-17T04:00:00Z');
const userIds: string[] = [];
let catId: string, conversationId: string, sourceId: string, token: string;
beforeEach(async () => {
  token = randomUUID();
  const [u] = await db.insert(users).values({ devTokenHash: hashToken(token) }).returning();
  userIds.push(u!.id);
  const [cat] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  catId = cat!.id;
  const [conversation] = await db.insert(conversations).values({ catId }).returning();
  conversationId = conversation!.id;
  sourceId = await message('帮我想想周末怎么过');
});
afterAll(async () => {
  for (const id of userIds) {
    await sql`delete from async_jobs where object_id in (select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id})`;
    await db.delete(users).where(eq(users.id, id));
  }
  await closeQueues();

  await sql.end();
});
async function message(text: string, role: 'user' | 'cat' = 'user') {
  const [m] = await db.insert(messages).values({ conversationId, role, text }).returning();
  return m!.id;
}
const create = () => startErrand(catId, sourceId, '周末建议', now);
const inputs = (id: string) => db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, id));
const events = () => db.select().from(triggers).where(eq(triggers.catId, catId));
const ticket = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
function request(id: string, body?: unknown, key?: string, cancel = false) {
  return app.request(`/v1/tickets/${id}${cancel ? '/cancel' : ''}`, {
    method: cancel ? 'POST' : 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

it('App重放同一补充只写一次，操作和收据持久化且不改原始授权', async () => {
  const t = await create(), before = await ticket(t.ticket_id), key = randomUUID();
  const responses = await Promise.all([request(t.ticket_id, { text: '想在家休息' }, key), request(t.ticket_id, { text: '想在家休息' }, key)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
  expect(await inputs(t.ticket_id)).toHaveLength(1);
  const records = await events();
  expect(records).toHaveLength(2);
  expect(records.find(e => e.source === 'app')?.payload).toMatchObject({ command: { kind: 'append' }, receipt: { ticket_id: t.ticket_id, saved: true } });
  expect(await db.select().from(decisions).where(eq(decisions.ticketId, t.ticket_id))).toHaveLength(2);
  expect((await ticket(t.ticket_id)).mandate).toEqual(before.mandate);
});

it('同一请求键换正文拒绝，不能覆盖已提交的补充', async () => {
  const t = await create(), key = randomUUID();
  expect((await request(t.ticket_id, { text: '在家' }, key)).status).toBe(200);
  const changed = await request(t.ticket_id, { text: '出门' }, key);
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: 'conflict' } });
  expect((await inputs(t.ticket_id)).map(i => i.text)).toEqual(['在家']);
});

it('取消收据可重放，重放旧补充不重新唤醒已取消的事项', async () => {
  const t = await create(), appendKey = randomUUID(), cancelKey = randomUUID();
  await request(t.ticket_id, { text: '在家' }, appendKey);
  const first = await request(t.ticket_id, undefined, cancelKey, true);
  const second = await request(t.ticket_id, undefined, cancelKey, true);
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(await first.json()).toEqual(await second.json());
  expect((await request(t.ticket_id, { text: '在家' }, appendKey)).status).toBe(200);
  expect((await ticket(t.ticket_id)).stage).toBe('cancelled');
  expect(await inputs(t.ticket_id)).toHaveLength(1);
  expect(await events()).toHaveLength(3);
});

it('聊天补充绑定原话并留下同一事项的操作记录，重放不重复写入', async () => {
  const t = await create(), inputId = await message('想待在家，别安排运动');
  await appendTicketInput(catId, t.ticket_id, '模型整理过的意思', inputId);
  await appendTicketInput(catId, t.ticket_id, '换一种整理', inputId);
  expect((await inputs(t.ticket_id)).map(i => i.text)).toEqual(['想待在家，别安排运动']);
  expect(await events()).toHaveLength(2);
  expect(await db.select().from(decisions).where(and(eq(decisions.ticketId, t.ticket_id), eq(decisions.outcome, 'attach')))).toHaveLength(1);
});

it.each(['cat', 'withdrawn', 'foreign'] as const)('取消工具不接受%s来源的授权', async kind => {
  const t = await create();
  let invalidId = await message('取消那件事', kind === 'cat' ? 'cat' : 'user');
  if (kind === 'withdrawn') await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, invalidId));
  if (kind === 'foreign') {
    const [u] = await db.insert(users).values({ devTokenHash: hashToken(randomUUID()) }).returning(); userIds.push(u!.id);
    const [c] = await db.insert(cats).values({ userId: u!.id, name: '别的猫', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
    const [v] = await db.insert(conversations).values({ catId: c!.id }).returning();
    const [m] = await db.insert(messages).values({ conversationId: v!.id, role: 'user', text: '取消' }).returning(); invalidId = m!.id;
  }
  const tools = await catTools({ catId, userMessageId: invalidId, turnId: randomUUID() });
  const result = await tools.cancel_ticket!.execute({ ticket_id: t.ticket_id }, new AbortController().signal);
  expect(result.status).toBe('failed');
  expect((await ticket(t.ticket_id)).status).toBe('open');
  expect(await events()).toHaveLength(1);
});

it('改期及重放都有统一收据，已过去的原创建请求不会重复建约定', async () => {
  const t = await scheduleFollowup(catId, sourceId, '2026-11-18T12:00:00Z', '面试怎么样', now);
  const inputId = await message('改到后一天');
  await updateTicket(catId, t.ticket_id, '2026-11-19T12:00:00Z', inputId, now);
  await updateTicket(catId, t.ticket_id, '2026-11-19T12:00:00Z', inputId, now);
  expect(await inputs(t.ticket_id)).toHaveLength(1);
  expect(await events()).toHaveLength(2);
  const replay = await scheduleFollowup(catId, sourceId, '2026-11-18T12:00:00Z', '面试怎么样', new Date('2026-11-20'));
  expect(replay.ticket_id).toBe(t.ticket_id);
  expect((await ticket(t.ticket_id)).dueAt?.toISOString()).toBe('2026-11-19T12:00:00.000Z');
});

it('失败事务不留下事件，缺少请求键仍兼容现有App', async () => {
  const t = await create();
  expect((await request(randomUUID(), { text: '找不到' }, randomUUID())).status).toBe(404);
  expect((await request(t.ticket_id, { when: '2026-11-18T12:00:00Z' }, randomUUID())).status).toBe(404);
  expect(await events()).toHaveLength(1);
  expect((await request(t.ticket_id, { text: '新补充' })).status).toBe(200);
  expect(await inputs(t.ticket_id)).toHaveLength(1);
  expect(await db.select().from(runs).where(eq(runs.ticketId, t.ticket_id))).toHaveLength(1);
});

// 重放身份不受执行后发生的时区变化影响；第二项在新时区恰好是不存在的夏令时时刻。
it.each(['2027-12-10T12:00:00', '2027-03-14T02:30:00'])('改期%s在切换时区后仍重放原收据', async when => {
  const t = await scheduleFollowup(catId, sourceId, '2027-12-01T12:00:00Z', '面试怎么样', now);
  const key = randomUUID(), body = { when };
  const first = await request(t.ticket_id, body, key);
  expect(first.status).toBe(200);
  const receipt = await first.json(), due = (await ticket(t.ticket_id)).dueAt;
  const changed = await app.request('/v1/me/time-zone', { method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ time_zone: 'America/New_York' }) });
  expect(changed.status).toBe(200);
  const replay = await request(t.ticket_id, body, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect((await ticket(t.ticket_id)).dueAt).toEqual(due);
  expect(await events()).toHaveLength(2);
  expect((await request(t.ticket_id, { when: '2027-12-12T12:00:00Z' }, key)).status).toBe(409);
});

it.each(['2027-02-30T12:00:00Z', '2027-02-29T12:00:00+08:00', '2027-13-01T12:00:00',
  '2027-00-10T12:00:00Z', '2027-12-00T12:00:00Z', '2027-12-10T24:00:00Z'])('非法日期%s返回400且不改约定', async when => {
  const t = await scheduleFollowup(catId, sourceId, '2027-12-01T12:00:00Z', '面试怎么样', now);
  const before = await ticket(t.ticket_id);
  expect((await request(t.ticket_id, { when }, randomUUID())).status).toBe(400);
  expect((await ticket(t.ticket_id)).dueAt).toEqual(before.dueAt);
  expect(await events()).toHaveLength(1);
  await expect(scheduleFollowup(catId, sourceId, when, '新的约定', now)).rejects.toMatchObject({ status: 400 });
});

it('合法闰日和显式偏移保留，夏令时缺失或重复时刻须澄清', () => {
  expect(parseFollowupTime('2028-02-29T12:00:00+08:00', 'UTC').toISOString()).toBe('2028-02-29T04:00:00.000Z');
  expect(parseFollowupTime('2028-02-29T12:00:00', 'Asia/Shanghai').toISOString()).toBe('2028-02-29T04:00:00.000Z');
  for (const when of ['2027-03-14T02:30:00', '2027-11-07T01:30:00']) {
    expect(() => parseFollowupTime(when, 'America/New_York')).toThrow();
  }
  expect(parseFollowupTime('2027-11-07T01:30:00-04:00', 'America/New_York').toISOString()).toBe('2027-11-07T05:30:00.000Z');
});
