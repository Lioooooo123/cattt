import type { DiaryEntry } from "../store/diary.ts";
import type { Boundary, Memory } from "../store/knowledge.ts";
import type { RecallEvidence } from "../store/knowledge-use.ts";
import { rankAgainst } from "./relevance.ts";

const MAX_ENTRIES = 8;
const MAX_UTF16 = 2400;

type KnowledgeEntry = Pick<Memory, "id" | "rev" | "hlc" | "subjectMemberId" | "predicate" | "value"
  | "sourceMemberId" | "sourceRevision"> & { sourceMessageId: string | null; diaryEntryId?: string };
type RankedEntry = { entry: KnowledgeEntry; score: number; predicateHits: string[] };
type Names = ReadonlyMap<string, string>;

export function memberLabel(names: Names, id: string): string | undefined {
  const name = names.get(id);
  return name !== undefined && [...names.values()].filter((value) => value === name).length > 1
    ? `${name}（成员 ${id}）` : name;
}

function provenance(entry: Pick<KnowledgeEntry, "sourceMemberId" | "sourceMessageId" | "sourceRevision">, names: Names) {
  return {
    sourceMember: memberLabel(names, entry.sourceMemberId)!,
    sourceMemberId: entry.sourceMemberId,
    sourceMessageId: entry.sourceMessageId,
    sourceRevision: entry.sourceRevision,
  };
}

function heading(memberId: string | null, names: Names): string {
  if (memberId === null) {
    return "### 关于你们俩";
  }
  return `### 关于成员 ${JSON.stringify(memberLabel(names, memberId))}`;
}

function renderKnowledge(entries: readonly KnowledgeEntry[], names: Names): string {
  if (entries.length === 0) {
    return "";
  }
  const sections = new Map<string | null, string[]>();
  for (const entry of entries) {
    const { subjectMemberId, predicate, value, diaryEntryId } = entry;
    const subjectMember = subjectMemberId === null ? "两位成员共同" : memberLabel(names, subjectMemberId)!;
    const line = "- " + JSON.stringify({ subjectMember, subjectMemberId, predicate, value, diaryEntryId, ...provenance(entry, names) });
    const section = sections.get(subjectMemberId);
    if (section) {
      section.push(line);
    } else {
      sections.set(subjectMemberId, [heading(subjectMemberId, names), line]);
    }
  }
  return "\n\n## 相关记忆\n" + [...sections.values()].map((lines) => lines.join("\n")).join("\n");
}

function compareRank(a: RankedEntry, b: RankedEntry): number {
  return b.score - a.score || b.entry.hlc.localeCompare(a.entry.hlc) || a.entry.id.localeCompare(b.entry.id);
}

function recallUnits(ranked: RankedEntry[]): RankedEntry[][] {
  // The strongest fact for each member in the same slot competes as one unit.
  // This protects both agreement and disagreement at the count/character cutoff.
  const slots = new Map<string, RankedEntry[]>();
  for (const item of ranked) {
    if (item.entry.subjectMemberId === null || item.entry.diaryEntryId) {
      continue;
    }
    const key = item.entry.predicate.normalize("NFKC").trim().toLowerCase();
    const group = slots.get(key) ?? [];
    if (!group.some(({ entry }) => entry.subjectMemberId === item.entry.subjectMemberId)) {
      group.push(item);
      slots.set(key, group);
    }
  }
  const companions = new Map<RankedEntry, RankedEntry[]>();
  for (const group of slots.values()) {
    if (group.length > 1) {
      for (const item of group) {
        companions.set(item, group);
      }
    }
  }
  return ranked.flatMap((item) => {
    const group = companions.get(item);
    return item.score > 0 && (!group || group[0] === item) ? [group ?? [item]] : [];
  });
}

export function renderBoundaries(boundaries: readonly Boundary[], names: Names): string {
  if (boundaries.length === 0) {
    return "";
  }
  const lines = boundaries.map((boundary) => "- " + JSON.stringify({
    member: memberLabel(names, boundary.subjectMemberId)!,
    memberId: boundary.subjectMemberId,
    topic: boundary.description,
    ...provenance(boundary, names),
  }));
  return "\n\n## 回避话题\n尊重相应成员的回避设置。仅在该成员本轮主动重提时回应，勿主动展开。\n"
    + lines.join("\n");
}

function diaryEntry(diary: DiaryEntry): KnowledgeEntry {
  return {
    id: diary.id,
    rev: diary.rev,
    hlc: diary.hlc,
    subjectMemberId: diary.ownerMemberId,
    predicate: `${diary.localDay} 日记`,
    value: diary.text,
    diaryEntryId: diary.id,
    sourceMemberId: diary.sourceMemberId,
    sourceMessageId: diary.sourceMessageId,
    sourceRevision: diary.sourceRevision ?? diary.rev,
  };
}

export function recallKnowledge(
  query: string, memories: readonly Memory[], diaries: readonly DiaryEntry[], names: Names,
  avoided: (text: string) => boolean,
): { text: string; evidence: RecallEvidence[]; facts: KnowledgeEntry[] } {
  const rank = rankAgainst(query);
  const entries: KnowledgeEntry[] = [...memories, ...diaries.map(diaryEntry)];
  const ranked = entries.flatMap((entry) => {
    const validSubject = entry.subjectMemberId === null ? names.size === 2 : names.has(entry.subjectMemberId);
    return validSubject && names.has(entry.sourceMemberId)
      && !avoided(`${entry.predicate} ${entry.value}`) ? [{ entry, ...rank(entry.predicate, entry.value) }] : [];
  }).sort(compareRank);
  const units = recallUnits(ranked);
  const candidates = units.flatMap((group) => group.map(({ entry }) => entry));
  // Keep broad overlap in roomy requests. Under pressure, prefer facts that cover
  // the specific dimensions the question mentions over topic-only matches.
  const constrained = candidates.length > MAX_ENTRIES || renderKnowledge(candidates, names).length > MAX_UTF16;
  const covered: Set<string>[] = [];
  let selected: KnowledgeEntry[] = [];
  let rendered = "";
  for (const group of units) {
    if (selected.length + group.length > MAX_ENTRIES) {
      continue;
    }
    const hits = new Set(group.flatMap(({ predicateHits }) => predicateHits));
    if (constrained && hits.size > 0 && covered.some((prior) =>
      prior.size > hits.size && [...hits].every((token) => prior.has(token)),
    )) {
      continue;
    }
    const next = [...selected, ...group.map(({ entry }) => entry)];
    const text = renderKnowledge(next, names);
    if (text.length <= MAX_UTF16) {
      selected = next;
      rendered = text;
      covered.push(hits);
    }
    if (selected.length === MAX_ENTRIES) {
      break;
    }
  }
  return {
    text: rendered,
    facts: selected.filter(({ diaryEntryId }) => !diaryEntryId),
    evidence: selected.map(({ id, rev, diaryEntryId }) => ({ id, rev, kind: diaryEntryId ? "diary" : "memory" })),
  };
}
