/** 复核模拟器独立账号的实际请求；凭证文件只读，不输出token。 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { and, desc, eq, lte } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { messages, turns } from '../src/db/schema.ts';
if (!process.env.DATABASE_URL?.includes('maomao_memory_review_')) throw new Error('只允许隔离验收库');
const account = JSON.parse(await readFile('/tmp/maomao-memory-recall-account.json', 'utf8'));
const rows = await db.select().from(turns).where(eq(turns.conversationId, account.conversationId)).orderBy(turns.createdAt);
const expected = [ ['忌口', '口味'], [], ['阅读偏好'] ];
assert.equal(rows.length, expected.length);
const checks: object[] = [];
for (const [i, row] of rows.entries()) {
  assert.equal(row.status, 'completed');
  const ids = expected[i]!.map(name => account.saved[name].id as string);
  assert.deepEqual([...row.memoryIds].sort(), ids.sort());
  const [input] = await db.select().from(messages).where(eq(messages.id, row.userMessageId));
  const history = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.conversationId, account.conversationId), lte(messages.seq, input!.seq)))
    .orderBy(desc(messages.seq)).limit(30);
  for (const name of expected[i]!) {
    assert(row.contextSourceIds?.includes(account.saved[name].sourceId));
    assert(!history.some(m => m.id === account.saved[name].sourceId), '旧来源不能冒充近期聊天');
  }
  const [reply] = await db.select().from(messages).where(eq(messages.id, row.catMessageId!));
  checks.push({ query: input!.text, status: row.status, memoryIds: row.memoryIds, expected: expected[i], oldSourcesOutsideRecent30: true, reply: reply!.text });
}
await writeFile(new URL('../../outputs/memory-recall-review/模拟器链路.json', import.meta.url), JSON.stringify({ evidence: '实际模拟器客户端→HTTP/SSE→正式回复执行器→真实PG；回复模型与扩词模型均为mock；中文问题由调试启动脚本发送', passed: checks.length, checks }, null, 2));
console.log(JSON.stringify({ passed: checks.length })); await sql.end();
