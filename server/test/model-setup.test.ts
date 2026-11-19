import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_TIERS, recommendModel, smallerModel, type Hardware } from '../src/runtime/hardware.ts';
import { smokeModel, updateModelEnv } from '../src/runtime/model-setup.ts';

const hardware = (totalMemGB: number, appleSilicon = true): Hardware => ({
  totalMemGB, appleSilicon, platform: appleSilicon ? 'darwin' : 'linux', arch: appleSilicon ? 'arm64' : 'x64', cpuModel: '测试', cpuCores: 8,
});

describe('硬件推荐', () => {
  it.each([[16, true, 'qwen2.5:7b'], [8, true, 'qwen2.5:3b'], [16, false, 'qwen2.5:3b'], [64, true, 'qwen2.5:32b'], [64, false, 'qwen2.5:14b'], [4, true, undefined], [8, false, undefined]] as const)('%s GB / Apple=%s', (memory, apple, model) => {
    const result = recommendModel(hardware(memory, apple));
    expect(result.kind === 'local' ? result.model : undefined).toBe(model);
  });
  it('逐档边界使用同一张表', () => {
    for (const tier of MODEL_TIERS) expect(recommendModel(hardware(tier.minMemGB))).toMatchObject({ model: tier.model });
    expect(smallerModel('qwen2.5:7b')).toBe('qwen2.5:3b');
    expect(smallerModel('custom')).toBeUndefined();
  });
  it('NVIDIA 按显存而非主存', () => {
    expect(recommendModel({ ...hardware(64, false), gpu: { model: 'NVIDIA', vramGB: 12 } })).toMatchObject({ model: 'qwen2.5:7b' });
    expect(recommendModel({ ...hardware(4, false), gpu: { model: 'NVIDIA', vramGB: 24 } })).toMatchObject({ model: 'qwen2.5:14b' });
  });
});

describe('配置文件', () => {
  it('更新本机模型时原样保留所有槽位来源与模型覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cattt-model-'));
    const path = join(dir, 'env');
    const overrides = 'CHAT_PROVIDER=deepseek\nexport ROUTER_PROVIDER=deepseek # 云端\nWORKER_PROVIDER=deepseek\nEXTRACT_PROVIDER=openai-compatible\nEXTRACT_MODEL=custom-local\n';
    try {
      await writeFile(path, `MODEL_PROVIDER=openai-compatible\nOPENAI_COMPAT_MODEL=old\n${overrides}`);
      await updateModelEnv(path, 'qwen2.5:3b');
      expect(await readFile(path, 'utf8')).toBe(`MODEL_PROVIDER=openai-compatible\nOPENAI_COMPAT_MODEL=qwen2.5:3b\n${overrides}`);
    } finally { await rm(dir, { recursive: true }); }
  });
  it('保留注释、其他配置，替换所有旧键并收紧权限', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cattt-model-'));
    const path = join(dir, 'env');
    try {
      await writeFile(path, '# 我的配置\nOTHER=keep\nMODEL_PROVIDER=mock # 来源\nexport OPENAI_COMPAT_MODEL="old"\nMODEL_PROVIDER=deepseek\n', { mode: 0o644 });
      await updateModelEnv(path, 'qwen2.5:7b');
      expect(await readFile(path, 'utf8')).toBe('# 我的配置\nOTHER=keep\nMODEL_PROVIDER=openai-compatible # 来源\nexport OPENAI_COMPAT_MODEL=qwen2.5:7b\nMODEL_PROVIDER=openai-compatible\n');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(dir, { recursive: true }); }
  });
  it('新文件与空文件，拒绝换行注入且不改文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cattt-model-'));
    const path = join(dir, 'env');
    try {
      await updateModelEnv(path, 'qwen2.5:3b');
      expect(await readFile(path, 'utf8')).toBe('MODEL_PROVIDER=openai-compatible\nOPENAI_COMPAT_MODEL=qwen2.5:3b\n');
      await expect(updateModelEnv(path, 'bad\nKEY=x')).rejects.toThrow();
      await writeFile(path, '');
      await updateModelEnv(path, 'qwen2.5:7b');
      expect((await readFile(path, 'utf8'))).toContain('OPENAI_COMPAT_MODEL=qwen2.5:7b');
    } finally { await rm(dir, { recursive: true }); }
  });
});

describe('真实回答烟测的判定', () => {
  const correct = [{ type: 'function', function: { name: 'set_companion_light', arguments: '{"color":"warm","brightness":30}' } }];
  it.each([
    ['陪你坐一会儿。', correct, true], ['Hello', correct, false], ['', correct, false],
    ['好呀', [], false], ['好呀', [{ type: 'function', function: { name: 'wrong', arguments: '{}' } }], false],
    ['好呀', [{ type: 'function', function: { name: 'set_companion_light', arguments: '{"color":"cold","brightness":30}' } }], false],
    ['好呀', [{ type: 'function', function: { name: 'set_companion_light', arguments: 'invalid' } }], false],
  ])('回复 %s', async (content, tool_calls, passed) => {
    let count = 0;
    const fake = (async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe('test');
      count++;
      if (count === 2) expect(body.tool_choice).toBe('required');
      return Response.json({ choices: [{ message: count === 1 ? { content } : { tool_calls } }] });
    }) as typeof fetch;
    const result = await smokeModel('http://localhost/v1', 'test', fake);
    expect(result.passed).toBe(passed);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(count).toBe(2);
  });
  it('空响应、HTTP 错误与网络错误均失败', async () => {
    for (const fake of [async () => Response.json({}), async () => new Response('', { status: 500 }), async () => { throw new Error('断开'); }]) {
      expect((await smokeModel('http://localhost/v1', 'test', fake as typeof fetch)).passed).toBe(false);
    }
  });
});
