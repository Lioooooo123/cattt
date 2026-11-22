import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Clock } from "../clock/index.ts";
import type { VerifiedBlob } from "../files/blobs.ts";
import { FileRequestError } from "../files/types.ts";
import type { FileManifest, FileSourcePointer } from "../files/types.ts";
import { can, canWriteAs } from "../identity/access.ts";
import type { Actor } from "../identity/index.ts";
import { uuidv7 } from "../ids/index.ts";
import { revision } from "./business.ts";
import { assertConversationAccess, listReadableConversationIds } from "./conversations.ts";
import { getHostMeta } from "./host-meta.ts";
import { getHouseholdMember } from "./identity.ts";
import type { StoreDb } from "./index.ts";
import { replicaAdapters } from "./replica-records.ts";
import type { ReplicationTx } from "./replication-adapter.ts";
import { appendNativeChange, atomicNativeChanges } from "./replication.ts";
import { conversations, messages } from "./schema/conversations.ts";
import { fileBlobs, fileDescriptions, files, fileUploads } from "./schema/files.ts";
import { households, hosts, members } from "./schema/identity.ts";

type Reader = Pick<StoreDb, "select">;
export type FileRow = typeof files.$inferSelect;
export type UploadRow = typeof fileUploads.$inferSelect;
type OwnedManifest = FileManifest & { ownerMemberId: string };

function getFile(db: Reader, id: string) {
  return db.select().from(files).where(eq(files.id, id)).get();
}

function hasCurrentMessage(db: Reader, file: OwnedManifest): boolean {
  if (file.sourceMessageId === null) {
    return file.sourceMessageRev === null;
  }
  return file.sourceMessageRev !== null && db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.id, file.sourceMessageId),
    eq(messages.conversationId, file.conversationId),
    eq(messages.authorMemberId, file.ownerMemberId),
    eq(messages.rev, file.sourceMessageRev),
    isNull(messages.deletedAt),
  )).get() !== undefined;
}

function currentFiles(db: Reader, condition: SQL | undefined) {
  return db.select({ file: files }).from(files)
    .innerJoin(households, and(eq(households.id, files.householdId), isNull(households.deletedAt)))
    .innerJoin(hosts, and(eq(hosts.id, files.originHostId), eq(hosts.householdId, files.householdId), isNull(hosts.deletedAt)))
    .innerJoin(members, and(eq(members.id, files.ownerMemberId), eq(members.householdId, files.householdId), isNull(members.deletedAt)))
    .innerJoin(conversations, and(
      eq(conversations.id, files.conversationId), eq(conversations.householdId, files.householdId),
      isNull(conversations.deletedAt),
    ))
    .leftJoin(messages, eq(messages.id, files.sourceMessageId))
    .where(and(
      condition, isNull(files.deletedAt), eq(members.homeHostId, files.originHostId),
      or(eq(conversations.kind, "group"), eq(conversations.ownerMemberId, files.ownerMemberId)),
      or(
        and(isNull(files.sourceMessageId), isNull(files.sourceMessageRev)),
        and(
          eq(messages.conversationId, files.conversationId), eq(messages.authorMemberId, files.ownerMemberId),
          eq(messages.rev, files.sourceMessageRev), isNull(messages.deletedAt),
        ),
      ),
    ));
}

/** Shared read gate for bytes, descriptions and ingestion of finished peer downloads. */
export function getCurrentFileSource(db: Reader, pointer: FileSourcePointer): FileRow | undefined {
  return currentFiles(db, and(eq(files.id, pointer.fileId), eq(files.rev, pointer.fileRev))).get()?.file;
}

export function findCurrentFileByHash(db: Reader, query: {
  householdId: string; sha256: string; originHostId?: string; byteSize?: number;
}) {
  const { householdId, sha256, originHostId, byteSize } = query;
  return currentFiles(db, and(
    eq(files.householdId, householdId), eq(files.sha256, sha256),
    originHostId === undefined ? undefined : eq(files.originHostId, originHostId),
    byteSize === undefined ? undefined : eq(files.byteSize, byteSize),
  )).limit(1).get()?.file;
}

export function listCurrentFilesFromPeer(db: Reader, householdId: string, originHostId: string, after: string, limit: number) {
  return currentFiles(db, and(
    eq(files.householdId, householdId), eq(files.originHostId, originHostId), gt(files.id, after),
  )).orderBy(asc(files.id)).limit(limit).all().map(({ file }) => file);
}

export function isActiveFileHost(db: Reader, householdId: string, hostId: string): boolean {
  return db.select({ id: hosts.id }).from(hosts)
    .innerJoin(households, and(eq(households.id, hosts.householdId), isNull(households.deletedAt)))
    .where(and(eq(hosts.id, hostId), eq(hosts.householdId, householdId), isNull(hosts.deletedAt))).get() !== undefined;
}

export function readFileForActor(db: Reader, actor: Actor, id: string): FileRow {
  const file = currentFiles(db, eq(files.id, id)).get()?.file;
  if (!file || !can(actor, file)) {
    throw new FileRequestError(404, "not_found");
  }
  assertConversationAccess(db, actor, file.conversationId);
  return file;
}

export function listFilesForActor(db: Reader, actor: Actor, conversationId: string, after: string | undefined, limit: number) {
  assertConversationAccess(db, actor, conversationId);
  return currentFiles(db, and(
    eq(files.householdId, actor.householdId), eq(files.conversationId, conversationId),
    after === undefined ? undefined : gt(files.id, after),
  )).orderBy(asc(files.id)).limit(limit).all().map(({ file }) => file);
}

export function listAvailableFilesForActor(db: Reader, actor: Actor) {
  const conversationIds = listReadableConversationIds(db, actor);
  return currentFiles(db, and(
    eq(files.householdId, actor.householdId), inArray(files.conversationId, conversationIds),
  )).orderBy(asc(files.id)).all().map(({ file }) => file);
}

function assertUploadSource(db: Reader, actor: Actor, file: OwnedManifest): void {
  assertConversationAccess(db, actor, file.conversationId);
  if (!hasCurrentMessage(db, file)) {
    throw new FileRequestError(404, "not_found");
  }
}

function assertHomeFileWriter(db: Reader, actor: Actor): void {
  if (actor.hostId !== getHostMeta(db, "host_id")
    || getHouseholdMember(db, actor.householdId, actor.memberId)?.homeHostId !== actor.hostId) {
    throw new FileRequestError(409, "not_writer");
  }
}

export function beginFileUpload(db: StoreDb, clock: Clock, actor: Actor, clientUploadId: string, manifest: FileManifest) {
  assertHomeFileWriter(db, actor);
  const existing = db.select().from(fileUploads).where(and(
    eq(fileUploads.ownerMemberId, actor.memberId), eq(fileUploads.clientUploadId, clientUploadId),
  )).get();
  if (existing) {
    const status = readUploadForActor(db, actor, existing.id);
    if ((Object.keys(manifest) as (keyof FileManifest)[]).some((key) => existing[key] !== manifest[key])) {
      throw new FileRequestError(409, "idempotency_conflict");
    }
    return { ...status, created: false };
  }
  const upload: UploadRow = {
    ...manifest, id: uuidv7(clock), clientUploadId, ownerMemberId: actor.memberId, householdId: actor.householdId,
  };
  assertUploadSource(db, actor, upload);
  db.insert(fileUploads).values(upload).run();
  return { upload, file: undefined, created: true };
}

export function readUploadForActor(db: Reader, actor: Actor, id: string) {
  const upload = db.select().from(fileUploads).where(eq(fileUploads.id, id)).get();
  if (!upload || !can(actor, upload) || !canWriteAs(actor, upload.ownerMemberId)) {
    throw new FileRequestError(404, "not_found");
  }
  assertUploadSource(db, actor, upload);
  const file = getFile(db, id);
  if (file && file.deletedAt !== null) {
    throw new FileRequestError(404, "not_found");
  }
  return { upload, file };
}

export function findFileBlob(db: Reader, sha256: string) {
  return db.select().from(fileBlobs).where(eq(fileBlobs.sha256, sha256)).get();
}

/** Local receipt only. R6 calls this after installing a fully verified blob. */
export function recordFileBlob(db: Pick<StoreDb, "insert">, blob: VerifiedBlob, verifiedAt: number): void {
  const { sha256, byteSize } = blob;
  db.insert(fileBlobs).values({ sha256, byteSize, verifiedAt }).onConflictDoUpdate({
    target: fileBlobs.sha256,
    set: { byteSize, verifiedAt },
  }).run();
}

export function completeFileUpload(db: ReplicationTx, clock: Clock, actor: Actor, id: string, blob: VerifiedBlob) {
  assertHomeFileWriter(db, actor);
  const { upload, file } = readUploadForActor(db, actor, id);
  if (file) {
    return { file, created: false };
  }
  if (blob.sha256 !== upload.sha256 || blob.byteSize !== upload.byteSize) {
    throw new Error("已验证文件与上传清单不一致");
  }
  const hostId = actor.hostId;
  const { clientUploadId: _, ...manifest } = upload;
  const update = revision(clock);
  const completed: FileRow = {
    ...manifest, ...update, originHostId: hostId, rev: 1, createdAt: update.updatedAt, deletedAt: null,
  };
  recordFileBlob(db, blob, update.updatedAt);
  db.insert(files).values(completed).run();
  appendNativeChange(db, hostId, upload.householdId, replicaAdapters.file, completed);
  return { file: completed, created: true };
}

export function withdrawFile(db: ReplicationTx, clock: Clock, actor: Actor, id: string): void {
  const file = getFile(db, id);
  if (!file || !can(actor, file) || !canWriteAs(actor, file.ownerMemberId)) {
    throw new FileRequestError(404, "not_found");
  }
  if (file.deletedAt !== null) {
    return;
  }
  if (getHostMeta(db, "host_id") !== file.originHostId) {
    throw new FileRequestError(409, "not_writer");
  }
  atomicNativeChanges(db, file.originHostId, () => {
    const update = revision(clock);
    const removed = db.update(files).set({ ...update, deletedAt: update.updatedAt, rev: file.rev + 1 })
      .where(eq(files.id, id)).returning().get()!;
    appendNativeChange(db, file.originHostId, file.householdId, replicaAdapters.file, removed);
    const descriptions = db.update(fileDescriptions).set({
      ...update, deletedAt: update.updatedAt, rev: sql`${fileDescriptions.rev} + 1`,
    }).where(and(eq(fileDescriptions.fileId, id), isNull(fileDescriptions.deletedAt))).returning().all();
    for (const description of descriptions) {
      appendNativeChange(db, file.originHostId, file.householdId, replicaAdapters.file_description, description);
    }
  });
}
