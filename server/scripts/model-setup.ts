import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from '../src/config.ts';
import { detectHardware, recommendModel, smallerModel } from '../src/runtime/hardware.ts';
import { pullModel, smokeModel, updateModelEnv } from '../src/runtime/model-setup.ts';

let json = false;
const emit = (event: string, data: object) => console.log(json ? JSON.stringify({ event, ...data }) : `${event}：${JSON.stringify(data)}`);
try {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const { values } = parseArgs({ args, options: { yes: { type: 'boolean' }, json: { type: 'boolean' }, model: { type: 'string' }, 'env-file': { type: 'string' } } });
  json = !!values.json;
  const hardware = detectHardware();
  const recommendation = recommendModel(hardware);
  const model = values.model ?? (recommendation.kind === 'local' ? recommendation.model : undefined);
  if (model && !/^[\w.:/-]+$/.test(model)) throw new Error('模型标签格式不正确');
  emit('硬件与推荐', { hardware, recommendation, selectedModel: model });
  let consent = !!values.yes;
  if (model && !consent && !json && stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    try { consent = /^y(?:es)?$/i.test((await rl.question(`下载并测试 ${model}？[y/N] `)).trim()); }
    finally { rl.close(); }
  }
  if (!model || !consent) emit('已停止', { reason: model ? '未获同意，没有下载或修改配置。' : recommendation.reason });
  else {
    const base = config.OPENAI_COMPAT_BASE_URL.replace(/\/+$/, '');
    const native = base.replace(/\/v1$/, '');
    const key = config.MAOMAO_OPENAI_COMPAT_API_KEY;
    let reachable = false;
    try { reachable = (await fetch(`${native}/api/tags`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(5000) })).ok; } catch { /* 下面给安装说明 */ }
    if (!reachable) {
      emit('连接失败', { reason: '请从 https://ollama.com/download 安装 Ollama 并启动（ollama serve），确认 OPENAI_COMPAT_BASE_URL 指向它的 /v1。Linux 可运行 curl -fsSL https://ollama.com/install.sh | sh。' });
      process.exitCode = 1;
    } else {
      await pullModel(native, model, progress => emit('下载进度', { progress }), key);
      const smoke = await smokeModel(base, model, fetch, key);
      emit('烟测', { model, ...smoke });
      if (!smoke.passed) {
        emit('未通过', { reason: '中文陪伴回复或工具调用烟测失败，未写配置。', suggestion: smallerModel(model) ? `可另行同意尝试 --model ${smallerModel(model)}` : '可尝试更小模型或填自己的 DeepSeek key。' });
        process.exitCode = 1;
      } else if (values['env-file']) {
        await updateModelEnv(values['env-file'], model);
        emit('配置已保存', { path: values['env-file'], mode: '0600' });
      }
    }
  }
} catch {
  emit('设置失败', { reason: '参数、下载或配置写入失败，请检查参数、网络、服务与文件权限后重试；不会自动换模型。' });
  process.exitCode = 1;
}
