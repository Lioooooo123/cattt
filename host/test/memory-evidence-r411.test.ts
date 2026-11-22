import { expect, test } from "bun:test";
import { extractMemoryForMessage } from "../src/memory/extraction.ts";
import type { ExtractionInput, ExtractionMessage } from "../src/memory/extraction.ts";
import type { ModelClient, ModelRequest } from "../src/llm/types.ts";

function message(id: string, text: string, author: "me" | "partner" | "cat" = "me"): ExtractionMessage {
  return {
    id, text, conversation_id: "group", status: "complete", permission: "allowed",
    author: author === "cat" ? { kind: "cat" } : { kind: "member", member_id: author },
  };
}

function extraction(text: string, response: unknown, history: ExtractionMessage[] = []) {
  const input: ExtractionInput = {
    conversation: { id: "group", kind: "group", owner_member_id: null, participant_member_ids: ["me", "partner"] },
    members: [{ id: "me", name: "小梅" }, { id: "partner", name: "阿乔" }],
    learningEnabled: true, current: message("current", text), history,
  };
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    provider: "mock", modelId: "r411-evidence",
    async *stream(request) {
      requests.push(request);
      yield { type: "text-delta", delta: JSON.stringify(response) };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  return { result: extractMemoryForMessage(input, client), requests };
}

function candidate(sourceQuote: string, value: string, overrides: Record<string, unknown> = {}) {
  return {
    subject: { kind: "member", memberId: "me" },
    subjectEvidence: { messageId: "current", quote: "我" },
    key: "茶口味", value, sourceQuote, kind: "preference", sensitivity: "low", correction: false,
    ...overrides,
  };
}

function proposed(...confirmed: unknown[]) {
  return { confirmed, pending: [] };
}

test("请求给出可引用的短锚点，只传可用于本轮消歧的紧邻人类原话", async () => {
  const { result, requests } = extraction("她更中意岩茶。", proposed(), [
    message("old", "很早以前聊起另一种饮料。", "partner"),
    message("adjacent", "下一句说的是阿乔。"),
  ]);
  await result;
  const data = JSON.parse(requests[0]!.messages[0]!.content);
  expect(data.history.map((entry: { messageId: string }) => entry.messageId)).toEqual(["adjacent"]);
  expect(data.subjectAnchors).toContainEqual({
    messageId: "adjacent", quote: "阿乔", subject: { kind: "member", memberId: "partner" },
  });
});

test("同句具名先行词可落在事实引文之外，但第三人称须唯一归属", async () => {
  const quote = "她每次都点岩茶";
  const proposal = candidate(quote, "岩茶", {
    subject: { kind: "member", memberId: "partner" },
    subjectEvidence: { messageId: "current", quote: "阿乔" },
  });
  const current = "我和阿乔去过几回茶馆，发现她每次都点岩茶。";
  await expect(extraction(current, proposed(proposal)).result).resolves.toMatchObject({
    confirmed: [{ sourceMemberId: "me", subject: { memberId: "partner" }, contextMessageIds: [] }], pending: [],
  });
  for (const text of ["我和阿乔、小梅去喝茶，她每次都点岩茶。", "她每次都点岩茶，后来我们才聊起阿乔。"]) {
    await expect(extraction(text, proposed(proposal)).result).resolves.toMatchObject({
      confirmed: [], pending: [{ reason: "subject" }],
    });
  }
});

test("共同习惯的主语锚点可以取我俩，排除分别持有的个人偏好", async () => {
  const shared = "我俩周末早上一起吃小米粥";
  const proposal = candidate(shared, "小米粥", {
    key: "周末共用早餐", subject: { kind: "pair" }, subjectEvidence: { messageId: "current", quote: "我俩" },
  });
  await expect(extraction(shared, proposed(proposal)).result).resolves.toMatchObject({
    confirmed: [{ subject: { kind: "pair" }, value: "小米粥" }], pending: [],
  });
  const separate = "我俩各自都爱吃小米粥";
  await expect(extraction(separate, proposed({ ...proposal, sourceQuote: separate })).result).resolves.toMatchObject({
    confirmed: [], pending: [{ reason: "subject" }],
  });
});

test("提议和陈述型助手旧话不送入抽取，历史原话仍不能成为事实证据", async () => {
  const plan = message("proposal", "我建议你试喝焙茶。", "cat");
  const current = "那只是你的建议，我还要考虑。";
  const { requests, result } = extraction(current, proposed(), [plan]);
  await expect(result).resolves.toMatchObject({ confirmed: [], pending: [] });
  expect(JSON.stringify(requests)).not.toContain(plan.text);
  await expect(extraction(current, proposed(candidate(plan.text, "焙茶")), [plan]).result)
    .rejects.toMatchObject({ code: "model_error" });
});

test("当前原话里提到建议不能直接升级成偏好，随后自主定下的选择能写入", async () => {
  const quote = "我还没决定要不要焙茶";
  const open = candidate(quote, "焙茶");
  await expect(extraction(quote, proposed(open)).result).resolves.toMatchObject({ confirmed: [], pending: [] });
  const decided = "我以后都点焙茶";
  await expect(extraction(quote + "。想过之后，" + decided + "。", proposed(candidate(decided, "焙茶"))).result)
    .resolves.toMatchObject({ confirmed: [{ value: "焙茶" }], pending: [] });
});

test("未表达的肯定值、重写引文和截取掉否定分别失败", async () => {
  const negative = "我从来不爱喝岩茶";
  for (const forged of [
    candidate(negative, "白茶"), candidate("我从来不爱喝 岩茶", "岩茶"), candidate("喝岩茶", "岩茶"),
  ]) {
    await expect(extraction(negative, proposed(forged)).result).rejects.toMatchObject({ code: "model_error" });
  }
  await expect(extraction(negative, proposed(candidate(negative, "不爱喝岩茶"))).result)
    .resolves.toMatchObject({ confirmed: [{ value: "不爱喝岩茶" }] });
});

test("简答可继承唯一受问者，带明确第三方主语的原话自身决定归属", async () => {
  const ask = message("question", "小梅，你通常选哪种茶？", "cat");
  const own = { subjectEvidence: { messageId: "question", quote: "小梅" } };
  await expect(extraction("岩茶。", proposed(candidate("岩茶", "岩茶", own)), [ask]).result)
    .resolves.toMatchObject({ confirmed: [{ subject: { memberId: "me" }, contextMessageIds: ["question"] }] });
  await expect(extraction("阿乔通常选岩茶。", proposed(candidate("岩茶", "岩茶", own)), [ask]).result)
    .resolves.toMatchObject({ confirmed: [], pending: [{ reason: "subject" }] });
  const other = candidate("阿乔通常选岩茶", "岩茶", {
    subject: { kind: "member", memberId: "partner" }, subjectEvidence: { messageId: "current", quote: "阿乔" },
  });
  await expect(extraction("阿乔通常选岩茶。", proposed(other), [ask]).result)
    .resolves.toMatchObject({ confirmed: [{ subject: { memberId: "partner" }, contextMessageIds: [] }] });
});

test("分清个人更正与引用更正，助理拟议中的具体值不会成为当前偏好", async () => {
  const correction = "更正一下，我以后喝不加糖的拿铁";
  const fixed = candidate(correction, "不加糖的拿铁", { key: "咖啡口味" });
  await expect(extraction(correction, proposed(fixed)).result).resolves.toMatchObject({
    confirmed: [{ value: "不加糖的拿铁", correction: true }],
  });
  const suggested = "你建议我以后喝不加糖的拿铁";
  const picked = candidate("我以后喝不加糖的拿铁", "不加糖的拿铁", { key: "咖啡口味" });
  await expect(extraction(suggested, proposed(picked)).result).resolves.toMatchObject({ confirmed: [], pending: [] });
});

test("同一句中第一人称锚点可早于短事实引文，更正仍归当前作者", async () => {
  const text = "关于我的咖啡口味，更正为馥芮白。";
  const quote = "更正为馥芮白";
  const revised = candidate(quote, "馥芮白", { key: "咖啡口味" });
  await expect(extraction(text, proposed(revised)).result).resolves.toMatchObject({
    confirmed: [{ value: "馥芮白", correction: true, contextMessageIds: [] }], pending: [],
  });
  await expect(extraction("我的偏好以后再说。阿乔跟我提过更正为馥芮白。", proposed(revised)).result)
    .resolves.toMatchObject({ confirmed: [] });
});

test("待确认来源优先于主语，同义键统一到正式记忆维度", async () => {
  const noAuthor = "匿名便签上写有人早餐爱喝麦茶";
  const reply = {
    confirmed: [], pending: [{ sourceQuote: noAuthor, reason: "subject", key: "早餐饮品", value: "麦茶" }],
  };
  await expect(extraction(noAuthor, reply).result).resolves.toMatchObject({
    confirmed: [], pending: [{ reason: "source", key: "早饭饮品", value: "麦茶" }],
  });
  const own = "我早饭爱喝麦茶";
  await expect(extraction(own, proposed(candidate(own, "麦茶", { key: "早餐饮品" }))).result).resolves.toMatchObject({
    confirmed: [{ key: "早饭饮品", value: "麦茶" }],
  });
});

test("同一条匿名证据被标了两个待确认原因时，只保留来源待确认", async () => {
  const text = "没署名的球馆留言写阿乔每周日打羽毛球。";
  const source = { reason: "source", sourceQuote: text, key: "周末运动", value: "羽毛球" };
  const subject = { ...source, reason: "subject" };
  for (const pending of [[source, subject], [subject, source]]) {
    await expect(extraction(text, { confirmed: [], pending }).result).resolves.toMatchObject({
      confirmed: [], pending: [{ reason: "source", sourceMessageId: "current", key: "周末运动", value: "羽毛球" }],
    });
  }
  for (const pending of [[source, source], [source, { ...subject, sourceQuote: "阿乔每周日打羽毛球" }]]) {
    await expect(extraction(text, { confirmed: [], pending }).result).rejects.toMatchObject({ code: "model_error" });
  }
});

test("早餐分类键带多余的偏好后缀时仍写入同一维度", async () => {
  const text = "我常吃贝果。";
  for (const key of ["早饭点心偏好", "早餐点心偏好"]) {
    await expect(extraction(text, proposed(candidate(text, "贝果", { key }))).result)
      .resolves.toMatchObject({ confirmed: [{ key: "早饭点心", value: "贝果" }] });
  }
});

test("把否定动作和食材作为一个完整原话值，不补引文之外的宾语", async () => {
  const text = "他不吃芹菜，先不说是谁。";
  const proposal = {
    confirmed: [], pending: [{ reason: "subject", key: "芹菜偏好", value: "不吃", sourceQuote: "他不吃芹菜" }],
  };
  await expect(extraction(text, proposal).result).resolves.toMatchObject({
    confirmed: [], pending: [{ key: "芹菜偏好", value: "不吃芹菜" }],
  });
  for (const detail of [
    { sourceQuote: "他不吃" },
    { sourceQuote: "他不吃芹菜", key: "萝卜偏好" },
  ]) {
    await expect(extraction(text, { ...proposal, pending: [{ ...proposal.pending[0], ...detail }] }).result)
      .rejects.toMatchObject({ code: "model_error" });
  }
});

test("共同早餐保留具体餐食，去掉模型顺带截入的用餐动作", async () => {
  const text = "我们两人每到周末一起吃烧麦和白粥。";
  const together = candidate(text, "吃烧麦和白粥", {
    key: "周末共用早餐", subject: { kind: "pair" }, subjectEvidence: { messageId: "current", quote: "我们两人" },
  });
  await expect(extraction(text, proposed(together)).result).resolves.toMatchObject({
    confirmed: [{ key: "周末共用早餐", value: "烧麦和白粥" }],
  });
});

test("只有原话给出单个具体食材时，饮食否定归入该食材的稳定键", async () => {
  const specific = "我不吃莲子";
  await expect(extraction(specific, proposed(candidate(specific, "不吃莲子", { key: "饮食偏好" }))).result)
    .resolves.toMatchObject({ confirmed: [{ key: "莲子偏好", value: "不吃莲子" }] });
  const multiple = "我不吃腰果和杏仁";
  await expect(extraction(multiple, proposed(candidate(multiple, "不吃腰果和杏仁", { key: "食物偏好" }))).result)
    .resolves.toMatchObject({ confirmed: [{ key: "食物偏好", value: "不吃腰果和杏仁" }] });
  await expect(extraction(specific, proposed(candidate(specific, "不吃腰果", { key: "食物偏好" }))).result)
    .rejects.toMatchObject({ code: "model_error" });
});
