import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Message } from "../../src/conversations/types.ts";
import { revision } from "../../src/store/business.ts";
import { readMessages } from "../../src/store/conversations.ts";
import { createDiaryEntry, setDiaryCatAllowed } from "../../src/store/diary.ts";
import { createBoundary, createMemoryBlock, listAvailableMemories, replaceMemory, saveMemory } from "../../src/store/knowledge.ts";
import type { Memory } from "../../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { messages } from "../../src/store/schema/conversations.ts";
import { observeContext, setupContextFixture } from "./context-fixture.ts";
import { controlledCandidates } from "./controlled-context-input.ts";
import { contextInput, timelines } from "./corpus.ts";
import type { MemberId } from "./corpus.ts";
import { scoreContext, summarize } from "./score.ts";

test("R4 SQLite 冷窗口评测从实际模型请求计分", async () => {
  const scores: (ReturnType<typeof scoreContext> & { memoryUtf16: number })[] = [];
  for (const timeline of timelines) {
    for (const probe of timeline.context) {
      const seed = setupContextFixture();
      try {
        const { events, query } = contextInput(timeline, probe);
        const ledger = new Map<string, Message>();
        const written = new Map<string, Memory>();
        const candidates = controlledCandidates[timeline.id]!;
        for (const event of events) {
          if (event.kind === "withdraw") {
            const withdrawn = ledger.get(event.messageId)!;
            expect(withdrawKnowledgeSource(seed.db, seed.clock, seed.actors[event.author], withdrawn.id, 1)).toBeDefined();
            continue;
          }
          const message = seed.append(event);
          ledger.set(event.id, message);
          for (const [, subject, predicate, value, replaces] of candidates.filter(([id]) => id === event.id)) {
            const input = {
              ...seed.source(message), subjectMemberId: subject === "pair" ? null : seed.actors[subject].memberId,
              fingerprint: predicate, predicate, value,
            };
            const old = replaces ? written.get(replaces)! : undefined;
            const memory = old && event.author !== "cat"
              ? replaceMemory(seed.db, seed.clock, seed.actors[event.author], old.id, old.rev, input)
              : saveMemory(seed.db, seed.clock, input);
            expect(memory, `${timeline.id}/${event.id} 写入`).toBeDefined();
            written.set(event.id, memory!);
          }
        }
        const available = listAvailableMemories(seed.db, { householdId: seed.householdId });
        if (timeline.id.endsWith("-budget")) {
          expect(available).toHaveLength(candidates.length);
        }
        const trigger = seed.append(query);
        const { system, messages: outgoing } = await seed.request(trigger);
        expect(outgoing).toHaveLength(1);
        const labelByMember = new Map<string, MemberId>([
          [seed.actors.a.memberId, "a"], [seed.actors.b.memberId, "b"],
        ]);
        const labelsByMessage = new Map([...ledger].map(([label, row]) => [row.id, label]));
        const observation = observeContext(system!, labelByMember, labelsByMessage);
        scores.push({ ...scoreContext(timeline, probe, observation), memoryUtf16: observation.memoryText.length });
      } finally {
        seed.store.close();
      }
    }
  }
  console.log(JSON.stringify({
    context: summarize(scores),
    probes: scores.map(({ probe, matchedFacts, expectedFacts, emittedFacts, memoryUtf16, violations }) =>
      ({ probe, matchedFacts, expectedFacts, emittedFacts, memoryUtf16, violations })),
  }));
  expect(summarize(scores)).toEqual({
    probes: 15, passedProbes: 15, expectedFacts: 25, matchedFacts: 25, emittedFacts: 25,
    expectedPending: 0, matchedPending: 0, violations: 0,
    recall: 1, precision: 1, pendingRecall: null, passed: true,
  });
});

test("现轮复核撤回、改版、回避和日记许可，聊天 UI 历史原样保留", async () => {
  const seed = setupContextFixture();
  const { store, db, clock, actors, ids, source, send, append, request, model } = seed;
  try {
    const revoked = send("w", "a", "拐角地标_撤回原话");
    const oldReply = append({ kind: "message", id: "cat", author: "cat", conversation: "group", text: "团子复述撤回原话" }, revoked.id);
    const stale = send("edit", "a", "咖啡杯型_旧版原话");
    const oldFact = saveMemory(db, clock, {
      ...source(stale), subjectMemberId: actors.a.memberId, fingerprint: "size", predicate: "咖啡杯型", value: "特大杯",
    });
    expect(oldFact).toBeDefined();
    db.update(messages).set({ ...revision(clock), rev: 2, text: "咖啡杯型_修订原话" }).where(eq(messages.id, stale.id)).run();
    expect(withdrawKnowledgeSource(db, clock, actors.a, revoked.id, 1)).toBeDefined();

    const exam = send("exam", "a", "阿岚准备面试_避免原话");
    const aboutB = saveMemory(db, clock, {
      ...source(exam), subjectMemberId: actors.b.memberId, fingerprint: "exam", predicate: "面试", value: "地点_避免事实",
    });
    expect(aboutB).toBeDefined();
    const boundary = send("b-boundary", "b", "别跟我提面试_设置原话", "direct-b");
    expect(createBoundary(db, clock, {
      ...source(boundary), subjectMemberId: actors.b.memberId, description: "面试",
    })).toBeDefined();

    const diary = (text: string, catAllowed: boolean) =>
      createDiaryEntry(db, clock, actors.a, {
        text, catAllowed, recordedAt: clock.wallMs(), timeZone: "UTC",
        localDay: new Date(clock.wallMs()).toISOString().slice(0, 10),
      });
    const disabled = diary("咖啡日记_旧分享", true);
    diary("咖啡日记_允许读取", true);
    diary("咖啡日记_默认私密", false);
    expect(setDiaryCatAllowed(db, clock, actors.a, disabled.id, disabled.rev, false)).toBeDefined();

    const trigger = send("q", "b", "说说咖啡日记和面试？");
    const outgoing = await request(trigger, [revoked, oldReply, stale, exam, trigger]);
    expect(outgoing.messages).toEqual([{ role: "user", content: '"小禾"：说说咖啡日记和面试？' }]);
    expect(outgoing.system).toContain("面试");
    expect(outgoing.system).toContain("小禾");
    expect(outgoing.system).toContain("咖啡日记_允许读取");
    for (const content of ["拐角地标", "撤回原话", "特大杯", "避免事实", "旧分享", "默认私密"]) {
      expect(outgoing.system).not.toContain(content);
    }
    const uiHistory = readMessages(db, actors.a, ids.group).messages;
    expect(uiHistory).toContainEqual(revoked);
    expect(uiHistory).toContainEqual(oldReply);
    expect(uiHistory.find(({ id }) => id === stale.id)?.text).toBe("咖啡杯型_修订原话");

    await expect(request(revoked)).rejects.toThrow();
    expect(model.requests).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("共同主体幂等、可单独屏蔽，成对候选超过 UTF-16 预算时整组跳过", async () => {
  const seed = setupContextFixture();
  const { store, db, clock, actors, source, send, request, householdId } = seed;
  try {
    const joint = send("joint", "a", "约好都喝咖啡");
    const shared = { ...source(joint), subjectMemberId: null, fingerprint: "共同咖啡", predicate: "共同咖啡", value: "热美式" };
    const pair = saveMemory(db, clock, shared)!;
    expect(pair.subjectMemberId).toBeNull();
    expect(saveMemory(db, clock, shared)).toEqual(pair);
    const make = (author: MemberId, value: string) => saveMemory(db, clock, {
      ...source(send(author, author, "我选了咖啡温度")),
      subjectMemberId: actors[author].memberId, fingerprint: "咖啡温度", predicate: "咖啡温度", value,
    });
    expect(make("a", "冰")).toBeDefined();
    expect(make("b", "🧊".repeat(1150))).toBeDefined();
    const filter = listAvailableMemories(db, { householdId, subjectMemberId: null });
    expect(filter).toEqual([pair]);

    const forget = send("forget", "a", "共同咖啡就别留了");
    expect(createMemoryBlock(db, clock, { ...shared, ...source(forget) })).toBeDefined();
    expect(listAvailableMemories(db, { householdId })).toHaveLength(2);
    expect(saveMemory(db, clock, shared)).toBeUndefined();
    const outgoing = await request(send("q", "b", "我们分别要什么咖啡温度？"));
    expect(outgoing.system).not.toContain("## 相关记忆");
  } finally {
    store.close();
  }
});
