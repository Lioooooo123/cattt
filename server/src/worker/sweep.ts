import { and, inArray, sql } from 'drizzle-orm';
import { STALE_TURN_MS } from '../config.ts';
import { db, dbNow } from '../db/client.ts';
import { turns } from '../db/schema.ts';
import { commitOutcome } from '../turns/store.ts';
import { publish, cleanupTurnState } from '../turns/events.ts';

/**
 * 进程崩了或被杀，进行中的回复就没人管了。生成时每 5 秒写一次心跳，
 * 超过 STALE_TURN_MS 没心跳的判失败，并给还在听的客户端发一个可重试的错误。
 */
export async function sweepStaleTurns() {
  await cleanupTurnState();
  const stale = await db
    .select({ id: turns.id }).from(turns)
    .where(
      and(
        inArray(turns.status, ['queued', 'generating']),
        sql`coalesce(${turns.heartbeatAt}, ${turns.createdAt}) < now() - ${`${STALE_TURN_MS} milliseconds`}::interval`,
      ),
    );

  for (const t of stale) {
    const result = await commitOutcome(t.id, { status: 'failed', error: 'stale: no heartbeat', staleBeforeMs: STALE_TURN_MS });
    if (!result.applied) continue;
    await publish(t.id, { event: 'error', data: { code: 'stale', retryable: true } })
      .catch((error) => console.error(`[sweep ${t.id}] 终态已保存，事件稍后从 PG 恢复`, error));
  }
  if (stale.length > 0) console.log(`[sweep] ${stale.length} 条卡住的回复判为失败`);
}
