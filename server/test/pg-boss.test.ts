import { processReport } from '../src/agent/reports.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { asyncJobs, boundaries, cats, conversations, diaryEntries, messages, turns, users } from '../src/db/schema.ts';
import { closeQueues, dispatchJob, getBoss, QUEUE, startQueueWorkers } from '../src/queue.ts';
import { executeJob, MAX_JOB_ATTEMPTS, recoverJobs } from '../src/jobs/store.ts';
import { UnrecoverableError } from '../src/jobs/errors.ts';
import { extractMemories } from '../src/worker/memory.ts';
import { summarizeBoundary } from '../src/worker/boundary.ts';
import { readDiary } from '../src/worker/diary.ts';
const jobs: string[] = [], accounts: string[] = [];
const actions = new Map<string, () => Promise<void>>();
const run = async (id: string) => {
  if (!jobs.includes(id)) return; // 共享测试库里其它用例的待办留给它自己的恢复扫描。
  await executeJob(id, task => {
  const action = actions.get(id); if (action) return action();
  return task.kind === 'report' ? processReport(task.objectId) : task.kind === 'memory' ? extractMemories(task.objectId, task.id) : task.kind === 'boundary' ? summarizeBoundary(task.objectId, task.id) : readDiary(task.objectId, task.version, task.id);
  });
};
const state = async (id: string) => (await db.select().from(asyncJobs).where(eq(asyncJobs.id, id)))[0]!;
async function pending(action: () => Promise<void>) {
  const id = randomUUID(); actions.set(id, action); jobs.push(id);
  const [job] = await db.insert(asyncJobs).values({ id, kind: 'boundary', sourceId: randomUUID(), objectId: randomUUID(), version: 'v1', nextAttemptAt: new Date(0) }).returning(); return job!;
}
beforeAll(async () => { await startQueueWorkers({ memory: run, boundary: run, diary_read: run, report: run, sweep: async () => {} }); }, 30000);
afterAll(async () => {
  await closeQueues();
  if (jobs.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, jobs));
  for (const id of accounts) await db.delete(users).where(eq(users.id, id));
  await sql.end();
});
it('pg-boss 正常投递，重复投递只认领一次', async () => {
  let calls = 0; const job = await pending(async () => { calls++; });
  await Promise.all([dispatchJob(job), dispatchJob(job)]);
  await vi.waitFor(async () => expect((await state(job.id)).state).toBe('done'), { timeout: 10000 });
  expect(calls).toBe(1); expect((await state(job.id)).attempts).toBe(1);
});
it('PG 控制重试到上限，旧的失败投递不挡住下一次', async () => {
  let calls = 0; const job = await pending(async () => { calls++; throw new Error('受控临时失败'); });
  for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
    await db.update(asyncJobs).set({ nextAttemptAt: new Date(0) }).where(eq(asyncJobs.id, job.id));
    await dispatchJob(await state(job.id));
    await vi.waitFor(async () => {
      const row = await state(job.id); expect(row.attempts).toBe(attempt); expect(row.state).toBe(attempt === MAX_JOB_ATTEMPTS ? 'failed' : 'pending');
    }, { timeout: 10000 });
  }
  await dispatchJob(await state(job.id));
  expect((await state(job.id)).state).toBe('failed'); expect(calls).toBe(MAX_JOB_ATTEMPTS);
}, 30000);
it('永久失败只执行一次，不耗尽全部尝试', async () => {
  let calls = 0; const job = await pending(async () => { calls++; throw new UnrecoverableError('受控永久失败'); });
  await dispatchJob(job);
  await vi.waitFor(async () => expect((await state(job.id)).state).toBe('failed'), { timeout: 10000 });
  await dispatchJob(await state(job.id));
  expect((await state(job.id)).attempts).toBe(1); expect(calls).toBe(1);
});
it('投递失败保留 PG 待办，恢复扫描可以补投', async () => {
  const job = await pending(async () => {}); const boss = await getBoss();
  const send = vi.spyOn(boss, 'send').mockRejectedValue(new Error('受控投递失败'));
  try { await recoverJobs(['boundary']); expect((await state(job.id)).state).toBe('pending'); expect((await state(job.id)).attempts).toBe(0); }
  finally { send.mockRestore(); }
  await recoverJobs(['boundary']);
  await vi.waitFor(async () => expect((await state(job.id)).state).toBe('done'), { timeout: 10000 });
});
it('三类真实处理器经 pg-boss 完成', async () => {
  const [user] = await db.insert(users).values({ name: '队列验收' }).returning(); accounts.push(user!.id);
  const [cat] = await db.insert(cats).values({ userId: user!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const [conv] = await db.insert(conversations).values({ catId: cat!.id }).returning();
  const [message] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: '我喜欢喝茶' }).returning();
  const [turn] = await db.insert(turns).values({ conversationId: conv!.id, userMessageId: message!.id, inputVersion: 0, status: 'completed' }).returning();
  const [boundary] = await db.insert(boundaries).values({ catId: cat!.id, sourceMessageId: message!.id }).returning();
  const [entry] = await db.insert(diaryEntries).values({ catId: cat!.id, clientId: randomUUID(), kind: 'text', text: '今天在窗边坐了一会儿。', recordedAt: new Date(), timeZone: 'Asia/Shanghai', day: '2026-11-10', time: '12:00', catAllowed: true, mutationId: randomUUID() }).returning();
  const queued = await db.insert(asyncJobs).values([
    { kind: 'memory' as const, sourceId: message!.id, objectId: turn!.id, version: 'v1', nextAttemptAt: new Date(0) },
    { kind: 'boundary' as const, sourceId: boundary!.id, objectId: boundary!.id, version: 'v1', nextAttemptAt: new Date(0) },
    { kind: 'diary_read' as const, sourceId: entry!.id, objectId: entry!.id, version: String(entry!.revision), nextAttemptAt: new Date(0) },
  ]).returning(); jobs.push(...queued.map(j => j.id));
  // 同猫记忆写入会使进行中的日记快照失效，故按顺序等待。
  for (const job of queued) {
    await dispatchJob(job);
    await vi.waitFor(async () => expect((await state(job.id)).state).toBe('done'), { timeout: 10000 });
  }
  const reports=await db.select().from(asyncJobs).where(eq(asyncJobs.sourceId,entry!.id));
  for(const job of reports.filter(j=>j.kind==='report')){jobs.push(job.id);await dispatchJob(job);await vi.waitFor(async()=>expect((await state(job.id)).state).toBe('done'),{timeout:10000});}
  expect((await db.select().from(turns).where(eq(turns.id, turn!.id)))[0]!.extractedAt).not.toBeNull();
  expect((await db.select().from(boundaries).where(eq(boundaries.id, boundary!.id)))[0]!.description).toBeTruthy();
  expect((await db.select().from(diaryEntries).where(eq(diaryEntries.id, entry!.id)))[0]!.visit).toBe(2);
}, 20000);
it('投递表位于 pgboss，业务表与 drizzle 迁移仍隔离', async () => {
  expect(await sql`select schemaname from pg_tables where tablename = 'async_jobs'`).toEqual([{ schemaname: 'public' }]);
  expect(await sql`select schemaname from pg_tables where tablename = 'job' and schemaname = 'pgboss'`).toHaveLength(1);
  const boss = await getBoss(); expect((await boss.getQueue(QUEUE.memoryExtract))?.retryLimit).toBe(0);
});
