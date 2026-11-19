import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auth, type Env } from '../src/api/auth.ts';
import { hashToken } from '../src/auth-token.ts';
import { config } from '../src/config.ts';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, pairedDevices, users } from '../src/db/schema.ts';
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

async function pairDevice(userId: string) {
  const token = `mm_dvc_${randomUUID()}`;
  await db.insert(pairedDevices).values({ userId, name: '测试手机', tokenHash: hashToken(token) });
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

it('开发环境接受开发 token', async () => {
  const dev = await account();
  expect(await request(dev.token)).toEqual({ status: 200, body: dev.owner });
});

it.each(['staging', 'production'] as const)('%s 拒绝开发 token，配对设备凭证仍能鉴权', async (env) => {
  config.APP_ENV = env;
  const dev = await account();
  const device = await pairDevice(dev.userId);
  expect((await app.request('/', { headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(401);
  expect((await app.request('/', { headers: { authorization: `Bearer ${device}` } })).status).toBe(200);
});

it.each(['no-cat', 'no-conversation'] as const)('有效凭证缺少猫或对话（%s）返回 409，不换成别的账号', async (state) => {
  const incomplete = await account(state);
  const device = await pairDevice(incomplete.userId);
  const noCat = { status: 409, body: { error: { code: 'no_cat', message: '这个账号还没有猫' } } };
  expect(await request(incomplete.token)).toEqual(noCat);
  const response = await app.request('/', { headers: { authorization: `Bearer ${device}` } });
  expect({ status: response.status, body: await response.json() }).toEqual(noCat);
});

it('旧 Apple 登录入口已移除', async () => {
  const { app: full } = await import('../src/api/app.ts');
  const dev = await account();
  for (const path of ['/auth/nonce', '/auth/apple']) expect((await full.request(path, { method: 'POST' })).status).toBe(404);
  expect((await full.request('/v1/session/logout', { method: 'POST', headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(404);
});
