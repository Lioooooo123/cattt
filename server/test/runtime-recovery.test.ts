import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { startErrand } from '../src/agent/errands.ts';
import { processErrand } from '../src/agent/executor.ts';
import { startFrontendRouter } from '../src/agent/frontend.ts';
import { scheduleFollowup } from '../src/agent/tickets.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { db, sql } from '../src/db/client.ts';
import { asyncJobs, cats, conversations, mailboxLetters, messages, runs, tickets, users } from '../src/db/schema.ts';
import { closeQueues } from '../src/queue.ts';

const userIds: string[] = [];

async function fixture(now = new Date()) {
  // 让前台以真实数据库时钟发布时处于白天。
  const hoursWest = now.getUTCHours() - 12;
  const timeZone = hoursWest === 0 ? 'UTC' : `Etc/GMT${hoursWest > 0 ? '+' : ''}${hoursWest}`;
  const token = randomUUID();
  const [user] = await db.insert(users).values({ devTokenHash: hashToken(token), timeZone }).returning();
  userIds.push(user!.id);
  const [cat] = await db.insert(cats).values({
    userId: user!.id, name: '团子', appearance: 'orange', temperament: 'slow',
    traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 },
  }).returning();
  const [conversation] = await db.insert(conversations).values({ catId: cat!.id }).returning();
  const [source] = await db.insert(messages).values({
    conversationId: conversation!.id, role: 'user', text: '帮我想想周末怎么过',
  }).returning();
  return { token, catId: cat!.id, sourceId: source!.id };
}

afterAll(async () => {
  await closeQueues();
  for (const id of userIds) {
    await sql`delete from async_jobs where object_id in (
      select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id}
    ) or object_id in (
      select w.id from worker_reports w join cats c on c.id=w.cat_id where c.user_id=${id}
    )`;
    await db.delete(users).where(eq(users.id, id));
  }

  await sql.end();
});

it('worker 停机且积压占满一批时，前台仍能发布已落库的汇报', async () => {
  const now = new Date();
  const { catId, sourceId } = await fixture(now);
  const backlog = await db.insert(asyncJobs).values(Array.from({ length: 100 }, () => ({
    kind: 'memory', sourceId: randomUUID(), objectId: randomUUID(), version: 'recovery-test', nextAttemptAt: new Date(0),
  }))).returning({ id: asyncJobs.id });
  const ids = backlog.map(job => job.id);
  let stopFrontend: (() => Promise<void>) | undefined;
  try {
    const { ticket_id: ticketId } = await startErrand(catId, sourceId, '周末建议', now);
    const [run] = await db.select().from(runs).where(eq(runs.ticketId, ticketId));
    await processErrand(run!.id, { now: () => now });
    const [reportJob] = await db.select().from(asyncJobs).where(and(eq(asyncJobs.kind, 'report'), eq(asyncJobs.sourceId, run!.id)));
    expect(reportJob?.state).toBe('pending');
    expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.ticketId, ticketId))).toHaveLength(0);

    stopFrontend = await startFrontendRouter();
    await vi.waitFor(async () => {
      const [delivery] = await sql`select exists(select 1 from pgboss.job
        where name='report' and data->>'taskId' = ${reportJob!.id}) as queued`;
      expect(delivery!.queued).toBe(true);
    }, { timeout: 3500 });
    // 同批测试留下的前台汇报会排在本用例之前，入队和消费要分别验证。
    await vi.waitFor(async () => {
      const [job] = await db.select().from(asyncJobs).where(eq(asyncJobs.id, reportJob!.id));
      expect(job?.state).toBe('done');
    }, { timeout: 30_000 });
    const letters = await db.select().from(mailboxLetters).where(eq(mailboxLetters.ticketId, ticketId));
    expect(letters).toHaveLength(1);
    expect((await db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]?.stage).toBe('ready');
    const [dispatched] = await sql`select count(*)::int as total from pgboss.job
      where name='memory-extract' and data->>'taskId' = any(${sql.array(ids)}::text[])`;
    expect(dispatched!.total).toBe(0);
  } finally {
    await stopFrontend?.();
    await db.delete(asyncJobs).where(inArray(asyncJobs.id, ids));
  }
}, 40_000);

it.each(['续办', '改期'] as const)('%s 在连接池只剩一个连接时仍能完成', async action => {
  const { token, catId, sourceId } = await fixture();
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  let ticketId: string;
  if (action === '续办') {
    ({ ticket_id: ticketId } = await startErrand(catId, sourceId, '周末建议'));
    await db.update(runs).set({ status: 'ended' }).where(eq(runs.ticketId, ticketId));
    await db.update(tickets).set({ status: 'ended', stage: 'failed' }).where(eq(tickets.id, ticketId));
  } else {
    ({ ticket_id: ticketId } = await scheduleFollowup(catId, sourceId,
      new Date(Date.now() + 86_400_000).toISOString(), '明天聊周末'));
  }

  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const acquire = Array.from({ length: 9 }, () => {
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const held = sql.begin(async () => { ready(); await released; });
    return { entered, held };
  });
  let response: Response | undefined;
  let request: Promise<void> | undefined;
  try {
    await Promise.all(acquire.map(connection => connection.entered));
    request = Promise.resolve(app.request(`/v1/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(action === '续办' ? { text: '继续想，我想待在家' } : { when: later }),
    })).then(result => { response = result; });
    await vi.waitFor(() => expect(response?.status).toBe(200), { timeout: 2000 });
  } finally {
    release();
    await Promise.all(acquire.map(connection => connection.held));
    await request;
  }
  if (action === '续办') {
    expect(await response!.json()).toMatchObject({ resumed: true });
    expect(await db.select().from(runs).where(eq(runs.ticketId, ticketId))).toHaveLength(2);
  } else {
    expect((await db.select().from(tickets).where(eq(tickets.id, ticketId)))[0]?.dueAt?.toISOString()).toBe(later);
  }
});
