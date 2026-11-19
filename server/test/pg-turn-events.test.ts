import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { createDevUser } from '../src/dev-user.ts';
import { cats, conversations, messages, turns, users } from '../src/db/schema.ts';
import { acquireConversationLock, cleanupTurnState, conversationBusy, publish, readCancel, readVisibleLength, recordVisibleLength, refreshConversationLock, releaseConversationLock, requestCancel, tail, type StoredEvent } from '../src/turns/events.ts';
import { subscribe } from '../src/turns/subscriber.ts';

const owners: string[] = [];
const ids: string[] = [];
async function fixture() {
  const owner = await createDevUser('pg-events'); owners.push(owner.userId);
  const [cat] = await db.select().from(cats).where(eq(cats.userId, owner.userId));
  const [conv] = await db.select().from(conversations).where(eq(conversations.catId, cat!.id));
  const [msg] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: '你好' }).returning();
  const [turn] = await db.insert(turns).values({ conversationId: conv!.id, userMessageId: msg!.id, inputVersion: 0, status: 'generating' }).returning();
  ids.push(turn!.id);
  return turn!.id;
}
afterAll(async () => {
  for (const id of owners) await db.delete(users).where(eq(users.id, id));
  for (const id of ids) {
    await sql`delete from turn_events where turn_id=${id}`;
    await sql`delete from turn_controls where turn_id=${id}`;
    await sql`delete from conversation_locks where conversation_id=${id}`;
  }
  await sql.end();
});

it('并发发布不漏序号，断点只读取后续事件；空流和未知游标返回 missing', async () => {
  const id = await fixture();
  const signal = new AbortController().signal;
  expect(await tail(id, '0', signal).next()).toEqual({ value: 'missing', done: true });
  await Promise.all(Array.from({ length: 12 }, (_, n) => publish(id, { event: 'delta', data: { text: String(n) } })));
  await publish(id, { event: 'done', data: { message_id: null, status: 'done' } });
  const received: (StoredEvent | 'ping')[] = [];
  for await (const ev of tail(id, 'pg-6', signal)) received.push(ev);
  expect(received.map(ev => ev === 'ping' ? ev : ev.id)).toEqual(Array.from({ length: 7 }, (_, n) => `pg-${n + 7}`));
  for (const cursor of ['pg-999', '123-0', 'missing', 'snapshot']) {
    expect(await tail(id, cursor, signal).next()).toEqual({ value: 'missing', done: true });
  }
  await expect(publish('not-a-uuid', { event: 'delta', data: { text: '失败' } })).rejects.toThrow();
});

it('订阅实时唤醒事件读取，空读保活并且可中止', async () => {
  const id = await fixture();
  await publish(id, { event: 'delta', data: { text: '一' } });
  const ac = new AbortController();
  const stream = tail(id, 'pg-1', ac.signal);
  expect((await stream.next()).value).toBe('ping');
  const started = performance.now();
  const next = stream.next();
  await new Promise(resolve => setTimeout(resolve, 50));
  await publish(id, { event: 'delta', data: { text: '二' } });
  expect((await next).value).toMatchObject({ event: 'delta', data: { text: '二' } });
  expect(performance.now() - started).toBeLessThan(700);
  ac.abort();
  expect(await stream.next()).toEqual({ value: 'aborted', done: true });
});

it('终态十分钟和非终态一小时按最后事件过期，清扫真正删除', async () => {
  const id = await fixture();
  await publish(id, { event: 'delta', data: { text: '正文' } });
  await sql`update turn_events set created_at=now()-interval '11 minutes' where turn_id=${id}`;
  const ac = new AbortController();
  const active = tail(id, '0', ac.signal);
  expect((await active.next()).value).toMatchObject({ event: 'delta' });
  ac.abort(); await active.next();
  await db.update(turns).set({ status: 'completed' }).where(eq(turns.id, id));
  expect(await tail(id, '0', ac.signal).next()).toEqual({ value: 'missing', done: true });
  await cleanupTurnState();
  expect(await sql`select 1 from turn_events where turn_id=${id}`).toHaveLength(0);
  await db.update(turns).set({ status: 'generating' }).where(eq(turns.id, id));
  await publish(id, { event: 'delta', data: { text: '新' } });
  await sql`update turn_events set created_at=now()-interval '61 minutes' where turn_id=${id}`;
  expect(await tail(id, '0', new AbortController().signal).next()).toEqual({ value: 'missing', done: true });
  await cleanupTurnState();
  expect(await sql`select 1 from turn_events where turn_id=${id}`).toHaveLength(0);
});

it('控制状态分别过期；可见长度通知与取消优先级独立', async () => {
  const id = randomUUID(); ids.push(id);
  expect(await readCancel(id)).toBeNull();
  expect(await readVisibleLength(id)).toBeNull();
  const lengths: string[] = [];
  const remove = await subscribe(`turn:${id}:visible`, value => lengths.push(value));
  try {
    await recordVisibleLength(id, 0);
    await expect.poll(() => lengths).toEqual(['0']);
    await requestCancel(id, 'stop'); await requestCancel(id, 'supersede'); await requestCancel(id, 'stop');
    expect(await readCancel(id)).toBe('supersede');
    expect(await readVisibleLength(id)).toBe(0);
    await sql`update turn_controls set cancel_expires_at=now()-interval '1 second' where turn_id=${id}`;
    expect(await readCancel(id)).toBeNull();
    expect(await readVisibleLength(id)).toBe(0);
    await requestCancel(id, 'stop');
    expect(await readCancel(id)).toBe('stop');
    await sql`update turn_controls set cancel_expires_at=now()-interval '1 second', visible_expires_at=now()-interval '1 second' where turn_id=${id}`;
    expect(await readVisibleLength(id)).toBeNull();
    await cleanupTurnState();
    expect(await sql`select 1 from turn_controls where turn_id=${id}`).toHaveLength(0);
  } finally { remove(); }
});

it('只有当前未过期令牌能续租，旧持有者不能影响接管者', async () => {
  const id = randomUUID(); ids.push(id);
  expect(await conversationBusy(id)).toBe(false);
  expect(await acquireConversationLock(id, 'a', 0)).toBe(true);
  expect(await conversationBusy(id)).toBe(true);
  expect(await refreshConversationLock(id, 'wrong')).toBe(false);
  expect(await refreshConversationLock(id, 'a')).toBe(true);
  await sql`update conversation_locks set expires_at=now()-interval '1 second' where conversation_id=${id}`;
  expect(await refreshConversationLock(id, 'a')).toBe(false);
  expect(await conversationBusy(id)).toBe(false);
  expect(await acquireConversationLock(id, 'b', 0)).toBe(true);
  await releaseConversationLock(id, 'a');
  expect(await conversationBusy(id)).toBe(true);
  await releaseConversationLock(id, 'b');
  expect(await conversationBusy(id)).toBe(false);
});

it('重复取消旧订阅不会移除后来注册的新订阅', async () => {
  const id = randomUUID(); ids.push(id);
  const channel = `turn:${id}:visible`;
  const received: string[] = [];
  const old = await subscribe(channel, () => {});
  old();
  const remove = await subscribe(channel, value => received.push(value));
  try {
    old();
    await recordVisibleLength(id, 7);
    await expect.poll(() => received).toEqual(['7']);
  } finally { remove(); }
});
