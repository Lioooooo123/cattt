import { TURN_EVENTS_TTL_S } from '../config.ts';
import { eq } from 'drizzle-orm';
import { db, sql } from '../db/client.ts';
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

const eventsChannel = (id: string) => `turn:${id}:events`;

export async function publish(turnId: string, ev: TurnEvent) {
  await sql.begin(async tx => {
    // 序号和提交顺序一致，续传不会跳过并发发布的事件。
    await tx`select pg_advisory_xact_lock(hashtextextended(${turnId}, 0))`;
    await tx`insert into turn_events (turn_id, seq, event, data)
      select ${turnId}, coalesce(max(seq), 0) + 1, ${ev.event}, ${JSON.stringify(ev.data)}::jsonb
      from turn_events where turn_id = ${turnId}`;
    await tx`select pg_notify('turn_updates', ${JSON.stringify({ channel: eventsChannel(turnId), message: '' })})`;
  });
}

export async function readEvents(turnId: string) {
  return sql`select e.*, 'pg-' || e.seq::text as id from turn_events e
    where e.turn_id = ${turnId}
    and (select max(created_at) from turn_events where turn_id = ${turnId}) >
      now() - make_interval(secs => case when exists (
        select 1 from turns where id = ${turnId} and status not in ('queued', 'generating')
      ) then ${TURN_EVENTS_TTL_S} else 3600 end)
    order by seq`;
}

/** 通知立即唤醒，定时读取兜底；看到终态后再读一次，避免遗漏尾字。 */
export async function* tail(
  turnId: string,
  afterId: string,
  signal: AbortSignal,
): AsyncGenerator<StoredEvent | 'ping', 'missing' | 'end' | 'aborted'> {
  if (afterId !== '0' && !/^pg-[1-9]\d*$/.test(afterId)) return 'missing';
  let wake: (() => void) | undefined;
  let notified = false;
  const remove = await subscribe(eventsChannel(turnId), () => { notified = true; wake?.(); });
  const onAbort = () => wake?.();
  signal.addEventListener('abort', onAbort, { once: true });
  let last = afterId === '0' ? 0n : BigInt(afterId.slice(3));
  try {
    let rows = await readEvents(turnId);
    if (!rows.length || (afterId !== '0' && !rows.some(row => row.id === afterId))) return 'missing';
    while (!signal.aborted) {
      notified = false;
      const remaining = rows.filter(row => BigInt(row.seq) > last);
      for (const row of remaining) {
        last = BigInt(row.seq);
        yield { id: row.id, event: row.event, data: row.data } as StoredEvent;
        if (isTerminal(row.event)) return 'end';
      }
      if (!remaining.length) {
        const terminal = await terminalEvent(turnId);
        if (terminal) {
          rows = await readEvents(turnId);
          if (!rows.length) return 'missing';
          for (const row of rows.filter(row => BigInt(row.seq) > last)) {
            last = BigInt(row.seq);
            yield { id: row.id, event: row.event, data: row.data } as StoredEvent;
            if (isTerminal(row.event)) return 'end';
          }
          yield { ...terminal, id: `pg-${last}` };
          return 'end';
        }
        yield 'ping';
      }
      if (!notified && !signal.aborted) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, 1000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
      rows = await readEvents(turnId);
      if (!rows.length) return 'missing';
    }
    return 'aborted';
  } finally { remove(); signal.removeEventListener('abort', onAbort); }
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
const cancelChannel = (turnId: string) => `turn:${turnId}:cancelled`;

export function subscribeCancel(turnId: string, listener: (reason: CancelReason) => void) {
  return subscribe(cancelChannel(turnId), reason => {
    if (reason === 'stop' || reason === 'supersede') listener(reason);
  });
}

export async function requestCancel(turnId: string, reason: CancelReason) {

  await sql.begin(async tx => {
    const saved = await tx`insert into turn_controls (turn_id, cancel_reason, cancel_expires_at)
      values (${turnId}, ${reason}, now() + interval '10 minutes')
      on conflict (turn_id) do update set cancel_reason = excluded.cancel_reason,
      cancel_expires_at = excluded.cancel_expires_at
      where turn_controls.cancel_expires_at <= now() or turn_controls.cancel_reason is null or ${reason} = 'supersede'
      returning turn_id`;
    if (saved.length) await tx`select pg_notify('turn_updates', ${JSON.stringify({ channel: cancelChannel(turnId), message: reason })})`;
  });
}

export async function readCancel(turnId: string): Promise<CancelReason | null> {
  const [row] = await sql`select cancel_reason from turn_controls where turn_id = ${turnId} and cancel_expires_at > now()`;
  return row?.cancel_reason ?? null;
}

/** 客户端显示的 UTF-16 长度，停止时按此截断。 */
export async function recordVisibleLength(turnId: string, length: number) {
  await sql.begin(async tx => {
    await tx`insert into turn_controls (turn_id, visible_length, visible_expires_at)
      values (${turnId}, ${length}, now() + interval '10 minutes')
      on conflict (turn_id) do update set visible_length = excluded.visible_length, visible_expires_at = excluded.visible_expires_at`;
    await tx`select pg_notify('turn_updates', ${JSON.stringify({ channel: `turn:${turnId}:visible`, message: String(length) })})`;
  });
}

export async function readVisibleLength(turnId: string): Promise<number | null> {
  const [row] = await sql`select visible_length from turn_controls where turn_id = ${turnId} and visible_expires_at > now()`;
  return row?.visible_length ?? null;
}

// ---- 同一段对话同一时间只生成一轮 ----

const lockChannel = (conversationId: string) => `conv:${conversationId}:lock-released`;

/** 只用于避免聊天忙碌时做无用措辞；发布仍必须实际取得锁。 */
export async function conversationBusy(conversationId: string) {
  return (await sql`select 1 from conversation_locks where conversation_id = ${conversationId} and expires_at > now()`).length > 0;
}

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
      const ok = await sql`insert into conversation_locks (conversation_id, token, expires_at)
        values (${conversationId}, ${token}, now() + interval '30 seconds')
        on conflict (conversation_id) do update set token = excluded.token, expires_at = excluded.expires_at
        where conversation_locks.expires_at <= now() returning token`;
      if (ok.length) return true;
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

export async function releaseConversationLock(conversationId: string, token: string) {
  await sql.begin(async tx => {
    const removed = await tx`delete from conversation_locks where conversation_id = ${conversationId} and token = ${token} returning token`;
    if (removed.length) await tx`select pg_notify('turn_updates', ${JSON.stringify({ channel: lockChannel(conversationId), message: 'released' })})`;
  });
}

export async function refreshConversationLock(conversationId: string, token: string) {
  return (await sql`update conversation_locks set expires_at = now() + interval '30 seconds'
    where conversation_id = ${conversationId} and token = ${token} and expires_at > now() returning token`).length > 0;
}

/** 保留窗口与读取过滤一致；过期控制和锁也定期回收。 */
export async function cleanupTurnState() {
  await sql`delete from turn_events where turn_id in (
    select e.turn_id from turn_events e left join turns t on t.id = e.turn_id
    group by e.turn_id, t.status having max(e.created_at) <= now() -
      make_interval(secs => case when t.status not in ('queued', 'generating')
        then ${TURN_EVENTS_TTL_S} else 3600 end)
  )`;
  await sql`delete from turn_controls where coalesce(cancel_expires_at, '-infinity') <= now()
    and coalesce(visible_expires_at, '-infinity') <= now()`;
  await sql`delete from conversation_locks where expires_at <= now()`;
}
