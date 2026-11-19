/** 仅在隔离验收库创建合成账号；token 只落 /tmp，不打印。 */
import { closeQueues } from '../src/queue.ts';
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, messages, boundaries } from '../src/db/schema.ts';
import { createDevUser } from '../src/dev-user.ts';
import { applyCandidate } from '../src/worker/memory.ts';
if (!process.env.DATABASE_URL?.includes('maomao_memory_review_')) throw new Error('只允许隔离验收库');
const account = await createDevUser('记忆功能验收');
const [cat] = await db.select().from(cats).where(eq(cats.userId, account.userId));
const [conv] = await db.select().from(conversations).where(eq(conversations.catId, cat!.id));
for (const [predicate, value, text] of [
  ['咖啡偏好', '不喝咖啡', '记住，我不喝咖啡，不过周末喜欢去图书馆。'],
  ['周末安排', '喜欢去图书馆', '记住，周末我喜欢去图书馆。'],
  ['回答方式', '尽量说得简单一点，少用专业词。有复杂的地方，请用生活中的例子解释。', '记住，请说得简单一点，少用专业词。有复杂的地方，请用生活中的例子解释。'],
]) {
  const [msg] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: text! }).returning();
  await applyCandidate(cat!.id, msg!.id, { subject: '用户', predicate: predicate!, value: value!, explicit: true, correction: false, kind: 'preference', confidence: 1, sensitivity: 'low' });
}
const [reply] = await db.insert(messages).values({ conversationId: conv!.id, role: 'cat', text: '上次考试的分数，想聊聊吗？' }).returning();
await db.insert(boundaries).values({ catId: cat!.id, sourceMessageId: reply!.id, description: '上次考试的分数' });
await writeFile('/tmp/maomao-memory-review-account.json', JSON.stringify({ ...account, catId: cat!.id, conversationId: conv!.id }), { mode: 0o600 });
console.log('已创建合成验收账号，凭证仅存本机临时文件');
await closeQueues();  await sql.end();
