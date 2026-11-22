import { slotSpec, thinkingOptions } from "./config.ts";
import type { ModelConfig, SlotName, SlotSpec } from "./config.ts";
import { createMockModel } from "./mock.ts";
import { mockWorkerModel } from "./worker-mock.ts";
import { createDeepSeek, createOpenAICompatible } from "./openai-compatible.ts";
import type { ModelClient } from "./types.ts";
import type { ToolModel } from "./tool-loop.ts";

export function createSlotModel(config: ModelConfig, slot: SlotName, spec: SlotSpec = slotSpec(config, slot)): ModelClient & ToolModel {
  if (spec.provider === "mock") {
    const text = createMockModel(config.MOCK_DELAY_MS, false, slot === "worker" ? "chat" : slot);
    return { ...text, modelId: spec.model!, ...mockWorkerModel };
  }
  const options = {
    modelId: spec.model, apiKey: spec.apiKey, extraBody: thinkingOptions(spec.provider, config, spec.thinking),
  };
  return spec.provider === "deepseek"
    ? createDeepSeek({ ...options, baseURL: spec.baseURL })
    : createOpenAICompatible({ ...options, baseURL: spec.baseURL ?? config.OPENAI_COMPAT_BASE_URL });
}

export const createChatModel = (config: ModelConfig): ModelClient => createSlotModel(config, "chat");
export const createExtractModel = (config: ModelConfig): ModelClient => createSlotModel(config, "extract");
export function createRouterModel(config: ModelConfig): ModelClient | undefined {
  const spec = slotSpec(config, "router");
  return spec.model ? createSlotModel(config, "router", spec) : undefined;
}
