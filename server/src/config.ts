import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

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
/** 真实模型来源；mock 只能全局打开（测试、没有模型时用），不能给单个槽位 */
export const modelSources = ['openai-compatible', 'deepseek'] as const;
const source = z.enum(modelSources);

const schema = z
  .object({
    APP_ENV: z.enum(['development','staging','production']).default('development'),
    REMOTE_PUSH_ENABLED: z.enum(['true','false']).default('false'),
    APNS_TEAM_ID: z.string().optional(), APNS_KEY_ID: z.string().optional(),
    APNS_PRIVATE_KEY_FILE: z.string().optional(), APNS_TOPIC: z.string().optional(),
    MODEL_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(120),
    MODEL_LOCAL_CONCURRENCY: z.coerce.number().int().min(0).default(1),
    MODEL_CLOUD_CONCURRENCY: z.coerce.number().int().min(0).default(0),
    MODEL_MOCK_CONCURRENCY: z.coerce.number().int().min(0).default(0),
    MODEL_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(2000000),
    AGENT_ENABLED: z.enum(['true','false']).default('true'),
    DATABASE_URL: z.string().default('postgres://maomao:maomao@localhost:5432/maomao'),
    PORT: z.coerce.number().int().default(8787),
    HOST: z.string().default('127.0.0.1'),
    LAN_HTTPS_HOST: z.string().default('0.0.0.0'),
    LAN_HTTPS_PORT: z.coerce.number().int().min(0).max(65535).default(8788),
    CATTT_DATA_DIR: z.string().default(fileURLToPath(new URL('../.local', import.meta.url))),
    CATTT_DIARY_SYNC_EPOCH: z.string().min(1).max(64).optional(),
    CATTT_WORKER_HEALTH_FILE: z.string().min(1).optional(),
    /** 默认来源；每个槽位可用 CHAT_PROVIDER 等单独改。mock 时全部槽位都用假模型 */
    MODEL_PROVIDER: z.enum([...modelSources, 'mock']).default('openai-compatible'),
    /** 本机 OpenAI 兼容服务（Ollama / LM Studio / llama.cpp server 等）；默认 Ollama */
    OPENAI_COMPAT_BASE_URL: z.url().default('http://127.0.0.1:11434/v1'),
    /** 本机服务一般不要 key；自带 key 的兼容云服务才填 */
    MAOMAO_OPENAI_COMPAT_API_KEY: z.string().optional(),
    /** 兼容来源各槽位的默认模型名，槽位的 *_MODEL 优先 */
    OPENAI_COMPAT_MODEL: z.string().optional(),
    /** 兼容来源怎么开关思考：不传 / reasoning_effort（Ollama 等）/ chat_template_kwargs.enable_thinking（llama.cpp、vLLM） */
    OPENAI_COMPAT_THINKING_PARAM: z.enum(['none', 'reasoning_effort', 'chat_template_kwargs']).default('reasoning_effort'),
    /** 带项目前缀，免得被 shell 里全局的 DEEPSEEK_API_KEY 盖掉 */
    MAOMAO_DEEPSEEK_API_KEY: z.string().optional(),
    CHAT_PROVIDER: source.optional(),
    CHAT_MODEL: z.string().optional(),
    CHAT_THINKING: thinking.default('disabled'),
    ROUTER_PROVIDER: source.optional(),
    ROUTER_MODEL: z.string().optional(),
    ROUTER_THINKING: thinking.default('disabled'),
    WORKER_PROVIDER: source.optional(),
    WORKER_MODEL: z.string().optional(),
    WORKER_THINKING: thinking.default('enabled'),
    EXTRACT_PROVIDER: source.optional(),
    EXTRACT_MODEL: z.string().optional(),
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

export type ModelSource = (typeof modelSources)[number];
export type SlotName = 'chat' | 'extract' | 'router' | 'worker';
export type SlotSpec = { name: SlotName; provider: ModelSource | 'mock'; model: string | undefined; thinking: 'enabled' | 'disabled' };
type ModelConfig = Pick<typeof config, 'MODEL_PROVIDER' | 'OPENAI_COMPAT_MODEL' | `${'CHAT' | 'EXTRACT' | 'ROUTER' | 'WORKER'}_${'PROVIDER' | 'MODEL' | 'THINKING'}`>;
const slotKeys = { chat: 'CHAT', extract: 'EXTRACT', router: 'ROUTER', worker: 'WORKER' } as const;
export const slotNames = Object.keys(slotKeys) as SlotName[];

export function slotAdmission(spec: SlotSpec, c: Pick<typeof config, 'OPENAI_COMPAT_BASE_URL' | 'MODEL_LOCAL_CONCURRENCY' | 'MODEL_CLOUD_CONCURRENCY' | 'MODEL_MOCK_CONCURRENCY'> = config) {
  if (spec.provider === 'openai-compatible') return { resource: `openai-compatible:${c.OPENAI_COMPAT_BASE_URL}`, limit: c.MODEL_LOCAL_CONCURRENCY };
  return { resource: spec.provider, limit: spec.provider === 'deepseek' ? c.MODEL_CLOUD_CONCURRENCY : c.MODEL_MOCK_CONCURRENCY };
}

/** 槽位的来源与模型名：槽位自己的设置优先，其次全局默认；DeepSeek 默认 deepseek-flash，兼容来源默认 OPENAI_COMPAT_MODEL */
export function slotSpec(name: SlotName, c: ModelConfig = config): SlotSpec {
  const k = slotKeys[name];
  const thinking = c[`${k}_THINKING`];
  if (c.MODEL_PROVIDER === 'mock') return { name, provider: 'mock', model: `mock-${name}`, thinking };
  const provider = c[`${k}_PROVIDER`] ?? c.MODEL_PROVIDER;
  const model = c[`${k}_MODEL`] ?? (provider === 'deepseek' ? 'deepseek-flash' : c.OPENAI_COMPAT_MODEL);
  return { name, provider, model, thinking };
}

/** 配置有问题时返回一句中文说明；没问题返回空数组 */
export function modelConfigProblems(c: ModelConfig & Pick<typeof config, 'MAOMAO_DEEPSEEK_API_KEY'> = config): string[] {
  const problems: string[] = [];
  const specs = slotNames.map(name => slotSpec(name, c));
  if (specs.some(s => s.provider === 'deepseek') && !c.MAOMAO_DEEPSEEK_API_KEY)
    problems.push('用到 DeepSeek 的槽位需要 MAOMAO_DEEPSEEK_API_KEY（填在 server/.env）。');
  const unnamed = specs.filter(s => s.provider === 'openai-compatible' && !s.model).map(s => `${slotKeys[s.name]}_MODEL`);
  if (unnamed.length) problems.push(`OpenAI 兼容来源需要模型名：填 OPENAI_COMPAT_MODEL（全部槽位共用），或单独填 ${unnamed.join('、')}。`);
  return problems;
}

/** 模型配置不阻断 API、配对和后台服务启动；有问题只提示，模型调用时再报未配置 */
export function assertModelConfig() {
  const problems = modelConfigProblems();
  if (problems.length) {
    console.warn(['模型：未配置。', ...problems, '模型调用暂不可用，其他服务继续运行。'].join('\n'));
  }
}

/** 启动日志里的一行：每个槽位用的哪个来源和模型、哪把 key（只露后 4 位），以及有没有被环境变量盖掉 .env */
export function describeModelConfig(): string {
  let model: string;
  if (config.MODEL_PROVIDER === 'mock') model = 'mock';
  else {
    const where = (p: ModelSource) => p === 'deepseek'
      ? (config.MAOMAO_DEEPSEEK_API_KEY ? `deepseek（key …${config.MAOMAO_DEEPSEEK_API_KEY.slice(-4)}）` : 'deepseek（key 未配置）')
      : `${config.OPENAI_COMPAT_BASE_URL}`;
    model = slotNames.map(name => { const s = slotSpec(name); return `${name}=${s.model ?? '未配置'}@${where(s.provider as ModelSource)}`; }).join('，');
  }
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
