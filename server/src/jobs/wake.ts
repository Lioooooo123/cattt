import { sql } from '../db/client.ts';
import type { JobKind } from '../queue.ts';
import { recoverJobs } from './store.ts';

/** 合并突发通知；扫描中再收到通知时补扫，断线/漏通知由15秒恢复兜底。 */
export async function startJobWakeup(kinds: JobKind[], onScan?: (status: Awaited<ReturnType<typeof recoverJobs>>) => Promise<void>) {
  let stopped=false, dirty=false;
  let running:Promise<void>|undefined;
  const wake=()=>{
    if(stopped)return;
    dirty=true;
    if(running)return;
    running=(async()=>{
      while (dirty && !stopped) {
        dirty = false;
        const status = await recoverJobs(kinds).catch(error => {
          console.error('[agent wake]', error);
          return { dispatchOK: false, overdue: false };
        });
        await onScan?.(status).catch(error => console.error('[agent wake] 写入队列状态失败', error));
      }
    })().finally(()=>{running=undefined;});
  };
  const listener=await sql.listen('cattt_agent_wake',wake,wake);
  const timer=setInterval(wake,15_000);
  wake();
  return async()=>{stopped=true;clearInterval(timer);await listener.unlisten();await running;};
}
