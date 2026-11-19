/** 少量真实模型抽查：隔离库、合成内容；结果只落 /tmp。 */
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { memories, messages, turns } from '../src/db/schema.ts';
import { createDevUser } from '../src/dev-user.ts';
import { createSendTurn, loadOwner } from '../src/turns/create.ts';
import { closeQueues } from '../src/queue.ts';
import { changeSettings, settings } from '../src/memory/control.ts';
if (!process.env.DATABASE_URL?.includes('maomao_memory_review_')) throw new Error('只允许隔离验收库');
const account = await createDevUser('真实模型合成验收');
const owner = (await loadOwner(account.userId))!;
const results: unknown[] = [];
async function send(text: string) {
  const { turnId } = await createSendTurn(owner, randomUUID(), text);
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 250));
    const [t] = await db.select().from(turns).where(eq(turns.id, turnId));
    if (t && !['queued', 'generating'].includes(t.status)) {
      const reply = t.catMessageId ? (await db.select().from(messages).where(eq(messages.id, t.catMessageId)))[0]?.text : null;
      const stored = await db.select({ value: memories.value, predicate: memories.predicate, status: memories.status }).from(memories).where(eq(memories.catId, owner.catId));
      results.push({ input: text, status: t.status, error: t.error, reply, stored });
      console.log(JSON.stringify(results.at(-1)));
      if (t.error?.startsWith('model_auth')) throw new Error('现有模型凭证无效，停止真实模型抽查');
      return;
    }
  }
  throw new Error('model sampling timeout');
}
try {
  await send('记住，我不喝咖啡。');
  await send('更正一下，我现在只喝无咖啡因咖啡，旧的偏好改成这个。');
  await send('更正一下，那个不是这样的。');
  await changeSettings(owner.catId, { learn: false, revision: (await settings(owner.catId)).revision });
  await send('记住，我喜欢周末去图书馆。');
  await writeFile('/tmp/maomao-memory-model-results.json', JSON.stringify(results, null, 2));
} finally { await closeQueues();  await sql.end(); }
