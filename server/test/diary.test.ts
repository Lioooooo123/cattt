import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { asyncJobs, boundaries, cats, conversations, diaryEntries, messages, turns, users } from '../src/db/schema.ts';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { diaryJSON, saveDiary, type DiaryInput } from '../src/diary/service.ts';
import { readDiary } from './report-pipeline.ts';
import { executeJob } from '../src/jobs/store.ts';
import { buildTurnContext } from '../src/runtime/context.ts';
import { commitOutcome } from '../src/turns/store.ts';
import { closeQueues } from '../src/queue.ts';
import { config } from '../src/config.ts';

const accounts: { userId: string; catId: string; convId: string; token: string }[] = [];
let owner: typeof accounts[number];
const input = (change: Partial<DiaryInput> = {}): DiaryInput => ({ client_id: randomUUID(), kind: 'text', text: '验收日记：今天在窗边看书。',
  recorded_at: '2026-10-19T04:00:00.000Z', day: '2026-10-19', time: '12:00', time_zone: 'Asia/Shanghai',
  cat_allowed: false, revision: 0, mutation_id: randomUUID(), ...change });
async function account() {
  const token = randomUUID();
  const [u] = await db.insert(users).values({ name: 'diary-test', devTokenHash: hashToken(token) }).returning();
  const [c] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const [v] = await db.insert(conversations).values({ catId: c!.id }).returning();
  const result = { userId: u!.id, catId: c!.id, convId: v!.id, token }; accounts.push(result); return result;
}
const req = (path: string, method = 'GET', body?: object, token = owner.token) => app.request('/v1/' + path, {
  method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const change = (base: DiaryInput, revision: number, cat_allowed: boolean, text = base.text) => ({ ...base, revision, cat_allowed, text, mutation_id: randomUUID() });
const row = async (id: string) => (await db.select().from(diaryEntries).where(eq(diaryEntries.id, id)))[0]!;
beforeEach(async () => { owner = await account(); });
afterAll(async () => {
  for (const a of accounts) {
    const ids = (await db.select().from(diaryEntries).where(eq(diaryEntries.catId, a.catId))).map(e => e.id);
    if (ids.length) await db.delete(asyncJobs).where(inArray(asyncJobs.sourceId, ids));
    await db.delete(users).where(eq(users.id, a.userId));
  }
  await closeQueues();  await sql.end();
});
it('增量游标可跨页和空轮询；旧日记的留言和撤回均可见', async () => {
  const original = input({ cat_allowed: true });
  const first = await saveDiary(owner.catId, original);
  await saveDiary(owner.catId, input());
  const changes = async (after: number) => {
    const response = await req('diary/changes?after=' + after + '&limit=1');
    expect(response.status).toBe(200);
    return response.json();
  };
  const page = await changes(0);
  expect(page.entries.map((entry: {id:string}) => entry.id)).toEqual([first.id]);
  expect(page.has_more).toBe(true);
  const last = await changes(page.cursor);
  expect(last.has_more).toBe(false);
  expect(await changes(last.cursor)).toEqual({entries: [], cursor: last.cursor, has_more: false});
  await readDiary(first.id, '1', randomUUID(), async () => '在旁边坐一会儿。');
  const read = await changes(last.cursor);
  expect(read.entries).toMatchObject([{id: first.id, visit: 2, note: '在旁边坐一会儿。'}]);
  await saveDiary(owner.catId, change(original, 1, false));
  expect((await changes(read.cursor)).entries).toMatchObject([{id: first.id, cat_allowed: false, visit: 0, note: ''}]);
  expect((await (await req('diary?after_seq=' + first.seq)).json()).entries).toHaveLength(1);
});

it('私密文字同步、重复回执只存一条，不创建读取任务', async () => {
  const body = input();
  const first = await (await req('diary', 'PUT', body)).json();
  const retry = await (await req('diary', 'PUT', body)).json();
  expect(retry.entry).toEqual(first.entry);
  expect((await (await req('diary')).json()).entries).toHaveLength(1);
  expect(await db.select().from(asyncJobs).where(eq(asyncJobs.sourceId, first.entry.id))).toHaveLength(0);
  let calls = 0; await readDiary(first.entry.id, '1', randomUUID(), async () => { calls++; return '不能读到'; });
  expect(calls).toBe(0);
});
it('恢复后拒绝旧世代的日记游标和写入，允许从新世代重新读取', async () => {
  const original = config.CATTT_DIARY_SYNC_EPOCH;
  config.CATTT_DIARY_SYNC_EPOCH = 'restored';
  try {
    const diary = input();
    const kept = await saveDiary(owner.catId, diary);
    const reset = await req('diary/changes?after=' + (kept.changeSeq + 100) + '&epoch=initial');
    expect(await reset.json()).toEqual({ entries: [], cursor: 0, has_more: false, epoch: 'restored', reset: true });
    const rejected = await app.request('/v1/diary', {
      method: 'PUT', headers: { authorization: 'Bearer ' + owner.token, 'content-type': 'application/json', 'x-cattt-diary-epoch': 'initial' },
      body: JSON.stringify(change(diary, 1, true)),
    });
    expect(rejected.status).toBe(409);
    expect((await row(kept.id)).catAllowed).toBe(false);
    const current = await req('diary/changes?after=0&epoch=restored');
    expect(await current.json()).toMatchObject({ entries: [{ id: kept.id }], cursor: kept.changeSeq, epoch: 'restored' });
  } finally {
    config.CATTT_DIARY_SYNC_EPOCH = original;
  }
});
it('开放记录与读取待办同时落库，重复执行不重复读取', async () => {
  const entry = await saveDiary(owner.catId, input({ cat_allowed: true }));
  const [job] = await db.select().from(asyncJobs).where(eq(asyncJobs.sourceId, entry.id));
  expect(job?.version).toBe('1');
  let calls = 0;
  await db.update(asyncJobs).set({ nextAttemptAt: new Date(0) }).where(eq(asyncJobs.id, job!.id));
  const execute = () => executeJob(job!.id, task => readDiary(task.objectId, task.version, task.id, async (text, _name, _jobId, day) => { calls++; expect(text).toContain('窗边'); expect(day).toBe('2026-10-19'); return '在旁边坐一会儿。'; }));
  await Promise.all([execute(), execute()]);
  expect(calls).toBe(1); expect((await row(entry.id)).visit).toBe(2); expect((await row(entry.id)).note).toContain('坐');
});
it('可以真实读过但不留言，不伪造评论', async () => {
  const entry = await saveDiary(owner.catId, input({ cat_allowed: true, text: '[quiet] 安静的一天。' }));
  await readDiary(entry.id, '1', randomUUID());
  expect((await row(entry.id)).visit).toBe(1); expect((await row(entry.id)).note).toBe('');
});
it('真实结构化mock读取返回留言，私密与模型输入隔离', async () => {
  const entry = await saveDiary(owner.catId, input({ cat_allowed: true }));
  await saveDiary(owner.catId, input({ text: '不应进入模型的私密标记' }));
  await readDiary(entry.id, '1', randomUUID());
  expect((await row(entry.id)).note).toBe('在这里陪你坐一会儿。');
});
it('撤回前已开始的模型结果不能落地，也不能再次读取', async () => {
  const original = input({ cat_allowed: true }); const entry = await saveDiary(owner.catId, original);
  await readDiary(entry.id, '1', randomUUID(), async () => {
    await saveDiary(owner.catId, change(original, 1, false)); return '迟到的旧结果';
  });
  expect((await row(entry.id)).catAllowed).toBe(false); expect((await row(entry.id)).visit).toBe(0); expect((await row(entry.id)).note).toBe('');
  let calls = 0; await readDiary(entry.id, '1', randomUUID(), async () => { calls++; return null; }); expect(calls).toBe(0);
});
it('修改正文后旧版任务与结果不能写回', async () => {
  const original = input({ cat_allowed: true }); const entry = await saveDiary(owner.catId, original);
  await readDiary(entry.id, '1', randomUUID(), async () => { await saveDiary(owner.catId, change(original, 1, true, '更正后的内容')); return '旧正文留言'; });
  expect((await row(entry.id)).note).toBe('');
  await readDiary(entry.id, '2', randomUUID(), async text => { expect(text).toBe('更正后的内容'); return '新留言'; });
  expect((await row(entry.id)).note).toBe('新留言');
});
it('过期分享、重放旧授权不能覆盖后来的撤回', async () => {
  const original = input({ cat_allowed: true }); const first = await (await req('diary', 'PUT', original)).json();
  const revoke = change(original, first.entry.revision, false);
  expect((await req('diary', 'PUT', revoke)).status).toBe(200);
  expect((await req('diary', 'PUT', original)).status).toBe(409);
  expect((await req('diary', 'PUT', change(original, 1, true))).status).toBe(409);
  expect((await row(first.entry.id)).catAllowed).toBe(false);
});
it('同版本并发修改最多接受一条，冲突返回当前正文', async () => {
  const original = input(); await saveDiary(owner.catId, original);
  const responses = await Promise.all([req('diary', 'PUT', change(original, 1, true)), req('diary', 'PUT', change(original, 1, false, '另一个设备'))]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await responses.find(r => r.status === 409)!.json()).entry.revision).toBe(2);
});
it('换账号不返回别人的日记，也不接受别人的来源ID', async () => {
  const entry = await saveDiary(owner.catId, input({ cat_allowed: true })); const other = await account();
  expect((await (await req('diary', 'GET', undefined, other.token)).json()).entries).toEqual([]);
  expect((await req('messages', 'POST', { client_message_id: randomUUID(), text: '接着聊', diary_entry_id: entry.id }, other.token)).status).toBe(404);
  expect(await db.select().from(messages).where(eq(messages.conversationId, other.convId))).toHaveLength(0);
});
it('私密来源不能发到聊天，客户端直接夹带正文或权限字段不能扩权', async () => {
  const entry = await saveDiary(owner.catId, input());
  expect((await req('messages', 'POST', { client_message_id: randomUUID(), text: '接着聊', diary_entry_id: entry.id })).status).toBe(404);
  expect((await req('diary', 'PUT', { ...input(), visit: 2, note: '假的猫留言' })).status).toBe(400);
});
it('日记来源真正进入聊天上下文；撤回让派生回复和后续复述停止使用', async () => {
  const original = input({ cat_allowed: true }); const entry = await saveDiary(owner.catId, original);
  const [m] = await db.insert(messages).values({ conversationId: owner.convId, role: 'user', text: '接着这条聊', diaryEntryId: entry.id }).returning();
  const [t] = await db.insert(turns).values({ conversationId: owner.convId, userMessageId: m!.id, inputVersion: 0 }).returning();
  const context = await buildTurnContext(owner.catId, owner.convId, t!.id);
  expect(context.instructions).toContain(original.text); expect(context.diarySourceIds).toEqual([entry.id]);
  await db.update(turns).set({ contextRevision: context.revision, contextSourceIds: context.sourceIds, diarySourceIds: context.diarySourceIds }).where(eq(turns.id, t!.id));
  const reply = await commitOutcome(t!.id, { status: 'completed', text: '窗边看书挺好。' });
  await saveDiary(owner.catId, change(original, 1, false));
  const [stopped] = await db.select().from(messages).where(eq(messages.id, reply.catMessageId!));
  expect(stopped!.contextAllowed).toBe(false);
  const after = await buildTurnContext(owner.catId, owner.convId);
  expect(JSON.stringify(after.messages)).not.toContain('窗边看书'); expect(after.instructions).not.toContain(original.text);
});
it('撤回期间正在生成的聊天不能提交旧上下文', async () => {
  const original = input({ cat_allowed: true }); const entry = await saveDiary(owner.catId, original);
  const [m] = await db.insert(messages).values({ conversationId: owner.convId, role: 'user', text: '继续', diaryEntryId: entry.id }).returning();
  const [cat] = await db.select().from(cats).where(eq(cats.id, owner.catId));
  const [t] = await db.insert(turns).values({ conversationId: owner.convId, userMessageId: m!.id, inputVersion: 0, status: 'generating', contextRevision: cat!.memoryRevision, diarySourceIds: [entry.id] }).returning();
  await saveDiary(owner.catId, change(original, 1, false));
  expect((await commitOutcome(t!.id, { status: 'completed', text: '旧正文' })).turn!.status).toBe('failed');
});
it('日记自动留言先避开回避话题，不调用模型', async () => {
  const [m] = await db.insert(messages).values({ conversationId: owner.convId, role: 'cat', text: '咖啡' }).returning();
  await db.insert(boundaries).values({ catId: owner.catId, sourceMessageId: m!.id, description: '咖啡' });
  const entry = await saveDiary(owner.catId, input({ cat_allowed: true, text: '今天喝了一杯咖啡。' }));
  let calls = 0; await readDiary(entry.id, '1', randomUUID(), async () => { calls++; return '不能主动提'; });
  expect(calls).toBe(0); expect((await row(entry.id)).visit).toBe(0);
});
it('猫自己日记可同步/明确带入聊天，但不能伪装用户开放读取任务', async () => {
  const entry = await saveDiary(owner.catId, input({ kind: 'cat', cat_allowed: true }));
  expect(entry.catAllowed).toBe(false);
  expect(await db.select().from(asyncJobs).where(eq(asyncJobs.sourceId, entry.id))).toHaveLength(0);
});
it('日期/时区/长度与身份不可换壳，空内容被拒绝', async () => {
  for (const value of [input({ day: '2026-10-18' }), input({ time_zone: 'wrong' }), input({ text: '' }), input({ text: '字'.repeat(10001) })]) expect((await req('diary', 'PUT', value)).status).toBe(400);
  const original = input(); await saveDiary(owner.catId, original);
  expect((await req('diary', 'PUT', { ...change(original, 1, true), kind: 'cat' })).status).toBe(409);
});
it('超过一页按服务器游标完整恢复，没有固定最近100条的遗漏', async () => {
  await db.insert(diaryEntries).values(Array.from({ length: 105 }, (_, i) => ({ catId: owner.catId, clientId: 'page-' + i, kind: 'text', text: '分页记录', recordedAt: new Date(), timeZone: 'Asia/Shanghai', day: '2026-10-19', time: '12:00', mutationId: randomUUID() })));
  const first = await (await req('diary')).json();
  expect(first.entries).toHaveLength(100); expect(first.next_seq).toBeGreaterThan(0);
  const next = await (await req('diary?after_seq=' + first.next_seq)).json();
  expect(next.entries).toHaveLength(5); expect(next.next_seq).toBeNull();
  expect(new Set([...first.entries, ...next.entries].map(e => e.id)).size).toBe(105);
});
