import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../src/api/app.ts';
import { hashToken } from '../src/auth-token.ts';
import { db, sql } from '../src/db/client.ts';
import { cats, conversations, users } from '../src/db/schema.ts';
import { buildTurnContext } from '../src/runtime/context.ts';
import { catTools } from '../src/runtime/tools.ts';
import { closeQueues } from '../src/queue.ts';
let userId: string, catId: string, conversationId: string;
const token = randomUUID();
const request = (body: unknown, authorization = 'Bearer ' + token) => app.request('/v1/me/time-zone', {
  method: 'PUT', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
beforeAll(async () => {
  const [user] = await db.insert(users).values({ devTokenHash: hashToken(token) }).returning(); userId = user!.id;
  const [cat] = await db.insert(cats).values({ userId, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning(); catId = cat!.id;
  const [conv] = await db.insert(conversations).values({ catId }).returning(); conversationId = conv!.id;
});
afterAll(async () => { await db.delete(users).where(eq(users.id, userId)); await closeQueues();  await sql.end(); });
it('时区缺省为上海，合法上报只更新当前用户', async () => {
  expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.timeZone).toBe('Asia/Shanghai');
  const [other] = await db.insert(users).values({}).returning();
  try {
    const response = await request({ time_zone: 'America/New_York' });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ time_zone: 'America/New_York' });
    expect((await db.select().from(users).where(eq(users.id, other!.id)))[0]!.timeZone).toBe('Asia/Shanghai');
  } finally { await db.delete(users).where(eq(users.id, other!.id)); }
});
it('非法值、缺字段和缺鉴权被拒绝且不修改时区', async () => {
  await request({ time_zone: 'Asia/Shanghai' });
  for (const body of [{ time_zone: 'wrong/zone' }, { time_zone: '+08:00' }, { time_zone: '' }, { time_zone: 8 }, {}]) expect((await request(body)).status).toBe(400);
  expect((await request({ time_zone: 'UTC' }, '')).status).toBe(401);
  expect((await db.select().from(users).where(eq(users.id, userId)))[0]!.timeZone).toBe('Asia/Shanghai');
});
it('换时区后上下文的现在与无显式参数的时间工具都采用用户时区', async () => {
  for (const timeZone of ['Pacific/Honolulu', 'Asia/Tokyo']) {
    await request({ time_zone: timeZone });
    const before = new Date();
    const context = await buildTurnContext(catId, conversationId);
    const after = new Date();
    const format = (instant: Date) => new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(instant);
    expect([format(before), format(after)]).toContain(context.instructions.split('## 现在\n')[1]);
    const tools = await catTools({ catId, turnId: randomUUID(), userMessageId: randomUUID() });
    const result = await tools.get_time!.execute({}, new AbortController().signal);
    expect(result.data).toMatchObject({ timeZone });
  }
});
