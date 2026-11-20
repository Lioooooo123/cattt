import { jobModelAccount } from '../runtime/budget.ts';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, dbNow, type Tx } from '../db/client.ts';
import { asyncJobs, boundaries, cats, conversations, memories, memoryReceipts, messages, turns } from '../db/schema.ts';
import type { JobKind } from '../queue.ts';
export const JOB_VERSION = 'v1';
export const MAX_JOB_ATTEMPTS = 3;

export async function ensureMemoryJob(tx: Tx, turn: typeof turns.$inferSelect) {
  // 首个事务提交的成功轮次是固定的提取输入；后来的重答共享这个结果。
  await tx.insert(asyncJobs).values({ kind: 'memory', sourceId: turn.userMessageId, objectId: turn.id, version: JOB_VERSION }).onConflictDoNothing();
  const [job] = await tx.select().from(asyncJobs).where(and(eq(asyncJobs.sourceId, turn.userMessageId), eq(asyncJobs.kind, 'memory'), eq(asyncJobs.version, JOB_VERSION)));
  if (job?.state === 'done') await tx.update(turns).set({ extractedAt: dbNow(), remembered: job.remembered }).where(eq(turns.id, turn.id));
}
export async function ensureBoundaryJob(tx: Tx, boundaryId: string) {
  await tx.insert(asyncJobs).values({ kind: 'boundary', sourceId: boundaryId, objectId: boundaryId, version: JOB_VERSION }).onConflictDoNothing();
}

/** 仅显式运行历史补建；普通 worker 启动不批量触发历史模型调用。 */
export async function backfillJobs(limit = 100) {
  return db.transaction(async (tx) => {
    const missingTurns = await tx.select({ turn: turns }).from(turns).leftJoin(asyncJobs,
      and(eq(asyncJobs.sourceId, turns.userMessageId), eq(asyncJobs.kind, 'memory'), eq(asyncJobs.version, JOB_VERSION)))
      .where(and(inArray(turns.status, ['completed', 'stopped']), isNull(turns.extractedAt), isNull(asyncJobs.id)))
      .orderBy(asc(turns.finishedAt), asc(turns.id)).limit(limit);
    for (const { turn } of missingTurns) await ensureMemoryJob(tx, turn);
    const missingBoundaries = await tx.select({ boundary: boundaries }).from(boundaries).leftJoin(asyncJobs,
      and(eq(asyncJobs.sourceId, boundaries.id), eq(asyncJobs.kind, 'boundary'), eq(asyncJobs.version, JOB_VERSION)))
      .where(and(isNull(boundaries.description), isNull(asyncJobs.id))).orderBy(boundaries.createdAt).limit(limit);
    for (const { boundary } of missingBoundaries) await ensureBoundaryJob(tx, boundary.id);
    return { turns: missingTurns.length, boundaries: missingBoundaries.length };
  });
}

/** 只补投本进程消费的类型，另一进程积压时仍能推进自己的待办。 */
export async function recoverJobs(kinds: JobKind[]) {
  const ownedKinds = inArray(asyncJobs.kind, kinds);
  await db.update(asyncJobs).set({ state: 'failed', error: 'lease expired after final attempt', leaseUntil: null })
    .where(and(ownedKinds, eq(asyncJobs.state, 'running'), sql`${asyncJobs.kind} not in ('followup','errand','daily_diary','push','inference','report')`, lte(asyncJobs.leaseUntil, dbNow()), sql`${asyncJobs.attempts} >= ${MAX_JOB_ATTEMPTS}`));
  const due = await db.select().from(asyncJobs).where(and(ownedKinds, sql`(${asyncJobs.kind} in ('followup','errand','daily_diary','push','inference','report') or ${asyncJobs.attempts} < ${MAX_JOB_ATTEMPTS})`,
    or(and(eq(asyncJobs.state, 'pending'), lte(asyncJobs.nextAttemptAt, dbNow())),
      and(eq(asyncJobs.state, 'running'), lte(asyncJobs.leaseUntil, dbNow()))))).limit(100);
  const { dispatchJob } = await import('../queue.ts');
  const overdueBefore = Date.now() - 5 * 60_000;
  const overdue = due.some(job => {
    const dueAt = job.state === 'pending' ? job.nextAttemptAt : job.leaseUntil;
    return dueAt !== null && dueAt.getTime() < overdueBefore;
  });
  for (const job of due) {
    try { await dispatchJob(job); }
    catch (error) {
      console.error(`[outbox ${job.id}] 投递失败，下轮继续`, error);
      return { dispatchOK: false, overdue }; // 同一投递故障不逐条等待整批；待办留在 PG。
    }
  }
  return { dispatchOK: true, overdue };
}

export async function executeJob(id: string, execute: (job: typeof asyncJobs.$inferSelect) => Promise<boolean | void | {retryAt:Date}>) {
  const [job] = await db.update(asyncJobs).set({ state: 'running', attempts: sql`${asyncJobs.attempts} + 1`,
    leaseUntil: sql`now() + interval '5 minutes'` }).where(and(eq(asyncJobs.id, id), sql`(${asyncJobs.kind} in ('followup','errand','daily_diary','push','inference','report') or ${asyncJobs.attempts} < ${MAX_JOB_ATTEMPTS})`,
      or(and(eq(asyncJobs.state, 'pending'), lte(asyncJobs.nextAttemptAt, dbNow())),
        and(eq(asyncJobs.state, 'running'), lte(asyncJobs.leaseUntil, dbNow()))))).returning();
  if (!job) return;
  const owned = and(eq(asyncJobs.id, id), eq(asyncJobs.state, 'running'), eq(asyncJobs.attempts, job.attempts));
  const heartbeat = setInterval(() => {
    void db.update(asyncJobs).set({ leaseUntil: sql`now() + interval '5 minutes'` }).where(owned)
      .catch((error) => console.error(`[outbox ${id}] 续租失败`, error));
  }, 30_000);
  try {
    const result = await jobModelAccount(job,()=>execute(job));
    if(result && typeof result === 'object') {
      await db.update(asyncJobs).set({state:'pending',leaseUntil:null,nextAttemptAt:result.retryAt}).where(owned); return;
    }
    let remembered = result === true;
    await db.transaction(async (tx) => {
      if (job.kind === 'memory') {
        const [turn] = await tx.select().from(turns).where(eq(turns.id, job.objectId));
        if (turn) {
          const [conv] = await tx.select().from(conversations).where(eq(conversations.id, turn.conversationId));
          if (conv) {
            const [cat] = await tx.select().from(cats).where(eq(cats.id, conv.catId)).for('update');
            const active = await tx.select().from(memories).innerJoin(messages, eq(messages.id, memories.sourceMessageId))
              .innerJoin(memoryReceipts, and(eq(memoryReceipts.catId, conv.catId), eq(memoryReceipts.fingerprint, memories.fingerprint), eq(memoryReceipts.sourceMessageId, job.sourceId), eq(memoryReceipts.accepted, true)))
              .where(and(eq(memories.catId, conv.catId), eq(memories.status, 'active'), eq(memories.explicit, true), eq(messages.contextAllowed, true)));
            remembered = remembered && !!cat?.learnMemories && active.length > 0;
          }
          await tx.select().from(conversations).where(eq(conversations.id, turn.conversationId)).for('update');
        }
      }
      const applied = await tx.update(asyncJobs).set({ state: 'done', remembered, leaseUntil: null, error: null }).where(owned).returning();
      if (applied.length && job.kind === 'memory') await tx.update(turns).set({ extractedAt: dbNow(), remembered })
        .where(and(eq(turns.userMessageId, job.sourceId), inArray(turns.status, ['completed', 'stopped'])));
    });
  } catch (error) {
    if(error instanceof Error&&error.message.includes('model_daily_budget')) {
      await db.update(asyncJobs).set({state:'pending',attempts:sql`greatest(${asyncJobs.attempts}-1,0)`,leaseUntil:null,error:'model_daily_budget',nextAttemptAt:sql`(date_trunc('day',now() at time zone 'UTC')+interval '1 day') at time zone 'UTC'`}).where(owned);
      return;
    }
    const permanent = error instanceof Error && error.name === 'UnrecoverableError';
    await db.update(asyncJobs).set({ state: permanent || (!['followup','errand','daily_diary','push','inference','report'].includes(job.kind) && job.attempts >= MAX_JOB_ATTEMPTS) ? 'failed' : 'pending',
      leaseUntil: null, error: String(error).slice(0, 1000), nextAttemptAt: sql`now() + interval '10 seconds'` }).where(owned);
    throw error;
  } finally { clearInterval(heartbeat); }
}
