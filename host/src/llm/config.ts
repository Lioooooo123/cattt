import { z } from "zod";

const source = z.enum(["openai-compatible", "deepseek"]);
const schema = z.object({
  MODEL_PROVIDER: z.enum(["echo", "mock", "openai-compatible", "deepseek"]).default("echo"),
  OPENAI_COMPAT_BASE_URL: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }).default("http://127.0.0.1:11434/v1"),
  OPENAI_COMPAT_MODEL: z.string().trim().min(1).optional(),
  MAOMAO_OPENAI_COMPAT_API_KEY: z.string().optional(),
  OPENAI_COMPAT_THINKING_PARAM: z.enum(["none", "reasoning_effort", "chat_template_kwargs"]).default("reasoning_effort"),
  MAOMAO_DEEPSEEK_API_KEY: z.string().optional(),
  CHAT_PROVIDER: source.optional(),
  CHAT_MODEL: z.string().trim().min(1).optional(),
  CHAT_THINKING: z.enum(["enabled", "disabled"]).default("disabled"),
  MOCK_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(40),
});

export type ModelConfig = z.infer<typeof schema>;

export function modelConfigFromEnv(env: Record<string, string | undefined>): ModelConfig {
  const result = schema.safeParse(env.MODEL_PROVIDER === undefined || env.MODEL_PROVIDER === "echo" ? { MODEL_PROVIDER: "echo" } : env);
  if (!result.success) {
    throw new Error(`模型配置无效：${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join("、")}`);
  }
  return result.data;
}

export function chatSpec(config: ModelConfig) {
  const provider = config.MODEL_PROVIDER === "mock" ? "mock" : config.CHAT_PROVIDER ?? config.MODEL_PROVIDER;
  const model = provider === "mock" ? "mock-chat" : config.CHAT_MODEL ?? (provider === "deepseek" ? "deepseek-flash" : config.OPENAI_COMPAT_MODEL);
  return { provider, model };
}

export function thinkingOptions(provider: string, config: ModelConfig): Record<string, unknown> {
  const thinking = config.CHAT_THINKING;
  if (provider === "deepseek" || provider === "mock") { return { thinking: { type: thinking } }; }
  if (config.OPENAI_COMPAT_THINKING_PARAM === "reasoning_effort") { return thinking === "disabled" ? { reasoning_effort: "none" } : {}; }
  if (config.OPENAI_COMPAT_THINKING_PARAM === "chat_template_kwargs") { return { chat_template_kwargs: { enable_thinking: thinking === "enabled" } }; }
  return {};
}
