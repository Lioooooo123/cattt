import type { Temperament, Traits } from "./protocol.ts";

/**
 * 行为参数来自现有 3D 世界。跨端检查对照 iOS 和旧后端的计算结果。
 * 依据 docs/方案/性格系统优化-方案-2026-09-12.md 第 2.1 节。
 */
export type BehaviorParams = {
  /** 每个地点停留时长的倍数 */
  idleScale: number;
  /** 蘑菇屋门口再多留一会儿的倍数 */
  homeIdleScale: number;
  /** 门口待机池里「打盹」的权重 */
  sleepWeight: number;
  /** 「坐着看你 + 歪头」的权重合计 */
  lookWeight: number;
  /** 看你里歪头占的比例 */
  tiltShare: number;
  /** 「舔毛」的权重 */
  groomWeight: number;
  /** 六个地点的去处权重：蘑菇屋、树屋、猫窝、草丛、池塘、栅栏边 */
  placeWeights: number[];
  /** 打开 App 时来门口坐下看你 */
  comesToDoor: boolean;
  /** 情绪时长倍数（委屈、开心） */
  moodScale: number;
  /** 倒水之后过多久去喝（秒） */
  drinkDelay: [number, number];
  /** 团子日记写几句 */
  diarySentences: number;
};

/** 慢热的「头几天」：按领养日算，前三天像安静的猫。 */
export const SLOW_WARMUP_DAYS = 3;

const BASE: Record<Temperament, BehaviorParams> = {
  quiet: { idleScale: 1.5, homeIdleScale: 1.0, sleepWeight: 0.85, lookWeight: 0.10, tiltShare: 0.35, groomWeight: 0.15, placeWeights: [4.0, 0.3, 3.0, 0.15, 0.1, 0.1], comesToDoor: false, moodScale: 0.6, drinkDelay: [20, 60], diarySentences: 2 },
  slow: { idleScale: 1.2, homeIdleScale: 1.0, sleepWeight: 0.50, lookWeight: 0.25, tiltShare: 0.35, groomWeight: 0.25, placeWeights: [2.5, 1.5, 1.0, 0.6, 0.5, 0.5], comesToDoor: true, moodScale: 0.8, drinkDelay: [10, 40], diarySentences: 2 },
  close: { idleScale: 1.0, homeIdleScale: 1.8, sleepWeight: 0.30, lookWeight: 0.45, tiltShare: 0.30, groomWeight: 0.25, placeWeights: [10.0, 0.5, 0.8, 0.3, 0.2, 0.2], comesToDoor: true, moodScale: 1.5, drinkDelay: [3, 15], diarySentences: 3 },
  curious: { idleScale: 0.6, homeIdleScale: 1.0, sleepWeight: 0.20, lookWeight: 0.30, tiltShare: 0.60, groomWeight: 0.25, placeWeights: [0.8, 1.2, 0.2, 2.0, 1.8, 1.8], comesToDoor: true, moodScale: 1.0, drinkDelay: [3, 15], diarySentences: 3 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const level = (traits: Traits, key: keyof Traits) => clamp(Math.round(traits[key] ?? 1), 0, 2);

export function compileBehavior(temperament: Temperament, traits: Traits, daysSinceAdoption = 0): BehaviorParams {
  const warm = temperament !== 'slow' || daysSinceAdoption >= SLOW_WARMUP_DAYS;
  const base = BASE[temperament] ?? BASE.slow;
  const p: BehaviorParams = { ...base, placeWeights: [...base.placeWeights], drinkDelay: [...base.drinkDelay] as [number, number] };
  if (temperament === 'slow' && !warm) { p.lookWeight = BASE.quiet.lookWeight; p.comesToDoor = false; }

  const energy = level(traits, 'energy'), initiative = level(traits, 'initiative');
  const directness = level(traits, 'directness'), closeness = level(traits, 'closeness');

  // 活力节奏：调停留与睡眠。
  p.idleScale *= [1.35, 1.0, 0.75][energy]!;
  p.sleepWeight = clamp(p.sleepWeight + [0.15, 0, -0.15][energy]!, 0.05, 0.85);

  // 主动性：调去处与来门口。
  const indoor = [1.3, 1.0, 0.8][initiative]!, outdoor = [0.7, 1.0, 1.3][initiative]!;
  p.placeWeights = p.placeWeights.map((w, i) => (i === 0 || i === 2 ? w * indoor : w * outdoor));
  if (initiative === 0) p.comesToDoor = false;
  if (initiative === 2 && warm) p.comesToDoor = true;

  // 亲近表达：调看你的频率与情绪时长。
  p.lookWeight = clamp(p.lookWeight * [0.5, 1.0, 1.6][closeness]!, 0.05, 0.8);
  p.moodScale = clamp(p.moodScale * [0.7, 1.0, 1.4][closeness]!, 0.4, 2.0);

  // 倒水后多久去喝：活力 + 主动性一起决定快慢。
  const factor = 1.4 - 0.8 * ((energy + initiative) / 4);
  p.drinkDelay = [Math.max(2, p.drinkDelay[0] * factor), Math.max(3, p.drinkDelay[1] * factor)];

  // 表达直接度：调日记的句数。
  p.diarySentences = clamp(p.diarySentences + [-1, 0, 1][directness]!, 2, 3);
  return p;
}
