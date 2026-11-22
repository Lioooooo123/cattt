import { z } from "zod";
import { rankAgainst } from "./relevance.ts";

type Fact = {
  subjectMemberId: string | null;
  predicate: string;
  value: string;
  sourceMemberId: string;
};

const lookupPlan = z.strictObject({ known: z.array(z.number().int()).max(8), missing: z.boolean() });
const unknown = "目前无法确认。";
const question = /[?？]|什么|哪些|哪种|哪个|谁|怎么|多少|吗(?:[。！!]|$)/u;
const recall = /记得|记不记得|想得起|上次|之前|以前|原来|已知|确认过|已(?:经)?确认|(?:说|提到|提过|告诉)过/u;
const habitual = /平时|通常|一般|习惯|偏好|常(?:用|选|喝|吃|穿|听|去)|喜欢|固定/u;
const comparison = /各自|各(?=\p{Script=Han}{0,6}(?:什么|哪|几|多少))|分别|每人|两人|两位|两个人|都(?:选|要|喜欢)|一起/u;
const catPreference = /(?:^|[，,：:\s])(?:团子[，,：:\s]*)?你(?:自己)?(?:也|还|平时|通常|一般|最|更|比较|一直)*(?:喜欢|偏好|感兴趣|觉得)/u;
const firsthand = /确认过|(?:已(?:经)?|曾)确认|(?:谁|有人|本人|自己|有)[^。！？?]{0,6}确认/u;

const ownPreference = /^你(?:自己)?(?:也|还|平时|通常|一般|最|更|比较|一直)*(?:喜欢|喜不喜欢|偏好|感兴趣)/u;
const chatInvitation = /^(?:请|麻烦|拜托)?(?:你)?(?:能不能|可不可以|可以|能|要不要)?(?:只|就)?(?:陪我|和我|跟我)(?:随便|随意|一起)*(?:聊聊|聊天|聊一?会儿?|说说话)/u;
const memoryRequest = /各自|分别|推荐|建议|(?:按(?:照)?|根据|结合|参考)(?:我|我们)|(?:我|我们)(?:自己)?的?(?:口味|偏好|习惯)/u;

/** Keep recall available for ambiguous or mixed turns. */
export function companionshipTurn(query: string): "cat-opinion" | "chat" | undefined {
  if (recall.test(query) || memoryRequest.test(query)) { return; }
  const text = query.trim().replace(/^(?:@?团子|猫猫)[，,：:、\s]*/u, "");
  const body = text.replace(/[。！？!?]+$/u, "");
  const request = body.split(/[，,。！？!?；;\n]/u).at(-1)?.trim();
  if (!request) { return; }

  // A bare “你” only identifies the cat in a standalone question.
  if (body === request && ownPreference.test(request)) {
    if (question.test(text) || /[吗呢]$/u.test(request) || request.includes("喜不喜欢")) { return "cat-opinion"; }
    return;
  }
  if (question.test(body.slice(0, body.lastIndexOf(request)))) { return; }
  const invitation = chatInvitation.exec(request);
  if (!invitation) { return; }
  const topic = request.slice(invitation[0].length).replace(/(?:好吗|可以吗|吗)$/u, "");
  if (!question.test(topic)) { return "chat"; }
}

export type FactualReply = {
  instruction: string;
  render(output: string): string;
};

/** Restrict quotation by reference to the confirmed memories already selected for this request. */
export function prepareFactualReply(input: {
  query: string;
  speakerId: string;
  names: ReadonlyMap<string, string>;
  facts: readonly Fact[];
  hasRecall: boolean;
  hasMemberStatements: boolean;
}): FactualReply | undefined {
  const { speakerId, names, facts, hasRecall, hasMemberStatements } = input;
  // The question makes up the lookup scope. A suggested answer after it is not a source.
  const query = input.query.split(/[。！？?]\s*(?=我猜|猜是|会不会是|是不是|难道是|是[^。！？?]+[？?])/u)[0]!.trim();
  const clauses = query.match(/[^。！？?]+[！？?]?/gu) ?? [];
  const eligible = clauses.some((clause) => question.test(clause) && !catPreference.test(clause)
    && (recall.test(clause) || hasRecall && (habitual.test(clause) || comparison.test(clause) || /(?:可以|可供)参考/u.test(clause))));
  if (!eligible) { return; }
  if (!facts.length && (hasMemberStatements || hasRecall)) { return; }
  if (new Set(names.values()).size !== names.size) { return; }

  const rank = rankAgainst(query);
  const selfConfirmed = firsthand.test(query);
  const ranked = facts
    .filter(({ subjectMemberId, sourceMemberId }) => !selfConfirmed || subjectMemberId === sourceMemberId)
    .map((fact) => ({ fact, ...rank(fact.predicate, fact.value) }))
    .filter(({ score }) => score > 0);
  const speaker = names.get(speakerId);
  const namedMembers = [...names].filter(([, name]) => query.includes(name));
  const both = names.size === 2 && (
    /我们俩|我俩|我们两(?:人|个)|两位成员|两个人/u.test(query)
    || comparison.test(query) && (/我们/u.test(query) || namedMembers.length === 2
      || namedMembers.some(([id]) => id !== speakerId) && /我(?:和|跟|与)/u.test(query))
  );
  const namedSubject = !both && !/^(?:有)?谁/u.test(query)
    ? namedMembers.find(([, name]) => query.startsWith(name) || query.includes(name + "的"))?.[0] : undefined;
  const candidates = ranked.filter(({ fact, predicateHits }) =>
    (namedSubject === undefined || fact.subjectMemberId === namedSubject)
    && !ranked.some((other) => query.includes(other.fact.predicate)
      && predicateHits.length > 0 && other.predicateHits.length > predicateHits.length
      && predicateHits.every((hit) => other.predicateHits.includes(hit))));
  // An explicit list of aspects or separate interrogative clauses requires more
  // than one distinct dimension. A conjunction between members is not a list.
  const severalAspects = !both && (/\p{Script=Han}{2}(?:和|以及|还有|、)\p{Script=Han}{2}/u.test(query)
    || query.split(/[，,]/u).filter((part) => /什么|哪些|哪种|多少|何时/u.test(part)).length > 1);
  const explicitAspects = !both && namedSubject !== undefined && clauses.length === 1
    ? query.match(/有(?:什么|哪些)(?:已知的)?(\p{Script=Han}{2})(?:和|以及|、)(\p{Script=Han}{2})(?:偏好|习惯)?[？?]?$/u)?.slice(1)
    : undefined;
  const matchedAspects = explicitAspects?.map((aspect) => candidates.flatMap(({ fact }, index) => {
    if (!fact.predicate.endsWith(aspect)) return [];
    const category = fact.predicate.slice(0, -aspect.length);
    return rank(category, "").predicateHits.length ? [{ category, id: index + 1 }] : [];
  }));
  const [first, second] = matchedAspects ?? [];
  // Complete an explicit pair only when both dimensions have unique evidence in the named topic.
  const explicitPair = first?.length === 1 && second?.length === 1
    && first[0]!.id !== second[0]!.id && first[0]!.category === second[0]!.category
    ? [first[0]!.id, second[0]!.id] : undefined;
  const sourceRequested = /谁[^。！？?]{0,12}(?:说|告诉|提供|介绍)|(?:来源|提供者)(?:是|呢)/u.test(query);
  const rows = candidates.map(({ fact }, index) => [
    index + 1, fact.subjectMemberId === null ? "两位成员共同" : names.get(fact.subjectMemberId),
    fact.predicate, names.get(fact.sourceMemberId),
  ]);
  const instruction = [
    "## 确认事实查询",
    `查找当前成员问到的既有事实。发问者：${JSON.stringify(speaker)}。只处理问题范围：${JSON.stringify(query)}`,
    "候选索引为[编号、事实说的是谁、项目、提供者]。值以相关记忆中的对应记录为准。索引之外的记录不允许引用。",
    JSON.stringify(rows),
    "只返回 JSON 对象，字段 known 是能回答问题的编号数组，missing 是是否有任一问项查不到的布尔值。",
    "逐位成员、逐个方面核对，值相同也保留各自的编号。有一项找不到，missing 就填 true，即使别的项有值。",
    "只选与问题相关的编号，旧聊天、猜测和提议不能代替候选。每个编号只用一次。没有匹配就给空数组和 true。",
  ].join("\n");

  return {
    instruction,
    render(output) {
      let parsed: unknown;
      try { parsed = JSON.parse(output); } catch { return unknown; }
      const result = lookupPlan.safeParse(parsed);
      if (!result.success) { return unknown; }
      const cited = new Set(result.data.known);
      if (!cited.size || cited.size !== result.data.known.length || [...cited].some((id) => id < 1 || id > candidates.length)) { return unknown; }

      const completedPair = explicitPair && [...cited].every((id) => explicitPair.includes(id));
      if (completedPair) explicitPair.forEach((id) => cited.add(id));
      if (both) {
        // Same question dimension, different subject. Compare source-backed rows even when the values coincide.
        const predicates = new Set([...cited].map((id) => candidates[id - 1]!.fact.predicate));
        candidates.forEach(({ fact }, index) => {
          if (fact.subjectMemberId !== null && predicates.has(fact.predicate)) { cited.add(index + 1); }
        });
      }
      const ordered = candidates.filter((_, index) => cited.has(index + 1)).map(({ fact }) => fact);
      const predicates = new Set(ordered.map(({ predicate }) => predicate));
      const mixedSources = new Set(ordered.map(({ sourceMemberId }) => sourceMemberId)).size > 1;
      const partial = !completedPair && (result.data.missing || severalAspects && predicates.size < 2 || both && [...predicates].some((predicate) => {
        const subjects = new Set(ordered.filter((fact) => fact.predicate === predicate).map((fact) => fact.subjectMemberId));
        return !subjects.has(null) && subjects.size < names.size;
      }));
      const lines = ordered.map(({ subjectMemberId, predicate, value, sourceMemberId }) => {
        const subject = subjectMemberId === null ? [...names.values()].join("和") + "共同" : names.get(subjectMemberId);
        const source = sourceRequested || mixedSources || sourceMemberId !== speakerId || sourceMemberId !== subjectMemberId
          ? `（${names.get(sourceMemberId)}告诉我的）` : "";
        return `${subject}的${predicate}是${value}${source}。`;
      });
      return lines.join("") + (partial ? "其余问到的部分，目前无法确认。" : "");
    },
  };
}
