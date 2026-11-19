import { budgetModel } from './budget.ts';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { APICallError, LoadAPIKeyError, type LanguageModel, type LanguageModelUsage, RetryError } from 'ai';
import { config } from '../config.ts';
import { db } from '../db/client.ts';
import { modelCalls } from '../db/schema.ts';
import { mockChatModel, mockExtractModel, mockRecallModel, mockDiaryModel, mockRouterModel, mockWorkerModel } from './mock.ts';

/**
 * 模型适配层。业务代码只拿 model + providerOptions，不关心是哪家。
 * DeepSeek V4.1 Flash 默认开思考，聊天必须显式关掉，否则首字要等思考结束。
 */
const deepseek = createDeepSeek({ apiKey: config.MAOMAO_DEEPSEEK_API_KEY });

export type ModelSlot = {
  model: LanguageModel;
  modelId: string;
  providerOptions: { deepseek: { thinking: { type: 'enabled' | 'disabled' } } };
};

export function chatSlot(purpose = 'chat'): ModelSlot {
  return {
    model: budgetModel(config.MODEL_PROVIDER === 'mock' ? mockChatModel() : deepseek(config.CHAT_MODEL),purpose),
    modelId: config.MODEL_PROVIDER === 'mock' ? 'mock-chat' : config.CHAT_MODEL,
    providerOptions: { deepseek: { thinking: { type: config.CHAT_THINKING } } },
  };
}

export function extractSlot(purpose = 'memory_extract'): ModelSlot {
  return {
    model: budgetModel(config.MODEL_PROVIDER === 'mock' ? mockExtractModel() : deepseek(config.EXTRACT_MODEL),purpose),
    modelId: config.MODEL_PROVIDER === 'mock' ? 'mock-extract' : config.EXTRACT_MODEL,
    providerOptions: { deepseek: { thinking: { type: config.EXTRACT_THINKING } } },
  };
}

export type ModelErrorInfo = { code: string; retryable: boolean; summary: string };

/**
 * 模型出错分两类：限流、超时、服务端 5xx 可以重试；
 * 余额不足、key 不对、请求格式错，重试也没用，要告诉客户端别让用户一直点「再试一次」。
 */
export function classifyModelError(err: unknown): ModelErrorInfo {
  if(err instanceof Error&&err.name==='ModelBudgetExceeded')return {code:'model_daily_budget',retryable:false,summary:'今天先歇一会儿，明天再聊。'};
  const e = RetryError.isInstance(err) ? err.lastError : err;
  if (LoadAPIKeyError.isInstance(e)) return { code: 'model_auth', retryable: false, summary: '模型尚未配置，请在电脑端填写模型密钥。' };
  if(e instanceof Error&&e.message.startsWith('model_input_budget:'))return {code:'model_input_budget',retryable:false,summary:'这次需要的内容太长，请缩小问题后再试。'};
  if(e instanceof Error&&e.name==='ModelBudgetExceeded')return {code:'model_daily_budget',retryable:false,summary:'今天先歇一会儿，明天再聊。'};
  if (APICallError.isInstance(e)) {
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
  usage: LanguageModelUsage | null;
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
    cacheReadTokens: entry.usage?.inputTokenDetails.cacheReadTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    reasoningTokens: entry.usage?.outputTokenDetails.reasoningTokens ?? null,
    latencyMs: entry.latencyMs,
  });
}

/** 查询扩词独立用途，mock 也独立，避免误走记忆写入提取。 */
export function recallSlot(): ModelSlot {
  const slot = extractSlot('memory_recall');
  return config.MODEL_PROVIDER === 'mock' ? { ...slot, model: budgetModel(mockRecallModel(),'memory_recall'), modelId: 'mock-recall' } : slot;
}

export function diarySlot(): ModelSlot {
  const slot = chatSlot('diary_read');
  return config.MODEL_PROVIDER === 'mock' ? { ...slot, model: budgetModel(mockDiaryModel(),'diary_read'), modelId: 'mock-diary' } : slot;
}

export function routerSlot(): ModelSlot {
  return { model:budgetModel(config.MODEL_PROVIDER === 'mock' ? mockRouterModel() : deepseek(config.ROUTER_MODEL),'route'),
    modelId:config.MODEL_PROVIDER === 'mock' ? 'mock-router' : config.ROUTER_MODEL,
    providerOptions:{deepseek:{thinking:{type:config.ROUTER_THINKING}}} };
}

export function workerSlot(purpose = 'errand'): ModelSlot {
 return {model:budgetModel(config.MODEL_PROVIDER==='mock'?mockWorkerModel():deepseek(config.WORKER_MODEL),purpose),
 modelId:config.MODEL_PROVIDER==='mock'?'mock-worker':config.WORKER_MODEL,
 providerOptions:{deepseek:{thinking:{type:config.WORKER_THINKING}}}};
}
