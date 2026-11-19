import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { hashToken } from '../auth-token.ts';
import { config } from '../config.ts';
import { db, dbNow } from '../db/client.ts';
import { cats, conversations, pairedDevices, sessions, users } from '../db/schema.ts';
import { withModelAccount } from '../runtime/budget.ts';
import type { Owner } from '../turns/create.ts';

export type Env = { Variables: { owner: Owner } };

function tokenUserId(tokenHash: string) {
  const session = db.select({ userId: sessions.userId }).from(sessions).where(and(
    eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, dbNow()),
  ));
  if (config.APP_ENV !== 'development') return sql<string>`(${session})`;

  const dev = db.select({ userId: users.id }).from(users).where(eq(users.devTokenHash, tokenHash));
  return sql<string>`coalesce((${session}), (${dev}))`;
}

export const auth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return c.json({ error: { code: 'unauthorized', message: '缺少 token' } }, 401);
  let deviceUserId: string | undefined;
  if (token.startsWith('mm_dvc_')) {
    const [device] = await db.update(pairedDevices).set({ lastSeenAt: dbNow() }).where(and(eq(pairedDevices.tokenHash, hashToken(token)), isNull(pairedDevices.revokedAt))).returning({ userId: pairedDevices.userId });
    if (!device) return c.json({ error: { code: 'unauthorized', message: 'token 不对' } }, 401);
    deviceUserId = device.userId;
  }

  const [row] = await db.select({ userId: users.id, catId: cats.id, conversationId: conversations.id })
    .from(users)
    .leftJoin(cats, eq(cats.userId, users.id))
    .leftJoin(conversations, eq(conversations.catId, cats.id))
    .where(eq(users.id, deviceUserId ?? tokenUserId(hashToken(token))));
  if (!row) return c.json({ error: { code: 'unauthorized', message: 'token 不对' } }, 401);

  const { userId, catId, conversationId } = row;
  if (!catId || !conversationId) return c.json({ error: { code: 'no_cat', message: '这个账号还没有猫' } }, 409);

  c.set('owner', { userId, catId, conversationId });
  await withModelAccount(userId, () => next());
});
