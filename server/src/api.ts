import { startFrontendRouter } from './agent/frontend.ts';
import { serve } from '@hono/node-server';
import { app } from './api/app.ts';
import { assertModelConfig, config, describeModelConfig } from './config.ts';
import { sql } from './db/client.ts';
import { closeQueues } from './queue.ts';
import { drainTurns } from './turns/run.ts';

assertModelConfig();
const stopRouter = await startFrontendRouter();

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[api] http://localhost:${info.port}  ${describeModelConfig()}`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[api] 收到退出信号，不再接新请求');
  server.close();
  await drainTurns(20_000);
  await stopRouter();
  await closeQueues();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
