import { redis } from '../redis.ts';

type Listener = (message: string) => void;
const listeners = new Map<string, Set<Listener>>();
let subscriber: ReturnType<typeof redis.duplicate> | undefined;
let pending = Promise.resolve();

/** 通知只负责加速；断线期间由调用方的低频读取兜底。 */
export async function subscribe(channel: string, listener: Listener): Promise<() => void> {
  if (!subscriber) {
    subscriber = redis.duplicate({ lazyConnect: true });
    subscriber.on('error', () => {});
    subscriber.on('message', (name, message) => {
      for (const notify of listeners.get(name) ?? []) notify(message);
    });
    redis.once('end', () => subscriber?.disconnect());
  }
  const conn = subscriber;
  const group = listeners.get(channel) ?? new Set<Listener>();
  listeners.set(channel, group);
  group.add(listener);
  pending = pending.then(async () => {
    if (conn.status === 'wait') await conn.connect();
    await conn.subscribe(channel);
  }).catch(() => {});
  await pending;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    group.delete(listener);
    if (group.size) return;
    listeners.delete(channel);
    pending = pending.then(async () => {
      if (!listeners.has(channel)) await conn.unsubscribe(channel);
    }).catch(() => {});
  };
}
