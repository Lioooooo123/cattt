import { z } from "zod";
import type { StoreDb } from "../store/index.ts";
import { readNativeSnapshot } from "../store/replication-snapshot.ts";
import { getNativeReplicationSource, getReplicationHead, MAX_CHANGE_PAGE, readChangePage } from "../store/replication.ts";
import { PEER_SYNC_PROTOCOL_VERSION } from "./peer-types.ts";
import type { PeerSyncReply, PeerSyncService, SnapshotManifest } from "./peer-types.ts";
import { ReplicationError } from "./types.ts";
import type { ReplicationSource } from "./types.ts";

const SNAPSHOT_TTL_MS = 5 * 60_000;
const MAX_OPEN_SNAPSHOTS = 4;

const snapshotPageRequestSchema = z.strictObject({
  snapshotId: z.uuidv4(),
  offset: z.int().nonnegative(),
  limit: z.int().min(1).max(MAX_CHANGE_PAGE),
});

function reply<T>(source: ReplicationSource, data: T): PeerSyncReply<T> {
  return { protocol_version: PEER_SYNC_PROTOCOL_VERSION, source, data };
}

// The route adapter must call these operations only after peer authentication.
export function createPeerSyncService(db: Pick<StoreDb, "select" | "transaction">, sourceHostId: string): PeerSyncService {
  type OpenSnapshot = ReturnType<typeof readNativeSnapshot> & { manifest: SnapshotManifest; expiresAt: number };
  const snapshots = new Map<string, OpenSnapshot>();

  return {
    openSnapshot() {
      const snapshot = readNativeSnapshot(db, sourceHostId);
      const manifest: SnapshotManifest = {
        snapshotId: crypto.randomUUID(),
        watermark: snapshot.watermark,
        recordCount: snapshot.records.length,
      };
      const now = performance.now();
      for (const [id, open] of snapshots) {
        if (open.expiresAt <= now || open.source.generation !== snapshot.source.generation) {
          snapshots.delete(id);
        }
      }
      if (snapshots.size === MAX_OPEN_SNAPSHOTS) {
        snapshots.delete(snapshots.keys().next().value!);
      }
      snapshots.set(manifest.snapshotId, { ...snapshot, manifest, expiresAt: now + SNAPSHOT_TTL_MS });
      return structuredClone(reply(snapshot.source, manifest));
    },

    readSnapshotPage(request) {
      const parsed = snapshotPageRequestSchema.safeParse(request);
      if (!parsed.success) {
        throw new ReplicationError("invalid_snapshot", "快照页参数无效");
      }
      const { snapshotId, offset, limit } = parsed.data;
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot || snapshot.expiresAt <= performance.now()) {
        snapshots.delete(snapshotId);
        throw new ReplicationError("snapshot_expired", "快照已过期，须重新打开");
      }
      const head = getReplicationHead(db, sourceHostId);
      if (snapshot.source.generation !== head.generation) {
        snapshots.delete(snapshotId);
        throw new ReplicationError("reset_required", "快照打开后来源世代变化", head);
      }
      if (offset >= snapshot.manifest.recordCount) {
        throw new ReplicationError("invalid_snapshot", "快照页起点超过记录范围");
      }
      return structuredClone(reply(snapshot.source, {
        snapshotId, offset, records: snapshot.records.slice(offset, offset + limit),
      }));
    },

    readChanges({ cursor, limit }) {
      return db.transaction((tx) => {
        const source = getNativeReplicationSource(tx, sourceHostId);
        try {
          const page = readChangePage(tx, sourceHostId, cursor, limit);
          return reply(source, { status: "changes", page });
        } catch (error) {
          if (error instanceof ReplicationError && error.code === "reset_required" && error.head) {
            return reply(source, { status: "reset_required", head: error.head });
          }
          throw error;
        }
      });
    },
  };
}
