import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

// 本机开发从 server/.env 读；已经在环境里的变量优先（部署时靠环境变量，测试时靠它临时切 mock）。
// 环境里的值和 .env 不一样时记下来，启动时提醒，免得被 shell 里的全局变量悄悄盖掉。
let fileValues: Record<string, string | undefined> = {};
try {
  fileValues = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
} catch {
  // 没有 .env 就只用环境变量
}
export const shadowedEnvKeys = Object.keys(fileValues).filter(
  (k) => process.env[k] !== undefined && process.env[k] !== fileValues[k],
);
for (const [k, v] of Object.entries(fileValues)) {
  if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
}

const thinking = z.enum(['enabled', 'disabled']);

const schema = z
  .object({
    APP_ENV: z.enum(['development','staging','production']).default('development'),
    APPLE_CLIENT_ID: z.string().optional(),
    SESSION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    APNS_TEAM_ID: z.string().optional(), APNS_KEY_ID: z.string().optional(),
    APNS_PRIVATE_KEY_FILE: z.string().optional(), APNS_TOPIC: z.string().optional(),
    MODEL_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(120),
    MODEL_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(2000000),
    AGENT_ENABLED: z.enum(['true','false']).default('true'),
    DATABASE_URL: z.string().default('postgres://maomao:maomao@localhost:5432/maomao'),
    PORT: z.coerce.number().int().default(8787),
    MODEL_PROVIDER: z.enum(['deepseek', 'mock']).default('deepseek'),
    /** 带项目前缀，免得被 shell 里全局的 DEEPSEEK_API_KEY 盖掉 */
    MAOMAO_DEEPSEEK_API_KEY: z.string().optional(),
    CHAT_MODEL: z.string().default('deepseek-flash'),
    CHAT_THINKING: thinking.default('disabled'),
    ROUTER_MODEL: z.string().default('deepseek-flash'),
    ROUTER_THINKING: thinking.default('disabled'),
    WORKER_MODEL: z.string().default('deepseek-flash'),
    WORKER_THINKING: thinking.default('enabled'),
    EXTRACT_MODEL: z.string().default('deepseek-flash'),
    EXTRACT_THINKING: thinking.default('disabled'),
    /** 假模型每个字之间停多久，测断线续传时调大 */
    MOCK_DELAY_MS: z.coerce.number().int().default(40),
    MEMORY_RECALL_MODE: z.enum(['hybrid', 'local']).default('hybrid'),
    MEMORY_RECALL_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(2500),
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;

/** api 和 worker 启动时调；建账号之类的脚本用不到模型，不检查 */
export function assertModelConfig() {
  if (config.MODEL_PROVIDER === 'deepseek' && !config.MAOMAO_DEEPSEEK_API_KEY) {
    console.error(
      'MODEL_PROVIDER=deepseek 需要 MAOMAO_DEEPSEEK_API_KEY（填在 server/.env）。没有 key 就先用 MODEL_PROVIDER=mock。',
    );
    process.exit(1);
  }
}

/** 启动日志里的一行：用的哪个模型、哪把 key（只露后 4 位），以及有没有被环境变量盖掉 .env */
export function describeModelConfig(): string {
  const key = config.MAOMAO_DEEPSEEK_API_KEY;
  const model = config.MODEL_PROVIDER === 'mock' ? 'mock' : `deepseek（key …${key?.slice(-4)}）`;
  const shadow =
    shadowedEnvKeys.length > 0 ? `\n  注意：环境变量盖掉了 .env 里的 ${shadowedEnvKeys.join('、')}` : '';
  return `模型：${model}${shadow}`;
}

/** 回复多久没心跳算卡住（生成时每 5 秒一次心跳） */
export const STALE_TURN_MS = 30_000;
/** 回复结束后，续传用的事件在 PG 里留多久 */
export const TURN_EVENTS_TTL_S = 10 * 60;
/** 带进上下文的最近消息条数 */
export const CONTEXT_MESSAGES = 30;
