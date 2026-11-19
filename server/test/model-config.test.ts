import { afterEach, expect, test, vi } from 'vitest';
import { createDeepSeek, generateText, ModelAuthError, ModelHttpError } from '../src/llm/index.ts';
import { assertModelConfig, config, describeModelConfig, slotAdmission, slotSpec } from '../src/config.ts';
import { classifyModelError } from '../src/runtime/model.ts';
import { ModelBudgetExceeded } from '../src/runtime/budget.ts';

const original = { provider: config.MODEL_PROVIDER, key: config.MAOMAO_DEEPSEEK_API_KEY };
test.each([
  [402, 'model_quota', false], [401, 'model_auth', false], [403, 'model_auth', false],
  [400, 'model_bad_request', false], [422, 'model_bad_request', false],
  [408, 'model_error', true], [429, 'model_error', true], [503, 'model_error', true],
])('HTTP %s 保持原有错误分类与摘要', (status, code, retryable) => {
  const error=new ModelHttpError(status as number,'供应商拒绝','');
  expect(classifyModelError(error)).toEqual({code,retryable,summary:`${status} 供应商拒绝`});
  expect(classifyModelError({lastError:error})).toEqual(classifyModelError(error));
});
test('额度和输入预算的中文提示保持不变', () => {
  expect(classifyModelError(new ModelBudgetExceeded())).toEqual({code:'model_daily_budget',retryable:false,summary:'今天先歇一会儿，明天再聊。'});
  expect(classifyModelError(new Error('model_input_budget: 太长'))).toEqual({code:'model_input_budget',retryable:false,summary:'这次需要的内容太长，请缩小问题后再试。'});
});
test('准入按来源共享资源，不按槽位或模型拆分', () => {
  const c = { OPENAI_COMPAT_BASE_URL: 'http://localhost:11434/v1', MODEL_LOCAL_CONCURRENCY: 1, MODEL_CLOUD_CONCURRENCY: 3, MODEL_MOCK_CONCURRENCY: 0 };
  const spec = slotSpec('chat');
  expect(slotAdmission({ ...spec, provider: 'openai-compatible' }, c)).toEqual({ resource: 'openai-compatible:http://localhost:11434/v1', limit: 1 });
  expect(slotAdmission({ ...spec, name: 'worker', model: 'another', provider: 'openai-compatible' }, c)).toEqual(slotAdmission({ ...spec, provider: 'openai-compatible' }, c));
  expect(slotAdmission({ ...spec, provider: 'deepseek' }, c)).toEqual({ resource: 'deepseek', limit: 3 });
  expect(slotAdmission({ ...spec, provider: 'mock' }, c)).toEqual({ resource: 'mock', limit: 0 });
});
afterEach(() => {
  config.MODEL_PROVIDER = original.provider;
  config.MAOMAO_DEEPSEEK_API_KEY = original.key;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('缺少密钥只警告，不阻止启动', () => {
  config.MODEL_PROVIDER = 'deepseek';
  config.MAOMAO_DEEPSEEK_API_KEY = undefined;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected exit'); });
  expect(() => assertModelConfig()).not.toThrow();
  expect(exit).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
  expect(describeModelConfig()).toContain('未配置');
});

test('有密钥或使用 mock 时不警告', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  config.MODEL_PROVIDER = 'deepseek';
  config.MAOMAO_DEEPSEEK_API_KEY = 'test-key';
  assertModelConfig();
  config.MODEL_PROVIDER = 'mock';
  config.MAOMAO_DEEPSEEK_API_KEY = undefined;
  assertModelConfig();
  expect(warn).not.toHaveBeenCalled();
});

test('模型客户端的缺密钥错误不重试且提示配置', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', undefined);
  let error: unknown;
  try {
    await generateText(createDeepSeek({ modelId: 'deepseek-flash' }), { messages: [{ role: 'user', content: 'hello' }] }, { maxRetries: 0 });
  } catch (caught) { error = caught; }
  expect(ModelAuthError.isInstance(error)).toBe(true);
  expect(classifyModelError(error)).toEqual({ code: 'model_auth', retryable: false, summary: '模型尚未配置，请在电脑端填写模型密钥。' });
});
