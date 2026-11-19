import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import {
  users,
  cats,
  conversations,
  messages,
  tickets,
  triggers,
  outbox,
  mailboxLetters,
  ticketInputs,
  asyncJobs,
  boundaries,
} from '../src/db/schema.ts';
import { scheduleFollowup, cancelTicket, parseFollowupTime } from '../src/agent/tickets.ts';
import { scanFollowups, processFollowup } from '../src/agent/followup.ts';
import { executeJob } from '../src/jobs/store.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { closeQueues } from '../src/queue.ts';
import { catTools } from '../src/runtime/tools.ts';
const now = new Date('2026-11-12T04:00:00Z');
let owner: { userId: string; catId: string; conversationId: string }, sourceId: string, token: string;
const userIds: string[] = [];
beforeEach(async () => {
  token = randomUUID();
  const [u] = await db
    .insert(users)
    .values({ devTokenHash: hashToken(token) })
    .returning();
  userIds.push(u!.id);
  const [c] = await db
    .insert(cats)
    .values({
      userId: u!.id,
      name: '团子',
      appearance: 'orange',
      temperament: 'slow',
      traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 },
    })
    .returning();
  const [v] = await db.insert(conversations).values({ catId: c!.id }).returning();
  owner = { userId: u!.id, catId: c!.id, conversationId: v!.id };
  const [m] = await db
    .insert(messages)
    .values({ conversationId: v!.id, role: 'user', text: '明天中午十二点问我面试怎么样' })
    .returning();
  sourceId = m!.id;
});
afterAll(async () => {
  for (const id of userIds) {
    await sql`delete from async_jobs where source_id in (select t.id from triggers t join cats c on c.id=t.cat_id where c.user_id=${id})`;
    await db.delete(users).where(eq(users.id, id));
  }
  await closeQueues();

  await sql.end();
});
it('500 个已经投递但仍开放的约定不会挡住下一件', async () => {
  const dueAt = new Date(+now - 60_000);
  await db.insert(tickets).values(Array.from({length: 500}, () => ({
    catId: owner.catId, kind: 'followup', goal: '等到白天再聊', dueAt,
    mandate: {kind: 'explicit' as const, source_message_id: sourceId},
  })));
  await scanFollowups(now, owner.catId);
  const later = await schedule();
  await scanFollowups(now, owner.catId);
  const clocks = await db.select().from(triggers).where(and(eq(triggers.catId, owner.catId), eq(triggers.source, 'clock')));
  expect(clocks.map(row => row.payload.ticket_id)).toContain(later.ticket_id);
}, 20_000);

const schedule = (when = '2026-11-12T12:00:00', about = '面试怎么样') =>
  scheduleFollowup(owner.catId, sourceId, when, about, new Date('2026-11-11T04:00:00Z'));
async function fire(at = now, route?: () => Promise<unknown>) {
  await scanFollowups(at, owner.catId);
  for (const t of await db.select().from(triggers).where(eq(triggers.catId, owner.catId)))
    await processFollowup(t.id, { now: at, route });
}
const said = () =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, owner.conversationId), eq(messages.role, 'cat')));
it('同一约定只问一次，重放有收据，主动消息不属于轮次且不改变输入版本', async () => {
  const r = await schedule();
  await fire();
  await fire();
  expect(await said()).toHaveLength(1);
  expect((await said())[0]).toMatchObject({ turnId: null, ticketId: r.ticket_id });
  expect((await db.select().from(conversations).where(eq(conversations.id, owner.conversationId)))[0]!.version).toBe(0);
});
it('到期前取消后不问，已产生的事件也丢弃', async () => {
  const r = await schedule();
  await scanFollowups(now, owner.catId);
  await cancelTicket(owner.catId, r.ticket_id);
  await fire();
  expect(await said()).toHaveLength(0);
});
it('原话停用后不问，不要再提边界同样阻断', async () => {
  await schedule();
  await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, sourceId));
  await fire();
  expect(await said()).toHaveLength(0);
  await db.update(messages).set({ contextAllowed: true }).where(eq(messages.id, sourceId));
  await schedule('2026-11-12T12:00:01');
  await db.insert(boundaries).values({ catId: owner.catId, sourceMessageId: sourceId, description: '面试' });
  await fire(new Date(now.getTime() + 2000));
  expect(await said()).toHaveLength(0);
});
it('安静时段顺延到用户本地09点', async () => {
  await schedule('2026-11-12T23:00:00');
  await fire(new Date('2026-11-12T15:00:00Z'));
  expect(await said()).toHaveLength(0);
  await fire(new Date('2026-11-13T00:59:59Z'));
  expect(await said()).toHaveLength(0);
  await fire(new Date('2026-11-13T01:00:00Z'));
  expect(await said()).toHaveLength(1);
});
it('改时区保留UTC约定，以新时区判断安静时段', async () => {
  const r = await schedule();
  await db.update(users).set({ timeZone: 'America/New_York' }).where(eq(users.id, owner.userId));
  await fire();
  expect(await said()).toHaveLength(0);
  await fire(new Date('2026-11-12T14:00:00Z'));
  expect(await said()).toHaveLength(1);
  expect((await db.select().from(tickets).where(eq(tickets.id, r.ticket_id)))[0]!.dueAt?.toISOString()).toBe(
    now.toISOString(),
  );
});
it('到期瞬间重启从PG投递恢复，发布后进程退出再重放不重不漏', async () => {
  await schedule();
  await scanFollowups(now, owner.catId);
  const [trigger] = await db.select().from(triggers).where(and(eq(triggers.catId, owner.catId), eq(triggers.source, 'clock')));
  const [job] = await db.select().from(asyncJobs).where(eq(asyncJobs.sourceId, trigger!.id));
  expect(job).toBeDefined();
  // 新进程只从PG重建输入；发布提交后立即退出，故意不确认投递。
  const code = `import { processFollowup } from './src/agent/followup.ts';
    await processFollowup(${JSON.stringify(trigger!.id)}, {now:new Date(${JSON.stringify(now.toISOString())})});
    process.exit(0);`;
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { timeout: 10000, env: {...process.env, MODEL_PROVIDER:'mock'} });
  // 再启动一个进程重放同一事件，并与原投递的恢复消费并发。
  await Promise.all([
    promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { timeout: 10000, env: {...process.env, MODEL_PROVIDER:'mock'} }),
    executeJob(job!.id, j => processFollowup(j.objectId, {now})),
  ]);
  await fire();
  expect(await said()).toHaveLength(1);
});
it('同一时刻三件合并为一条，每件都有去重凭证', async () => {
  for (const a of ['面试怎么样', '看牙怎么样', '比赛怎么样']) await schedule(undefined, a);
  await fire();
  expect(await said()).toHaveLength(1);
  for (const w of ['面试', '看牙', '比赛']) expect((await said())[0]!.text).toContain(w);
  expect(
    (await db.select().from(outbox).where(eq(outbox.catId, owner.catId))).filter((r) => r.kind === 'chat_message'),
  ).toHaveLength(3);
});
it('“改成后天”通过工具直达事项，记录追加来源，旧事件失效', async () => {
  // 工具默认取宿主时间；固定 Date，避免样例日期随真实日历过期。
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  try {
  const r = await schedule();
  await scanFollowups(now, owner.catId);
  const [m] = await db
    .insert(messages)
    .values({ conversationId: owner.conversationId, role: 'user', text: '改成后天' })
    .returning();
  const tools = await catTools({ catId: owner.catId, turnId: randomUUID(), userMessageId: m!.id });
  expect(
    (
      await tools.update_ticket!.execute(
        { ticket_id: r.ticket_id, when: '2026-11-14T12:00:00' },
        new AbortController().signal,
      )
    ).status,
  ).toBe('succeeded');
  expect(await db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, r.ticket_id))).toHaveLength(1);
  await fire();
  expect(await said()).toHaveLength(0);
  await fire(new Date('2026-11-14T04:00:00Z'));
  expect(await said()).toHaveLength(1);
  } finally {vi.useRealTimers();}
});
it('模型故障或结构复核失败用模板，explicit不能被模型否决', async () => {
  await schedule();
  await fire(now, async () => {
    throw new Error('model down');
  });
  expect((await said())[0]!.text).toContain('面试怎么样');
  await schedule('2026-11-12T12:01:00', '复查怎么样');
  await fire(new Date(now.getTime() + 60000), async () => ({ decision: 'ignore' }));
  expect(await said()).toHaveLength(2);
});
it('超过24小时只进信箱，不补聊天提问', async () => {
  await schedule();
  await fire(new Date('2026-11-13T04:00:01Z'));
  expect(await said()).toHaveLength(0);
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, owner.catId))).toHaveLength(1);
});
it('接口列表、改时、取消、信箱、已读归属鉴权与分页，别人的事项404', async () => {
  const r = await schedule();
  const revised = new Date();
  revised.setUTCDate(revised.getUTCDate() + 1);
  revised.setUTCHours(4, 0, 0, 0); // 用户当地明天中午，不依赖运行测试的日期。
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request('/v1' + path, {
      method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  expect((await request('/tickets?status=open')).status).toBe(200);
  expect((await request('/tickets/' + r.ticket_id, 'PATCH', { when: revised.toISOString() })).status).toBe(200);
  const [other] = await db
    .insert(tickets)
    .values({
      catId: (await db.select().from(cats).where(eq(cats.userId, userIds[0]!)))[0]!.id,
      kind: 'followup',
      goal: '别人的约定',
      mandate: { kind: 'explicit', source_message_id: sourceId },
      sourceMessageId: sourceId,
    })
    .returning();
  for (const id of [randomUUID(), other!.id]) {
    expect((await request('/tickets/' + id, 'PATCH', { when: revised.toISOString() })).status).toBe(404);
    expect((await request('/tickets/' + id + '/cancel', 'POST')).status).toBe(404);
  }
  await fire(revised);
  const data = (await (await request('/mailbox?after=0')).json()) as any;
  expect(data.letters).toHaveLength(1);
  expect((await request('/mailbox/' + data.letters[0].id + '/read', 'POST')).status).toBe(200);
  expect((await request('/mailbox/' + randomUUID() + '/read', 'POST')).status).toBe(404);
  expect(((await (await request('/mailbox?after=' + data.letters[0].seq)).json()) as any).letters).toHaveLength(0);
  expect((await app.request('/v1/tickets')).status).toBe(401);
});
it('用户本地ISO时间解析，模糊时间不返回成功凭证', async () => {
  expect(parseFollowupTime('2026-11-14T12:00:00', 'Asia/Shanghai').toISOString()).toBe('2026-11-14T04:00:00.000Z');
  expect(() => parseFollowupTime('改天', 'Asia/Shanghai')).toThrow();
  await expect(schedule('改天')).rejects.toThrow();
});
it('出口复核模型等待期间跨过24小时或进入安静时段的候选', async () => {
  await schedule();
  const at = new Date(now);
  await fire(at, async () => { at.setTime(+now + 86400001); throw new Error('slow router'); });
  expect(await said()).toHaveLength(0);
  expect(await db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, owner.catId))).toHaveLength(1);
  await schedule('2026-11-12T21:59:55', '晚间那件事');
  const evening = new Date('2026-11-12T13:59:55Z');
  await fire(evening, async () => { evening.setTime(Date.parse('2026-11-12T14:00:05Z')); throw new Error('slow router'); });
  expect(await said()).toHaveLength(0);
  await fire(new Date('2026-11-13T01:00:00Z'));
  expect(await said()).toHaveLength(1);
});
