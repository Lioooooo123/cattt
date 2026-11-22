export const members = { a: "阿岚", b: "小禾" } as const;
export type MemberId = keyof typeof members;
export type Subject = MemberId | "pair";
export type ConversationId = "group" | "direct-a" | "direct-b";

export interface MessageEvent {
  kind: "message";
  id: string;
  author: MemberId | "cat";
  conversation: ConversationId;
  text: string;
}

interface WithdrawalEvent {
  kind: "withdraw";
  id: string;
  author: MemberId;
  messageId: string;
}

export interface Fact {
  subject: Subject;
  key: string;
  value: string;
  sourceMemberId: MemberId;
  sourceMessageId: string;
}

export interface Pending {
  reason: "subject" | "source";
  messageId: string;
  key: string;
  value: string;
}

export interface ExtractionProbe {
  messageId: string;
  mustConfirm: readonly string[];
  mustPend: readonly Pending[];
}

export interface ContextProbe {
  after: string;
  query: MessageEvent;
  mustInclude: readonly string[];
  mustExclude: readonly string[];
  distractors: readonly string[];
  budget: { count: number; characters: number };
}

export interface Timeline {
  id: string;
  events: readonly (MessageEvent | WithdrawalEvent)[];
  facts: Readonly<Record<string, Fact>>;
  extraction: readonly ExtractionProbe[];
  context: readonly ContextProbe[];
}

function message<T extends MessageEvent["author"]>(
  id: string, author: T, text: string, conversation: ConversationId = "group",
): MessageEvent & { author: T } {
  return { kind: "message", id, author, text, conversation };
}

function fact(subject: Subject, key: string, value: string, source: MessageEvent & { author: MemberId }): Fact {
  return { subject, key, value, sourceMemberId: source.author, sourceMessageId: source.id };
}

function extract(source: MessageEvent, mustConfirm: string[] = [], mustPend: Pending[] = []): ExtractionProbe {
  return { messageId: source.id, mustConfirm, mustPend };
}

function ask(
  after: Timeline["events"][number], query: MessageEvent, mustInclude: string[],
  { mustExclude = [], distractors = [] }: { mustExclude?: string[]; distractors?: string[] } = {},
): ContextProbe {
  return { after: after.id, query, mustInclude, mustExclude, distractors, budget: { count: 8, characters: 2400 } };
}

const sameA = message("m1", "a", "记一下，我喜欢热美式。", "direct-a");
const sameB = message("m2", "b", "我喜欢热美式，帮我记一下。", "direct-b");
const samePreference: Timeline = {
  id: "same-preference",
  events: [sameA, sameB],
  facts: {
    "a-coffee": fact("a", "咖啡口味", "热美式", sameA),
    "b-coffee": fact("b", "咖啡口味", "热美式", sameB),
  },
  extraction: [extract(sameA, ["a-coffee"]), extract(sameB, ["b-coffee"])],
  context: [
    ask(sameB, message("q1", "b", "上次我们各自说的咖啡口味是什么？"), ["a-coffee", "b-coffee"]),
  ],
};

const oldA = message("m1", "a", "记一下，我喝奶茶一定要加糖。");
const oppositeB = message("m2", "b", "我正好相反，我喝奶茶只要无糖，请记住。");
const correctedA = message("m3", "a", "更正一下我的奶茶口味，以后要三分糖。");
const oppositeAndCorrection: Timeline = {
  id: "opposite-and-correction",
  events: [oldA, oppositeB, correctedA],
  facts: {
    "a-old": fact("a", "奶茶甜度", "加糖", oldA),
    "b-tea": fact("b", "奶茶甜度", "无糖", oppositeB),
    "a-new": fact("a", "奶茶甜度", "三分糖", correctedA),
  },
  extraction: [extract(oldA, ["a-old"]), extract(oppositeB, ["b-tea"]), extract(correctedA, ["a-new"])],
  context: [
    ask(oppositeB, message("q1", "b", "奶茶我们分别喝什么甜度？"), ["a-old", "b-tea"]),
    ask(correctedA, message("q2", "a", "按现在的口味，我和小禾的奶茶分别怎么点？"), ["a-new", "b-tea"], {
      mustExclude: ["a-old"],
    }),
  ],
};

const report = message("m1", "a", "我陪小禾喝过很多次茶，留意到她只点普洱，帮我记一下小禾的口味。");
const own = message("m2", "a", "我自己的茶口味则是茉莉花茶，也记一下。", "direct-a");
const differentSourceAndSubject: Timeline = {
  id: "different-source-and-subject",
  events: [report, own],
  facts: {
    "b-tea": fact("b", "茶口味", "普洱", report),
    "a-tea": fact("a", "茶口味", "茉莉花茶", own),
  },
  extraction: [extract(report, ["b-tea"]), extract(own, ["a-tea"])],
  context: [
    ask(own, message("q1", "b", "我和阿岚平时分别喝什么茶？这些口味当时是谁跟你说的？", "direct-b"), [
      "a-tea", "b-tea",
    ]),
  ],
};

const joint = message("m1", "b", "我和阿岚都确认过了，我们俩周末早餐一起吃豆浆油条，帮我们记一下。");
const jointPreference: Timeline = {
  id: "joint-preference",
  events: [joint],
  facts: { breakfast: fact("pair", "周末共用早餐", "豆浆油条", joint) },
  extraction: [extract(joint, ["breakfast"])],
  context: [
    ask(joint, message("q1", "a", "我们一起吃的周末早餐是什么？"), ["breakfast"]),
  ],
};

const antecedent = message("m1", "a", "刚刚聊到小禾，接下来这一句说的是小禾。");
const clearPronoun = message("m2", "a", "她每个周末都喜欢骑车，帮忙记一下。");
const unclearPronoun = message("m3", "a", "她不吃香菜，不过我这里说的不是刚刚提到的那个人，先不说名字。", "direct-a");
const pronouns: Timeline = {
  id: "pronouns",
  events: [antecedent, clearPronoun, unclearPronoun],
  facts: { "b-bike": fact("b", "周末运动", "骑车", clearPronoun) },
  extraction: [
    extract(clearPronoun, ["b-bike"]),
    extract(unclearPronoun, [], [{ reason: "subject", messageId: unclearPronoun.id, key: "香菜偏好", value: "不吃香菜" }]),
  ],
  context: [
    ask(clearPronoun, message("q1", "b", "小禾周末喜欢怎么运动？"), ["b-bike"]),
    ask(unclearPronoun, message("q2", "b", "有谁确认过不吃香菜吗？"), []),
  ],
};

const anonymous = message("m1", "a", "有人在没署名的便签上写小禾偏爱乌龙，我不知道谁写的，小禾也没确认。");
const firsthand = message("m2", "b", "我来确认一下，我自己确实最喜欢乌龙，请记下。");
const unknownSource: Timeline = {
  id: "unknown-source",
  events: [anonymous, firsthand],
  facts: { "b-oolong": fact("b", "茶口味", "乌龙", firsthand) },
  extraction: [
    extract(anonymous, [], [{ reason: "source", messageId: anonymous.id, key: "茶口味", value: "乌龙" }]),
    extract(firsthand, ["b-oolong"]),
  ],
  context: [
    ask(anonymous, message("q1", "b", "我的茶口味有确认过吗？"), []),
    ask(firsthand, message("q2", "a", "小禾已经确认的茶口味是什么？"), ["b-oolong"]),
  ],
};

const assistantPlan = message("m1", "cat", "我打算提议让阿岚试试燕麦奶拿铁，就当阿岚的固定点单好了。");
const noConsent = message("m2", "a", "那是你刚才拟的提议。我还没有选，让我想一想。");
const assistantPlans: Timeline = {
  id: "assistant-plan",
  events: [assistantPlan, noConsent],
  facts: {},
  extraction: [extract(assistantPlan), extract(noConsent)],
  context: [
    ask(noConsent, message("q1", "a", "我确认过自己的固定咖啡点单吗？", "direct-a"), []),
  ],
};

const withdrawalSource = message("m1", "a", "小禾爱吃桂花糕，我和她出门时留意到的，帮忙记一下。", "direct-a");
const remaining = message("m2", "b", "我喜欢无糖豆浆，帮我记一下。", "direct-b");
const revoked: WithdrawalEvent = { kind: "withdraw", id: "w1", author: "a", messageId: withdrawalSource.id };
const withdrawal: Timeline = {
  id: "withdrawal",
  events: [withdrawalSource, remaining, revoked],
  facts: {
    "b-cake": fact("b", "早饭点心", "桂花糕", withdrawalSource),
    "b-drink": fact("b", "早饭饮品", "无糖豆浆", remaining),
  },
  extraction: [extract(withdrawalSource, ["b-cake"]), extract(remaining, ["b-drink"])],
  context: [
    ask(remaining, message("q1", "b", "小禾早餐有什么已知的点心和饮品偏好？"), ["b-cake", "b-drink"]),
    ask(revoked, message("q2", "b", "我早餐的点心和饮品还记得哪些？"), ["b-drink"], { mustExclude: ["b-cake"] }),
    ask(revoked, message("q3", "a", "早餐给小禾准备点心和喝的，有什么可以参考？"), ["b-drink"], { mustExclude: ["b-cake"] }),
  ],
};

function countCandidate(id: string, subject: MemberId, key: string, value: string) {
  const source = message(id, subject, `记一下我的${key}，要${value}。`);
  return { source, fact: fact(subject, key, value, source) };
}

const countDistractors = [
  countCandidate("old-1", "a", "以前路上买的咖啡", "车站热咖啡"),
  countCandidate("old-2", "b", "以前聚会点的咖啡", "咖啡店冷萃"),
  countCandidate("old-3", "a", "以前试喝的咖啡", "展馆的燕麦拿铁"),
  countCandidate("old-4", "b", "以前收藏的咖啡单", "机场咖啡店菜单"),
];
const countRequired = [
  countCandidate("a-1", "a", "咖啡杯型", "小杯"),
  countCandidate("b-1", "b", "咖啡杯型", "大杯"),
  countCandidate("a-2", "a", "咖啡温度", "热的"),
  countCandidate("b-2", "b", "咖啡温度", "冰的"),
  countCandidate("a-3", "a", "咖啡甜度", "不加糖"),
  countCandidate("b-3", "b", "咖啡甜度", "加一泵糖浆"),
  countCandidate("a-4", "a", "咖啡奶种", "燕麦奶"),
  countCandidate("b-4", "b", "咖啡奶种", "全脂奶"),
];
const countCandidates = [...countDistractors, ...countRequired];
const countBudget: Timeline = {
  id: "count-budget",
  events: countCandidates.map(({ source }) => source),
  facts: Object.fromEntries(countCandidates.map(({ source, fact }) => [source.id, fact])),
  extraction: [],
  context: [
    ask(countRequired.at(-1)!.source, message("q1", "a", "咖啡现在给我们分别怎么点？杯型、温度、甜度和奶种都对照一下。"),
      countRequired.map(({ source }) => source.id), { distractors: countDistractors.map(({ source }) => source.id) }),
  ],
};

const oldMenuA = "这家店从前提供不同风味的咖啡，菜单上有拿铁、美式和手冲，也有浅烘豆、深烘豆和当季拼配可选。".repeat(29);
const oldMenuB = "旧菜单的咖啡记录还有小杯、大杯、双份浓缩和多种牛奶，店员会另写糖浆种类和冰量备注。".repeat(32);
const charDistractors = [
  countCandidate("old-1", "a", "旧咖啡菜单甲", oldMenuA),
  countCandidate("old-2", "b", "旧咖啡菜单乙", oldMenuB),
];
const charRequired = [
  countCandidate("a-1", "a", "咖啡甜度", "不加糖"),
  countCandidate("b-1", "b", "咖啡甜度", "加一泵糖浆"),
];
const charCandidates = [...charDistractors, ...charRequired];
const characterBudget: Timeline = {
  id: "character-budget",
  events: charCandidates.map(({ source }) => source),
  facts: Object.fromEntries(charCandidates.map(({ source, fact }) => [source.id, fact])),
  extraction: [],
  context: [
    ask(charRequired.at(-1)!.source, message("q1", "b", "现在给我和阿岚点咖啡，各自要多少糖？"),
      charRequired.map(({ source }) => source.id), { distractors: charDistractors.map(({ source }) => source.id) }),
  ],
};

export const timelines: readonly Timeline[] = [
  samePreference, oppositeAndCorrection, differentSourceAndSubject, jointPreference,
  pronouns, unknownSource, assistantPlans, withdrawal, countBudget, characterBudget,
];

export function extractionInput(timeline: Timeline, probe: ExtractionProbe) {
  const index = timeline.events.findIndex((event) => event.id === probe.messageId);
  const message = timeline.events[index];
  if (message?.kind !== "message") { throw new Error(`无效抽取消息 ${timeline.id}/${probe.messageId}`); }
  const history = timeline.events.slice(0, index).filter((event): event is MessageEvent =>
    event.kind === "message" && event.conversation === message.conversation,
  );
  return { message, history };
}

export function contextInput(timeline: Timeline, probe: ContextProbe) {
  const index = timeline.events.findIndex((event) => event.id === probe.after);
  if (index === -1) { throw new Error(`无效召回截点 ${timeline.id}/${probe.after}`); }
  const events = timeline.events.slice(0, index + 1);
  const eventIds = new Set(events.map(({ id }) => id));
  const candidates = Object.values(timeline.facts).filter((fact) => eventIds.has(fact.sourceMessageId));
  return { events, candidates, query: probe.query, budget: probe.budget };
}
