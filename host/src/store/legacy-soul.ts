import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { textSha256 } from "../import-pg/values.ts";
import type { PublicationProof } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import type { FactsOf } from "../soul/facts.ts";
import { habitSchema, stateSchema } from "../soul/rules.ts";
import type { MessageProof } from "../soul/rules.ts";
import { readCatFact, saveCatFact } from "./cat-facts.ts";
import type { CatReader } from "./cat-facts.ts";
import { allowsSoulSource } from "./cat-source.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { messages } from "./schema/conversations.ts";
import { pgImportArchive, pgImportReceipts } from "./schema/pg-import.ts";

const receiptSchema = z.object({
  status: z.literal("imported"), hostId: z.string(), householdId: z.string(),
  sourceSha256: z.string(), sourceCatId: z.uuid().nullable(), memberId: z.string(),
});
const rowSchema = z.object({ cat_id: z.uuid() });
const versionSchema = rowSchema.extend({ version: z.int().positive(), entries: z.array(z.unknown()) });
const stateRow = rowSchema.extend({ state: z.object({
  sourceMessageId: z.uuid().nullable(), energy: z.string(), willingness: z.string(),
  observedAt: z.string(), expiresAt: z.string().nullable(),
}) });
const eventRow = stateRow.extend({ source_message_id: z.uuid() });
const legacyEntry = z.object({ status: z.literal("active"), sourceMessageId: z.uuid() });
const mappedMessage = z.object({ role: z.literal("user"), context_allowed: z.literal(true), memory_eligible: z.literal(true) });
type LegacyFact = FactsOf<"legacy_soul">;

function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function archived(db: CatReader, table: string, catId: string) {
  return db.select().from(pgImportArchive).where(and(
    eq(pgImportArchive.sourceTable, table), eq(pgImportArchive.reason, "world_and_soul_pending"),
  )).all().flatMap((row) => {
    const data = json(row.evidenceJson);
    return textSha256(row.evidenceJson) === row.sourceSha256 && rowSchema.safeParse(data).data?.cat_id === catId
      ? [{ row, data }] : [];
  });
}

function sourceProof(db: CatReader, householdId: string, memberId: string, oldId: string, legacyCatId: string): MessageProof | undefined {
  const prior = db.select().from(pgImportArchive).where(and(
    eq(pgImportArchive.sourceTable, "messages"), eq(pgImportArchive.sourceKey, oldId),
    eq(pgImportArchive.reason, "legacy_fields"),
  )).get();
  if (!prior?.targetId || !mappedMessage.safeParse(json(prior.evidenceJson)).success
    || archived(db, "soul_blocked_sources", legacyCatId).some(({ data }) =>
      z.object({ source_message_id: z.string() }).safeParse(data).data?.source_message_id === oldId)) return;
  const msg = db.select().from(messages).where(eq(messages.id, prior.targetId)).get();
  if (!msg || msg.authorMemberId !== memberId || msg.rev !== 1) return;
  const source = { kind: "message", sourceMemberId: memberId, sourceMessageId: msg.id, sourceRevision: msg.rev } as const;
  return allowsSoulSource(db, householdId, [memberId], source, "") ? source : undefined;
}

export function importArchivedSoul(tx: ReplicationTx, ctx: HostContext, proof: PublicationProof, cat: { id: string; legacyId: string | null }) {
  if (!cat.legacyId || readCatFact(tx, cat.id, "legacy_soul", "initial")) return;
  const receipt = tx.select().from(pgImportReceipts).where(eq(pgImportReceipts.id, 1)).get();
  const report = receiptSchema.safeParse(receipt?.report).data;
  if (!report || report.sourceSha256 !== receipt?.sourceSha256 || report.sourceCatId !== cat.legacyId
    || report.householdId !== proof.householdId || report.hostId !== ctx.hostId) return;
  const versions = archived(tx, "soul_versions", cat.legacyId);
  const latest = versions.flatMap(({ row, data }) => {
    const parsed = versionSchema.safeParse(data).data;
    return parsed ? [{ row, data: parsed }] : [];
  }).sort((left, right) => right.data.version - left.data.version)[0];
  let unmapped = versions.length - (latest ? 1 : 0);
  const entries = new Map<string, LegacyFact["entries"][number]>();
  for (const candidate of latest?.data.entries ?? []) {
    if (z.object({ status: z.enum(["superseded", "withdrawn"]) }).safeParse(candidate).success) continue;
    const entry = legacyEntry.safeParse(candidate).data;
    const change = entry && habitSchema.safeParse({ kind: (candidate as { kind: string }).kind,
      value: (candidate as { value: string }).value }).data;
    const source = entry && sourceProof(tx, proof.householdId, report.memberId, entry.sourceMessageId, cat.legacyId);
    if (!change || !source) {
      unmapped++;
      continue;
    }
    entries.set(change.kind, { change, source });
  }

  const runtime = archived(tx, "cat_runtime_states", cat.legacyId);
  const current = runtime.length === 1 ? stateRow.safeParse(runtime[0]?.data).data?.state : undefined;
  let state: LegacyFact["state"] = null;
  if (current?.sourceMessageId) {
    const change = stateSchema.safeParse({
      kind: "state", energy: current.energy, willingness: current.willingness,
      observedAt: Date.parse(current.observedAt), expiresAt: Date.parse(current.expiresAt ?? ""),
    }).data;
    const source = sourceProof(tx, proof.householdId, report.memberId, current.sourceMessageId, cat.legacyId);
    const event = archived(tx, "cat_runtime_events", cat.legacyId).find(({ data }) => {
      const event = eventRow.safeParse(data).data;
      return event?.source_message_id === current.sourceMessageId && JSON.stringify(event.state) === JSON.stringify(current);
    });
    if (change && source && event) state = { change, source, sourceHash: event.row.sourceSha256 };
    else unmapped++;
  } else if (runtime.length && !current) {
    unmapped += runtime.length;
  }
  saveCatFact(tx, ctx, proof, cat.id, { type: "legacy_soul", version: latest?.data.version ?? null,
    sourceHash: latest?.row.sourceSha256 ?? null, entries: [...entries.values()], state, unmapped });
}
