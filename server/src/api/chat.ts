import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './auth.ts';
import { bad, notFound } from './responses.ts';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { boundaries, messages, turns } from '../db/schema.ts';
import { recordVisibleLength, requestCancel } from '../turns/events.ts';
import { createReplyTurn, createSendTurn } from '../turns/create.ts';
import { streamTurn } from './sse.ts';
import { MemoryControlError } from '../memory/control.ts';

export const chatRoutes = new Hono<Env>();
chatRoutes.onError((error, c) => {
  if (error instanceof MemoryControlError) return c.json({ error: { code: 'diary_unavailable', message: error.message } }, error.status);
  throw error;
});

// ---- 聊天 ----

const sendBody = z.object({
  client_message_id: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(4000),
  diary_entry_id: z.uuid().optional(),
});

/** 发一条消息，响应就是这一轮回复的 SSE 流 */
chatRoutes.post('/messages', async (c) => {
  const body = sendBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(bad(z.prettifyError(body.error)), 400);
  const { turnId } = await createSendTurn(c.get('owner'), body.data.client_message_id, body.data.text, body.data.diary_entry_id);
  return streamTurn(c, turnId, '0');
});

/** 对已有的用户消息重新回复（超时后「再试一次」） */
chatRoutes.post('/messages/:id/reply', async (c) => {
  const id = z.uuid().safeParse(c.req.param('id'));
  if (!id.success) return c.json(notFound, 404);
  const body = z.object({ request_id: z.uuid().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json(bad(z.prettifyError(body.error)), 400);
  const created = await createReplyTurn(c.get('owner'), id.data, body.data.request_id);
  if (!created) return c.json(notFound, 404);
  return streamTurn(c, created.turnId, '0');
});

/** 历史消息，按时间正序。before 传上一页最早那条的 seq。
 *  猫的消息带两个标记，气泡下的注文要用：remembered（这一轮记下了用户明确要记的）、boundary（被标了不要再提） */
chatRoutes.get('/messages', async (c) => {
  const integerParam = (name: string, fallback: number) => {
    const value = Number(c.req.query(name) ?? fallback);
    return Number.isInteger(value) ? value : fallback;
  };
  const after = integerParam('after', 0);
  const before = integerParam('before', 0);
  const limit = Math.min(100, Math.max(1, integerParam('limit', 50)));
  const conditions = [eq(messages.conversationId, c.get('owner').conversationId)];
  if (after > 0) conditions.push(gt(messages.seq, after));
  if (before > 0) conditions.push(lt(messages.seq, before));
  const rows = await db
    .select({ m: messages, remembered: turns.remembered, boundaryId: boundaries.id })
    .from(messages)
    .leftJoin(turns, eq(turns.id, messages.turnId))
    .leftJoin(boundaries, eq(boundaries.sourceMessageId, messages.id))
    .where(and(...conditions))
    .orderBy(after > 0 ? asc(messages.seq) : desc(messages.seq))
    .limit(limit);
  return c.json({
    messages: (after > 0 ? rows : rows.reverse()).map(({ m, remembered, boundaryId }) => ({
      id: m.id,
      seq: m.seq,
      role: m.role,
      text: m.text,
      status: m.status,
      context_allowed: m.contextAllowed,
      client_message_id: m.clientMessageId,
      diary_entry_id: m.diaryEntryId,
      turn_id: m.turnId,
      ticket_id: m.ticketId,
      remembered: remembered ?? false,
      boundary: boundaryId !== null,
      created_at: m.createdAt,
    })),
  });
});

async function ownTurn(turnId: string, conversationId: string) {
  if (!z.uuid().safeParse(turnId).success) return null;
  const [turn] = await db
    .select()
    .from(turns)
    .where(and(eq(turns.id, turnId), eq(turns.conversationId, conversationId)));
  return turn ?? null;
}

/** 断线续传：带 Last-Event-ID 从断点接着读 */
chatRoutes.get('/turns/:id/stream', async (c) => {
  const turn = await ownTurn(c.req.param('id'), c.get('owner').conversationId);
  if (!turn) return c.json(notFound, 404);
  const after = c.req.header('last-event-id') ?? c.req.query('last_event_id') ?? '0';
  // 只接受 Redis Stream 的 id 格式；db-* 是从库里补发的，续传就从头读
  return streamTurn(c, turn.id, /^db-\d+$/.test(after) ? 'snapshot' : /^\d+-\d+$/.test(after) ? after : '0');
});

const cancelBody = z.object({ visible_length: z.number().int().min(0).optional() });

/** 停止。可以带上屏幕上已经显示的长度（UTF-16），服务端只存这么多 */
chatRoutes.post('/turns/:id/cancel', async (c) => {
  const turn = await ownTurn(c.req.param('id'), c.get('owner').conversationId);
  if (!turn) return c.json(notFound, 404);
  const body = cancelBody.safeParse(await c.req.json().catch(() => ({})));
  if (turn.status === 'queued' || turn.status === 'generating') {
    if (body.success && body.data.visible_length !== undefined) {
      await recordVisibleLength(turn.id, body.data.visible_length);
    }
    await requestCancel(turn.id, 'stop');
  }
  return c.json({ ok: true });
});

/** 这一轮的状态。iOS 在 done 之后轮询 remembered，用来显示「记下了」 */
chatRoutes.get('/turns/:id', async (c) => {
  const turn = await ownTurn(c.req.param('id'), c.get('owner').conversationId);
  if (!turn) return c.json(notFound, 404);
  return c.json({
    id: turn.id,
    status: turn.status,
    user_message_id: turn.userMessageId,
    cat_message_id: turn.catMessageId,
    /** 这一轮回复用到了哪些记忆 */
    memory_ids: turn.memoryIds,
    diary_source_ids: turn.diarySourceIds,
    extracted: turn.extractedAt !== null,
    remembered: turn.remembered,
  });
});
