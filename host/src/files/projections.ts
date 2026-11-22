import type { FileDescription } from "../store/file-descriptions.ts";
import { findFileBlob } from "../store/files.ts";
import type { FileRow } from "../store/files.ts";
import type { StoreDb } from "../store/index.ts";
import type { BlobStorage } from "./blobs.ts";

export function availableFilePath(db: Pick<StoreDb, "select">, storage: BlobStorage, file: FileRow) {
  const verified = findFileBlob(db, file.sha256);
  return verified?.byteSize === file.byteSize ? storage.localPath(file) : undefined;
}

export function projectFile(db: Pick<StoreDb, "select">, storage: BlobStorage, file: FileRow) {
  return {
    id: file.id,
    owner_member_id: file.ownerMemberId,
    conversation_id: file.conversationId,
    source_message_id: file.sourceMessageId,
    source_message_rev: file.sourceMessageRev,
    sha256: file.sha256,
    byte_size: file.byteSize,
    file_name: file.fileName,
    media_type: file.mediaType,
    description: file.description,
    rev: file.rev,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
    available: availableFilePath(db, storage, file) !== undefined,
  };
}

export function projectFileDescription(row: FileDescription) {
  return {
    id: row.id,
    file_id: row.fileId,
    file_rev: row.fileRev,
    sha256: row.sha256,
    source_message_id: row.sourceMessageId,
    source_message_rev: row.sourceMessageRev,
    text: row.text,
    model_id: row.modelId,
    created_at: row.createdAt,
  };
}
