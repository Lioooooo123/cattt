import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users, cats, conversations, messages, turns, boundaries, memoryBlocks } from '../src/db/schema.ts';
import { turnGuardSnapshot, turnPublicationChecks } from '../src/agent/publisher.ts';
import { acquireConversationLock, releaseConversationLock, requestCancel, readCancel, subscribeCancel } from '../src/turns/events.ts';

const ids: string[] = [];
afterAll(async () => {
  for (const id of ids) await db.delete(users).where(eq(users.id, id));
  await sql.end();
});

it('取消通知及时到达，保留晚读与作废优先', async () => {
  const id = randomUUID();
  const received: string[] = [];
  const remove = await subscribeCancel(id, reason => received.push(reason));
  try {
    await requestCancel(id, 'supersede');
    await requestCancel(id, 'stop');
    await expect.poll(() => received, { timeout: 500 }).toEqual(['supersede']);
    expect(await readCancel(id)).toBe('supersede');
    remove();
    await requestCancel(id, 'supersede');
    expect(received).toEqual(['supersede']);
  } finally { remove(); await sql`delete from turn_controls where turn_id=${id}`; }
});

it('释放锁唤醒等待者，错误持有者不能释放；短等待仍立即尝试', async () => {
  const id = randomUUID();
  expect(await acquireConversationLock(id, 'owner', 150)).toBe(true);
  expect(await acquireConversationLock(id, 'short', 150)).toBe(false);
  const started = performance.now();
  const waiter = acquireConversationLock(id, 'waiter', 1500);
  await new Promise(resolve => setTimeout(resolve, 80));
  await releaseConversationLock(id, 'wrong');
  expect((await sql`select token from conversation_locks where conversation_id=${id}`)[0]?.token).toBe('owner');
  await releaseConversationLock(id, 'owner');
  expect(await waiter).toBe(true);
  expect(performance.now() - started).toBeLessThan(700);
  await releaseConversationLock(id, 'waiter');
});

it('合并快照与原有 revision/boundaryStamp 字符串完全一致', async () => {
  const [user] = await db.insert(users).values({ name: '轮次快照' }).returning(); ids.push(user!.id);
  const [cat] = await db.insert(cats).values({ userId: user!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const [conv] = await db.insert(conversations).values({ catId: cat!.id }).returning();
  const [message] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: '你好' }).returning();
  const [other] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: '还有' }).returning();
  const [turn] = await db.insert(turns).values({ conversationId: conv!.id, userMessageId: message!.id, inputVersion: 0 }).returning();
  const checks = turnPublicationChecks(cat!.id);
  for (const populated of [false, true]) {
    if (populated) await db.insert(memoryBlocks).values({ catId: cat!.id, fingerprint: 'blocked' });
    if (populated) await db.insert(boundaries).values([
      { catId: cat!.id, sourceMessageId: message!.id, description: '不聊这个' },
      { catId: cat!.id, sourceMessageId: other!.id, description: '也不聊那个' },
    ]);
    const snapshot = await turnGuardSnapshot(cat!.id, turn!.id);
    expect(snapshot!.revision).toBe(await checks.revision());
    expect(snapshot!.boundaryStamp).toBe(await checks.boundaryStamp());
    expect(snapshot!.status).toBe('queued');
    expect(snapshot!.version).toBe(conv!.version);
  }
  expect(await turnGuardSnapshot(cat!.id, randomUUID())).toBeUndefined();
});

it('锁过期而没有发布通知时，低频重试仍可取得锁', async () => {
  const id = randomUUID();
  await sql`insert into conversation_locks values (${id}, 'expired', now() + interval '100 milliseconds')`;
  expect(await acquireConversationLock(id, 'next', 1600)).toBe(true);
  await releaseConversationLock(id, 'next');
});
