/** 真实模型连通检查：仅发送固定测试文字，不读取账号或日记数据。失败以非零状态退出。 */
import { ModelHttpError, generateText } from '../src/llm/index.ts';
import { config, modelConfigProblems, slotNames, slotSpec } from '../src/config.ts';
import { slotFrom } from '../src/runtime/model.ts';

async function checkDeepSeekBalance(key: string) {
  if (key !== key.trim() || /\s/.test(key)) return { connected: false, code: 'model_key_format' };
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return { connected: false, authentication: 'failed', status: response.status,
      code: [401, 403].includes(response.status) ? 'model_auth' : 'model_balance_check_failed' };
  }
  const balance: unknown = await response.json();
  if (typeof balance !== 'object' || balance === null || !('is_available' in balance) || typeof balance.is_available !== 'boolean') {
    return { connected: false, authentication: 'passed', code: 'model_balance_response_invalid' };
  }
  if (!balance.is_available) {
    return { connected: false, authentication: 'passed', generation: 'not_attempted', code: 'model_quota',
      detail: '密钥认证通过，账户余额不足；补充余额后重新运行。' };
  }
  return null;
}

/** 本机服务先确认能连上、模型已下载，免得把“没装模型”报成生成失败。 */
async function checkOpenAICompatibleModels(models: string[]) {
  let response: Response;
  try {
    response = await fetch(`${config.OPENAI_COMPAT_BASE_URL.replace(/\/$/, '')}/models`, {
      headers: config.MAOMAO_OPENAI_COMPAT_API_KEY ? { Authorization: `Bearer ${config.MAOMAO_OPENAI_COMPAT_API_KEY}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { connected: false, code: 'model_server_unreachable', baseURL: config.OPENAI_COMPAT_BASE_URL,
      detail: '连不上 OpenAI 兼容服务；确认 Ollama / LM Studio / llama.cpp server 已启动，OPENAI_COMPAT_BASE_URL 指向它的 /v1。' };
  }
  if (!response.ok) return { connected: false, status: response.status, baseURL: config.OPENAI_COMPAT_BASE_URL,
    code: [401, 403].includes(response.status) ? 'model_auth' : 'model_list_failed' };
  const body = await response.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
  const available = new Set((body?.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string'));
  // 有的服务（llama.cpp 单模型）只列出一个别名；列表为空或对不上时只提示，仍以真实生成为准。
  const missing = available.size ? models.filter(m => !available.has(m)) : [];
  return { missing };
}

async function check() {
  if (config.MODEL_PROVIDER === 'mock') {
    return { connected: false, code: 'real_provider_required', detail: '请使用 MODEL_PROVIDER=openai-compatible 或 deepseek，检查不会回退到模拟模型。' };
  }
  const problems = modelConfigProblems();
  if (problems.length) return { connected: false, code: 'model_config_invalid', detail: problems.join(' ') };

  // 不同槽位可能用不同来源与模型；相同的只验证一次。
  const specs = slotNames.map(name => slotSpec(name))
    .filter((s, i, all) => all.findIndex(o => o.provider === s.provider && o.model === s.model && o.thinking === s.thinking) === i);
  const warnings: string[] = [];
  if (specs.some(s => s.provider === 'deepseek')) {
    const failed = await checkDeepSeekBalance(config.MAOMAO_DEEPSEEK_API_KEY!);
    if (failed) return failed;
  }
  const compat = [...new Set(specs.filter(s => s.provider === 'openai-compatible').map(s => s.model!))];
  if (compat.length) {
    const listed = await checkOpenAICompatibleModels(compat);
    if ('connected' in listed) return listed;
    if (listed.missing.length) warnings.push(`服务的模型列表里没有 ${listed.missing.join('、')}（Ollama 先 ollama pull）`);
  }
  for (const spec of specs) {
    const slot = slotFrom(spec, 'check');
    try {
      const result = await generateText(slot.client, {
        messages: [{ role: 'user', content: '连接测试：只回复 OK。' }], extraBody: slot.extraBody,
        // 本机推理模型开思考时会先想一段，给够长度
        maxOutputTokens: spec.thinking === 'enabled' ? 1024 : 64, signal: AbortSignal.timeout(spec.provider === 'deepseek' ? 15_000 : 120_000),
      }, { maxRetries: 0 });
      if (!/^ok[.!。！]?$/i.test(result.text.trim())) return { connected: false, authentication: 'passed', provider: spec.provider, model: spec.model, code: 'model_unexpected_reply' };
    } catch (error) {
      const status = ModelHttpError.isInstance(error) ? error.statusCode : undefined;
      return { connected: false, provider: spec.provider, model: spec.model, status, warnings,
        code: status === 402 ? 'model_quota' : [401, 403].includes(status ?? 0) ? 'model_auth' : status === 404 ? 'model_not_found' : 'model_generation_failed' };
    }
  }
  return { connected: true, slots: Object.fromEntries(slotNames.map(n => { const s = slotSpec(n); return [n, `${s.provider}:${s.model}`]; })),
    ...(warnings.length ? { warnings } : {}),
    scope: '仅验证固定文字生成，不代表记忆召回、日记读取或自然表达验收通过。' };
}

try {
  const result = await check();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.connected ? 0 : 1;
} catch {
  // 不输出原始异常，避免供应商错误携带请求头或密钥。
  console.log(JSON.stringify({ connected: false, code: 'model_check_unavailable', detail: '网络或模型服务检查失败，请稍后重试。' }));
  process.exitCode = 1;
}
