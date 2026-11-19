/** 正式HTTP/SSE与常驻worker，隔离PG和受控模型。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, messages, turns } from '../src/db/schema.ts';
import { createDevUser } from '../src/dev-user.ts';
if (!process.env.DATABASE_URL?.includes('maomao_diary_sync_review_') || process.env.MODEL_PROVIDER !== 'mock') throw new Error('仅允许隔离验收库与mock');
const base = 'http://localhost:8790/v1/';
const owner = await createDevUser('diary-http-review');
const checks: string[] = [];
async function request(path: string, method = 'GET', body?: object, token = owner.token) {
  return fetch(base + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
}
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean, seconds = 40) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { const value = await read(); if (test(value)) return value; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('等待HTTP/worker状态超时');
}
const payload = { client_id: randomUUID(), kind: 'text', text: 'HTTP验收：今天读了科幻小说。', recorded_at: '2026-10-19T04:00:00.000Z', time_zone: 'Asia/Shanghai', day: '2026-10-19', time: '12:00', cat_allowed: false, revision: 0, mutation_id: randomUUID() };
const first = await (await request('diary', 'PUT', payload)).json(); assert(first.entry.id);
assert.equal((await (await request('diary', 'PUT', payload)).json()).entry.id, first.entry.id);
assert.equal((await (await request('diary')).json()).entries.length, 1); checks.push('私密同步与重复请求幂等');
const shared = { ...payload, cat_allowed: true, revision: 1, mutation_id: randomUUID() };
assert.equal((await request('diary', 'PUT', shared)).status, 200);
const seen = await until(async () => (await (await request('diary')).json()).entries[0], e => e.visit === 2);
assert.equal(seen.note, '在这里陪你坐一会儿。'); checks.push('常驻worker读取并留言');
const stream = await request('messages', 'POST', { client_message_id: randomUUID(), text: '[diary] 接着这条聊', diary_entry_id: first.entry.id });
assert.equal(stream.status, 200); const sse = await stream.text(); assert(sse.includes('科幻小说'));
const [cat] = await db.select().from(cats).where(eq(cats.userId, owner.userId));
const [conv] = await db.select().from(conversations).where(eq(conversations.catId, cat!.id));
const [turn] = await db.select().from(turns).where(eq(turns.conversationId, conv!.id));
assert.deepEqual(turn!.diarySourceIds, [first.entry.id]); checks.push('日记真实进入SSE回复模型与来源追溯');
const other = await createDevUser('diary-other-review');
assert.equal((await (await request('diary', 'GET', undefined, other.token)).json()).entries.length, 0);
assert.equal((await request('messages', 'POST', { client_message_id: randomUUID(), text: '越权', diary_entry_id: first.entry.id }, other.token)).status, 404); checks.push('其他账号不可读/不可引用');
const slow = await request('messages', 'POST', { client_message_id: randomUUID(), text: '[slow] [diary] 继续聊', diary_entry_id: first.entry.id });
await until(async () => (await db.select().from(turns).where(eq(turns.conversationId, conv!.id))).find(t => t.id !== turn!.id), t => !!t?.diarySourceIds.length, 15);
const revoked = { ...payload, cat_allowed: false, revision: 2, mutation_id: randomUUID() };
assert.equal((await request('diary', 'PUT', revoked)).status, 200);
await slow.text();
const [oldReply] = await db.select().from(messages).where(eq(messages.id, turn!.catMessageId!)); assert.equal(oldReply!.contextAllowed, false);
const all = await db.select().from(turns).where(eq(turns.conversationId, conv!.id)); assert.equal(all.find(t => t.id !== turn!.id)!.status, 'failed'); checks.push('生成中撤回停止输出、旧回复停止作为上下文');
assert.equal((await request('diary', 'PUT', shared)).status, 409); checks.push('旧分享回放不能重新授权');
const final = (await (await request('diary')).json()).entries[0]; assert.equal(final.cat_allowed, false); assert.equal(final.note, ''); checks.push('另一客户端恢复当前私密状态与清空留言');
// 另建模拟器账号，凭据只保存在/tmp。
const sim = await createDevUser('diary-simulator-review');
const [simCat] = await db.select().from(cats).where(eq(cats.userId, sim.userId));
const [simConv] = await db.select().from(conversations).where(eq(conversations.catId, simCat!.id));
await writeFile('/tmp/maomao-diary-sync-account.json', JSON.stringify({ ...sim, catId: simCat!.id, conversationId: simConv!.id }), { mode: 0o600 });
await writeFile(new URL('../../outputs/diary-sync-review/HTTP检查.json', import.meta.url), JSON.stringify({ evidence: '正式HTTP/SSE+常驻worker+真实PG，模型为受控mock', passed: checks.length, checks }, null, 2));
console.log(JSON.stringify({ passed: checks.length, checks })); await sql.end();
