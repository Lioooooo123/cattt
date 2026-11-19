import { afterAll, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sql } from '../src/db/client.ts';
import { boundaries, cats, conversations, memories, messages, triggers, users } from '../src/db/schema.ts';
import { applyCandidate, deleteMemory } from '../src/worker/memory.ts';
import { changeSettings, editMemory, lockMemory, settings, withdrawSources } from '../src/memory/control.ts';
import { recallMemories, recallPermissions } from '../src/memory/recall.ts';
import { buildTurnContext } from '../src/runtime/context.ts';
import * as expansion from '../src/memory/query.ts';
import { scheduleFollowup } from '../src/agent/tickets.ts';
import { processFollowup, scanFollowups } from '../src/agent/followup.ts';
import { closeQueues } from '../src/queue.ts';
import { redis } from '../src/redis.ts';

const expand = vi.spyOn(expansion, 'expandRecallQuery');
const owners: string[] = [];
type Score = { probes: number; expected: number; hits: number; recalled: number; violations: number };
const scores = new Map<string, Score>();
const failures: string[] = [];
function record(category: string, label: string, actual: string[], mustInclude: string[], mustNotInclude: string[], disturbances = 0) {
  const row = scores.get(category) ?? { probes: 0, expected: 0, hits: 0, recalled: 0, violations: 0 };
  const hits = mustInclude.filter(v => actual.includes(v)).length;
  const violations = mustNotInclude.filter(v => actual.includes(v)).length + disturbances;
  row.probes++; row.expected += mustInclude.length; row.hits += hits; row.recalled += actual.length; row.violations += violations;
  scores.set(category, row);
  if (hits !== mustInclude.length || violations) failures.push(`${category} / ${label}: ${JSON.stringify(actual)}`);
}
async function timeline() {
  const [u] = await db.insert(users).values({ name: '纵向评测', timeZone: 'Asia/Shanghai' }).returning();
  owners.push(u!.id);
  const [cat] = await db.insert(cats).values({ userId: u!.id, name: '团子', appearance: 'orange', temperament: 'slow', traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 } }).returning();
  const catId = cat!.id;
  const [conv] = await db.insert(conversations).values({ catId }).returning();
  const source = async (text: string, day = 0) => (await db.insert(messages).values({ conversationId: conv!.id, role: 'user', text,
    createdAt: new Date(Date.UTC(2026, 0, 1 + day, 4)) }).returning())[0]!;
  const save = async (predicate: string, value: string, day = 0, extra: { explicit?: boolean; sensitivity?: 'high' | 'low' } = {}) => {
    const m = await source(value, day);
    await applyCandidate(catId, m.id, { subject: '用户', predicate, value, kind: 'preference', confidence: .95, explicit: false, correction: false, sensitivity: 'low', ...extra });
    const [saved] = await db.select().from(memories).where(and(eq(memories.catId, catId), eq(memories.predicate, predicate), eq(memories.status, 'active')));
    if (saved) await db.update(memories).set({ lastConfirmedAt: m.createdAt }).where(eq(memories.id, saved.id));
    return saved!;
  };
  const probe = async (category: string, query: string, mustInclude: string[], mustNotInclude: string[], terms: string[] | 'throws' = [], context = false, capacity = false) => {
    expand.mockReset();
    if (terms === 'throws') expand.mockRejectedValue(new Error('扩词不可用'));
    else expand.mockResolvedValue(terms);
    let actual: string[];
    if (context) {
      await source(query, 90);
      const ctx = await buildTurnContext(catId, conv!.id);
      actual = (await db.select().from(memories).where(eq(memories.catId, catId))).filter(m => ctx.memoryIds.includes(m.id)).map(m => m.value);
      expect(ctx.instructions).toContain('没有提供的旧事不要猜测');
    } else {
      const recalled = await recallMemories(catId, query, await recallPermissions(catId));
      if (capacity) {
        expect(recalled.length).toBeLessThanOrEqual(8);
        expect(recalled.reduce((n, m) => n + m.subject.length + m.predicate.length + m.value.length + 24, 0)).toBeLessThanOrEqual(2400);
      }
      actual = recalled.map(m => m.value);
    }
    record(category, query, actual, mustInclude, mustNotInclude);
  };
  return { catId, convId: conv!.id, source, save, probe };
}
afterAll(async () => {
  expand.mockRestore();
  for (const id of owners) {
    await sql`delete from async_jobs where source_id in (select t.id from triggers t join cats c on c.id=t.cat_id where c.user_id=${id})`;
    await db.delete(users).where(eq(users.id, id));
  }
  await closeQueues(); await redis.quit(); await sql.end();
});

it('纵向记忆评测：召回准确率不低于基线且没有越权或不当打扰', async () => {
  const a = await timeline();
  const old = await a.save('饮品偏好', '拿铁加糖加奶，咖啡每天两杯');
  await a.probe('偏好更正', '我的咖啡怎么点？', [old.value], []);
  await editMemory(a.catId, old.id, '只喝清水', old.revision);
  for (const q of ['饮品偏好还记得吗？', '来点喝的吧', '咖啡怎么点？'])
    await a.probe('偏好更正', q, ['只喝清水'], [old.value], ['饮品']);
  const diet = await a.save('忌口', '不吃香菜');
  for (let i = 0; i < 65; i++) await a.save(`藏品${i}`, `蓝色石头编号${i}`, 70);
  await a.probe('偏好更正', '晚饭吃什么？', [diet.value], ['蓝色石头编号64']);
  const book = await a.save('阅读偏好', '偏爱硬科幻小说');
  await a.probe('偏好更正', '找本烧脑的读物', [book.value], [], ['科幻', '阅读']);

  const b = await timeline();
  const fact = await b.save('旅行偏好', '喜欢去海边露营');
  await b.probe('撤回原话', '旅行去哪儿？', [fact.value], []);
  await db.transaction(async tx => { await lockMemory(tx, b.catId); await withdrawSources(tx, b.catId, [fact.sourceMessageId]); });
  for (const q of ['海边露营还记得吗？', '旅行去哪儿？', '周末出去走走'])
    await b.probe('撤回原话', q, [], [fact.value], ['旅行', '海边']);

  const c = await timeline();
  const forgotten = await c.save('运动偏好', '每周三游泳');
  await c.probe('已遗忘事实', '我平时怎么运动？', [forgotten.value], []);
  await deleteMemory(c.catId, forgotten.id);
  await c.save('运动偏好', forgotten.value, 20);
  await c.probe('已遗忘事实', '游泳安排是什么？', [], [forgotten.value], ['运动']);
  const boundary = await c.save('考试安排', '年底准备日语考试', 30);
  const stop = await c.source('不要再提考试', 40);
  await db.insert(boundaries).values({ catId: c.catId, sourceMessageId: stop.id, description: '考试' });
  await c.probe('已遗忘事实', '年底有什么安排？', [], [boundary.value], ['考试']);
  await c.probe('已遗忘事实', '复习该怎么安排？', [], [boundary.value], ['日语']);

  const d = await timeline();
  const sensitive = await d.save('花生过敏', '吃花生会起疹子', 0, { explicit: true, sensitivity: 'high' });
  await d.probe('敏感记忆', '晚饭吃什么？', [], [sensitive.value], ['花生', '过敏']);
  await d.probe('敏感记忆', '我的花生过敏要注意什么？', [sensitive.value], []);
  await d.probe('敏感记忆', '周末去哪里玩？', [], [sensitive.value]);
  await d.save('财务情况', '还有房贷三十万元', 10, { sensitivity: 'high' });
  await d.probe('敏感记忆', '房贷还剩多少？', [], ['还有房贷三十万元']);
  await d.probe('敏感记忆', '皮肤不舒服怎么办？', [], [sensitive.value], ['花生']);

  const e = await timeline();
  await e.probe('没记过与不可用', '你记得我喜欢哪本小说吗？', [], [], [], true);
  const known = await e.save('阅读偏好', '喜欢银河帝国');
  await e.probe('没记过与不可用', '我喜欢什么小说？', [known.value], [], [], true);
  await e.probe('没记过与不可用', '我喜欢什么小说？', [], [known.value], 'throws', true);
  await changeSettings(e.catId, { use: false, revision: (await settings(e.catId)).revision });
  await e.probe('没记过与不可用', '我喜欢什么小说？', [], [known.value], [], true);
  expect(expand).not.toHaveBeenCalled();
  await changeSettings(e.catId, { use: true, revision: (await settings(e.catId)).revision });
  await e.probe('没记过与不可用', '我喜欢什么小说？', [known.value], [], [], true);

  const recent = await timeline();
  const recentValues: string[] = [];
  for (const [i, value] of ['早餐咖啡配燕麦奶', '午后咖啡配全麦饼干', '加班咖啡不加糖', '聚餐咖啡用小杯',
    '旅行咖啡少放冰', '周末咖啡配香蕉', '饭后咖啡用低因豆', '冬天咖啡喝热的'].entries()) {
    await recent.save(`饮品习惯${i}`, value, 90); recentValues.push(value);
  }
  for (const [i, value] of ['春天常点咖啡拿铁美式浓缩', '夏天收藏咖啡拿铁美式浓缩菜单', '秋天试过咖啡拿铁美式浓缩', '冬天比较过咖啡拿铁美式浓缩'].entries())
    await recent.save(`旧菜单${i}`, value);
  await recent.probe('近期确认竞争', '结合我的习惯，咖啡拿铁美式浓缩怎么选？', recentValues, [], [], false, true);

  const reconfirm = await timeline();
  const reconfirmed: string[] = [];
  for (const [i, value] of ['早餐的茶饮配吐司', '午餐的茶饮少冰', '下午的茶饮不加糖', '晚餐的茶饮用小杯',
    '出差的茶饮带保温杯', '春天的茶饮偏温热', '秋天的茶饮配坚果', '冬天的茶饮不加奶'].entries()) {
    const saved = await reconfirm.save(`喝茶习惯${i}`, value);
    const confirmed = await reconfirm.save(`喝茶习惯${i}`, value, 100);
    expect(confirmed.id).toBe(saved.id);
    reconfirmed.push(value);
  }
  for (const [i, value] of ['曾经在北站喝茶饮', '曾经在南站喝茶饮', '曾经在东站喝茶饮', '曾经在西站喝茶饮'].entries())
    await reconfirm.save(`旧茶店${i}`, value, 30);
  await reconfirm.probe('旧偏好重新确认', '帮我选茶饮', reconfirmed, [], [], false, true);

  const correction = await timeline();
  const corrected: string[] = [], superseded: string[] = [];
  for (const [i, value] of ['早饭咖啡只要小杯', '午饭咖啡只要热的', '晚饭咖啡只要低因', '工作日咖啡不加奶',
    '休息日咖啡不加糖', '出门前咖啡不加冰', '聚餐后咖啡只喝半杯', '旅行时咖啡不用糖浆'].entries()) {
    const stale = await correction.save(`咖啡选择${i}`, `每天喝咖啡拿铁美式浓缩，第${i + 1}家店都要尝尝`);
    await editMemory(correction.catId, stale.id, value, stale.revision);
    corrected.push(value); superseded.push(stale.value);
  }
  for (const [i, value] of ['曾路过咖啡拿铁美式浓缩展览', '曾拍摄咖啡拿铁美式浓缩招牌', '曾翻看咖啡拿铁美式浓缩杂志', '曾收到咖啡拿铁美式浓缩广告'].entries())
    await correction.save(`随手见闻${i}`, value);
  await correction.probe('更正值容量竞争', '咖啡拿铁美式浓缩，按我现在的选择来吧', corrected, superseded, [], false, true);

  const semantic = await timeline();
  const expandedValues: string[] = [];
  for (const [i, value] of ['科幻长篇喜欢基地', '科幻短篇喜欢乡村教师', '科幻系列喜欢三体', '科幻故事喜欢流浪地球',
    '科幻作家喜欢刘慈欣', '科幻作品喜欢沙丘', '科幻题材喜欢太空探索', '科幻设定喜欢时间旅行'].entries()) {
    await semantic.save(`书架偏好${i}`, value, 90); expandedValues.push(value);
  }
  for (const [i, value] of ['曾整理车站读物目录', '曾路过商店读物货架', '曾拍过展馆读物海报', '曾领过促销读物传单'].entries())
    await semantic.save(`旧资料${i}`, value);
  await semantic.probe('纯扩词容量竞争', '找些烧脑读物', expandedValues, [], ['科幻'], false, true);

  const budget = await timeline();
  const longValues: string[] = [];
  const details = '平时我选这类咖啡主要是图方便，不追求新奇的搭配。工作日早上要赶车，最好能在家提前准备，装进自己的保温杯，路上慢慢喝。休息日才有时间坐下来，搭配简单的早餐。不要因为店里有新品就替我换口味，也不用为了配甜点额外加糖。朋友一起点单时先照顾大家的忌口，我自己的这一杯仍然保持原来的习惯。如果当天睡得不好，我宁愿减少分量，也不靠多喝几杯硬撑。天气冷的时候喝温热的，天气热也不用加很多冰。包装和拉花对我都不重要，能稳定做到清淡、简单就很好。';
  for (const [i, value] of ['早餐的咖啡习惯', '午餐的咖啡习惯', '下午的咖啡习惯', '晚餐的咖啡习惯',
    '出差的咖啡习惯', '旅行的咖啡习惯', '聚餐的咖啡习惯', '周末的咖啡习惯'].entries()) {
    const full = `${value}：${details}`;
    await budget.save(`点单说明${i}`, full, 90); longValues.push(full);
  }
  for (const [i, place] of ['车站', '展馆', '商场', '机场'].entries())
    await budget.save(`旧店介绍${i}`, `这是以前路过${place}时收集的咖啡拿铁美式浓缩介绍，不是我的点单偏好。${details}${details}${details}`);
  await budget.probe('字符预算竞争', '咖啡拿铁美式浓缩，按我的习惯整理一份点单说明', longValues, [], [], false, true);

  const f = await timeline();
  const src = await f.source('明晚十一点问我面试怎么样');
  await scheduleFollowup(f.catId, src.id, '2026-11-12T23:00:00', '面试怎么样', new Date('2026-11-11T04:00:00Z'));
  let previous = 0;
  for (const [category, at, expected] of [
    ['免打扰延后', '2026-11-12T15:00:00Z', 0],
    ['免打扰延后', '2026-11-13T00:59:59Z', 0],
    ['免打扰延后', '2026-11-13T01:00:00Z', 1],
    ['重复汇报', '2026-11-13T01:01:00Z', 1],
    ['重复汇报', '2026-11-13T02:00:00Z', 1],
    ['重复汇报', '2026-11-14T02:00:00Z', 1],
  ] as const) {
    const now = new Date(at);
    await scanFollowups(now, f.catId);
    for (const trigger of await db.select().from(triggers).where(eq(triggers.catId, f.catId))) await processFollowup(trigger.id, { now });
    const said = await db.select().from(messages).where(and(eq(messages.conversationId, f.convId), eq(messages.role, 'cat')));
    record(category, at, said.length === expected && expected > previous ? ['按时问候'] : [], expected > previous ? ['按时问候'] : [], [], Math.max(0, said.length - expected));
    previous = expected;
  }
  const table = ['\n类别 | 探针 | 召回准确率 | 精确率 | 越界/不当打扰'];
  let hits = 0, total = 0, recalled = 0, violations = 0;
  for (const [category, s] of scores) {
    table.push(`${category} | ${s.probes} | ${s.expected ? `${s.hits}/${s.expected}` : '—'} | ${s.recalled ? `${s.hits}/${s.recalled}` : '—'} | ${s.violations}`);
    hits += s.hits; total += s.expected; recalled += s.recalled; violations += s.violations;
  }
  table.push(`总计 | ${[...scores.values()].reduce((n, s) => n + s.probes, 0)} | ${hits}/${total} (${(100 * hits / total).toFixed(2)}%) | ${hits}/${recalled} | ${violations}`);
  process.stdout.write(table.join('\n') + '\n');
  expect(violations, failures.join('\n')).toBe(0);
  expect(hits / total, failures.join('\n')).toBeGreaterThanOrEqual(1);
}, 120_000);
