import { generateText } from 'ai';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { cats } from '../db/schema.ts';
import { catDiarySlot, recordModelCall } from './model.ts';
import { compileBehavior } from './behavior.ts';
import { TEMPERAMENTS, type Temperament } from './persona.ts';

/**
 * 团子每天自己写的那一条。模型只从事实表里写，不许编事。
 * 事实表和 App 本地模板（ios/Maomao/Model/CatDiary.swift）是同一张；
 * 这个接口不通时 App 用本地模板兜底。
 * 依据 docs/方案/性格系统优化-方案-2026-09-12.md 第 2.3 节。
 */
export type DiaryFacts = {
  date: string;
  isFirstDay: boolean;
  mood: 'calm' | 'happy' | 'sulk' | 'sad';
  moodReason?: string;
  weather: 'clear' | 'rain';
  filledToday: boolean;
  drankToday: boolean;
  visitedToday: boolean;
  absenceDays: number;
  emptyDays: number;
  places: string[];
  chatSnippet?: string;
  fragmentSnippet?: string;
};

const MOOD_NAMES = { calm: '平常', happy: '开心', sulk: '不高兴', sad: '委屈' } as const;

export function factLines(f: DiaryFacts): string[] {
  const lines = [
    `- 日期：${f.date}${f.isFirstDay ? '（被领养的第一天）' : ''}`,
    `- 天气：${f.weather === 'rain' ? '下雨' : '晴'}`,
    `- 心情：${MOOD_NAMES[f.mood]}${f.moodReason ? `（${f.moodReason}）` : ''}`,
    `- 水：${f.filledToday ? '今天有人倒过水' : `碗空着，已经 ${Math.max(1, f.emptyDays)} 天没换水`}；${f.drankToday ? '今天喝过' : '今天没喝'}`,
    `- 对方：${f.visitedToday ? '今天来过院子' : `已经 ${Math.max(1, f.absenceDays)} 天没来`}`,
  ];
  if (f.places.length) lines.push(`- 今天去过：${[...new Set(f.places)].join('、')}`);
  if (f.chatSnippet) lines.push(`- 今天对方说过：${f.chatSnippet}`);
  if (f.fragmentSnippet) lines.push(`- 今天看到对方写的：${f.fragmentSnippet}`);
  return lines;
}

export async function writeDiary(catId: string, facts: DiaryFacts) {
  const [cat] = await db.select().from(cats).where(eq(cats.id, catId));
  if (!cat) throw new Error('not_found');
  // 现有日记请求没有可核验的来源 ID。暂不接收任意聊天/碎片正文，避免绕过停用原话。
  facts = { ...facts, chatSnippet: undefined, fragmentSnippet: undefined };
  const temperament = (cat.temperament in TEMPERAMENTS ? cat.temperament : 'slow') as Temperament;
  const behavior = compileBehavior(temperament, cat.traits);
  const slot = catDiarySlot('chat');
  const started = Date.now();
  const { text, usage } = await generateText({
    model: slot.model,
    instructions: `你是${cat.name}，一只猫。晚上你在自己的本子上记下今天。
- 只写下面这张事实表里有的事，一件都不许添。没写的事就是没发生。
- ${behavior.diarySentences} 句以内，短句，猫的口吻，平铺直叙。
- 不问"为什么不来"，不指责，不许诺，不写打卡、任务、连续天数这类词。
- 不写标题、日期、署名，不用 markdown。只输出正文。`,
    messages: [{ role: 'user', content: `今天的事实：\n${factLines(facts).join('\n')}` }],
    providerOptions: slot.providerOptions,
    maxRetries: 2,
  });
  await recordModelCall({ purpose: 'cat_diary', modelId: slot.modelId, usage, latencyMs: Date.now() - started });
  return text.trim().replace(/\s+/g, '').slice(0, 120);
}
