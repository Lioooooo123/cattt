import { expect, test } from "bun:test";
import { setupContextFixture } from "./context-fixture.ts";
import { chatEvidenceProbes } from "./r4-chat-evidence-probes.ts";

const probeIds = [
  "renamed-source-and-subject", "no-evidence", "assistant-proposal", "before-withdrawal", "after-withdrawal",
];

test.each(probeIds)("正式聊天请求保留可判定的证据边界 (%s)", async (id) => {
  const seed = setupContextFixture();
  try {
    for (const probe of chatEvidenceProbes(seed)) {
      if (probe.id !== id) { continue; }
      const outgoing = await seed.request(probe.trigger, probe.history);
      expect(seed.model.requests).toHaveLength(1);
      expect(outgoing.messages.at(-1)).toEqual({
        role: "user", content: `${JSON.stringify(probe.speaker)}：${probe.trigger.text}`,
      });
      const system = outgoing.system!;
      const memory = system.split("\n\n## 相关记忆\n")[1] ?? "";
      const entries = memory.split("\n").filter((line) => line.startsWith("- ")).map((line) => JSON.parse(line.slice(2)));
      expect(entries).toHaveLength(probe.memories.length);
      const names = new Map([[seed.actors.a.memberId, "沈乔"], [seed.actors.b.memberId, "林溪"]]);
      for (const fact of probe.memories) {
        expect(entries).toContainEqual(expect.objectContaining({
          subjectMember: names.get(fact.subjectMemberId!),
          subjectMemberId: fact.subjectMemberId,
          predicate: fact.predicate,
          value: fact.value,
          sourceMember: names.get(fact.sourceMemberId),
          sourceMemberId: fact.sourceMemberId,
          sourceMessageId: fact.sourceMessageId,
          sourceRevision: fact.sourceRevision,
        }));
      }
      if (id === "renamed-source-and-subject") {
        expect(system).not.toMatch(/阿岚|小禾|我常喝焙茶，她常喝白茶/);
        expect(outgoing.messages).toHaveLength(1);
        expect(system).toContain("本轮问题中的“我”指发问成员");
      } else if (id === "no-evidence" || id === "assistant-proposal") {
        expect(system).toContain("本轮未召回获准记忆或日记");
        expect(system).toContain("直接说目前无法确认");
        expect(system).toContain("问题里的猜测");
        if (id === "assistant-proposal") {
          expect(outgoing.messages).toContainEqual({ role: "assistant", content: "可以试试燕麦拿铁，看合不合口味。" });
          expect(system).toContain("团子的旧回复、提议和计划只用于衔接");
        }
      } else {
        const visible = outgoing.messages.map(({ content }) => content).join("\n");
        expect(visible).toContain("温牛奶");
        if (id === "before-withdrawal") {
          expect(visible).toContain("我早餐常吃芝麻饼。");
          expect(outgoing.messages).toContainEqual({ role: "assistant", content: "嗯，早餐常吃芝麻饼。" });
          expect(memory).toContain("芝麻饼");
        } else {
          expect(visible).not.toContain("芝麻饼");
          expect(memory).not.toContain("芝麻饼");
          expect(system).toContain("逐项判断");
        }
      }
      return;
    }
    throw new Error(`未运行证据探针 ${id}`);
  } finally {
    seed.store.close();
  }
});
