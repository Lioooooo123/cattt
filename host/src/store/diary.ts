import { and, asc, eq, exists, isNull, or } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { Actor } from "../identity/index.ts";
import { matchesDiaryLocalDay } from "./diary-date.ts";
export { matchesDiaryLocalDay } from "./diary-date.ts";
import { businessRow, revision } from "./business.ts";
import { requireLocalHostId } from "./host-meta.ts";
import { getHousehold, getHouseholdMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { hasKnowledgeSource, readKnowledgeSource } from "./knowledge-source.ts";
import type { KnowledgeSource } from "./knowledge-source.ts";
import { replicaAdapters } from "./replica-records.ts";
import { appendNativeChange } from "./replication.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { diaryEntries } from "./schema/diary.ts";
import { households, members } from "./schema/identity.ts";

export type DiaryEntry = typeof diaryEntries.$inferSelect;

type Reader = Pick<StoreDb, "select">;
type Writer = Pick<StoreDb, "transaction">;

export interface DiaryInput {
  text: string;
  recordedAt: number;
  localDay: string;
  timeZone: string;
  catAllowed?: boolean;
  source?: KnowledgeSource;
}

export interface DiaryFilter {
  householdId: string;
  ownerMemberId?: string;
  id?: string;
  rev?: number;
  sourceMemberId?: string;
  sourceMessageId?: string;
  sourceRevision?: number;
}

function requireText(text: string) {
  if (!text.trim()) {
    throw new TypeError("日记正文不能为空");
  }
}

function diaryInScope(db: Reader, filter: DiaryFilter, includeDeleted = false) {
  const table = diaryEntries;
  return and(
    eq(table.householdId, filter.householdId),
    filter.ownerMemberId === undefined ? undefined : eq(table.ownerMemberId, filter.ownerMemberId),
    filter.id === undefined ? undefined : eq(table.id, filter.id),
    filter.rev === undefined ? undefined : eq(table.rev, filter.rev),
    filter.sourceMemberId === undefined ? undefined : eq(table.sourceMemberId, filter.sourceMemberId),
    filter.sourceMessageId === undefined ? undefined : eq(table.sourceMessageId, filter.sourceMessageId),
    filter.sourceRevision === undefined ? undefined : eq(table.sourceRevision, filter.sourceRevision),
    includeDeleted ? undefined : isNull(table.deletedAt),
    exists(db.select({ id: members.id }).from(members)
      .innerJoin(households, eq(households.id, members.householdId)).where(and(
        eq(members.id, table.ownerMemberId),
        eq(households.id, table.householdId),
        isNull(members.deletedAt),
        isNull(households.deletedAt),
      ))),
  );
}

function allowedSource(db: Reader) {
  return or(isNull(diaryEntries.sourceMessageId), hasKnowledgeSource(db, diaryEntries));
}

function appendDiary(tx: ReplicationTx, row: DiaryEntry | undefined) {
  if (row) {
    appendNativeChange(tx, row.originHostId, row.householdId, replicaAdapters.diary_entry, row);
  }
  return row;
}

export function createDiaryEntry(db: Writer, clock: Clock, actor: Actor, input: DiaryInput, importedId?: string): DiaryEntry {
  requireText(input.text);
  if (!matchesDiaryLocalDay(input)) {
    throw new TypeError("日记日期须与记录时间及原时区一致");
  }
  const { source } = input;
  const { householdId, memberId } = actor;
  return db.transaction((tx) => {
    const hostId = requireLocalHostId(tx);
    if (!getHousehold(tx, householdId) || getHouseholdMember(tx, householdId, memberId)?.homeHostId !== hostId) {
      throw new Error("日记归属无效");
    }
    if (source && (source.householdId !== householdId || source.sourceMemberId !== memberId
      || !readKnowledgeSource(tx, source))) {
      throw new Error("日记来源不可用");
    }
    return appendDiary(tx, tx.insert(diaryEntries).values({
      ...businessRow(clock, hostId),
      ...(importedId ? { id: importedId } : {}),
      householdId,
      ownerMemberId: memberId,
      sourceMemberId: memberId,
      sourceMessageId: source?.sourceMessageId ?? null,
      sourceRevision: source?.sourceRevision ?? null,
      text: input.text,
      recordedAt: input.recordedAt,
      localDay: input.localDay,
      timeZone: input.timeZone,
      catAllowed: input.catAllowed ?? false,
    }).returning().get())!;
  }, { behavior: "immediate" });
}

/** 业务记录读取。直接写入的日记使用自身 rev 作为来源版本。 */
export function getDiaryEntry(db: Reader, filter: DiaryFilter & { ownerMemberId: string; id: string }) {
  return db.select().from(diaryEntries).where(diaryInScope(db, filter)).get();
}

export function getSharedDiaryEntry(db: Reader, householdId: string, id: string, includeDeleted = false) {
  return db.select().from(diaryEntries).where(diaryInScope(db, { householdId, id }, includeDeleted)).get();
}

export function listSharedDiaryEntries(db: Reader, householdId: string): DiaryEntry[] {
  return db.select().from(diaryEntries).where(diaryInScope(db, { householdId }))
    .orderBy(asc(diaryEntries.localDay), asc(diaryEntries.id)).all();
}

/** 模型读取入口，读取时核对许可和聊天来源修订。 */
export function listAllowedDiaryEntries(db: Reader, filter: DiaryFilter): DiaryEntry[] {
  return db.select().from(diaryEntries).where(and(
    diaryInScope(db, filter),
    eq(diaryEntries.catAllowed, true),
    allowedSource(db),
  )).orderBy(asc(diaryEntries.localDay), asc(diaryEntries.id)).all();
}

function writableDiary(tx: ReplicationTx, actor: Actor, id: string, rev: number) {
  return and(
    eq(diaryEntries.originHostId, requireLocalHostId(tx)),
    diaryInScope(tx, { householdId: actor.householdId, ownerMemberId: actor.memberId, id, rev }),
  );
}

export function reviseDiaryEntry(
  db: Writer, clock: Clock, actor: Actor, id: string, expectedRevision: number, text: string,
) {
  requireText(text);
  return db.transaction((tx) => appendDiary(tx, tx.update(diaryEntries).set({
    ...revision(clock), rev: expectedRevision + 1, text,
  }).where(writableDiary(tx, actor, id, expectedRevision)).returning().get()), { behavior: "immediate" });
}

export function setDiaryCatAllowed(
  db: Writer, clock: Clock, actor: Actor, id: string, expectedRevision: number, catAllowed: boolean,
) {
  return db.transaction((tx) => {
    const where = and(
      writableDiary(tx, actor, id, expectedRevision),
      catAllowed ? allowedSource(tx) : undefined,
    );
    const current = tx.select().from(diaryEntries).where(where).get();
    if (!current || current.catAllowed === catAllowed) {
      return current;
    }
    return appendDiary(tx, tx.update(diaryEntries).set({
      ...revision(clock), rev: expectedRevision + 1, catAllowed,
    }).where(eq(diaryEntries.id, id)).returning().get());
  }, { behavior: "immediate" });
}

export function withdrawDiaryEntry(
  db: Writer, clock: Clock, actor: Actor, id: string, expectedRevision: number,
) {
  return db.transaction((tx) => {
    const update = revision(clock);
    return appendDiary(tx, tx.update(diaryEntries).set({
      ...update, rev: expectedRevision + 1, deletedAt: update.updatedAt, catAllowed: false,
    }).where(writableDiary(tx, actor, id, expectedRevision)).returning().get());
  }, { behavior: "immediate" });
}
