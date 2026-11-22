import { and, eq, sql } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { mappedId } from "../import-pg/values.ts";
import { createDiaryEntry, getSharedDiaryEntry, setDiaryCatAllowed } from "./diary.ts";
import type { DiaryInput } from "./diary.ts";
import { MemberResourceError } from "./member-resources.ts";
import type { MemberResourceDb } from "./member-resources.ts";
import type { ImportReport } from "./pg-import/index.ts";
import { pgImportArchive, pgImportReceipts } from "./schema/pg-import.ts";

type Reader = Pick<MemberResourceDb, "select">;

export function legacyDiaryAccount(db: Reader, actor: Actor): string | undefined {
  const receipt = db.select().from(pgImportReceipts).where(eq(pgImportReceipts.id, 1)).get();
  const report = receipt?.report as ImportReport | undefined;
  if (report?.status === "imported" && report.formatVersion === 1 && report.sourceSha256 === receipt?.sourceSha256
    && report.householdId === actor.householdId && report.memberId === actor.memberId && report.hostId === actor.hostId) {
    return report.sourceUserId;
  }
  return undefined;
}

export function continueLegacyDiary(
  tx: MemberResourceDb, clock: Clock, actor: Actor,
  input: { accountId: string; clientId: string; cloudId?: string; revokeCatAccess: boolean; draft?: DiaryInput },
): string {
  if (legacyDiaryAccount(tx, actor) !== input.accountId) throw new MemberResourceError("not_found");

  const archived = pgImportArchive;
  const scoped = tx.select().from(archived);
  const oldDiary = eq(archived.sourceTable, "diary_entries");
  const clientId = sql<string>`json_extract(${archived.evidenceJson}, '$.client_id')`;
  const kind = sql<string>`json_extract(${archived.evidenceJson}, '$.kind')`;
  const byCloud = input.cloudId && scoped.where(and(oldDiary, eq(archived.sourceKey, input.cloudId),
    eq(clientId, input.clientId), eq(kind, "text"))).get();
  const byClient = !input.cloudId && scoped.where(and(oldDiary, eq(clientId, input.clientId), eq(kind, "text"))).get();
  const evidence = byCloud || byClient;
  if (input.cloudId && !evidence) throw new MemberResourceError("not_found");

  // Use the member's immutable UUID timestamp as the namespace timestamp for phone-only IDs.
  // The ID stays stable across devices, even if their saved text or timestamps differ.
  const memberCreatedAt = Number.parseInt(actor.memberId.slice(0, 13).replace("-", ""), 16);
  const phoneId = mappedId(actor.memberId, "legacy-ios-diary", input.clientId, memberCreatedAt);
  const id = evidence ? evidence.targetId : phoneId;
  const current = id && getSharedDiaryEntry(tx, actor.householdId, id, true);
  if (current) {
    if (current.ownerMemberId !== actor.memberId) throw new MemberResourceError("not_found");
    if (current.deletedAt === null && current.catAllowed && input.revokeCatAccess) {
      if (current.originHostId !== actor.hostId) throw new MemberResourceError("wrong_home_host", current.originHostId);
      setDiaryCatAllowed(tx, clock, actor, current.id, current.rev, false);
    }
    return current.id;
  }
  // A known server row or archived source must never be recreated from a phone snapshot.
  if (evidence || !input.draft) throw new MemberResourceError("not_found");
  return createDiaryEntry(tx, clock, actor, { ...input.draft, catAllowed: input.draft.catAllowed && !input.revokeCatAccess },
    phoneId).id;
}
