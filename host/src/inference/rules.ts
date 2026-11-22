import { localISO, parseTicketTime } from "../tickets/time.ts";

export const dayMs = 86_400_000;
export const outcomeLabels = {
  interview: "面试",
  exam: "考试",
  medical: "就诊",
  competition: "比赛",
  defense: "答辩",
} as const;
export type OutcomeTopic = keyof typeof outcomeLabels;

export type AskOutcomeRule = {
  version: number;
  mode: "off" | "observe" | "auto";
};
export const defaultAskOutcomeRule: AskOutcomeRule = { version: 1, mode: "observe" };
export const askOutcomeRuleId = "ask_outcome";
const topics: Record<OutcomeTopic, RegExp> = {
  interview: /面试/,
  exam: /考试|考完/,
  medical: /就诊|看医生|手术/,
  competition: /比赛/,
  defense: /答辩/,
};
const settled = /通过|没过|过了|顺利|失败|不顺|结果是|结果出来了|赢了|输了|拿到了|没拿到|已经好了|没事了|医生说|考得|发挥得|发挥不好/;

export type OutcomeEvent = {
  topic: OutcomeTopic;
  afterAt: number;
  timeQuote: string;
};

export function alreadyAnswered(text: string, topic: OutcomeTopic): boolean {
  return topics[topic].test(text)
    && (settled.test(text) || /(?:别|不用|不要|不想)(?:再)?(?:问|聊|提|说)/.test(text));
}

const vocative = /^(?:@团子(?=$|[\s，,。！？!?：:、])|团子\s*(?=[，,！？!?：:、]|$)|团子(?:在吗|呢[？?]|你(?:能|可以|觉得|知道|想)|帮我|陪我|看看))/u;

export function callsCat(text: string): boolean {
  const line = text.normalize("NFKC").trim();
  return vocative.test(line) || /,\s*团子[呀啊]?[。!?]?$/u.test(line);
}

/** 只认本人明确说出的近期结束时间，模型无权将不明确的表达提升为候选。 */
export function outcomeEvent(text: string, at: number, zone: string): OutcomeEvent | undefined {
  const self = text.trim().replace(vocative, "").replace(/^[\s，,！？!?：:、]+/, "");
  const sentence = self.split(/[。！？!?\n]/u)[0]!;
  if (/也许|大概|可能|如果|听说|是不是|原来|取消|延期|改期|［|「|『|“|"/u.test(sentence)) {
    return;
  }
  const eventWord = "(?:面试|考试|就诊|看医生|手术|比赛|答辩)";
  const ending = `\\s*(?:(?:的)?${eventWord})?(?:会|将)?(?:结束|出结果|考完|面试完|比赛完|就诊完|答辩完)`;
  const owned = new RegExp(`^我(?:的)?(?:这场|这次)?${eventWord}?(?:将在|会在|要在|在|将于)?\\s*$`);
  const iso = sentence.match(new RegExp(
    `(\\d{4}-\\d\\d-\\d\\d[T ]\\d\\d:\\d\\d(?::\\d\\d(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d\\d:\\d\\d)?)(?![\\d:.+Z-])${ending}`,
  ));
  const relative = iso ? null : sentence.match(new RegExp(
    `(今天|明天|后天)(?:的)?(上午|下午|晚上|中午)?(\\d{1,2})(?::(\\d{2})|点(?:(\\d{1,2})分|半)?)${ending}`,
  ));
  const match = iso ?? relative;
  const quote = match?.[0];
  const matched = (Object.keys(topics) as OutcomeTopic[]).filter((topic) => topics[topic].test(sentence));
  const [topic] = matched;
  if (!match || !quote || !topic || matched.length !== 1 || !owned.test(sentence.slice(0, match.index))
    || alreadyAnswered(text, topic)) { return; }

  let afterAt: number;
  try {
    if (iso) {
      afterAt = parseTicketTime(iso[1]!.replace(" ", "T"), zone);
    } else {
      const [, day, period, rawHour, clockMinute, statedMinute] = relative!;
      const localDay = localISO(at, zone).slice(0, 10);
      const shift = day === "明天" ? 1 : day === "后天" ? 2 : 0;
      const date = localISO(Date.parse(localDay) + shift * dayMs, "UTC").slice(0, 10);
      let hour = Number(rawHour);
      if (period && (hour < 1 || hour > 12)) { return; }
      if (period === "上午" && hour === 12) { hour = 0; }
      if (period && /下午|晚上|中午/u.test(period) && hour < 12) { hour += 12; }
      const minute = clockMinute ?? statedMinute ?? (quote.includes("点半") ? "30" : "00");
      const hhmm = `${String(hour).padStart(2, "0")}:${minute.padStart(2, "0")}`;
      afterAt = parseTicketTime(`${date}T${hhmm}`, zone);
    }
  } catch {
    return;
  }
  return afterAt < at - dayMs || afterAt > at + 7 * dayMs
    ? undefined : { topic, afterAt, timeQuote: quote };
}
