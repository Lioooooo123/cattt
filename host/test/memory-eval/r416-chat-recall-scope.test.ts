import { expect, test } from "bun:test";
import { assembleChatRequest } from "../../src/context/chat.ts";
import type { ModelClient, ModelRequest } from "../../src/llm/types.ts";
import { withdrawKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { ChatReplier } from "../../src/turns/chat-replier.ts";
import type { ReplyPublicationGuard } from "../../src/turns/types.ts";
import { chatRecallScopeFixture, chatRecallScopeProbes } from "./chat-recall-scope-fixture.ts";

type Seed = ReturnType<typeof chatRecallScopeFixture>;

async function ask(seed: Seed, id: keyof typeof chatRecallScopeProbes) {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    provider: "openai-compatible", modelId: "scope-regression",
    async *stream(request) {
      request.guard?.();
      requests.push(request);
      yield { type: "text-delta", delta: "听见了。" };
      yield { type: "text-delta", delta: "我在窗边呢。" };
      yield { type: "finish", finishReason: "stop" };
    },
  };
  const reply = new ChatReplier(client, (input) => assembleChatRequest(seed.db, input));
  let guard: ReplyPublicationGuard | undefined;
  const chunks: string[] = [];
  for await (const part of reply.reply({
    ...seed.input(id), signal: new AbortController().signal, beforePublish: (value) => { guard = value; },
  })) {
    chunks.push(part);
  }
  expect(requests).toHaveLength(1);
  return { request: requests[0]!, evidence: guard!.knowledgeEvidence, chunks };
}

for (const id of ["cat-opinion", "cat-opinion-alternative", "companionship"] as const) {
  test(`${id}：同主题旧偏好不进入自由聊天，保留近轮原话和 Soul`, async () => {
    const seed = chatRecallScopeFixture();
    try {
      const recalled = await ask(seed, "explicit-recall");
      expect(recalled.request.system).toContain("青瓷");
      expect(recalled.evidence.some(({ kind }) => kind === "memory")).toBe(true);

      const { request, evidence, chunks } = await ask(seed, id);
      expect(request.extraBody?.response_format).toBeUndefined();
      expect(chunks).toEqual(["听见了。", "我在窗边呢。"]);
      expect(request.system).toContain("团子的当前相处信息");
      expect(request.system).toContain("只根据成员明确说出的内容判断眼前发生了什么");
      expect(request.system?.includes("直接回答团子自己的喜好")).toBe(id !== "companionship");
      expect(request.messages.some(({ content }) => content.includes(seed.nearby.text))).toBe(true);
      expect(request.system).not.toContain("## 相关记忆");
      expect(request.system).not.toMatch(/青瓷|黄铜|低沉/u);
      expect(evidence.some(({ kind }) => kind === "memory")).toBe(false);
    } finally { seed.store.close(); }
  });
}

test("明确回忆、比较、按本人偏好给建议、未指定范围的交谈及并列请求仍收到可用事实", async () => {
  const seed = chatRecallScopeFixture();
  try {
    for (const id of ["explicit-recall", "comparison", "personalized-advice", "unmarked-chat", "mixed-request"] as const) {
      const { request, chunks } = await ask(seed, id);
      expect(request.system).toContain("## 相关记忆");
      expect(request.system).toContain(id === "personalized-advice" ? "低沉" : "青瓷");
      if (id === "comparison") expect(request.system).toContain("黄铜");
      if (id === "personalized-advice" || id === "unmarked-chat") {
        expect(request.extraBody?.response_format).toBeUndefined();
        expect(chunks).toEqual(["听见了。", "我在窗边呢。"]);
        expect(request.system?.includes("按发言成员自己的已确认偏好提出一项建议")).toBe(id === "personalized-advice");
      }
    }
    expect(withdrawKnowledgeSource(seed.db, seed.clock, seed.actors.a, seed.second.id, 1)).toBeDefined();
    const { request } = await ask(seed, "unmarked-chat");
    expect(request.system).not.toContain("青瓷");
    expect(request.system).toContain("黄铜");
  } finally { seed.store.close(); }
});
