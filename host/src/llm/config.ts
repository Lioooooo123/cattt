import { z } from "zod";

const source = z.enum(["openai-compatible", "deepseek"]);
const thinking = z.enum(["enabled", "disabled"]);
const modelName = z.string().trim().min(1).max(255);
const LOCAL_URL = "http://127.0.0.1:11434/v1";
const DEEPSEEK_URL = "https://api.deepseek.com";
const endpoint = z.url().refine((value) => {
  const url = URL.parse(value);
  return !!url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}).transform((value) => new URL(value).href.replace(/\/+$/, ""));
export const isLoopback = (value: string) => ["127.0.0.1", "[::1]", "localhost"].includes(new URL(value).hostname);
const schema = z.object({
  MODEL_PROVIDER: z.enum(["echo", "mock", "openai-compatible", "deepseek"]).default("deepseek"),
  OPENAI_COMPAT_BASE_URL: endpoint.default(LOCAL_URL),
  OPENAI_COMPAT_MODEL: modelName.optional(),
  MAOMAO_OPENAI_COMPAT_API_KEY: z.string().trim().optional(),
  OPENAI_COMPAT_THINKING_PARAM: z.enum(["none", "reasoning_effort", "chat_template_kwargs"]).default("reasoning_effort"),
  MAOMAO_DEEPSEEK_API_KEY: z.string().trim().optional(),
  MAOMAO_DEEPSEEK_BASE_URL: endpoint.refine((url) => isLoopback(url) || url === DEEPSEEK_URL).default(DEEPSEEK_URL),
  CHAT_PROVIDER: source.optional(),
  CHAT_MODEL: modelName.optional(),
  CHAT_THINKING: thinking.default("disabled"),
  ROUTER_PROVIDER: source.optional(),
  ROUTER_MODEL: modelName.optional(),
  ROUTER_THINKING: thinking.default("disabled"),
  WORKER_PROVIDER: source.optional(),
  WORKER_MODEL: modelName.optional(),
  WORKER_THINKING: thinking.default("enabled"),
  EXTRACT_PROVIDER: source.optional(),
  EXTRACT_MODEL: modelName.optional(),
  EXTRACT_BASE_URL: endpoint.optional(),
  MAOMAO_EXTRACT_API_KEY: z.string().trim().optional(),
  EXTRACT_THINKING: thinking.default("disabled"),
  MODEL_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(120),
  MODEL_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(2_000_000),
  MODEL_LOCAL_CONCURRENCY: z.coerce.number().int().min(0).default(1),
  MODEL_CLOUD_CONCURRENCY: z.coerce.number().int().min(0).default(0),
  MODEL_MOCK_CONCURRENCY: z.coerce.number().int().min(0).default(0),
  MOCK_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(40),
});

export type ModelConfig = z.infer<typeof schema>;
const slotKeys = { chat: "CHAT", router: "ROUTER", worker: "WORKER", extract: "EXTRACT" } as const;
export type SlotName = keyof typeof slotKeys;
export type SlotSpec = {
  provider: ModelConfig["MODEL_PROVIDER"];
  model?: string;
  thinking: z.infer<typeof thinking>;
  baseURL?: string;
  apiKey?: string;
};

export function modelConfigFromEnv(env: Record<string, string | undefined>): ModelConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`模型配置无效：${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join("、")}`);
  }
  return result.data;
}

export function slotSpec(config: ModelConfig, slot: SlotName): SlotSpec {
  const key = slotKeys[slot];
  const thinking = config[`${key}_THINKING`];
  const override = config[`${key}_PROVIDER`];
  if (config.MODEL_PROVIDER === "mock") { return { provider: "mock", model: `mock-${slot}`, thinking }; }
  if (config.MODEL_PROVIDER === "echo" && slot === "chat") { return { provider: "echo", thinking }; }

  const global = config.MODEL_PROVIDER;
  const model = config[`${key}_MODEL`];
  const provider = override ?? (slot === "extract" || global === "echo" ? "openai-compatible" : global);
  if (provider === "deepseek") {
    return { provider, model: model ?? "deepseek-flash", thinking,
      baseURL: config.MAOMAO_DEEPSEEK_BASE_URL, apiKey: config.MAOMAO_DEEPSEEK_API_KEY };
  }
  const shared = config.OPENAI_COMPAT_BASE_URL;
  const baseURL = slot === "extract"
    ? config.EXTRACT_BASE_URL ?? (override || isLoopback(shared) ? shared : LOCAL_URL)
    : shared;
  const apiKey = slot === "extract"
    ? config.MAOMAO_EXTRACT_API_KEY ?? (baseURL === shared ? config.MAOMAO_OPENAI_COMPAT_API_KEY : undefined)
    : config.MAOMAO_OPENAI_COMPAT_API_KEY;
  const defaultModel = global === "echo" && slot !== "extract" && !override ? undefined : config.OPENAI_COMPAT_MODEL;
  return { provider, model: model ?? defaultModel, thinking, baseURL, apiKey };
}

export function isConfigured(spec: SlotSpec): boolean {
  return !!spec.model && (spec.provider !== "deepseek" || !!spec.apiKey);
}

function specSummary(config: ModelConfig, slot: SlotName) {
  const { provider, model } = slotSpec(config, slot);
  return { provider, model };
}

export const chatSpec = (config: ModelConfig) => specSummary(config, "chat");
export const routerSpec = (config: ModelConfig) => specSummary(config, "router");
export const extractSpec = (config: ModelConfig) => specSummary(config, "extract");

export function thinkingOptions(provider: string, config: ModelConfig, thinking = config.CHAT_THINKING): Record<string, unknown> {
  if (provider === "deepseek" || provider === "mock") { return { thinking: { type: thinking } }; }
  if (config.OPENAI_COMPAT_THINKING_PARAM === "reasoning_effort") { return thinking === "disabled" ? { reasoning_effort: "none" } : {}; }
  if (config.OPENAI_COMPAT_THINKING_PARAM === "chat_template_kwargs") { return { chat_template_kwargs: { enable_thinking: thinking === "enabled" } }; }
  return {};
}
