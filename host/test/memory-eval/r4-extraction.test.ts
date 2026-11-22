import { expect, test } from "bun:test";
import type { ModelClient } from "../../src/llm/types.ts";
import { timelines } from "./corpus.ts";
import type { MemberId } from "./corpus.ts";
import { runExtractionProbe } from "./extraction-probe.ts";
import { summarize } from "./score.ts";

function confirmed(messageId: string, subject: MemberId | "pair", quote: string, sourceQuote: string, key: string, value: string, correction = false) {
  return {
    confirmed: [{
      subject: subject === "pair" ? { kind: "pair" } : { kind: "member", memberId: subject },
      subjectEvidence: { messageId, quote }, sourceQuote, key, value, kind: "preference", sensitivity: "low", correction,
    }],
    pending: [],
  };
}

function pending(reason: "subject" | "source", sourceQuote: string, key: string, value: string) {
  return { confirmed: [], pending: [{ reason, sourceQuote, key, value }] };
}

const responses: Record<string, ReturnType<typeof confirmed> | ReturnType<typeof pending> | { confirmed: []; pending: [] }> = {
  "same-preference/m1": confirmed("m1", "a", "我", "我喜欢热美式", "咖啡口味", "热美式"),
  "same-preference/m2": confirmed("m2", "b", "我", "我喜欢热美式", "咖啡口味", "热美式"),
  "opposite-and-correction/m1": confirmed("m1", "a", "我", "我喝奶茶一定要加糖", "奶茶甜度", "加糖"),
  "opposite-and-correction/m2": confirmed("m2", "b", "我", "我喝奶茶只要无糖", "奶茶甜度", "无糖"),
  "opposite-and-correction/m3": confirmed("m3", "a", "我的", "我的奶茶口味，以后要三分糖", "奶茶甜度", "三分糖", true),
  "different-source-and-subject/m1": confirmed("m1", "b", "小禾", "小禾喝过很多次茶，留意到她只点普洱", "茶口味", "普洱"),
  "different-source-and-subject/m2": confirmed("m2", "a", "我", "我自己的茶口味则是茉莉花茶", "茶口味", "茉莉花茶"),
  "joint-preference/m1": confirmed("m1", "pair", "我们俩", "我们俩周末早餐一起吃豆浆油条", "周末共用早餐", "豆浆油条"),
  "pronouns/m2": confirmed("m1", "b", "小禾", "她每个周末都喜欢骑车", "周末运动", "骑车"),
  "pronouns/m3": pending("subject", "她不吃香菜", "香菜偏好", "不吃香菜"),
  "unknown-source/m1": pending("source", "小禾偏爱乌龙", "茶口味", "乌龙"),
  "unknown-source/m2": confirmed("m2", "b", "我", "我自己确实最喜欢乌龙", "茶口味", "乌龙"),
  "assistant-plan/m2": { confirmed: [], pending: [] },
  "withdrawal/m1": confirmed("m1", "b", "小禾", "小禾爱吃桂花糕", "早饭点心", "桂花糕"),
  "withdrawal/m2": confirmed("m2", "b", "我", "我喜欢无糖豆浆", "早饭饮品", "无糖豆浆"),
};

test("R4 固定语料经生产抽取解析和来源验证，计分不读取期望标签", async () => {
  const scores = [];
  let calls = 0;
  for (const timeline of timelines) {
    for (const probe of timeline.extraction) {
      const label = timeline.id + "/" + probe.messageId;
      const client: ModelClient = {
        provider: "mock",
        modelId: "scripted-extraction",
        async *stream() {
          calls++;
          const reply = responses[label];
          if (!reply) { throw new Error("探针意外调用模型：" + label); }
          yield { type: "text-delta", delta: JSON.stringify(reply) };
          yield { type: "finish", finishReason: "stop" };
        },
      };
      const { score } = await runExtractionProbe(timeline, probe, client);
      scores.push(score);
    }
  }
  const total = summarize(scores);
  console.log(JSON.stringify({ extraction: total, calls, probes: scores }));
  expect(calls).toBe(15);
  expect(total).toEqual({
    probes: 16, passedProbes: 16, expectedFacts: 12, matchedFacts: 12, emittedFacts: 12,
    expectedPending: 2, matchedPending: 2, violations: 0,
    recall: 1, precision: 1, pendingRecall: 1, passed: true,
  });
});
