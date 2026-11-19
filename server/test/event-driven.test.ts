import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users, cats, conversations, messages, runs, mailboxLetters, asyncJobs, triggers, tickets, workerReports, diaryEntries } from '../src/db/schema.ts';
import { cancelTicket } from '../src/agent/tickets.ts';
import { startErrand } from '../src/agent/errands.ts';
import { processErrand } from '../src/agent/executor.ts';
import { scheduleFollowup } from '../src/agent/tickets.ts';
import { scanFollowups, processFollowup } from '../src/agent/followup.ts';
import { acquireConversationLock, releaseConversationLock } from '../src/turns/events.ts';
import { closeQueues } from '../src/queue.ts';
import { config } from '../src/config.ts';
config.MODEL_PROVIDER = 'mock';
const accounts: string[] = [];
const now = new Date('2026-11-13T04:00:00Z');
async function fixture() {
  const [user] = await db.insert(users).values({timeZone: 'Asia/Shanghai'}).returning();
  accounts.push(user!.id);
  const [cat] = await db.insert(cats).values({userId: user!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: {energy: 1, initiative: 1, directness: 1, closeness: 1}}).returning();
  const [conv] = await db.insert(conversations).values({catId: cat!.id}).returning();
  const [source] = await db.insert(messages).values({conversationId: conv!.id, role: 'user', text: '帮我想想周末怎么过'}).returning();
  return {catId: cat!.id, conversationId: conv!.id, sourceId: source!.id};
}
afterAll(async () => {
  for (const id of accounts) {
    await sql`delete from async_jobs where object_id in (select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id}) or source_id in (select t.id from triggers t join cats c on c.id=t.cat_id where c.user_id=${id})`;
    await db.delete(users).where(eq(users.id, id));
  }
  await closeQueues();  await sql.end();
});
it('后台完成只落盘汇报，不取得聊天锁、不直接写聊天或信箱', async () => {
  const f = await fixture();
  const t = await startErrand(f.catId, f.sourceId, '想想周末怎么过', now);
  const [r] = await db.select().from(runs).where(eq(runs.ticketId, t.ticket_id));
  await processErrand(r!.id, {now: () => now});
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, f.catId))).toHaveLength(0);
  expect(await db.select().from(messages).where(and(eq(messages.conversationId, f.conversationId), eq(messages.role, 'cat')))).toHaveLength(0);
  expect((await db.select().from(asyncJobs).where(and(eq(asyncJobs.kind, 'report'), eq(asyncJobs.sourceId, r!.id))))).toHaveLength(1);
});
it('到期措辞生成期间，用户消息仍能取得聊天锁', async () => {
  const f = await fixture();
  await scheduleFollowup(f.catId, f.sourceId, '2026-11-13T12:00:00', '面试怎么样', new Date(+now - 86400000));
  await scanFollowups(now, f.catId);
  const [event] = await db.select().from(triggers).where(and(eq(triggers.catId, f.catId), eq(triggers.source, 'clock')));
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => entered = r), barrier = new Promise<void>(r => release = r);
  const background = processFollowup(event!.id, {now, route: async () => {entered(); await barrier; throw new Error('controlled router unavailable');}});
  const token = randomUUID();
  try {
    await ready;
    expect(await acquireConversationLock(f.conversationId, token, 150)).toBe(true);
  } finally { release(); await background; await releaseConversationLock(f.conversationId, token); }
});
it('PG待办提交后立即通知，事务回滚不发通知，通知不含正文', async () => {
  const notifications: string[] = [];
  const listener = await sql.listen('cattt_agent_wake', payload => notifications.push(payload));
  const f = await fixture();
  try {
    await expect(db.transaction(async tx => {
      await tx.insert(asyncJobs).values({kind: 'memory', sourceId: randomUUID(), objectId: randomUUID(), version: 'test-event'});
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(notifications).toHaveLength(0);
    await startErrand(f.catId, f.sourceId, '想想周末怎么过', now);
    await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0), {timeout: 1500});
    expect(notifications.every(payload => payload === '')).toBe(true);
  } finally { await listener.unlisten(); }
});

it('汇报落盘后可由新前台接管；聊天占用时延后，重复投递只开口一次', async () => {
  const f = await fixture();
  const t = await startErrand(f.catId, f.sourceId, '周末建议', now);
  const [r] = await db.select().from(runs).where(eq(runs.ticketId, t.ticket_id));
  const token = randomUUID();
  await acquireConversationLock(f.conversationId, token, 150);
  await processErrand(r!.id, {now: () => now});
  const [job] = await db.select().from(asyncJobs).where(and(eq(asyncJobs.kind, 'report'), eq(asyncJobs.sourceId, r!.id)));
  const { processReport } = await import('../src/agent/reports.ts');
  let routed=0;
  try { expect(await processReport(job!.objectId, {now,route:async()=>{routed++;return {text:'放在信箱里了。'};}})).toHaveProperty('retryAt'); expect(routed).toBe(0); }
  finally { await releaseConversationLock(f.conversationId, token); }
  await processReport(job!.objectId, {now});
  await processReport(job!.objectId, {now});
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, f.catId))).toHaveLength(1);
  expect(await db.select().from(messages).where(and(eq(messages.conversationId, f.conversationId), eq(messages.role, 'cat')))).toHaveLength(1);
});
it('前台在措辞期间不占锁；新消息到达后旧措辞不得发布', async () => {
  const f = await fixture();
  const t = await startErrand(f.catId, f.sourceId, '周末建议', now);
  const [r] = await db.select().from(runs).where(eq(runs.ticketId, t.ticket_id));
  await processErrand(r!.id, {now: () => now});
  const [job] = await db.select().from(asyncJobs).where(and(eq(asyncJobs.kind, 'report'), eq(asyncJobs.sourceId, r!.id)));
  const { processReport } = await import('../src/agent/reports.ts');
  const token = randomUUID();
  await processReport(job!.objectId, {now, route: async snapshot => {
    expect(snapshot.recent.some(m => m.id === f.sourceId)).toBe(true);
    expect(await acquireConversationLock(f.conversationId, token, 150)).toBe(true);
    await db.update(conversations).set({version: 1}).where(eq(conversations.id, f.conversationId));
    await releaseConversationLock(f.conversationId, token);
    return {text: '我想好了，放在信箱里了。'};
  }});
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, f.catId))).toHaveLength(0);
  expect((await db.select().from(runs).where(eq(runs.id, r!.id)))[0]!.report.active).toBeUndefined();
});
it('执行完成但尚未开口时取消，前台丢弃旧汇报', async () => {
  const f = await fixture();
  const t = await startErrand(f.catId, f.sourceId, '周末建议', now);
  const [r] = await db.select().from(runs).where(eq(runs.ticketId, t.ticket_id));
  await processErrand(r!.id, {now: () => now});
  await cancelTicket(f.catId, t.ticket_id);
  const [job] = await db.select().from(asyncJobs).where(and(eq(asyncJobs.kind, 'report'), eq(asyncJobs.sourceId, r!.id)));
  const { processReport } = await import('../src/agent/reports.ts');
  await processReport(job!.objectId, {now});
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, f.catId))).toHaveLength(0);
});
it('猫日记执行器也只交结构化草稿，由前台复核出版', async () => {
  const f = await fixture();
  await db.update(cats).set({createdAt: new Date('2026-11-12T00:00:00Z')}).where(eq(cats.id, f.catId));
  const {scanDailyDiaries, processDailyDiary} = await import('../src/agent/daily-diary.ts');
  await scanDailyDiaries(now, f.catId);
  const [event] = await db.select().from(triggers).where(and(eq(triggers.catId, f.catId), eq(triggers.source, 'clock')));
  await processDailyDiary(event!.id);
  expect(await db.select().from(diaryEntries).where(eq(diaryEntries.catId, f.catId))).toHaveLength(0);
  const [report] = await db.select().from(workerReports).where(eq(workerReports.catId, f.catId));
  const {processReport} = await import('../src/agent/reports.ts');
  await processReport(report!.id, {now});
  expect(await db.select().from(diaryEntries).where(eq(diaryEntries.catId, f.catId))).toHaveLength(1);
});

it('用户日记的后台阅读也只汇报，由前台留下短话', async () => {
  const f = await fixture();
  const [entry] = await db.insert(diaryEntries).values({catId:f.catId,clientId:randomUUID(),mutationId:randomUUID(),kind:'text',text:'窗边看书',catAllowed:true,recordedAt:now,timeZone:'Asia/Shanghai',day:'2026-11-13',time:'12:00'}).returning();
  const {readDiary} = await import('../src/worker/diary.ts');
  await readDiary(entry!.id,String(entry!.revision),randomUUID(),async()=> '这页慢慢留着。');
  expect((await db.select().from(diaryEntries).where(eq(diaryEntries.id,entry!.id)))[0]!.visit).toBe(0);
  const [report] = await db.select().from(workerReports).where(eq(workerReports.catId,f.catId));
  const {processReport} = await import('../src/agent/reports.ts');
  await processReport(report!.id,{now});
  expect((await db.select().from(diaryEntries).where(eq(diaryEntries.id,entry!.id)))[0]!.note).toBe('这页慢慢留着。');
});

it('汇报等待前台期间撤回原话，不再把旧结果送给措辞模型', async () => {
  const f = await fixture();
  const t = await startErrand(f.catId, f.sourceId, '周末建议', now);
  const [r] = await db.select().from(runs).where(eq(runs.ticketId, t.ticket_id));
  await processErrand(r!.id, {now: () => now});
  await db.update(messages).set({contextAllowed:false}).where(eq(messages.id,f.sourceId));
  const [job] = await db.select().from(asyncJobs).where(and(eq(asyncJobs.kind,'report'),eq(asyncJobs.sourceId,r!.id)));
  const {processReport} = await import('../src/agent/reports.ts');
  let calls=0;
  await processReport(job!.objectId,{now,route:async()=>{calls++;return {text:'想法放在信箱里了。'};}});
  expect(calls).toBe(0);
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId,f.catId))).toHaveLength(0);
});
