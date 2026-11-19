import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { messages, turns } from '../db/schema.ts';
import { tail, type TurnEvent } from '../turns/events.ts';

/** 把一轮回复的事件以 SSE 发给客户端。afterId 是上次收到的事件 id，'0' 表示从头。 */
export function streamTurn(c: Context, turnId: string, afterId: string) {
  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    const events = tail(turnId, afterId, ac.signal);
    let next = await events.next();
    while (!next.done) {
      const ev = next.value;
      if (ev === 'ping') await stream.write(': ping\n\n');
      else await write(stream, ev.id, ev);
      next = await events.next();
    }
    // PG 里的事件已过期（结束超过 10 分钟）：按库里的结果补发
    if (next.value === 'missing') await replayFromDb(stream, turnId, afterId !== '0', c.req.header('x-maomao-snapshot') === '1');
  });
}

async function write(stream: SSEStreamingApi, id: string, ev: TurnEvent) {
  await stream.writeSSE({ id, event: ev.event, data: JSON.stringify(ev.data) });
}

async function replayFromDb(stream: SSEStreamingApi, turnId: string, resuming: boolean, supportsSnapshot: boolean) {
  const [turn] = await db.select().from(turns).where(eq(turns.id, turnId));
  if (!turn) {
    await write(stream, 'db-0', { event: 'error', data: { code: 'not_found', retryable: false } });
    return;
  }
  await write(stream, 'db-0', {
    event: 'accepted',
    data: { turn_id: turn.id, user_message_id: turn.userMessageId },
  });
  switch (turn.status) {
    case 'completed':
    case 'stopped': {
      if (turn.catMessageId) {
        const [msg] = await db.select({ text: messages.text }).from(messages).where(eq(messages.id, turn.catMessageId));
        if (msg) {
          if (resuming && !supportsSnapshot) {
            await write(stream, 'db-1', { event: 'error', data: { code: 'lost', retryable: true } });
            return;
          }
          await write(stream, 'db-1', { event: supportsSnapshot ? 'snapshot' : 'delta', data: { text: msg.text } });
        }
      }
      await write(stream, 'db-2', {
        event: 'done',
        data: { message_id: turn.catMessageId, status: turn.status === 'completed' ? 'done' : 'stopped' },
      });
      return;
    }
    case 'superseded':
      await write(stream, 'db-1', { event: 'superseded', data: { turn_id: turn.id } });
      return;
    default:
      // failed，或者进行中但事件丢了（PG 被清空）
      await write(stream, 'db-1', { event: 'error', data: { code: 'lost', retryable: true } });
  }
}
