import { z } from "zod";
import { MAX_SNAPSHOT_RECORDS, snapshotManifestSchema, snapshotRecordSchema } from "../replication/peer-types.ts";
import type { SnapshotManifest } from "../replication/peer-types.ts";
import { ReplicationError, replicationSourceSchema } from "../replication/types.ts";
import type { ApplyPageResult, ReplicationCursor, ReplicationSource } from "../replication/types.ts";
import type { StoreDb } from "./index.ts";
import { replicaAdapters } from "./replica-records.ts";
import type { NativeReplicaRecord } from "./replica-records.ts";
import {
  applyReplicaBatch, applyReplicaRecord, assertRemoteScope, getNativeReplicationSource, getReplicationHead,
  installReplicationWatermark, PageWaitingError,
} from "./replication.ts";

type ReplicationDb = Pick<StoreDb, "transaction">;

export function readNativeSnapshot(db: ReplicationDb, sourceHostId: string) {
  return db.transaction((tx) => {
    // The first read fixes the WAL view. Both the watermark and every record
    // are read from this view, including tombstones.
    const watermark = getReplicationHead(tx, sourceHostId);
    const source = getNativeReplicationSource(tx, sourceHostId);
    const records: NativeReplicaRecord[] = [];
    for (const adapter of Object.values(replicaAdapters)) {
      for (const record of adapter.snapshot(source, tx, MAX_SNAPSHOT_RECORDS - records.length + 1)) {
        records.push(record);
      }
      if (records.length > MAX_SNAPSHOT_RECORDS) {
        throw new ReplicationError("snapshot_too_large", "来源业务行数超过当前快照上限");
      }
    }
    return { source, watermark, records };
  });
}

const snapshotSchema = z.strictObject({
  manifest: snapshotManifestSchema,
  records: z.array(snapshotRecordSchema).max(MAX_SNAPSHOT_RECORDS),
});

export function applyReplicaSnapshot(
  db: ReplicationDb, authenticatedSource: ReplicationSource, expected: ReplicationCursor | null,
  manifest: SnapshotManifest, records: readonly unknown[],
): ApplyPageResult {
  const sourceResult = replicationSourceSchema.safeParse(authenticatedSource);
  if (!sourceResult.success) {
    throw new ReplicationError("source_mismatch", "快照缺少有效的已认证复制来源");
  }
  const source = sourceResult.data;
  const parsed = snapshotSchema.safeParse({ manifest, records });
  if (!parsed.success || parsed.data.manifest.recordCount !== parsed.data.records.length) {
    throw new ReplicationError("invalid_snapshot", "快照缺少完整的业务记录");
  }
  const { watermark } = parsed.data.manifest;
  if (watermark.sourceHostId !== source.sourceHostId) {
    throw new ReplicationError("source_mismatch", "快照水位属于另一宿主");
  }
  if (watermark.generation !== source.generation) {
    throw new ReplicationError("reset_required", "快照水位的世代已变化");
  }
  const keys = new Set<string>();
  for (const { kind, row } of parsed.data.records) {
    if (row.originHostId !== source.sourceHostId) {
      throw new ReplicationError("unauthorized_writer", "快照只接受已认证宿主的原创记录");
    }
    const key = JSON.stringify([kind, row.id]);
    if (keys.has(key)) {
      throw new ReplicationError("invalid_snapshot", "快照包含重复业务记录");
    }
    keys.add(key);
  }
  if (!keys.has(JSON.stringify(["host", source.sourceHostId]))) {
    throw new ReplicationError("invalid_snapshot", "快照缺少来源宿主资料");
  }

  try {
    return db.transaction((tx) => {
      assertRemoteScope(tx, source);
      const applied = applyReplicaBatch(parsed.data.records, expected, (record) => applyReplicaRecord(tx, source, record));
      installReplicationWatermark(tx, source, watermark, expected);
      return { status: "applied", cursor: watermark, applied };
    }, { behavior: "immediate" });
  } catch (error) {
    if (error instanceof PageWaitingError) {
      return error.result;
    }
    throw error;
  }
}
