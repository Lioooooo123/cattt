import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelClient } from '../llm/index.ts';
import { sql } from '../db/client.ts';

export type AdmissionLane = 'chat' | 'background';
export const admissionLane = (purpose: string): AdmissionLane =>
  ['chat', 'memory_recall', 'memory_extract_chat'].includes(purpose) ? 'chat' : 'background';

export async function acquire(resource: string, lane: AdmissionLane, purpose: string, limit: number, signal?: AbortSignal): Promise<() => Promise<void>> {
  signal?.throwIfAborted();
  if (limit === 0) return async () => {};
  const id = randomUUID();
  await sql`insert into model_admissions (id, resource, lane, purpose, state, lease_expires_at)
    values (${id}, ${resource}, ${lane}, ${purpose}, 'waiting', now() + interval '30 seconds')`;
  let released: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    void sql`update model_admissions set lease_expires_at = now() + interval '30 seconds' where id = ${id}`.catch(() => {});
  }, 10_000);
  heartbeat.unref();
  const release = () => released ??= (async () => {
    clearInterval(heartbeat);
    await sql`delete from model_admissions where id = ${id}`;
    await sql`select pg_notify('model_admission', ${resource})`;
  })();
  try {
    await sql`select pg_notify('model_admission', ${resource})`;
    for (;;) {
      signal?.throwIfAborted();
      const granted = await sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtext('model_admission:' || ${resource}))`;
        await tx`delete from model_admissions where resource = ${resource} and lease_expires_at <= now()`;
        const [row] = await tx`update model_admissions a set state = 'running', lease_expires_at = now() + interval '30 seconds'
          where a.id = ${id} and
          (select count(*) from model_admissions where resource = ${resource} and state = 'running') < ${limit}
          and not exists (select 1 from model_admissions b where b.resource = a.resource and b.state = 'waiting' and b.id <> a.id
            and ((${lane} = 'background' and b.lane = 'chat') or
              (b.lane = a.lane and (b.created_at, b.id) < (a.created_at, a.id))))
          returning a.id`;
        if (!row) {
          const [exists] = await tx`select id from model_admissions where id = ${id}`;
          if (!exists) throw new Error('model_admission_lease_expired');
        }
        return !!row;
      });
      signal?.throwIfAborted();
      if (granted) return release;
      await delay(200, undefined, { signal });
    }
  } catch (error) {
    await release();
    throw error;
  }
}

export function admissionModel(model: ModelClient, purpose: string, resource: string, limit: number): ModelClient {
  if (limit === 0) return model;
  return { provider: model.provider, modelId: model.modelId, async *stream(request, signal) {
    const signals = [request.signal, signal].filter((s): s is AbortSignal => !!s);
    const combined = signals.length ? AbortSignal.any(signals) : undefined;
    const release = await acquire(resource, admissionLane(purpose), purpose, limit, combined);
    try { yield* model.stream(request, combined); } finally { await release(); }
  } };
}
