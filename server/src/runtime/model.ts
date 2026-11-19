import { budgetModel } from './budget.ts';
import { admissionModel } from './admission.ts';
import { createDeepSeek, createOpenAICompatible, ModelHttpError, ModelAuthError, type ModelClient, type ModelUsage } from '../llm/index.ts';
import { config, slotSpec, slotAdmission, type SlotSpec } from '../config.ts';
import { db } from '../db/client.ts';
import { modelCalls } from '../db/schema.ts';
import { mockChatModel, mockExtractModel, mockRecallModel, mockDiaryModel, mockRouterModel, mockWorkerModel } from './mock.ts';

/**
 * 模型适配层。业务代码只拿 client + extraBody，不关心是哪家。
 * 来源：OpenAI 兼容（本机 Ollama / LM Studio / llama.cpp server，或自带 key 的兼容云服务）、DeepSeek（自带 key）、mock。
 * DeepSeek V4.1 Flash 默认开思考，聊天必须显式关掉，否则首字要等思考结束；本机推理模型同理。
 */
export type Thinking = 'enabled' | 'disabled';
export type ModelSlot = {
  client: ModelClient;
  modelId: string;
  thinking: Thinking;
  extraBody: Record<string, unknown>;
};

/** 各来源开关思考的请求参数。兼容来源里没开思考的模型会忽略这些字段。 */
export function thinkingOptions(provider: SlotSpec['provider'], thinking: Thinking,
  param: typeof config.OPENAI_COMPAT_THINKING_PARAM = config.OPENAI_COMPAT_THINKING_PARAM): Record<string, unknown> {
  if (provider === 'deepseek' || provider === 'mock') return { thinking: { type: thinking } };
  // 开思考时不传，交给模型自己的默认；关时显式关掉，首字才快
  if (param === 'reasoning_effort') return thinking === 'disabled' ? { reasoning_effort: 'none' } : {};
  if (param === 'chat_template_kwargs') return { chat_template_kwargs: { enable_thinking: thinking === 'enabled' } };
  return {};
}

const mocks = { chat: mockChatModel, extract: mockExtractModel, router: mockRouterModel, worker: mockWorkerModel };

export function slotFrom(spec: SlotSpec, purpose: string, thinking: Thinking = spec.thinking): ModelSlot {
  const base = spec.provider === 'mock' ? mocks[spec.name]()
    : spec.provider === 'deepseek' ? createDeepSeek({ modelId: spec.model!, apiKey: config.MAOMAO_DEEPSEEK_API_KEY }) : createOpenAICompatible({ modelId: spec.model!, baseURL: config.OPENAI_COMPAT_BASE_URL, apiKey: config.MAOMAO_OPENAI_COMPAT_API_KEY });
  return { client: wrapSlotModel(base, spec, purpose), modelId: spec.model!, thinking, extraBody: thinkingOptions(spec.provider, thinking) };
}

function wrapSlotModel(model: ModelClient, spec: SlotSpec, purpose: string): ModelClient {
  const { resource, limit } = slotAdmission(spec);
  return admissionModel(budgetModel(model, purpose), purpose, resource, limit);
}

export function chatSlot(purpose = 'chat'): ModelSlot {
  return slotFrom(slotSpec('chat'), purpose);
}

export function extractSlot(purpose = 'memory_extract'): ModelSlot {
  return slotFrom(slotSpec('extract'), purpose);
}

export type ModelErrorInfo = { code: string; retryable: boolean; summary: string };

/**
 * 模型出错分两类：限流、超时、服务端 5xx 可以重试；
 * 余额不足、key 不对、请求格式错，重试也没用，要告诉客户端别让用户一直点「再试一次」。
 */
export function classifyModelError(err: unknown): ModelErrorInfo {
  if(err instanceof Error&&err.name==='ModelBudgetExceeded')return {code:'model_daily_budget',retryable:false,summary:'今天先歇一会儿，明天再聊。'};
  const e = err && typeof err === 'object' && 'lastError' in err ? err.lastError : err;
  if (ModelAuthError.isInstance(e)) return { code: 'model_auth', retryable: false, summary: '模型尚未配置，请在电脑端填写模型密钥。' };
  if(e instanceof Error&&e.message.startsWith('model_input_budget:'))return {code:'model_input_budget',retryable:false,summary:'这次需要的内容太长，请缩小问题后再试。'};
  if(e instanceof Error&&e.name==='ModelBudgetExceeded')return {code:'model_daily_budget',retryable:false,summary:'今天先歇一会儿，明天再聊。'};
  if (ModelHttpError.isInstance(e)) {
    const summary = `${e.statusCode ?? '?'} ${e.message}`;
    switch (e.statusCode) {
      case 402:
        return { code: 'model_quota', retryable: false, summary };
      case 401:
      case 403:
        return { code: 'model_auth', retryable: false, summary };
      case 400:
      case 422:
        return { code: 'model_bad_request', retryable: false, summary };
      default:
        return { code: 'model_error', retryable: true, summary };
    }
  }
  return { code: 'model_error', retryable: true, summary: e instanceof Error ? e.message : String(e) };
}

/** 成本账本：每次模型调用记一行，按用途分 */
export async function recordModelCall(entry: {
  purpose: 'errand' | 'route' | 'chat' | 'memory_extract' | 'boundary_summarize' | 'cat_diary' | 'memory_recall' | 'diary_read';
  modelId: string;
  usage: ModelUsage | null;
  latencyMs: number;
  turnId?: string;
  jobId?: string;
}) {
  await db.insert(modelCalls).values({
    purpose: entry.purpose,
    model: entry.modelId,
    turnId: entry.turnId,
    jobId: entry.jobId,
    inputTokens: entry.usage?.inputTokens ?? null,
    cacheReadTokens: entry.usage?.cacheReadTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    reasoningTokens: entry.usage?.reasoningTokens ?? null,
    latencyMs: entry.latencyMs,
  });
}

/** 查询扩词独立用途，mock 也独立，避免误走记忆写入提取；扩词要快，总是关思考。 */
export function recallSlot(): ModelSlot {
  const slot = slotFrom(slotSpec('extract'), 'memory_recall', 'disabled');
  return config.MODEL_PROVIDER === 'mock' ? { ...slot, client: wrapSlotModel(mockRecallModel(), slotSpec('extract'), 'memory_recall'), modelId: 'mock-recall' } : slot;
}

export function diarySlot(): ModelSlot {
  const slot = extractSlot('diary_read');
  return config.MODEL_PROVIDER === 'mock' ? { ...slot, client: wrapSlotModel(mockDiaryModel(), slotSpec('extract'), 'diary_read'), modelId: 'mock-diary' } : slot;
}

export function catDiarySlot(writer: 'chat' | 'worker'): ModelSlot {
  const spec = slotSpec(config.MODEL_PROVIDER === 'mock' ? writer : 'extract');
  return slotFrom(spec, 'cat_diary', writer === 'worker' ? config.WORKER_THINKING : config.CHAT_THINKING);
}

export function routerSlot(): ModelSlot {
  return slotFrom(slotSpec('router'), 'route');
}

export function workerSlot(purpose = 'errand'): ModelSlot {
  return slotFrom(slotSpec('worker'), purpose);
}
