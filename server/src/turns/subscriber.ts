import { sql } from '../db/client.ts';

type Listener = (message: string) => void;
const listeners = new Map<string, Set<Listener>>();
let pending: Promise<unknown> | undefined;

/** 固定频道避免标识符长度限制；逻辑频道共享一条专用连接。 */
export async function subscribe(channel: string, listener: Listener): Promise<() => void> {
  const group = listeners.get(channel) ?? new Set<Listener>();
  listeners.set(channel, group);
  group.add(listener);
  pending ??= sql.listen('turn_updates', payload => {
    try {
      const { channel, message } = JSON.parse(payload);
      for (const notify of listeners.get(channel) ?? []) notify(message);
    } catch {}
  }).catch(error => { pending = undefined; throw error; });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
  } catch { /* 定时读取兜底 */ }
  finally { clearTimeout(timer); }
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    group.delete(listener);
    if (!group.size && listeners.get(channel) === group) listeners.delete(channel);
  };
}
