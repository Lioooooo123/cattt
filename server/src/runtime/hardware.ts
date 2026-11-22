import os from 'node:os';
import { execFileSync } from 'node:child_process';

export interface Hardware {
  platform: string;
  arch: string;
  appleSilicon: boolean;
  totalMemGB: number;
  cpuModel: string;
  cpuCores: number;
  gpu?: { model: string; vramGB: number };
}

export const MODEL_TIERS = [
  { minMemGB: 48, model: 'qwen3:32b', sizeGB: 20 },
  { minMemGB: 24, model: 'qwen3:14b', sizeGB: 9.3 },
  { minMemGB: 16, model: 'qwen3:8b', sizeGB: 5.2 },
  { minMemGB: 8, model: 'qwen3:4b', sizeGB: 2.5 },
] as const;

function command(file: string, args: string[]) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function detectHardware(): Hardware {
  const platform = os.platform();
  const cpus = os.cpus();
  const hw: Hardware = {
    platform, arch: os.arch(), appleSilicon: false, totalMemGB: os.totalmem() / 1024 ** 3,
    cpuModel: cpus[0]?.model ?? '未知', cpuCores: cpus.length,
  };
  if (platform === 'darwin') {
    hw.appleSilicon = command('sysctl', ['-n', 'hw.optional.arm64']) === '1';
    hw.cpuModel = command('sysctl', ['-n', 'machdep.cpu.brand_string']) || hw.cpuModel;
  }
  if (platform === 'linux') {
    const rows = command('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    for (const row of rows.split('\n')) {
      const parts = row.split(',');
      const vramGB = Number(parts.pop()?.trim()) / 1024;
      if (vramGB > (hw.gpu?.vramGB ?? 0)) hw.gpu = { model: parts.join(',').trim(), vramGB };
    }
  }
  return hw;
}

export function recommendModel(hw: Hardware) {
  const accelerated = hw.appleSilicon || !!hw.gpu;
  const memory = hw.appleSilicon ? hw.totalMemGB : hw.gpu?.vramGB ?? hw.totalMemGB;
  const index = MODEL_TIERS.findIndex(t => memory >= t.minMemGB);
  const tier = index < 0 ? undefined : MODEL_TIERS[index + (accelerated ? 0 : 1)];
  if (!tier) return { kind: 'deepseek' as const, reason: '硬件不够，建议填自己的 DeepSeek key。' };
  return { kind: 'local' as const, model: tier.model, sizeGB: tier.sizeGB,
    reason: `按${hw.appleSilicon ? 'Apple Silicon 统一内存' : hw.gpu ? 'NVIDIA 显存（按最大单卡，不叠加）' : '内存（无 GPU 加速，降一档）'} ${memory.toFixed(1)} GB 推荐；Qwen3 下载约 ${tier.sizeGB} GB，仍须真答与工具烟测。${tier.model === 'qwen3:4b' ? '4b 为低内存降级选择，记忆提取准确性低于 8b。' : ''}` };
}

export function smallerModel(model: string) {
  const index = MODEL_TIERS.findIndex(t => t.model === model);
  return index >= 0 ? MODEL_TIERS[index + 1]?.model : undefined;
}
