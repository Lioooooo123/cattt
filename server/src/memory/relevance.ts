/** 本地排序不访问网络、不保存副本；语义扩词只影响相关性，不能改变使用许可。 */
export type RecallItem = {
  id: string; subject: string; predicate: string; value: string; fingerprint: string;
  explicit: boolean; sensitivity: string; lastConfirmedAt: Date; revision: number;
};
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const stop = new Set(['用户', '自己', '喜欢', '事情', '东西', '现在', '今天', '最近', '以前', '之前', '什么', '怎么', '怎样', '可以', '帮我', '帮忙', '一下', '想想', '告诉', '知道', '记得', '记住', '你们', '我们', '一个', '这个', '那个', '还有', '一些', '请问', '推荐', '安排', '建议', '不能', '不要', '从不', '需要', '应该', '你好', '谢谢']);
const topics = [
  ['最后怎么样', '最后怎样', '后来怎么样', '后来怎样', '结果如何', '结果', '结局'],
  ['晚饭', '晚餐', '午餐', '午饭', '早餐', '吃饭', '饭菜', '菜品', '饮食', '食物', '口味', '忌口', '香菜', '素食', '辣椒', '辛辣', '海鲜'],
  ['饮料', '喝点', '喝什么', '喝的', '清水', '白开水', '饮水', '咖啡', '拿铁', '美式', '茶饮', '奶茶', '饮品', '无咖啡因'],
  ['看书', '读书', '阅读', '书籍', '小说', '作家', '文学', '科幻', '图书'],
  ['电影', '影片', '影院', '观影'],
  ['运动', '锻炼', '健身', '跑步', '游泳', '骑行'],
  ['旅行', '旅游', '出游', '景点', '度假'],
  ['周末', '休息日', '假期', '闲暇'],
  ['考试', '复习', '备考', '课程', '学习'],
];
export function normalizeRecall(text: string) { return text.normalize('NFKC').toLowerCase(); }
export function recallTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const part of segmenter.segment(normalizeRecall(text))) {
    if (!part.isWordLike || part.segment.length < 2 || stop.has(part.segment)) continue;
    tokens.add(part.segment);
    // 未登录词和中英混排也可匹配；不拆单字，减少偶然命中。
    if (/^[\p{Script=Han}]{3,}$/u.test(part.segment)) {
      for (let i = 0; i < part.segment.length - 1; i++) {
        const token = part.segment.slice(i, i + 2);
        if (!stop.has(token)) tokens.add(token);
      }
    }
  }
  return [...tokens];
}
export function localRecallTerms(query: string) {
  const q = normalizeRecall(query);
  return [...new Set(topics.filter(group => group.some(term => q.includes(term))).flat())];
}
/** 只在明确接续请求时补上一条用户消息；寒暄、肯定句不会把旧话题带回来。 */
export function recallQuery(current: string, previous?: string) {
  if (previous && /^(那[呢就]?|还有[吗呢]?|换(一[个种家本]|个|种|家|本)|再(推荐|来|换)|其他[的呢]?)/u.test(current.trim())) {
    return `${previous.slice(0, 600)}\n${current.slice(0, 600)}`;
  }
  return current.slice(0, 1200);
}
export function boundaryOverlaps(item: RecallItem, topic: string) {
  const content = normalizeRecall(`${item.predicate} ${item.value}`);
  return recallTokens(topic).some(t => content.includes(t));
}
export function rankMemories<T extends RecallItem>(items: T[], query: string, expanded: string[] = []) {
  const direct = recallTokens(query);
  const normalizedQuery = normalizeRecall(query);
  const extra = [...new Set([...localRecallTerms(query), ...expanded.flatMap(recallTokens)])]
    .filter(t => !direct.includes(t));
  const documents = items.map(item => ({ item, text: normalizeRecall(`${item.subject} ${item.predicate} ${item.value}`) }));
  const weights = new Map([...direct, ...extra].map(t => [t, 1 + Math.log(1 + items.length / (1 + documents.filter(d => d.text.includes(t)).length))]));
  const now = Date.now();
  const candidates = documents.map(({ item, text }) => {
    const hits = direct.filter(t => text.includes(t));
    const semantic = extra.filter(t => text.includes(t));
    // 敏感记忆不能仅因扩词被找到：当前问题必须直接点到对应内容。
    const permitted = item.sensitivity !== 'high' || (item.explicit && hits.length > 0);
    const lexical = hits.reduce((sum, t) => sum + weights.get(t)!, 0);
    // 分词漏掉的查询原词仍可准入，但不能再作为扩词获得第二票。
    const expansion = semantic.filter(t => !normalizedQuery.includes(t)).reduce((sum, t) => sum + weights.get(t)!, 0);
    const essential = item.explicit && /^(回答方式|沟通偏好|称呼|回复长度|表达方式)$/.test(item.predicate);
    const eligible = permitted && (hits.length > 0 || semantic.length > 0 || essential);
    // 半衰期 90 天、按 UTC 日计龄，同天确认不因写入毫秒差而分出先后。
    const ageDays = Math.max(0, Math.floor(now / 86400000) - Math.floor(item.lastConfirmedAt.getTime() / 86400000));
    const recent = Math.exp(-Math.LN2 * ageDays / 90);
    return { item, lexical, expansion, recent, eligible };
  }).filter(row => row.eligible);
  const fused = new Map(candidates.map(row => [row.item.id, 0]));
  for (const key of ['lexical', 'expansion', 'recent'] as const) {
    const list = candidates.filter(row => row[key] > 0).sort((a, b) => b[key] - a[key] || newestFirst(a.item, b.item));
    let rank = 0;
    for (let i = 0; i < list.length; i++) {
      if (i === 0 || list[i]![key] !== list[i - 1]![key]) rank = i + 1;
      const id = list[i]!.item.id;
      fused.set(id, fused.get(id)! + 1 / (60 + rank));
    }
  }
  return candidates.map(({ item }) => ({ item, score: fused.get(item.id)! }))
    .sort((a, b) => b.score - a.score || newestFirst(a.item, b.item));
}
function newestFirst(a: RecallItem, b: RecallItem) {
  return b.revision - a.revision || b.lastConfirmedAt.getTime() - a.lastConfirmedAt.getTime() || a.id.localeCompare(b.id);
}
export function selectMemories<T extends RecallItem>(ranked: { item: T; score: number }[], maxCount = 8, maxChars = 2400): T[] {
  const result: T[] = []; const seen = new Set<string>(); let chars = 0;
  const newest = new Map<string, T>();
  for (const { item } of ranked) {
    const prior = newest.get(item.fingerprint);
    if (!prior || newestFirst(item, prior) < 0) newest.set(item.fingerprint, item);
  }
  for (const { item } of ranked) {
    const size = item.subject.length + item.predicate.length + item.value.length + 24;
    if (newest.get(item.fingerprint) !== item || seen.has(item.fingerprint) || chars + size > maxChars) continue;
    seen.add(item.fingerprint); result.push(item); chars += size;
    if (result.length >= maxCount) break;
  }
  // 保留完整记忆，避免截掉末尾的否定或限制条件。
  return result;
}
