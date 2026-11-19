import { startFrontendRouter } from './agent/frontend.ts';
import { serve } from '@hono/node-server';
import { createApp } from './api/app.ts';
import { createServer, type Server as HttpsServer } from 'node:https';
import { initializeLan } from './lan-tls.ts';
import { assertModelConfig, config, describeModelConfig } from './config.ts';
import { sql } from './db/client.ts';
import { closeQueues } from './queue.ts';
import { redis } from './redis.ts';
import { drainTurns } from './turns/run.ts';

assertModelConfig();
const stopRouter = await startFrontendRouter();
const identity = await initializeLan();
if (!['127.0.0.1', 'localhost', '::1'].includes(config.HOST)) throw new Error('HOST 必须是回环地址，管理接口不能暴露到局域网');

const server = serve({ fetch: createApp(undefined, identity).fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  console.log(`[api] http://localhost:${info.port}  ${describeModelConfig()}`);
});
const lanServer = config.LAN_HTTPS_PORT ? serve({ fetch: createApp().fetch, hostname: config.LAN_HTTPS_HOST,
  port: config.LAN_HTTPS_PORT, createServer, serverOptions: identity.serverOptions() }) as HttpsServer : undefined;
let refreshing = false;
const timer = setInterval(async () => {
  if (refreshing) return;
  refreshing = true;
  try { if (await identity.refresh()) lanServer?.setSecureContext(identity.serverOptions()); }
  catch (error) { console.error('[api] 更新局域网证书失败', error); }
  finally { refreshing = false; }
}, 60_000);
timer.unref();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[api] 收到退出信号，不再接新请求');
  server.close();
  lanServer?.close();
  clearInterval(timer);
  await drainTurns(20_000);
  await stopRouter();
  await closeQueues();
  redis.disconnect();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
