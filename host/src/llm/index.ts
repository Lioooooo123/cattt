import { chatSpec, thinkingOptions } from "./config.ts";
import type { ModelConfig } from "./config.ts";
import { createMockModel } from "./mock.ts";
import { createDeepSeek, createOpenAICompatible } from "./openai-compatible.ts";
import type { ModelClient } from "./types.ts";

export function createChatModel(config: ModelConfig): ModelClient {
  const { provider, model } = chatSpec(config);
  if (provider === "mock") { return createMockModel(config.MOCK_DELAY_MS); }
  const extraBody = thinkingOptions(provider, config);
  return provider === "deepseek"
    ? createDeepSeek({ modelId: model, apiKey: config.MAOMAO_DEEPSEEK_API_KEY, extraBody })
    : createOpenAICompatible({ modelId: model, baseURL: config.OPENAI_COMPAT_BASE_URL, apiKey: config.MAOMAO_OPENAI_COMPAT_API_KEY, extraBody });
}
