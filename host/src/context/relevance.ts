const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const stopWords = new Set([
  "他们", "你们", "我们", "分别", "各自", "一起", "现在", "以前", "今天", "什么", "怎么", "多少",
  "喜欢", "准备", "确认", "已经", "记得", "知道", "一下", "可以", "参考", "当时", "上次", "哪些",
]);

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/早饭|早膳/gu, "早餐")
    .replace(/晚饭/gu, "晚餐")
    .replace(/午饭/gu, "午餐")
    .replace(/多少糖|糖量|几分糖/gu, "甜度");
}

function terms(text: string): string[] {
  const result = new Set<string>();
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike || stopWords.has(segment)) {
      continue;
    }
    if (segment.length >= 2 || /^[茶糖]$/u.test(segment)) {
      result.add(segment);
    }
  }
  // ICU sometimes emits two one-character segments for domain terms such as
  // a size or unit. Recover adjacent Han pairs even across segment boundaries.
  for (const [, pair] of text.matchAll(/(?=(\p{Script=Han}{2}))/gu)) {
    if (pair && !stopWords.has(pair)) {
      result.add(pair);
    }
  }
  return [...result];
}

export function rankAgainst(query: string) {
  const tokens = terms(normalize(query));
  return (predicate: string, value: string) => {
    const key = normalize(predicate);
    const detail = normalize(value);
    const predicateHits = tokens.filter((token) => key.includes(token));
    const valueHits = tokens.filter((token) => !key.includes(token) && detail.includes(token));
    const score = predicateHits.reduce((sum, token) => sum + token.length * 3, valueHits.length);
    return { score, predicateHits };
  };
}

export function avoidTopics(topics: readonly string[]) {
  const boundaries = topics.map((topic) => normalize(topic.trim()));
  return (text: string) => {
    const content = normalize(text);
    return boundaries.some((topic) => content.includes(topic)
      || terms(topic).some((token) => content.includes(token)));
  };
}
