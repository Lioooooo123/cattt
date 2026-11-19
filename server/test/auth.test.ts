import { randomUUID } from 'node:crypto';
import { inArray, sql as raw } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auth, type Env } from '../src/api/auth.ts';
import { hashToken } from '../src/auth-token.ts';
import { config } from '../src/config.ts';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, sessions, users } from '../src/db/schema.ts';
import { revokeSession } from '../src/identity/service.ts';
import { DEFAULT_TRAITS } from '../src/runtime/persona.ts';

const app = new Hono<Env>().get('/', auth, (c) => c.json(c.get('owner')));
const originalEnv = config.APP_ENV;
const userIds: string[] = [];

beforeEach(() => { config.APP_ENV = 'development'; });
afterEach(() => { config.APP_ENV = originalEnv; });
afterAll(async () => {
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await sql.end();
});

async function account(state: 'complete' | 'no-cat' | 'no-conversation' = 'complete') {
  const token = randomUUID();
  const [user] = await db.insert(users).values({ devTokenHash: hashToken(token) }).returning({ id: users.id });
  const userId = user!.id;
  userIds.push(userId);
  if (state === 'no-cat') return { token, userId };

  const [cat] = await db.insert(cats)
    .values({ userId, name: '团子', appearance: 'orange', temperament: 'slow', traits: DEFAULT_TRAITS })
    .returning({ id: cats.id });
  if (state === 'no-conversation') return { token, userId };

  const [conversation] = await db.insert(conversations).values({ catId: cat!.id }).returning({ id: conversations.id });
  return { token, userId, owner: { userId, catId: cat!.id, conversationId: conversation!.id } };
}

async function issueSession(userId: string, token = randomUUID()) {
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt: raw`now() + interval '1 day'` });
  return token;
}

async function request(token?: string) {
  const queries = vi.spyOn(sql, 'unsafe');
  try {
    const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
    const response = await app.request('/', { headers });
    expect(queries).toHaveBeenCalledTimes(token ? 1 : 0);
    return { status: response.status, body: await response.json() };
  } finally {
    queries.mockRestore();
  }
}

it('缺少 token 不查询，无效 token 只查询一次', async () => {
  expect(await request()).toEqual({ status: 401, body: { error: { code: 'unauthorized', message: '缺少 token' } } });
  expect(await request(randomUUID())).toEqual({ status: 401, body: { error: { code: 'unauthorized', message: 'token 不对' } } });
});

it('开发环境优先用有效会话，会话撤销后按原规则回退到开发 token', async () => {
  const dev = await account();
  const session = await account();
  expect(await request(dev.token)).toEqual({ status: 200, body: dev.owner });
  await issueSession(session.userId, dev.token);
  expect(await request(dev.token)).toEqual({ status: 200, body: session.owner });
  await revokeSession(dev.token);
  expect(await request(dev.token)).toEqual({ status: 200, body: dev.owner });
});

it.each(['staging', 'production'] as const)('%s 拒绝开发 token，正常会话仍能鉴权', async (env) => {
  config.APP_ENV = env;
  const dev = await account();
  const session = await issueSession(dev.userId);
  expect((await request(dev.token)).status).toBe(401);
  expect(await request(session)).toEqual({ status: 200, body: dev.owner });
});

it.each(['no-cat', 'no-conversation'] as const)('有效凭证缺少猫或对话（%s）返回 409，不换成别的账号', async (state) => {
  const incomplete = await account(state);
  const dev = await account();
  await issueSession(incomplete.userId, dev.token);
  const noCat = { status: 409, body: { error: { code: 'no_cat', message: '这个账号还没有猫' } } };
  expect(await request(incomplete.token)).toEqual(noCat);
  expect(await request(dev.token)).toEqual(noCat);
});
