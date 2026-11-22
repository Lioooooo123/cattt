import type { ContextProbe, ExtractionProbe, Fact, Pending, Subject, Timeline } from "./corpus.ts";

export interface ExtractionObservation {
  confirmed: readonly Fact[];
  pending: readonly Pending[];
}

export interface ContextObservation {
  entries: readonly { fact: Fact; section: Subject }[];
  memoryText: string;
}

interface Matches {
  expected: number;
  matched: number;
}

interface ProbeScore {
  probe: string;
  expectedFacts: number;
  matchedFacts: number;
  emittedFacts: number;
  expectedPending: number;
  matchedPending: number;
  violations: string[];
  passed: boolean;
}

function factKey({ subject, key, value, sourceMemberId, sourceMessageId }: Fact) {
  return JSON.stringify([subject, key, value, sourceMemberId, sourceMessageId]);
}

function pendingKey({ reason, messageId, key, value }: Pending) {
  return JSON.stringify([reason, messageId, key, value]);
}

function referencedKeys(timeline: Timeline, ids: readonly string[]) {
  return new Set(ids.map((id) => {
    const fact = timeline.facts[id];
    if (!fact) { throw new Error(`无效事实 ${timeline.id}/${id}`); }
    return factKey(fact);
  }));
}

function match(
  expected: ReadonlySet<string>, observed: readonly string[],
  classifyExtra: (key: string) => string | undefined, violations: string[],
): Matches {
  const seen = new Set<string>();
  let matched = 0;
  for (const key of observed) {
    if (seen.has(key)) { violations.push(`duplicate:${key}`); }
    else if (expected.has(key)) { matched++; }
    else {
      const violation = classifyExtra(key);
      if (violation) { violations.push(`${violation}:${key}`); }
    }
    seen.add(key);
  }
  return { expected: expected.size, matched };
}

function result(probe: string, facts: Matches, emittedFacts: number, pending: Matches, violations: string[]): ProbeScore {
  return {
    probe,
    expectedFacts: facts.expected,
    matchedFacts: facts.matched,
    emittedFacts,
    expectedPending: pending.expected,
    matchedPending: pending.matched,
    violations,
    passed: facts.matched === facts.expected && facts.matched === emittedFacts
      && pending.matched === pending.expected && violations.length === 0,
  };
}

export function scoreExtraction(timeline: Timeline, probe: ExtractionProbe, observation: ExtractionObservation) {
  const violations: string[] = [];
  const facts = match(
    referencedKeys(timeline, probe.mustConfirm), observation.confirmed.map(factKey),
    () => "unexpected_confirmed", violations,
  );
  const pending = match(
    new Set(probe.mustPend.map(pendingKey)), observation.pending.map(pendingKey),
    () => "unexpected_pending", violations,
  );
  return result(`${timeline.id}/${probe.messageId}`, facts, observation.confirmed.length, pending, violations);
}

export function scoreContext(timeline: Timeline, probe: ContextProbe, observation: ContextObservation) {
  const violations: string[] = [];
  const expected = referencedKeys(timeline, probe.mustInclude);
  const excluded = referencedKeys(timeline, probe.mustExclude);
  const distractors = referencedKeys(timeline, probe.distractors);
  const correctlyPlaced: string[] = [];
  for (const { fact, section } of observation.entries) {
    const key = factKey(fact);
    if (section === fact.subject) { correctlyPlaced.push(key); }
    else { violations.push(`wrong_section:${section}:${key}`); }
  }
  const facts = match(expected, correctlyPlaced, (key) => {
    if (excluded.has(key)) { return "forbidden_fact"; }
    return distractors.has(key) ? undefined : "unexpected_fact";
  }, violations);
  if (observation.entries.length > probe.budget.count) { violations.push("count_budget"); }
  if (observation.memoryText.length > probe.budget.characters) { violations.push("character_budget"); }
  return result(`${timeline.id}/${probe.query.id}`, facts, observation.entries.length, { expected: 0, matched: 0 }, violations);
}

export function summarize(scores: readonly ProbeScore[]) {
  const totals = {
    probes: scores.length, passedProbes: 0, expectedFacts: 0, matchedFacts: 0, emittedFacts: 0,
    expectedPending: 0, matchedPending: 0, violations: 0,
  };
  for (const score of scores) {
    totals.passedProbes += Number(score.passed);
    totals.expectedFacts += score.expectedFacts;
    totals.matchedFacts += score.matchedFacts;
    totals.emittedFacts += score.emittedFacts;
    totals.expectedPending += score.expectedPending;
    totals.matchedPending += score.matchedPending;
    totals.violations += score.violations.length;
  }
  return {
    ...totals,
    recall: totals.expectedFacts ? totals.matchedFacts / totals.expectedFacts : null,
    precision: totals.emittedFacts ? totals.matchedFacts / totals.emittedFacts : null,
    pendingRecall: totals.expectedPending ? totals.matchedPending / totals.expectedPending : null,
    passed: scores.length > 0 && totals.passedProbes === totals.probes,
  };
}
