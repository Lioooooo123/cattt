import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { app } from '../src/api/app.ts';
import { db, sql } from '../src/db/client.ts';
import { createDevUser } from '../src/dev-user.ts';
import { cats, conversations, messages, turns, users } from '../src/db/schema.ts';
import { publish, tail } from '../src/turns/events.ts';
const ids: string[] = []; const turnIds: string[] = [];
async function fixture() {
  const user = await createDevUser('sse-test'); ids.push(user.userId);
  const [cat] = await db.select().from(cats).where(eq(cats.userId, user.userId));
  const [conv] = await db.select().from(conversations).where(eq(conversations.catId, cat!.id));
  const [msg] = await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text: '你好', clientMessageId: randomUUID() }).returning();
  const [turn] = await db.insert(turns).values({ conversationId: conv!.id, userMessageId: msg!.id, inputVersion: 0, status: 'completed' }).returning(); turnIds.push(turn!.id);
  const [reply] = await db.insert(messages).values({ conversationId: conv!.id, role: 'cat', text: '完整回复', turnId: turn!.id }).returning();
  await db.update(turns).set({ catMessageId: reply!.id }).where(eq(turns.id, turn!.id));
  return { turn: turn!, headers: { authorization: `Bearer ${user.token}` } };
}
afterAll(async () => {
  for (const id of ids) await db.delete(users).where(eq(users.id, id));
  for (const id of turnIds) await sql`delete from turn_events where turn_id=${id}`;
  await sql.end();
});
describe('HTTP SSE 恢复契约', () => {
  it('空读后才发布的最后 delta 必须先于补发 done', async () => {
    const { turn, headers } = await fixture();
    await db.update(turns).set({ status: 'generating' }).where(eq(turns.id, turn.id));
    await publish(turn.id, { event: 'accepted', data: { turn_id: turn.id, user_message_id: turn.userMessageId } });
    const stream = tail(turn.id, '0', new AbortController().signal);
    expect((await stream.next()).value).toMatchObject({ event: 'accepted' });
    // 空读之后、终态查询之前插入最后一段。
    const hook = vi.spyOn(db, 'select').mockImplementationOnce((...args: Parameters<typeof db.select>) => {
      const query = db.select(...args);
      const from = query.from.bind(query);
      vi.spyOn(query, 'from').mockImplementationOnce((...tables: Parameters<typeof from>) => {
        const result = from(...tables);
        const where = result.where.bind(result);
        vi.spyOn(result, 'where').mockImplementationOnce(((...filters: Parameters<typeof where>) => {
          return (async () => {
            await publish(turn.id, { event: 'delta', data: { text: '完整回复' } });
            await db.update(turns).set({ status: 'completed' }).where(eq(turns.id, turn.id));
            return await where(...filters);
          })();
        }) as typeof result.where);
        return result;
      });
      return query;
    });
    try {
      expect((await stream.next()).value).toMatchObject({ event: 'delta', data: { text: '完整回复' } });
      expect((await stream.next()).value).toMatchObject({ event: 'done' });
      expect((await stream.next()).done).toBe(true);
    } finally { hook.mockRestore(); await stream.return('aborted'); }
  });
  it('保留正文的流缺少 done 时，从 PG 补终态而不重复全文', async () => {
    const { turn, headers } = await fixture();
    await publish(turn.id, { event: 'accepted', data: { turn_id: turn.id, user_message_id: turn.userMessageId } });
    await publish(turn.id, { event: 'delta', data: { text: '完整回复' } });
    const res = await app.request(`/v1/turns/${turn.id}/stream`, { headers });
    const body = await res.text();
    expect(body.match(/完整回复/g)).toHaveLength(1); expect(body).toContain('event: done');
  });
  it('丢失流的续传用 snapshot 替换全文；旧客户端收到 lost 而非重复追加', async () => {
    const { turn, headers } = await fixture();
    const res = await app.request(`/v1/turns/${turn.id}/stream`, { headers: { ...headers, 'last-event-id': '123-0', 'x-maomao-snapshot': '1' } });
    expect(await res.text()).toContain('event: snapshot');
    const legacy = await app.request(`/v1/turns/${turn.id}/stream`, { headers: { ...headers, 'last-event-id': '123-0' } });
    const body = await legacy.text(); expect(body).toContain('lost'); expect(body).not.toContain('完整回复');
  });
  it('鉴权保护新增 Soul 与世界入口', async () => {
    expect((await app.request('/v1/cat/soul')).status).toBe(401);
    expect((await app.request('/v1/world/sessions', { method: 'POST' })).status).toBe(401);
  });
});
