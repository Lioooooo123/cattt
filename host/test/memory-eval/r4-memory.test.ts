import { describe, expect, test } from "bun:test";
import { contextInput, extractionInput, members, timelines } from "./corpus.ts";
import type { Timeline } from "./corpus.ts";
import { scoreContext, scoreExtraction, summarize } from "./score.ts";

function timeline(id: string) {
  return timelines.find((item) => item.id === id)!;
}

function visible(fixture: Timeline, ids: readonly string[]) {
  return ids.map((id) => ({ fact: fixture.facts[id]!, section: fixture.facts[id]!.subject }));
}

function render(entries: ReturnType<typeof visible>) {
  return entries.map(({ fact, section }) => {
    const subject = section === "pair" ? "你们俩" : members[section];
    return `关于${subject}：${fact.key}=${fact.value}（来源：${members[fact.sourceMemberId]}）`;
  }).join("\n");
}

describe("R4 双成员记忆评测", () => {
  test("语料引用可按时间回放，标注可通过各阶段门槛", () => {
    expect(new Set(timelines.map(({ id }) => id)).size).toBe(timelines.length);
    for (const fixture of timelines) {
      const events = new Map(fixture.events.map((event) => [event.id, event]));
      expect(events.size).toBe(fixture.events.length);
      for (const fact of Object.values(fixture.facts)) {
        expect(events.get(fact.sourceMessageId)).toMatchObject({
          kind: "message", author: fact.sourceMemberId,
        });
      }
      for (const event of fixture.events) {
        if (event.kind === "withdraw") {
          const source = events.get(event.messageId);
          expect(source).toMatchObject({ kind: "message", author: event.author });
          expect(fixture.events.indexOf(source!)).toBeLessThan(fixture.events.indexOf(event));
        }
      }
      for (const probe of fixture.extraction) {
        const input = extractionInput(fixture, probe);
        const confirmed = probe.mustConfirm.map((id) => fixture.facts[id]!);
        expect(input.message.id).toBe(probe.messageId);
        expect(input.history.every((message) => message.conversation === input.message.conversation)).toBe(true);
        expect(confirmed.every(({ sourceMessageId }) => sourceMessageId === input.message.id)).toBe(true);
        expect(scoreExtraction(fixture, probe, { confirmed, pending: probe.mustPend }).passed).toBe(true);
      }
      for (const probe of fixture.context) {
        const input = contextInput(fixture, probe);
        expect(input.events.at(-1)?.id).toBe(probe.after);
        expect(input.query.id).toBe(probe.query.id);
        for (const id of [...probe.mustInclude, ...probe.mustExclude, ...probe.distractors]) {
          expect(input.candidates).toContain(fixture.facts[id]!);
        }
        const entries = visible(fixture, probe.mustInclude);
        expect(scoreContext(fixture, probe, { entries, memoryText: render(entries) }).passed).toBe(true);
      }
    }
  });

  test("待确认单独计分，已知事实降格后仍未命中", () => {
    const fixture = timeline("pronouns");
    const [known, unknown] = fixture.extraction;
    const pending = [{
      messageId: known!.messageId, reason: "subject" as const, key: "周末运动", value: "骑车",
    }];
    expect(scoreExtraction(fixture, known!, { confirmed: [], pending })).toMatchObject({
      matchedFacts: 0, expectedFacts: 1, expectedPending: 0, matchedPending: 0, passed: false,
    });
    expect(scoreExtraction(fixture, unknown!, { confirmed: [], pending: unknown!.mustPend })).toMatchObject({
      matchedFacts: 0, expectedFacts: 0, expectedPending: 1, matchedPending: 1, passed: true,
    });
    expect(scoreExtraction(fixture, unknown!, { confirmed: [], pending: [] }).passed).toBe(false);
    expect(scoreExtraction(fixture, unknown!, {
      confirmed: [{ ...fixture.facts["b-bike"]!, sourceMessageId: unknown!.messageId }],
      pending: unknown!.mustPend,
    }).violations).toHaveLength(1);
  });

  test("同值保留两条，互换来源、放错分节和重复均触发违例", () => {
    const fixture = timeline("same-preference");
    const probe = fixture.context[0]!;
    const [a, b] = visible(fixture, probe.mustInclude);
    const wrongSource = { ...b!, fact: { ...b!.fact, sourceMemberId: a!.fact.sourceMemberId } };
    const wrongSection = { ...b!, section: a!.section };
    for (const wrong of [wrongSource, wrongSection, a!]) {
      const entries = [a!, wrong];
      const result = scoreContext(fixture, probe, { entries, memoryText: render(entries) });
      expect(result).toMatchObject({ expectedFacts: 2, matchedFacts: 1, passed: false });
      expect(result.violations).toHaveLength(1);
    }
  });

  test("无候选基线保持空分母，越界与排序损失分别报数", () => {
    const empty = summarize(timelines.flatMap((fixture) => fixture.context.map((probe) =>
      scoreContext(fixture, probe, { entries: [], memoryText: "" }),
    )));
    expect(empty.expectedFacts).toBeGreaterThan(0);
    expect(empty).toMatchObject({ matchedFacts: 0, precision: null, violations: 0, passed: false });

    for (const id of ["opposite-and-correction", "withdrawal"]) {
      const fixture = timeline(id);
      const probe = fixture.context.at(-1)!;
      const entries = visible(fixture, [...probe.mustInclude, ...probe.mustExclude]);
      expect(scoreContext(fixture, probe, { entries, memoryText: render(entries) }).violations).toHaveLength(1);
    }
    const fixture = timeline("count-budget");
    const probe = fixture.context[0]!;
    const entries = visible(fixture, [...probe.mustInclude.slice(0, 7), probe.distractors[0]!]);
    const result = scoreContext(fixture, probe, { entries, memoryText: render(entries) });
    expect(result).toMatchObject({ matchedFacts: 7, emittedFacts: 8, violations: [], passed: false });
    expect(summarize([result]).precision).toBe(7 / 8);
  });

  test("条数和实际渲染字符分别守预算，夹具能触发竞争", () => {
    const count = timeline("count-budget");
    const countProbe = count.context[0]!;
    const countEntries = visible(count, [...countProbe.mustInclude, ...countProbe.distractors]);
    const allCount = scoreContext(count, countProbe, { entries: countEntries, memoryText: render(countEntries) });
    expect(allCount.violations).toEqual(["count_budget"]);
    expect(contextInput(count, countProbe).candidates).toHaveLength(12);

    const chars = timeline("character-budget");
    const charsProbe = chars.context[0]!;
    const charEntries = visible(chars, [...charsProbe.mustInclude, ...charsProbe.distractors]);
    const allChars = scoreContext(chars, charsProbe, { entries: charEntries, memoryText: render(charEntries) });
    expect(allChars.violations).toEqual(["character_budget"]);
    expect(charEntries.length).toBeLessThan(charsProbe.budget.count);
  });
});
