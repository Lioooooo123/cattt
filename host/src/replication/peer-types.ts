import { z } from "zod";
import { businessFields, replicationCursorSchema, replicationSourceSchema } from "./types.ts";
import type { ChangePage, ReplicaRecord, ReplicationCursor, ReplicationSource } from "./types.ts";

export const PEER_SYNC_PROTOCOL_VERSION = 1;
export const MAX_SNAPSHOT_RECORDS = 100_000;

export type PeerSyncIdentity = Pick<ReplicationSource, "sourceHostId" | "householdId">;

export interface PeerSyncReply<T> {
  protocol_version: typeof PEER_SYNC_PROTOCOL_VERSION;
  source: ReplicationSource;
  data: T;
}

export const snapshotManifestSchema = z.strictObject({
  snapshotId: z.uuidv4(),
  watermark: replicationCursorSchema,
  recordCount: z.int().min(1).max(MAX_SNAPSHOT_RECORDS),
});
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;

export const snapshotRecordSchema = z.strictObject({
  kind: z.string().min(1),
  row: z.looseObject(businessFields),
});

export interface SnapshotPageRequest {
  snapshotId: string;
  offset: number;
  limit: number;
}

export interface SnapshotPage {
  snapshotId: string;
  offset: number;
  records: readonly ReplicaRecord[];
}

export interface PeerChangesRequest {
  cursor: ReplicationCursor | null;
  limit: number;
}

export type PeerChanges =
  | { status: "changes"; page: ChangePage }
  | { status: "reset_required"; head: ReplicationCursor };

export interface PeerSyncService {
  openSnapshot(): PeerSyncReply<SnapshotManifest>;
  readSnapshotPage(request: SnapshotPageRequest): PeerSyncReply<SnapshotPage>;
  readChanges(request: PeerChangesRequest): PeerSyncReply<PeerChanges>;
}

// Implementations bind these operations to the configured peer's authenticated
// mTLS session. The envelope alone grants no authority to a source or generation.
export interface PeerSyncTransport {
  openSnapshot(signal: AbortSignal): Promise<PeerSyncReply<SnapshotManifest>>;
  readSnapshotPage(request: SnapshotPageRequest, signal: AbortSignal): Promise<PeerSyncReply<SnapshotPage>>;
  readChanges(request: PeerChangesRequest, signal: AbortSignal): Promise<PeerSyncReply<PeerChanges>>;
}

export function replySchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    protocol_version: z.literal(PEER_SYNC_PROTOCOL_VERSION),
    source: replicationSourceSchema,
    data,
  });
}
