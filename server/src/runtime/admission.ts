import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
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

export function admissionModel(model: LanguageModel, purpose: string, resource: string, limit: number): LanguageModel {
  if (limit === 0) return model;
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params }) => {
      const release = await acquire(resource, admissionLane(purpose), purpose, limit, params.abortSignal);
      try { return await doGenerate(); } finally { await release(); }
    },
    wrapStream: async ({ doStream, params }) => {
      const release = await acquire(resource, admissionLane(purpose), purpose, limit, params.abortSignal);
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        return { ...result, stream: new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { await release(); controller.close(); }
              else { if (next.value.type === 'error') await release(); controller.enqueue(next.value); }
            } catch (error) { await release(); controller.error(error); }
          },
          async cancel(reason) { try { await reader.cancel(reason); } finally { await release(); } },
        }, { highWaterMark: 0 }) };
      } catch (error) { await release(); throw error; }
    },
  };
  return wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]['model'], middleware });
}
