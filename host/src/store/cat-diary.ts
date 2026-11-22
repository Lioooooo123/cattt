import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { localISO } from "../tickets/time.ts";
import { textSha256 } from "../import-pg/values.ts";
import type { Actor } from "../identity/index.ts";
import type { PublicationProof } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { readKnowledgePolicy } from "../context/policy.ts";
import { dayStart, localDay, nextDay } from "../soul/diary-date.ts";
import { composeDailyDraft, diaryReflection, safeReflection } from "../soul/diary-writer.ts";
import type { DiaryCard } from "../soul/diary-writer.ts";
import { catFactKey, diaryDraftSchema } from "../soul/facts.ts";
import type { ConfirmDiary, DiaryDraft, DiarySource, FactsOf } from "../soul/facts.ts";
import { soulCore } from "../soul/rules.ts";
import type { WorldSnapshot } from "../world/protocol.ts";
import { diaryPlanProgress, readCatFact, readCatFacts, saveCatFact } from "./cat-facts.ts";
import type { CatReader } from "./cat-facts.ts";
import { diarySourceUse } from "./cat-source.ts";
import { isActiveDeviceActor, listMembers } from "./identity.ts";
import { listImportedCatDiary } from "./imported-history.ts";
import { jobs } from "./schema/index.ts";
import { enqueueJob, getHeldJob } from "./jobs.ts";
import type { JobAttempt } from "./jobs.ts";
import { readProactivePermission } from "./proactive-permission.ts";
import { readPublicationRoute, requireSharedPublisher } from "./publication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { importArchivedSoul } from "./legacy-soul.ts";
import { SoulError } from "./soul.ts";
import { ensureWorld, readWorld } from "./world-state.ts";

export const queue = "daily-cat-diary";
export const publishQueue = "publish-cat-diary";
export const diaryJobSchema = z.strictObject({ catId: z.uuidv7(), day: z.iso.date(), epoch: z.int().positive(), grantId: z.uuid() });
export type DiaryJob = z.infer<typeof diaryJobSchema>;
export const diaryPublicationSchema = diaryJobSchema.extend({
  draft: diaryDraftSchema, inputHash: z.string().regex(/^[0-9a-f]{64}$/),
});
type Plan = FactsOf<"diary_plan">;
type DailyEntry = FactsOf<"daily_diary">;

function currentTimeZone(db: CatReader, catId: string) {
  const overrides = readCatFacts(db, catId, "diary_timezone");
  const latest = overrides.reduce<typeof overrides[number] | undefined>((prior, row) =>
    !prior || row.fact.version > prior.fact.version ? row : prior, undefined);
  const calendar = readCatFact(db, catId, "diary_calendar", "initial")?.fact;
  return { calendar, zone: latest?.fact.timeZone ?? calendar?.timeZone, version: latest?.fact.version ?? 0 };
}

function ensureCalendar(tx: ReplicationTx, ctx: HostContext, proof: PublicationProof, catId: string) {
  const present = currentTimeZone(tx, catId);
  if (present.calendar) return { calendar: present.calendar, zone: present.zone!, version: present.version };
  const [first] = listMembers(tx, proof.householdId);
  const timeZone = readProactivePermission(tx, first?.id ?? "").timeZone;
  const calendar = { type: "diary_calendar", timeZone, startDay: localDay(ctx.clock.wallMs(), timeZone) } as const;
  saveCatFact(tx, ctx, proof, catId, calendar);
  return { calendar, zone: timeZone, version: 0 };
}

export function setDiaryTimeZone(ctx: HostContext, actor: Actor, timeZone: string, expectedVersion: number) {
  return ctx.store.db.transaction((tx) => {
    if (!isActiveDeviceActor(tx, actor)) throw new SoulError("unauthorized", 401);
    const proof = requireSharedPublisher(tx, actor.householdId, ctx.publication);
    const { cat } = ensureWorld(tx, ctx.clock, proof);
    const current = ensureCalendar(tx, ctx, proof, cat.id);
    if (current.zone === timeZone) return { time_zone: timeZone, version: current.version };
    if (current.version !== expectedVersion) throw new SoulError("version_conflict", 409);
    const version = current.version + 1;
    saveCatFact(tx, ctx, proof, cat.id, { type: "diary_timezone", timeZone, version });
    return { time_zone: timeZone, version };
  }, { behavior: "immediate" });
}

export function confirmDiarySource(ctx: HostContext, actor: Actor, input: ConfirmDiary) {
  return ctx.store.db.transaction((tx) => {
    if (!isActiveDeviceActor(tx, actor)) throw new SoulError("unauthorized", 401);
    const { householdId, memberId } = actor;
    const proof = requireSharedPublisher(tx, householdId, ctx.publication);
    const { cat } = ensureWorld(tx, ctx.clock, proof);
    const source: DiarySource = input.kind === "diary" ? { kind: "diary", id: input.id, rev: input.revision }
      : { kind: "message", sourceMemberId: memberId, sourceMessageId: input.id, sourceRevision: input.revision };
    if (!diarySourceUse(tx, householdId, memberId, source)) throw new SoulError("source_unavailable", 409);
    const fact = { type: "diary_source", memberId, source } as const;
    const existing = readCatFact(tx, cat.id, "diary_source", catFactKey(fact));
    return { confirmed: true, id: existing?.id ?? saveCatFact(tx, ctx, proof, cat.id, fact).id };
  }, { behavior: "immediate" });
}

export function recordWorldObservation(
  tx: ReplicationTx, ctx: HostContext, proof: PublicationProof, catId: string, snapshot: WorldSnapshot, observedAt: number,
) {
  if (!snapshot.runnable || snapshot.paused || (snapshot.phase !== "idle" && snapshot.phase !== "interacting")) return;
  const { zone } = ensureCalendar(tx, ctx, proof, catId);
  const fact = { type: "diary_observation", day: localDay(observedAt, zone), timeZone: zone,
    destination: snapshot.currentDestinationId, observedAt } as const;
  if (!readCatFact(tx, catId, fact.type, catFactKey(fact))) saveCatFact(tx, ctx, proof, catId, fact);
}

function workKey({ catId, day, grantId }: DiaryJob) {
  return `${catId}:${day}:${grantId}`;
}

export function hasDiaryDraft(db: CatReader, job: DiaryJob) {
  const existing = db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.queue, publishQueue), eq(jobs.dedupeKey, workKey(job)), inArray(jobs.status, ["queued", "running"]),
  )).get();
  return existing !== undefined;
}

export function scanCatDiary(ctx: HostContext) {
  const { clock, householdId, publication, store } = ctx;
  const pending = store.db.transaction((tx) => {
    const route = readPublicationRoute(tx, householdId, publication);
    if (route.status !== "ready" || !listMembers(tx, householdId).length) return;
    const proof = requireSharedPublisher(tx, householdId, publication, route.current);
    const current = readWorld(tx, householdId);
    // A pristine joining host may still be waiting for the origin's world.
    const world = current ?? ensureWorld(tx, clock, proof);
    importArchivedSoul(tx, ctx, proof, world.cat);
    const { id: catId } = world.cat;
    const { calendar, zone } = ensureCalendar(tx, ctx, proof, catId);
    const local = localISO(clock.wallMs(), zone);
    const last = nextDay(local.slice(0, 10), local.slice(11, 16) >= "00:05" ? -1 : -2);
    const { latest, pending } = diaryPlanProgress(tx, catId);
    let day = latest ? nextDay(latest) : calendar.startDay;
    // Bounded catch-up after restart; a date skipped by IANA cannot be completed.
    for (let scanned = 0; day <= last && scanned < 32; day = nextDay(day), scanned++) {
      const startAt = dayStart(day, zone);
      const endAt = dayStart(nextDay(day), zone);
      if (startAt === endAt) continue;
      saveCatFact(tx, ctx, proof, catId, { type: "diary_plan", day, timeZone: zone, startAt, endAt });
      pending.push(day);
    }
    return { catId, proof, days: pending.slice(0, 32) };
  }, { behavior: "immediate" });
  if (!pending?.days.length) return;
  const { catId, proof: { epoch, grantId } } = pending;
  for (const day of pending.days) {
    const payload = { catId, day, epoch, grantId };
    if (!hasDiaryDraft(store.db, payload)) enqueueJob(store.db, clock, { queue, payload, dedupeKey: workKey(payload) });
  }
  ctx.bus.publish("jobs:wake", { queue });
}

const places = { house: "小屋旁", tree: "树边", bed: "窝边", grass: "草地边", pond: "池塘边", fence: "栅栏边" };

function diaryPolicy(db: CatReader, householdId: string) {
  const members = listMembers(db, householdId);
  const policy = readKnowledgePolicy(db, householdId, members.map(({ id }) => id));
  return { ...policy, labels: new Map(members.map(({ id, displayName }) => [id, displayName])) };
}

function diaryCards(
  db: CatReader, householdId: string, catId: string, plan: Plan, policy: ReturnType<typeof diaryPolicy>, ids?: string[],
) {
  const { avoids, boundaries, labels } = policy;
  const boundarySources = new Set(boundaries.map(({ sourceMessageId }) => sourceMessageId));
  const observations = readCatFacts(db, catId, "diary_observation", { ids, prefix: `${plan.day}:` })
    .sort((a, b) => a.fact.observedAt - b.fact.observedAt || a.id.localeCompare(b.id))
    .map(({ id, fact }) => ({ id, text: `有一会儿，我在${places[fact.destination]}。`, kind: "world" as const }));
  const confirmed = readCatFacts(db, catId, "diary_source", { ids }).flatMap(({ id, fact }) => {
    const { source, memberId } = fact;
    if (!labels.has(memberId) || (source.kind === "message" && boundarySources.has(source.sourceMessageId))) return [];
    const allowed = diarySourceUse(db, householdId, memberId, source);
    if (!allowed || allowed.datedAt < plan.startAt || allowed.datedAt >= plan.endAt || avoids(allowed.text)) return [];
    const quote = Array.from(allowed.text.replace(/[\r\n]+/g, " ").trim()).slice(0, 80).join("");
    const label = Array.from(labels.get(memberId)!.replace(/[\r\n]+/g, " ")).slice(0, 24).join("");
    const text = `${label}留下一句话：「${quote}」`;
    return quote ? [{ id, text, kind: source.kind, datedAt: allowed.datedAt }] : [];
  }).sort((a, b) => b.datedAt - a.datedAt || a.id.localeCompare(b.id));
  return [...observations, ...confirmed].filter(({ text }) => !avoids(text));
}

export function cardHash(card: DiaryCard) {
  return { id: card.id, sha256: textSha256(card.text) };
}

export function loadCatDiary(db: CatReader, ctx: HostContext, job: DiaryJob) {
  const { householdId, publication } = ctx;
  const route = readPublicationRoute(db, householdId, publication);
  if (route.status !== "ready" || route.current?.epoch !== job.epoch || route.current.grantId !== job.grantId) return;
  const plan = readCatFact(db, job.catId, "diary_plan", job.day);
  if (plan?.householdId !== householdId || readCatFact(db, job.catId, "daily_diary", job.day)) return;
  const world = readWorld(db, householdId);
  if (world?.cat.id !== job.catId) return;
  const policy = diaryPolicy(db, householdId);
  const cards = diaryCards(db, householdId, job.catId, plan.fact, policy);
  const facts = [...cards.filter(({ kind }) => kind === "world").slice(0, 6),
    ...cards.filter(({ kind }) => kind !== "world").slice(0, 6)].map(({ id, text }) => ({ id, text }));
  const { profile } = world.state;
  const persona = `${soulCore}\n当前基础性格（资料）：${JSON.stringify({ temperament: profile.temperament, traits: profile.traits })}`;
  const input = { day: job.day, persona, facts };
  const boundaries = policy.boundaries.map(({ id, rev }) => [id, rev]);
  const inputHash = textSha256(JSON.stringify({ plan: plan.fact, input, boundaries }));
  return { plan, input, inputHash, avoids: policy.avoids };
}

/** The compute job can only persist a local draft and wake the Router's queue. */
export function submitCatDiaryDraft(ctx: HostContext, job: DiaryJob, attempt: JobAttempt, inputHash: string, draft: DiaryDraft) {
  const result = ctx.store.db.transaction((tx) => {
    if (!getHeldJob(tx, ctx.clock, attempt)) return "done";
    const current = loadCatDiary(tx, ctx, job);
    if (!current) return "done";
    if (current.inputHash !== inputHash) return "stale";
    enqueueJob(tx, ctx.clock, { queue: publishQueue, payload: { ...job, inputHash, draft }, dedupeKey: workKey(job) });
    return "ready";
  }, { behavior: "immediate" });
  if (result === "ready") ctx.bus.publish("jobs:wake", { queue: publishQueue });
  return result;
}

export function publishCatDiary(
  ctx: HostContext, job: z.infer<typeof diaryPublicationSchema>, attempt: JobAttempt,
) {
  ctx.store.db.transaction((tx) => {
    if (!getHeldJob(tx, ctx.clock, attempt)) return;
    const current = loadCatDiary(tx, ctx, job);
    if (!current || current.inputHash !== job.inputHash) return;
    const { draft, inputHash } = job;
    if (draft.writer.provider === "fallback") {
      if (draft.reflection !== diaryReflection || draft.inputs.length || draft.cards.length) return;
    } else {
      const expected = current.input.facts.map(cardHash);
      if (JSON.stringify(draft.inputs) !== JSON.stringify(expected)
        || draft.cards.some(({ id, sha256 }) => !expected.some((item) => item.id === id && item.sha256 === sha256))) return;
      composeDailyDraft({ reflection: draft.reflection, fact_ids: draft.cards.map(({ id }) => id) }, current.input.facts);
    }
    const reflection = safeReflection(draft.reflection, current.avoids);
    const captured = { householdId: ctx.householdId, holderHostId: ctx.hostId, epoch: job.epoch, grantId: job.grantId };
    saveCatFact(tx, ctx, captured, job.catId, {
      type: "daily_diary", day: job.day, planId: current.plan.id, ...draft, reflection, inputHash,
    });
  }, { behavior: "immediate" });
}

export function listCatDiaries(db: CatReader, actor: Actor) {
  const world = readWorld(db, actor.householdId);
  const calendar = world && currentTimeZone(db, world.cat.id);
  const legacy = listImportedCatDiary(db, actor).map((entry) => ({ ...entry, origin: "legacy" as const }));
  const policy = diaryPolicy(db, actor.householdId);
  const daily = !world ? [] : readCatFacts(db, world.cat.id, "daily_diary").flatMap((row) => {
    const plan = readCatFact(db, world.cat.id, "diary_plan", row.fact.day);
    if (!plan || row.fact.planId !== plan.id) return [];
    const { fact } = row;
    const cards = diaryCards(db, actor.householdId, world.cat.id, plan.fact, policy, fact.inputs.map(({ id }) => id));
    const byId = new Map(cards.map((card) => [card.id, card]));
    const available = ({ id, sha256 }: DailyEntry["inputs"][number]) => {
      const card = byId.get(id);
      return card && textSha256(card.text) === sha256 ? card : undefined;
    };
    const cited = fact.cards.flatMap((item) => available(item) ?? []);
    const reflection = safeReflection(fact.inputs.every(available) ? fact.reflection : diaryReflection, policy.avoids);
    return [{
      id: row.id, revision: row.rev, origin: "daily" as const, local_day: fact.day, time_zone: plan.fact.timeZone,
      recorded_at: plan.fact.startAt, updated_at: row.updatedAt, text: [...cited.map(({ text }) => text), reflection].join("\n"),
      writer: { provider: fact.writer.provider, model_id: fact.writer.modelId }, input_sha256: fact.inputHash,
      sources: cited.map(({ id, kind, text }) => ({ id, kind, sha256: textSha256(text) })),
    }];
  });
  return {
    entries: [...legacy, ...daily].sort((a, b) => a.local_day.localeCompare(b.local_day) || a.recorded_at - b.recorded_at || a.id.localeCompare(b.id)),
    calendar: calendar?.zone ? { time_zone: calendar.zone, version: calendar.version } : null,
  };
}
