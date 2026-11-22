import { and, eq } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import { FileRequestError } from "../files/types.ts";
import type { FileSourcePointer } from "../files/types.ts";
import type { Actor } from "../identity/index.ts";
import { businessRow } from "./business.ts";
import { getCurrentFileSource, readFileForActor } from "./files.ts";
import type { FileRow } from "./files.ts";
import { isActiveDeviceActor } from "./identity.ts";
import { readKnowledgeSource } from "./knowledge-source.ts";
import type { StoreDb } from "./index.ts";
import { replicaAdapters } from "./replica-records.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { appendNativeChange } from "./replication.ts";
import { fileDescriptions } from "./schema/files.ts";

type Reader = Pick<StoreDb, "select">;
export type FileDescription = typeof fileDescriptions.$inferSelect;

function allowsDescriptionSource(db: Reader, file: FileRow): boolean {
  if (file.sourceMessageId === null) {
    return file.sourceMessageRev === null;
  }
  if (file.sourceMessageRev === null) {
    return false;
  }
  const message = readKnowledgeSource(db, {
    householdId: file.householdId,
    sourceMemberId: file.ownerMemberId,
    sourceMessageId: file.sourceMessageId,
    sourceRevision: file.sourceMessageRev,
  });
  return message?.conversationId === file.conversationId;
}

function matchingDescription(db: Reader, file: FileRow) {
  const row = db.select().from(fileDescriptions).where(and(
    eq(fileDescriptions.fileId, file.id), eq(fileDescriptions.fileRev, file.rev),
  )).get();
  return row?.sha256 === file.sha256 && row.sourceMessageId === file.sourceMessageId
    && row.sourceMessageRev === file.sourceMessageRev && row.originHostId === file.originHostId
    && row.deletedAt === null ? row : undefined;
}

/** 设备投影只对已通过文件和会话可见性筛选的行调用。 */
export function getVisibleFileDescription(db: Reader, file: FileRow) {
  return allowsDescriptionSource(db, file) ? matchingDescription(db, file) : undefined;
}

/** Context consumers re-read by source pointer at each use. This never loads original bytes. */
export function readVerifiedFileDescription(
  db: Reader, pointer: FileSourcePointer, householdId?: string,
): FileDescription | undefined {
  const file = getCurrentFileSource(db, pointer);
  return file && (householdId === undefined || file.householdId === householdId)
    ? getVisibleFileDescription(db, file) : undefined;
}

export function readFileDescriptionForActor(db: Reader, actor: Actor, fileId: string, expectedRev?: number) {
  if (!isActiveDeviceActor(db, actor)) {
    throw new FileRequestError(401, "unauthorized");
  }
  const visible = readFileForActor(db, actor, fileId);
  if (expectedRev !== undefined && visible.rev !== expectedRev) {
    throw new FileRequestError(409, "file_revision_changed");
  }
  if (!allowsDescriptionSource(db, visible) || (expectedRev !== undefined && visible.ownerMemberId !== actor.memberId)) {
    throw new FileRequestError(404, "not_found");
  }
  return { file: visible, description: matchingDescription(db, visible) };
}

export function assertSameDescriptionSource(current: FileRow, expected: FileRow): void {
  if (current.sha256 !== expected.sha256 || current.byteSize !== expected.byteSize
    || current.sourceMessageId !== expected.sourceMessageId || current.sourceMessageRev !== expected.sourceMessageRev
    || current.mediaType !== expected.mediaType || current.originHostId !== expected.originHostId
    || current.householdId !== expected.householdId || current.conversationId !== expected.conversationId) {
    throw new FileRequestError(409, "file_revision_changed");
  }
}

/** The caller runs this in an immediate transaction. */
export function saveFileDescription(
  db: ReplicationTx, clock: Clock, actor: Actor, expected: FileRow, modelId: string, text: string,
) {
  const { file, description } = readFileDescriptionForActor(db, actor, expected.id, expected.rev);
  assertSameDescriptionSource(file, expected);
  if (file.originHostId !== actor.hostId) {
    throw new FileRequestError(409, "not_writer");
  }
  if (description) {
    return description;
  }
  const saved = db.insert(fileDescriptions).values({
    ...businessRow(clock, actor.hostId),
    fileId: file.id, fileRev: file.rev, sha256: file.sha256,
    sourceMessageId: file.sourceMessageId, sourceMessageRev: file.sourceMessageRev,
    modelId, text,
  }).onConflictDoNothing({
    target: [fileDescriptions.fileId, fileDescriptions.fileRev],
  }).returning().get();
  if (saved) {
    appendNativeChange(db, file.originHostId, file.householdId, replicaAdapters.file_description, saved);
  }
  return saved;
}
