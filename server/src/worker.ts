import { startJobWakeup } from "./jobs/wake.ts";
import { writeFileSync, unlinkSync } from 'node:fs';
import { scanDailyDiaries, processDailyDiary } from './agent/daily-diary.ts';
import { processErrand } from './agent/executor.ts';
import { scanErrands } from './agent/errands.ts';
import { config, assertModelConfig, describeModelConfig } from './config.ts';
import { sql } from './db/client.ts';
import { closeQueues, startQueueWorkers } from './queue.ts';
import { summarizeBoundary } from './worker/boundary.ts';
import { extractMemories } from './worker/memory.ts';
import { sweepStaleTurns } from './worker/sweep.ts';
import { executeJob, recoverJobs } from './jobs/store.ts';
import { recoveryScanner } from './worker/recovery.ts';
import { readDiary } from './worker/diary.ts';

assertModelConfig();
const kinds = await startQueueWorkers({
  memory: id => executeJob(id, task => extractMemories(task.objectId, task.id)),
  boundary: id => executeJob(id, task => summarizeBoundary(task.objectId, task.id)),
  diary_read: id => executeJob(id, task => readDiary(task.objectId, task.version, task.id)),
  daily_diary: id => executeJob(id,task=>config.AGENT_ENABLED==='true'?processDailyDiary(task.objectId):Promise.resolve({retryAt:new Date(Date.now()+60000)})),
  errand: id => executeJob(id,task=>config.AGENT_ENABLED==='true'?processErrand(task.objectId):Promise.resolve({retryAt:new Date(Date.now()+60000)})),
  sweep: sweepStaleTurns,
});

const stopWake = await startJobWakeup(kinds);
const scan = recoveryScanner(async()=>{}, sweepStaleTurns);
const scanTimer = setInterval(() => void scan().then(()=>writeFileSync('/tmp/cattt-worker-heartbeat','ready')), 15_000);
void scan().then(()=>writeFileSync('/tmp/cattt-worker-heartbeat','ready'));
const followupScan = () => config.AGENT_ENABLED==='false'?Promise.resolve():scanErrands().then(()=>scanDailyDiaries()).then(() => recoverJobs(kinds)).catch(error=>console.error('[followup scan]',error));
const followupTimer = setInterval(() => void followupScan(),30_000);
void followupScan();

console.log(`[worker] 已启动  ${describeModelConfig()}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[worker] 收到退出信号，等手上的任务做完');
  clearInterval(scanTimer);
  clearInterval(followupTimer);
  try{unlinkSync('/tmp/cattt-worker-heartbeat');}catch{}
  await stopWake();
  await closeQueues();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
