import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { assembleChatRequest } from "../../src/context/chat.ts";
import { prepareFactualReply } from "../../src/context/factual-reply.ts";
import type { ModelClient, ModelRequest } from "../../src/llm/types.ts";
import { revision } from "../../src/store/business.ts";
import { getConversation } from "../../src/store/conversations.ts";
import { withdrawKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { saveMemory } from "../../src/store/knowledge.ts";
import { members } from "../../src/store/schema/identity.ts";
import { ChatReplier } from "../../src/turns/chat-replier.ts";
import { setupContextFixture } from "./context-fixture.ts";

function scenario() {
  const seed = setupContextFixture();
  const { actors, clock, db, source, send } = seed;
  for (const [actor, displayName] of [[actors.a, "陆遥"], [actors.b, "舒宁"]] as const) {
    db.update(members).set({ ...revision(clock), displayName }).where(eq(members.id, actor.memberId)).run();
  }
  const first = send("scarf-first", "a", "我的围巾选墨绿。");
  const second = send("scarf-second", "a", "舒宁的围巾也选墨绿，我帮她挑的。", "direct-a");
  const unrelated = send("scarf-length", "b", "我的围巾长度要一米。");
  for (const [message, subjectMemberId, predicate, value] of [
    [first, actors.a.memberId, "围巾颜色", "墨绿"],
    [second, actors.b.memberId, "围巾颜色", "墨绿"],
    [unrelated, actors.b.memberId, "围巾长度", "一米"],
  ] as const) {
    expect(saveMemory(db, clock, { ...source(message), subjectMemberId, predicate, fingerprint: predicate, value })).toBeDefined();
  }

  let lastRequest: ModelRequest | undefined;
  async function ask(text: string, plan: unknown, beforeFinish?: () => void, history = [] as ReturnType<typeof send>[]) {
    const trigger = send("lookup", "b", text);
    const conversation = getConversation(db, actors.b, trigger.conversation_id);
    const client: ModelClient = {
      provider: "openai-compatible", modelId: "regression-fixture",
      async *stream(request) {
        request.guard?.();
        lastRequest = request;
        const content = request.extraBody?.response_format ? JSON.stringify(plan) : "我记得是浅蓝，舒宁说的。";
        yield { type: "text-delta", delta: content };
        beforeFinish?.();
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const reply = new ChatReplier(client, (input) => assembleChatRequest(db, input));
    const chunks: string[] = [];
    for await (const part of reply.reply({ conversation, trigger, history, signal: new AbortController().signal })) {
      chunks.push(part);
    }
    return { chunks, text: chunks.join(""), request: lastRequest! };
  }
  return { ...seed, second, ask };
}

test("同值不吞掉另一位成员，代为提供的消息保持原归属", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("上次我们各自选的围巾颜色是什么？", { known: [1], missing: false });
    expect(result.text.match(/墨绿/gu)).toHaveLength(2);
    expect(result.text).toContain("陆遥的围巾颜色");
    expect(result.text).toContain("舒宁的围巾颜色");
    expect(result.text).toContain("陆遥告诉我的");
    expect(result.text).not.toContain("一米");
  } finally { seed.store.close(); }
});

test("混合范围保留有证据的一项，明示缺项；拒绝越界或无关的引用", async () => {
  const options = [
    { known: [1], missing: true },
    { known: [999], missing: false },
    { known: [2], missing: false },
  ];
  for (const [index, plan] of options.entries()) {
    const seed = scenario();
    try {
      const result = await seed.ask("舒宁之前选的围巾长度和手套材质，你还记得吗？我猜是羊毛。", plan);
      expect(result.text).toContain("目前无法确认");
      expect(result.text).not.toContain("羊毛");
      if (index === 0) {
        expect(result.text).toContain("一米");
      } else {
        expect(result.text).not.toContain("墨绿");
      }
    } finally { seed.store.close(); }
  }
});

test("开放式找确认人时，无编号就不从问句中捏造名字与值", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("有人确认过会用哪种琴弦吗？我猜舒宁用了尼龙。", { known: [1], missing: false });
    expect(result.text).toContain("目前无法确认");
    expect(result.text).not.toContain("舒宁");
    expect(result.text).not.toContain("尼龙");
  } finally { seed.store.close(); }
});

test("聊天邀请即使召回记忆也继续原有的自然流式路径", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("今天下雨了，陪我随便聊聊围巾吧。", { known: [1], missing: false });
    expect(result.request.extraBody?.response_format).toBeUndefined();
    expect(result.chunks).toEqual(["我记得是浅蓝，舒宁说的。"]);
  } finally { seed.store.close(); }
});

test("事实呈现前复核来源：模型响应期间撤回时拒绝呈现", async () => {
  const seed = scenario();
  try {
    await expect(seed.ask("上次我们各自选的围巾颜色是什么？", { known: [1, 2], missing: false }, () => {
      expect(withdrawKnowledgeSource(seed.db, seed.clock, seed.actors.a, seed.second.id, 1)).toBeDefined();
    })).rejects.toThrow();
  } finally { seed.store.close(); }
});

test("即使编号回答漏标缺项，明确并列的问项也显示当前证据不足", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("舒宁之前选的围巾长度和手套材质，你还记得吗？我猜是羊毛。", { known: [1], missing: false });
    expect(result.text).toContain("一米");
    expect(result.text).toContain("目前无法确认");
    expect(result.text).not.toContain("羊毛");
  } finally { seed.store.close(); }
});

test("先前消息包含他人的猜测，仍没有本人确认的证据", async () => {
  const seed = scenario();
  try {
    const guess = seed.send("raw-guess", "a", "舒宁在试不同琴弦，我觉得她会选羊肠弦。");
    const result = await seed.ask("有人确认过会用哪种琴弦吗？", { known: [], missing: true }, undefined, [guess]);
    expect(result.text).toBe("目前无法确认。");
  } finally { seed.store.close(); }
});

test("同主题的证据不能替代明确指定的主语", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("陆遥之前定的围巾长度是多少？", { known: [1], missing: false });
    expect(result.text).toBe("目前无法确认。");
  } finally { seed.store.close(); }
});

test("句子中间点出两名成员时，完整对照无需追加缺项", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("现在给我和陆遥选围巾，各自上次定的颜色是什么？", { known: [1], missing: false });
    expect(result.text.match(/墨绿/gu)).toHaveLength(2);
    expect(result.text).not.toContain("无法确认");
  } finally { seed.store.close(); }
});

test("普通聊天里提起过去并不会把接下来的随意聊天变成事实查询", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("上次下雨让我想起了家。我们聊点什么好？", { known: [], missing: true });
    expect(result.request.extraBody?.response_format).toBeUndefined();
    expect(result.chunks).toEqual(["我记得是浅蓝，舒宁说的。"]);
  } finally { seed.store.close(); }
});

test("问团子自己的感受时，即使同主题有记忆也保持普通聊天", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("团子，你也喜欢这条围巾吗？", { known: [1], missing: false });
    expect(result.request.extraBody?.response_format).toBeUndefined();
    expect(result.chunks).toEqual(["我记得是浅蓝，舒宁说的。"]);
  } finally { seed.store.close(); }
});

test("两人问题用单字各时，仍按同一个事项逐人覆盖", async () => {
  const seed = scenario();
  try {
    const result = await seed.ask("我和陆遥各选的围巾是什么颜色？", { known: [1], missing: false });
    expect(result.text.match(/墨绿/gu)).toHaveLength(2);
    expect(result.text).toContain("陆遥的围巾颜色");
    expect(result.text).toContain("舒宁的围巾颜色");
  } finally { seed.store.close(); }
});

test("明确并列的同类偏好各有唯一证据时，补齐模型漏选的维度", () => {
  const input = {
    query: "小禾早餐有什么已知的点心和饮品偏好？",
    speakerId: "b",
    names: new Map([["a", "阿岚"], ["b", "小禾"]]),
    hasRecall: true,
    hasMemberStatements: false,
  };
  const drink = { subjectMemberId: "b", predicate: "早饭饮品", value: "无糖豆浆", sourceMemberId: "b" };
  const snack = { subjectMemberId: "b", predicate: "早饭点心", value: "桂花糕", sourceMemberId: "a" };
  const differentMeal = { subjectMemberId: "b", predicate: "晚饭点心", value: "芝麻饼", sourceMemberId: "a" };
  const plan = JSON.stringify({ known: [1], missing: true });
  expect(prepareFactualReply({ ...input, facts: [drink, snack, differentMeal] })?.render(plan))
    .toBe("小禾的早饭饮品是无糖豆浆（小禾告诉我的）。小禾的早饭点心是桂花糕（阿岚告诉我的）。");
  expect(prepareFactualReply({ ...input, facts: [drink, differentMeal] })?.render(plan))
    .toBe("小禾的早饭饮品是无糖豆浆。其余问到的部分，目前无法确认。");
});
