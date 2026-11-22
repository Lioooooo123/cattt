import type { Actor } from "../identity/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { habitText, baseline, soulCore } from "../soul/rules.ts";
import type { Habit, MessageProof, SoulChange, SoulEdit, SoulWithdrawal } from "../soul/rules.ts";
import { readCatFact, readCatFacts, saveCatFact } from "./cat-facts.ts";
import type { CatReader } from "./cat-facts.ts";
import { allowsSoulSource } from "./cat-source.ts";
import { isActiveDeviceActor } from "./identity.ts";
import { importedMemoryPreferences } from "./imported-history.ts";
import { importArchivedSoul } from "./legacy-soul.ts";
import { requireSharedPublisher } from "./publication.ts";
import { ensureWorld, readWorld } from "./world-state.ts";

export class SoulError extends Error {
  constructor(readonly code: "source_unavailable" | "version_conflict" | "not_found" | "unauthorized", readonly status: 401 | 404 | 409) {
    super(code);
  }
}
type Entry = { id: string | null; change: SoulChange; source: MessageProof };

function soulHistory(db: CatReader, catId: string) {
  const edits = readCatFacts(db, catId, "soul_edit").sort((a, b) => a.fact.version - b.fact.version);
  const withdrawals = readCatFacts(db, catId, "soul_withdrawal");
  const version = withdrawals.reduce((previous, { fact }) => Math.max(previous, fact.version), edits.at(-1)?.fact.version ?? 1);
  const withdrawn = new Set(withdrawals.map(({ fact }) => fact.entryId));
  return { edits, version, withdrawn, legacy: readCatFact(db, catId, "legacy_soul", "initial")?.fact };
}

function memberSpecific(change: SoulChange) {
  return change.kind === "nickname" || change.kind === "relationship";
}

export function currentSoul(db: CatReader, householdId: string, audience: readonly string[], now: number) {
  const world = readWorld(db, householdId);
  const history = world ? soulHistory(db, world.cat.id) : undefined;
  const dimensions = new Map<string, Entry>();
  const collect = (entry: Entry) => {
    const { change, source } = entry;
    if (memberSpecific(change) && !audience.includes(source.sourceMemberId)) return;
    dimensions.set(memberSpecific(change) ? `${source.sourceMemberId}:${change.kind}` : change.kind, entry);
  };
  for (const entry of history?.legacy?.entries ?? []) collect({ id: null, ...entry });
  if (history?.legacy?.state) collect({ id: null, ...history.legacy.state });
  for (const { id, fact } of history?.edits ?? []) collect({ id, change: fact.change, source: fact.source });

  const entries = [...dimensions.values()].filter(({ change, source, id }) => {
    if (change.kind === "state" && (now < change.observedAt || change.expiresAt <= now) || id && history?.withdrawn.has(id)) return false;
    if (importedMemoryPreferences(db, source.sourceMemberId)?.recallDisabled) return false;
    const text = change.kind === "nickname" ? change.value ?? ""
      : change.kind === "state" || change.kind === "relationship" ? "" : habitText(change);
    return allowsSoulSource(db, householdId, audience, source, text);
  });
  const state = entries.find(({ change }) => change.kind === "state")?.change;
  const runtime = state?.kind === "state"
    ? { energy: state.energy, willingness: state.willingness, expires_at: state.expiresAt } : baseline;
  const habits = entries.flatMap(({ change }) => change.kind === "state" || change.kind === "relationship" || change.kind === "nickname"
    ? [] : [change]);
  const relationships = audience.map((id) => {
    const own = entries.filter(({ source }) => source.sourceMemberId === id);
    const nickname = own.find(({ change }) => change.kind === "nickname")?.change;
    const relationship = own.find(({ change }) => change.kind === "relationship")?.change;
    return { member_id: id, nickname: nickname?.kind === "nickname" ? nickname.value : null,
      kind: relationship?.kind === "relationship" ? relationship.value : "getting_to_know" as const };
  });
  return {
    version: history?.version ?? 1, core: soulCore, runtime, habits, relationships, evidence: entries.map(({ source }) => source),
    entryVersions: entries.map(({ id, change, source }) => ({
      id, kind: change.kind, ...(memberSpecific(change) && { member_id: source.sourceMemberId }),
    })),
    legacy: history?.legacy
      ? { status: "mapped" as const, version: history.legacy.version, unmapped: history.legacy.unmapped,
          source_sha256: history.legacy.sourceHash }
      : world?.cat.legacyId ? { status: "publisher_required" as const } : null,
  };
}

export function projectSoul(db: CatReader, actor: Actor, now: number) {
  const soul = currentSoul(db, actor.householdId, [actor.memberId], now);
  return {
    version: soul.version, core: soul.core, runtime: soul.runtime, entries: soul.entryVersions,
    habits: Object.fromEntries(soul.habits.map(({ kind, value }) => [kind, value])) as Partial<Record<Habit["kind"], Habit["value"]>>,
    relationship: soul.relationships[0]!, legacy: soul.legacy ?? null,
  };
}

export function updateSoul(ctx: HostContext, actor: Actor, input: SoulEdit | SoulWithdrawal) {
  return ctx.store.db.transaction((tx) => {
    if (!isActiveDeviceActor(tx, actor)) throw new SoulError("unauthorized", 401);
    const { householdId, memberId } = actor;
    const proof = requireSharedPublisher(tx, householdId, ctx.publication);
    const { cat } = ensureWorld(tx, ctx.clock, proof);
    importArchivedSoul(tx, ctx, proof, cat);
    const history = soulHistory(tx, cat.id);
    const now = ctx.clock.wallMs();
    const view = () => projectSoul(tx, actor, now);
    const version = history.version + 1;
    if ("entry_id" in input) {
      const entry = history.edits.find(({ id }) => id === input.entry_id);
      if (!entry || entry.fact.source.sourceMemberId !== memberId) throw new SoulError("not_found", 404);
      if (history.withdrawn.has(entry.id)) return view();
      if (input.expected_version !== history.version) throw new SoulError("version_conflict", 409);
      saveCatFact(tx, ctx, proof, cat.id, { type: "soul_withdrawal", version, entryId: entry.id, memberId });
      return view();
    }
    const source = { kind: "message", sourceMemberId: memberId,
      sourceMessageId: input.source.message_id, sourceRevision: input.source.revision } as const;
    const { change } = input;
    const text = change.kind === "nickname" ? change.value ?? "" : "";
    if (importedMemoryPreferences(tx, memberId)?.learningDisabled || !allowsSoulSource(tx, householdId, [memberId], source, text)) {
      throw new SoulError("source_unavailable", 409);
    }
    if (history.edits.some(({ fact }) => fact.source.sourceMessageId === source.sourceMessageId && fact.change.kind === change.kind)
      || history.legacy?.entries.some((entry) => entry.source.sourceMessageId === source.sourceMessageId && entry.change.kind === change.kind)
      || change.kind === "state" && history.legacy?.state?.source.sourceMessageId === source.sourceMessageId) return view();
    if (input.expected_version !== history.version) throw new SoulError("version_conflict", 409);
    const applied: SoulChange = change.kind === "state" ? { kind: change.kind, energy: change.energy,
      willingness: change.willingness, observedAt: now, expiresAt: now + change.duration_minutes * 60_000 } : change;
    saveCatFact(tx, ctx, proof, cat.id, { type: "soul_edit", version, source, change: applied });
    return view();
  }, { behavior: "immediate" });
}
