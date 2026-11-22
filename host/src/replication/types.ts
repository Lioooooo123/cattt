import { z } from "zod";
import { parseHlc } from "../clock/index.ts";
import { MAX_PHYSICAL_MS } from "../clock/hlc.ts";

export const businessId = z.uuidv7();
const generation = z.uuidv4();
const sequence = z.int().nonnegative();
const wallMs = z.int().min(0).max(MAX_PHYSICAL_MS);

export const replicationCursorSchema = z.strictObject({
  sourceHostId: businessId,
  generation,
  seq: sequence,
});
export const replicationSourceSchema = z.strictObject({
  sourceHostId: businessId,
  generation,
  householdId: businessId,
});

export type ReplicationCursor = z.infer<typeof replicationCursorSchema>;

// The peer transport supplies this binding after authenticating the source.
// A page cannot establish its own authority.
export type ReplicationSource = z.infer<typeof replicationSourceSchema>;

export const businessFields = {
  id: businessId,
  originHostId: businessId,
  hlc: z.string().refine((value) => {
    try {
      parseHlc(value);
      return true;
    } catch {
      return false;
    }
  }),
  rev: z.int().positive(),
  createdAt: wallMs,
  updatedAt: wallMs,
  deletedAt: wallMs.nullable(),
};

export type ReplicatedRevision = {
  [Key in keyof typeof businessFields]: z.infer<(typeof businessFields)[Key]>;
};

export interface ReplicaRecord {
  kind: string;
  row: ReplicatedRevision;
}

export type ReplicationChange<Record extends ReplicaRecord = ReplicaRecord> = ReplicationCursor & Record;
export interface ChangePage<Record extends ReplicaRecord = ReplicaRecord> {
  from: ReplicationCursor;
  next: ReplicationCursor;
  changes: readonly ReplicationChange<Record>[];
  hasMore: boolean;
}

export interface MissingReplicaDependency {
  kind: string;
  id: string;
}

export type ApplyPageResult =
  | { status: "applied"; cursor: ReplicationCursor; applied: number }
  | { status: "waiting"; cursor: ReplicationCursor | null; missing: readonly MissingReplicaDependency[] };

export const replicationErrorCodeSchema = z.enum([
  "invalid_cursor",
  "source_mismatch",
  "reset_required",
  "cursor_ahead",
  "sequence_gap",
  "invalid_page",
  "invalid_record",
  "unsupported_kind",
  "unauthorized_writer",
  "record_conflict",
  "source_uninitialized",
  "watermark_conflict",
  "invalid_snapshot",
  "snapshot_expired",
  "snapshot_too_large",
  "unsupported_protocol",
]);
export type ReplicationErrorCode = z.infer<typeof replicationErrorCodeSchema>;

export class ReplicationError extends Error {
  constructor(
    public readonly code: ReplicationErrorCode,
    message: string,
    public readonly head?: ReplicationCursor,
  ) {
    super(message);
    this.name = "ReplicationError";
  }
}
