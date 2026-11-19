import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { and, asc, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { users, cats, conversations, messages, tickets, ticketInputs, runs, runSteps, workerReports, asyncJobs, mailboxLetters, boundaries, pushNotifications } from '../src/db/schema.ts';
import { startErrand, appendTicketInput, scanErrands } from '../src/agent/errands.ts';
import { cancelTicket, listTickets } from '../src/agent/tickets.ts';
import { processErrand } from '../src/agent/executor.ts';
import { deliverReports } from './report-pipeline.ts';
import { catTools } from '../src/runtime/tools.ts';
import { mockWorkerModel } from '../src/runtime/mock.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { registerDevice, processPush } from '../src/push/service.ts';
import { closeQueues } from '../src/queue.ts';

const day = new Date().toISOString().slice(0, 10);
const now = new Date(day + 'T12:00:00Z');
const owners: string[] = [];
let userId: string, catId: string, conversationId: string, sourceId: string, token: string;
beforeEach(async () => {
  token = randomUUID();
  const [u] = await db.insert(users).values({ devTokenHash: hashToken(token), timeZone: 'UTC' }).returning();
  userId = u!.id; owners.push(userId);
  const [c] = await db.insert(cats).values({ userId, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  catId = c!.id;
  const [v] = await db.insert(conversations).values({ catId }).returning(); conversationId = v!.id;
  sourceId = await message('帮我想想周末怎么过');
});
afterAll(async () => {
  for (const id of owners) {
    await sql`delete from async_jobs where object_id in(select r.id from runs r join tickets t on t.id=r.ticket_id join cats c on c.id=t.cat_id where c.user_id=${id}) or object_id in(select w.id from worker_reports w join cats c on c.id=w.cat_id where c.user_id=${id}) or source_id in(select p.id from push_notifications p join cats c on c.id=p.cat_id where c.user_id=${id})`;
    await db.delete(users).where(eq(users.id, id));
  }
  await closeQueues();  await sql.end();
});
async function message(text: string) {
  const [m] = await db.insert(messages).values({ conversationId, role: 'user', text }).returning(); return m!.id;
}
const runList = (id: string) => db.select().from(runs).where(eq(runs.ticketId, id)).orderBy(asc(runs.createdAt));
const ticket = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
const said = () => db.select().from(messages).where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'cat')));
const letters = () => db.select().from(mailboxLetters).where(eq(mailboxLetters.catId, catId));
const request = (id: string, text: string, key = randomUUID(), bearer = token) => app.request(`/v1/tickets/${id}`, {
  method: 'PATCH', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ text }),
});
const failModel = () => new MockLanguageModelV4({ doGenerate: async () => { throw Object.assign(new Error('provider refused'), { statusCode: 400 }); } });
async function failed(goal = '周末建议', at = now) {
  const t = await startErrand(catId, sourceId, goal, at), [r] = await runList(t.ticket_id);
  await processErrand(r!.id, { now: () => at, model: failModel() });
  await deliverReports(r!.id, at);
  expect((await ticket(t.ticket_id)).stage).toBe('failed');
  return { id: t.ticket_id, run: (await runList(t.ticket_id))[0]! };
}

it('HTTP补充恢复原托付，重放只创建一次执行；旧汇报不能干扰新执行', async () => {
  const t = await failed(), before = await ticket(t.id), key = randomUUID();
  const responses = await Promise.all([request(t.id, '继续想，我想待在家', key), request(t.id, '继续想，我想待在家', key)]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  const receipt = await responses[0]!.json();
  expect(receipt).toMatchObject({ ticket_id: t.id, saved: true, resumed: true, queued: false });
  expect(await responses[1]!.json()).toEqual(receipt);
  const all = await runList(t.id); expect(all).toHaveLength(2);
  expect(all[0]).toEqual(t.run);
  expect(all[1]).toMatchObject({ generation: 1, status: 'pending', outputTokens: 0, elapsedMs: 0 });
  expect((await ticket(t.id)).mandate).toEqual(before.mandate);
  await deliverReports(t.run.id, now); await processErrand(t.run.id, { now: () => now });
  expect((await ticket(t.id)).stage).toBe('thinking'); expect(await said()).toHaveLength(1);
  await processErrand(all[1]!.id, { now: () => now });
  expect(await letters()).toHaveLength(0); // worker只汇报
  await deliverReports(all[1]!.id, now); await deliverReports(all[1]!.id, now);
  expect((await ticket(t.id)).stage).toBe('ready'); expect(await letters()).toHaveLength(1);
  expect((await letters())[0]!.text).toContain('待在家'); expect(await said()).toHaveLength(2);
  expect((await request(t.id, '继续想，我想待在家', key)).status).toBe(200);
  expect((await request(t.id, '换个意思', key)).status).toBe(409);
  expect(await runList(t.id)).toHaveLength(2);
});

it('第二次失败仍发布一次，失败事项不会被扫描自动重开', async () => {
  const t = await failed();
  await appendTicketInput(catId, t.id, '再试一次');
  const r = (await runList(t.id)).at(-1)!;
  await processErrand(r.id, { now: () => now, model: failModel() });
  await deliverReports(r.id, now); await deliverReports(r.id, now);
  expect((await ticket(t.id)).stage).toBe('failed'); expect(await said()).toHaveLength(2);
  await scanErrands(now, catId);
  expect((await ticket(t.id)).status).toBe('ended'); expect(await runList(t.id)).toHaveLength(2);
});

it('耗尽的执行保留预算与检查点，新执行可用独立预算读旧补充', async () => {
  const t = await startErrand(catId, sourceId, '周末建议', now), [old] = await runList(t.ticket_id);
  await appendTicketInput(catId, t.ticket_id, '不要安排跑步');
  const loop = mockWorkerModel();
  // 用固定progress模型真实耗尽20步；原goal保持普通托付，下一次恢复可正常完成。
  const progress = new MockLanguageModelV4({ doGenerate: async call => loop.doGenerate({ ...call, prompt: [{ role: 'user', content: [{ type: 'text', text: '[loop]' }] }, ...call.prompt] }) });
  await processErrand(old!.id, { now: () => now, model: progress }); await deliverReports(old!.id, now);
  const oldSteps = await db.select().from(runSteps).where(eq(runSteps.runId, old!.id)); expect(oldSteps).toHaveLength(20);
  const previous = (await runList(t.ticket_id))[0]!;
  const source = await message('继续想，主要想在家休息');
  await appendTicketInput(catId, t.ticket_id, '模型概括', source);
  const next = (await runList(t.ticket_id)).at(-1)!;
  await processErrand(next.id, { now: () => now }); await deliverReports(next.id, now);
  expect((await runList(t.ticket_id))[0]).toEqual(previous);
  expect(await db.select().from(runSteps).where(eq(runSteps.runId, old!.id))).toEqual(oldSteps);
  expect((await letters())[0]!.text).toContain('不要安排跑步');
  expect((await letters())[0]!.text).toContain('主要想在家休息');
}, 20000);

it.each(['ready', 'cancelled', 'dropped'])('%s终态不允许用补充恢复', async stage => {
  const t = await failed(); await db.update(tickets).set({ stage }).where(eq(tickets.id, t.id));
  expect((await request(t.id, '继续')).status).toBe(404);
  expect(await runList(t.id)).toHaveLength(1);
  expect(await db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, t.id))).toHaveLength(0);
});

it.each(['source', 'input', 'boundary'])('%s撤回或回避后拒绝续办且不落入半条补充', async change => {
  const t = await failed();
  if (change === 'source') await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, sourceId));
  if (change === 'input') {
    const id = await message('上次补充'); await db.insert(ticketInputs).values({ ticketId: t.id, messageId: id, text: '上次补充', readAt: now });
    await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, id));
  }
  if (change === 'boundary') await db.insert(boundaries).values({ catId, sourceMessageId: sourceId, description: '周末' });
  const before = await db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, t.id));
  expect((await request(t.id, '继续想')).status).toBe(409);
  expect(await runList(t.id)).toHaveLength(1);
  expect(await db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, t.id))).toEqual(before);
});

it('恢复后取消使旧输入重放和待发新报告都保持安静', async () => {
  const t = await failed(), key = randomUUID();
  expect((await request(t.id, '继续', key)).status).toBe(200);
  const r = (await runList(t.id)).at(-1)!;
  await processErrand(r.id, { now: () => now }); await cancelTicket(catId, t.id);
  expect((await request(t.id, '继续', key)).status).toBe(200);
  await deliverReports(r.id, now);
  expect((await ticket(t.id)).stage).toBe('cancelled'); expect(await said()).toHaveLength(1); expect(await letters()).toHaveLength(0);
});

it('跨账号与撤回的聊天原话不能恢复托付', async () => {
  const t = await failed(), otherToken = randomUUID();
  const [u] = await db.insert(users).values({ devTokenHash: hashToken(otherToken) }).returning(); owners.push(u!.id);
  const [otherCat] = await db.insert(cats).values({ userId: u!.id, name: '别的猫', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  await db.insert(conversations).values({ catId: otherCat!.id });
  expect((await request(t.id, '继续', randomUUID(), otherToken)).status).toBe(404);
  const id = await message('再试一次'); await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, id));
  await expect(appendTicketInput(catId, t.id, '继续', id)).rejects.toMatchObject({ status: 404 });
  expect(await runList(t.id)).toHaveLength(1);
});

it('续办后的安静时段延迟前台发布，来源撤回后丢弃待发结果', async () => {
  const t = await failed(); await appendTicketInput(catId, t.id, '继续');
  const r = (await runList(t.id)).at(-1)!;
  await processErrand(r.id, { now: () => now });
  const quiet = new Date(day + 'T23:00:00Z'); await deliverReports(r.id, quiet);
  expect((await ticket(t.id)).status).toBe('open'); expect(await letters()).toHaveLength(0);
  await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, sourceId));
  await deliverReports(r.id, new Date(+now + 86400000));
  expect((await ticket(t.id)).stage).toBe('dropped'); expect(await letters()).toHaveLength(0);
});

it.each(['failed', 'blocked'])('用户可取消%s托付，之后既不列为可续办也不接受新补充', async stage => {
  const t = await failed(); await db.update(tickets).set({ stage }).where(eq(tickets.id, t.id));
  const response = await app.request(`/v1/tickets/${t.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() } });
  expect(response.status).toBe(200); expect((await ticket(t.id)).stage).toBe('cancelled');
  expect((await request(t.id, '继续')).status).toBe(404);
  expect(await listTickets(catId, 'actionable')).toHaveLength(0);
});

it('续办后旧补充被撤回，不把其文字交给新执行的模型', async () => {
  const t = await startErrand(catId, sourceId, '周末建议', now), [r] = await runList(t.ticket_id);
  const oldInput = await message('想去秘密花园');
  await appendTicketInput(catId, t.ticket_id, '想去秘密花园', oldInput);
  await processErrand(r!.id, { now: () => now, afterStep: async () => { throw new Error('controlled stop after input read'); } });
  await deliverReports(r!.id, now);
  await appendTicketInput(catId, t.ticket_id, '继续');
  await db.update(messages).set({ contextAllowed: false }).where(eq(messages.id, oldInput));
  let calls = 0; const next = (await runList(t.ticket_id)).at(-1)!;
  await processErrand(next.id, { now: () => now, model: mockWorkerModel({ onRequest: () => { calls++; } }) });
  await deliverReports(next.id, now);
  expect(calls).toBe(0); expect((await ticket(t.ticket_id)).stage).toBe('dropped'); expect(await letters()).toHaveLength(0);
});

it('聊天列出失败/受阻托付供原事项续办；默认HTTP开放列表语义保留', async () => {
  const t = await failed('[blocked] 周末建议');
  await db.update(tickets).set({ stage: 'blocked' }).where(eq(tickets.id, t.id));
  const input = await message('那件事继续想，只整理思路就好');
  const tools = await catTools({ catId, userMessageId: input, turnId: randomUUID() });
  const result = await tools.list_tickets!.execute({}, new AbortController().signal);
  expect(result).toMatchObject({ status: 'succeeded', data: { tickets: [expect.objectContaining({ id: t.id, stage: 'blocked' })] } });
  expect(await listTickets(catId)).toHaveLength(0);
  const saved = await tools.update_ticket!.execute({ ticket_id: t.id, text: '换一种概括' }, new AbortController().signal);
  expect(saved).toMatchObject({ status: 'succeeded', data: { resumed: true } });
  expect((await db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, t.id)))[0]!.text).toBe('那件事继续想，只整理思路就好');
  expect(await runList(t.id)).toHaveLength(2);
});

it('续办受两个并发名额约束，扫描仅唤醒最新执行', async () => {
  const t = await failed();
  const a = await startErrand(catId, sourceId, '另一件甲', now);
  await startErrand(catId, sourceId, '另一件乙', now);
  const res = await request(t.id, '继续'); expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ queued: true });
  const latest = (await runList(t.id)).at(-1)!;
  expect(await db.select().from(asyncJobs).where(eq(asyncJobs.objectId, latest.id))).toHaveLength(0);
  await cancelTicket(catId, a.ticket_id); await scanErrands(now, catId);
  expect((await ticket(t.id)).stage).toBe('thinking');
  expect(await db.select().from(asyncJobs).where(eq(asyncJobs.objectId, latest.id))).toHaveLength(1);
  expect((await runList(t.id))[0]!.status).toBe('ended');
});

it('同一托付反复续办计入每日五次开工，次日再获得名额', async () => {
  const t = await failed();
  for (let i = 1; i < 5; i++) {
    const res = await request(t.id, '再试' + i); expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ queued: false });
    const r = (await runList(t.id)).at(-1)!;
    await processErrand(r.id, { now: () => now, model: failModel() }); await deliverReports(r.id, now);
  }
  const last = await request(t.id, '明天再想'); expect(last.status).toBe(200); expect(await last.json()).toMatchObject({ queued: true });
  await scanErrands(now, catId); expect((await ticket(t.id)).stage).toBe('queued');
  await scanErrands(new Date(+now + 86400000), catId); expect((await ticket(t.id)).stage).toBe('thinking');
  expect(await runList(t.id)).toHaveLength(6);
});

it('新执行从持久输入恢复，可由另一个worker进程接续', async () => {
  const t = await failed(); expect((await request(t.id, '继续，在家休息')).status).toBe(200);
  const r = (await runList(t.id)).at(-1)!;
  const code = `import {processErrand} from './src/agent/executor.ts'; await processErrand(${JSON.stringify(r.id)}, {now:()=>new Date(${JSON.stringify(now.toISOString())})}); process.exit(0);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try { expect((await once(child, 'exit'))[0]).toBe(0); } finally { clearTimeout(timer); }
  expect(await letters()).toHaveLength(0);
  await deliverReports(r.id, now); expect((await letters())[0]!.text).toContain('在家休息');
}, 20000);

it('只认当前执行的waiting推送，旧执行同名工具回执不会恢复旧问题', async () => {
  await registerDevice(userId, { token: randomUUID().replaceAll('-', '').repeat(2), environment: 'sandbox', topic: 'local.test.cat' }, 'local.test.cat');
  const t = await failed();
  const wait = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'tool-call', toolCallId: 'same-call', toolName: 'report', input: JSON.stringify({ status: 'waiting', question: '想待在家吗？' }) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] }) });
  await appendTicketInput(catId, t.id, '继续'); let r = (await runList(t.id)).at(-1)!;
  await processErrand(r.id, { now: () => now, model: wait }); await deliverReports(r.id, now);
  const oldPush = (await db.select().from(pushNotifications).where(eq(pushNotifications.catId, catId)))[0]!;
  await appendTicketInput(catId, t.id, '是的'); await processErrand(r.id, { now: () => now, model: failModel() }); await deliverReports(r.id, now);
  await appendTicketInput(catId, t.id, '再想想'); r = (await runList(t.id)).at(-1)!;
  await processErrand(r.id, { now: () => now, model: wait }); await deliverReports(r.id, now);
  const allPushes = await db.select().from(pushNotifications).where(eq(pushNotifications.catId, catId)); expect(allPushes).toHaveLength(2);
  let sent = 0; const transport = async () => { sent++; return { status: 200 }; };
  await processPush(oldPush.id, { now, transport }); expect(sent).toBe(0);
  await processPush(allPushes.find(p => p.id !== oldPush.id)!.id, { now, transport }); expect(sent).toBe(1);
});
