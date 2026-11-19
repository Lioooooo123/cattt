import { TURN_EVENTS_TTL_S } from '../config.ts';
import { redis } from '../redis.ts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { turns } from '../db/schema.ts';
import { subscribe } from './subscriber.ts';

/**
 * 发给 iOS 的 SSE 事件。格式是我们自己定的，不用 AI SDK 的流协议，
 * 这样 SDK 升级不会牵连 iOS 发版。见 docs/方案/后端-开发者版-方案-2026-09-11.md 第 7 节。
 */
export type TurnEvent =
  | { event: 'accepted'; data: { turn_id: string; user_message_id: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'snapshot'; data: { text: string } }
  | { event: 'superseded'; data: { turn_id: string } }
  | { event: 'done'; data: { message_id: string | null; status: 'done' | 'stopped' } }
  | { event: 'error'; data: { code: string; retryable: boolean } };

export type StoredEvent = TurnEvent & { id: string };

const TERMINAL = new Set(['done', 'superseded', 'error']);
export const isTerminal = (event: string) => TERMINAL.has(event);

const eventsKey = (turnId: string) => `turn:${turnId}:events`;

/**
 * 每一段都写进 Redis Stream。HTTP 响应只是跟着读，断线后带 Last-Event-ID 从断点接着读。
 * 结束事件写完后只留 10 分钟；进行中的留 1 小时兜底，防止进程崩了留下孤儿键。
 */
export async function publish(turnId: string, ev: TurnEvent) {
  const key = eventsKey(turnId);
  const results = await redis
    .multi()
    .xadd(key, '*', 'event', ev.event, 'data', JSON.stringify(ev.data))
    .expire(key, isTerminal(ev.event) ? TURN_EVENTS_TTL_S : 3600)
    .exec();
  if (!results) throw new Error('Redis transaction aborted');
  for (const [error] of results) if (error) throw error;
}

function parse(id: string, fields: string[]): StoredEvent {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
  return { id, event: map.event, data: JSON.parse(map.data ?? '{}') } as StoredEvent;
}

/**
 * 从 afterId 之后开始读这一轮的事件，读到结束事件为止。
 * 键不存在（已过期或从没有过）返回 'missing'，由调用方回库里查。
 * 每 15 秒没新事件吐一个 'ping'，用来给 SSE 保活。
 */
export async function* tail(
  turnId: string,
  afterId: string,
  signal: AbortSignal,
): AsyncGenerator<StoredEvent | 'ping', 'missing' | 'end' | 'aborted'> {
  if (afterId === 'snapshot') return 'missing';
  const key = eventsKey(turnId);
  if ((await redis.exists(key)) === 0) return 'missing';
  if (afterId !== '0' && (await redis.xrange(key, afterId, afterId)).length === 0) return 'missing';

  // 阻塞读会占住连接，每个监听者单独一条
  const conn = redis.duplicate({ lazyConnect: true });
  const onAbort = () => conn.disconnect();
  signal.addEventListener('abort', onAbort, { once: true });
  let lastId = afterId;
  try {
    if (signal.aborted) return 'aborted';
    await conn.connect();
    while (!signal.aborted) {
      const res = await conn.xread('BLOCK', 1_000, 'STREAMS', key, lastId);
      if (!res) {
        if (!await redis.exists(key)) return 'missing';
        const terminal = await terminalEvent(turnId);
        if (terminal) {
          // 最后 delta 可能在空读之后、PG 终态之前写入。终态不可变，
          // 此时再读完已落入流的内容，才能补结束标记，避免漏尾字。
          const remaining = await conn.xrange(key, `(${lastId}`, '+');
          if (!await redis.exists(key)) return 'missing';
          for (const [id, fields] of remaining) {
            lastId = id;
            const ev = parse(id, fields);
            yield ev;
            if (isTerminal(ev.event)) return 'end';
          }
          yield { ...terminal, id: lastId };
          return 'end';
        }
        yield 'ping';
        continue;
      }
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          lastId = id;
          const ev = parse(id, fields);
          yield ev;
          if (isTerminal(ev.event)) return 'end';
        }
      }
    }
    return 'aborted';
  } catch (err) {
    if (signal.aborted) return 'aborted';
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    conn.disconnect();
  }
}

export async function terminalEvent(turnId: string): Promise<TurnEvent | null> {
  const [turn] = await db.select().from(turns).where(eq(turns.id, turnId));
  if (!turn) return { event: 'error', data: { code: 'not_found', retryable: false } };
  if (turn.status === 'completed' || turn.status === 'stopped') return { event: 'done', data: { message_id: turn.catMessageId, status: turn.status === 'completed' ? 'done' : 'stopped' } };
  if (turn.status === 'superseded') return { event: 'superseded', data: { turn_id: turn.id } };
  if (turn.status === 'failed') {
    const code = turn.error?.split(':', 1)[0] ?? 'stale';
    return { event: 'error', data: { code, retryable: !['model_auth', 'model_quota', 'model_bad_request'].includes(code) } };
  }
  return null;
}

// ---- 停止与作废 ----

export type CancelReason = 'stop' | 'supersede';
const cancelKey = (turnId: string) => `turn:${turnId}:cancel`;
const cancelChannel = (turnId: string) => `turn:${turnId}:cancelled`;

export function subscribeCancel(turnId: string, listener: (reason: CancelReason) => void) {
  return subscribe(cancelChannel(turnId), reason => {
    if (reason === 'stop' || reason === 'supersede') listener(reason);
  });
}

export async function requestCancel(turnId: string, reason: CancelReason) {
  // 作废优先于停止：两者都来时按作废处理
  const saved = reason === 'stop'
    ? await redis.set(cancelKey(turnId), reason, 'EX', 600, 'NX')
    : await redis.set(cancelKey(turnId), reason, 'EX', 600);
  if (saved) await redis.publish(cancelChannel(turnId), reason).catch(() => {});
}

export async function readCancel(turnId: string): Promise<CancelReason | null> {
  return (await redis.get(cancelKey(turnId))) as CancelReason | null;
}

/** 停止时客户端屏幕上显示了多少（UTF-16 长度），存库时截到这里 */
const visibleKey = (turnId: string) => `turn:${turnId}:visible`;

export async function recordVisibleLength(turnId: string, length: number) {
  await redis.set(visibleKey(turnId), String(length), 'EX', 600);
}

export async function readVisibleLength(turnId: string): Promise<number | null> {
  const raw = await redis.get(visibleKey(turnId));
  return raw === null ? null : Number(raw);
}

// ---- 同一段对话同一时间只生成一轮 ----

const lockKey = (conversationId: string) => `conv:${conversationId}:lock`;
const lockChannel = (conversationId: string) => `conv:${conversationId}:lock-released`;

/** 只用于避免聊天忙碌时做无用措辞；发布仍必须实际取得锁。 */
export async function conversationBusy(conversationId: string) { return await redis.exists(lockKey(conversationId)) > 0; }
const LOCK_TTL_MS = 30_000;

export async function acquireConversationLock(
  conversationId: string,
  token: string,
  waitMs: number,
  onWait?: () => Promise<void>,
): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  let lastBeat = performance.now();
  let notified = false;
  let wake: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    do {
      notified = false;
      const ok = await redis.set(lockKey(conversationId), token, 'PX', LOCK_TTL_MS, 'NX');
      if (ok) return true;
      if (performance.now() >= deadline) return false;
      if (!unsubscribe) {
        let expired = false;
        let timer: NodeJS.Timeout | undefined;
        const registration = subscribe(lockChannel(conversationId), () => { notified = true; wake?.(); });
        unsubscribe = await Promise.race([
          registration.then(remove => { if (expired) remove(); return remove; }),
          new Promise<undefined>(resolve => { timer = setTimeout(() => { expired = true; resolve(undefined); }, Math.max(0, deadline - performance.now())); }),
        ]);
        clearTimeout(timer);
        if (!unsubscribe) return false;
        continue;
      }
      if (onWait && performance.now() - lastBeat > 5_000) {
        lastBeat = performance.now();
        await onWait();
      }
      if (!notified) await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.max(0, Math.min(1_000, deadline - performance.now())));
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    } while (performance.now() < deadline);
    return false;
  } finally { unsubscribe?.(); }
}

// 只删自己持有的锁
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then local removed = redis.call('del', KEYS[1]); redis.call('publish', ARGV[2], 'released'); return removed else return 0 end`;
const REFRESH = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export async function releaseConversationLock(conversationId: string, token: string) {
  await redis.eval(RELEASE, 1, lockKey(conversationId), token, lockChannel(conversationId));
}

export async function refreshConversationLock(conversationId: string, token: string) {
  return (await redis.eval(REFRESH, 1, lockKey(conversationId), token, LOCK_TTL_MS)) === 1;
}
