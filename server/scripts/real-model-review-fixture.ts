/** 真实模型验收的隔离夹具/本机HTTP入口；凭据只写本机0600临时文件。 */
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations } from '../src/db/schema.ts';
import { createDevUser } from '../src/dev-user.ts';
import { config } from '../src/config.ts';
if (!config.DATABASE_URL.includes('maomao_memory_review_real_e2e_') || config.MODEL_PROVIDER !== 'deepseek') throw new Error('仅限真实模型隔离验收库');
if (process.argv[2] === 'seed') {
  const accounts: Record<string, object> = {};
  for (const kind of ['app', 'long', 'slow', 'close', 'quiet', 'curious']) {
    const account = await createDevUser('真实模型合成验收-' + kind);
    const [cat] = await db.select().from(cats).where(eq(cats.userId, account.userId));
    const [conversation] = await db.select().from(conversations).where(eq(conversations.catId, cat!.id));
    if (['slow', 'close', 'quiet', 'curious'].includes(kind)) {
      await db.update(cats).set({ temperament: kind, learnMemories: false, createdAt: new Date(Date.now() - 8 * 86400000) }).where(eq(cats.id, cat!.id));
    }
    accounts[kind] = { ...account, catId: cat!.id, conversationId: conversation!.id };
  }
  if (!process.env.REVIEW_ACCOUNT_PATH) throw new Error('缺临时输出路径');
  await writeFile(process.env.REVIEW_ACCOUNT_PATH, JSON.stringify({ accounts, model: config.CHAT_MODEL, extractModel: config.EXTRACT_MODEL,
    provider: config.MODEL_PROVIDER, thinking: config.CHAT_THINKING, recallMode: config.MEMORY_RECALL_MODE }), { mode: 0o600 });
  console.log('隔离账号已准备，凭据仅写本机临时文件。');
  await sql.end();
} else if (process.argv[2] === 'serve') {
  const { serve } = await import('@hono/node-server');
  const { app } = await import('../src/api/app.ts');
  const server = serve({ hostname: '127.0.0.1', port: config.PORT, fetch: app.fetch });
  console.log('隔离API启动。');
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    server.close();
    const { drainTurns } = await import('../src/turns/run.ts');
    await drainTurns(20000);
    const { closeQueues } = await import('../src/queue.ts');
await closeQueues();  await sql.end(); process.exit(0);
  };
  process.on('SIGTERM', close); process.on('SIGINT', close);
} else { await sql.end(); throw new Error('只允许seed或serve'); }
