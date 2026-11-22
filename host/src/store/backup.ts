import { Database } from "bun:sqlite";
import { getHostMeta, setHostMeta } from "./host-meta.ts";
import { openStore, writeTransaction } from "./index.ts";
import { migrations } from "./migrations.generated.ts";
import { getReplicationHead, rotateReplicationGeneration } from "./replication.ts";
import { leases, pairingCodes } from "./schema/index.ts";

const expectedMigrations = migrations.map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis }));
const migrationVersion = expectedMigrations.at(-1)!;
const expectedSchema = (() => {
  // Created lazily so normal host boot doesn't migrate a second database.
  let schema: string | undefined;
  return () => {
    if (schema !== undefined) return schema;
    const reference = openStore(":memory:");
    try { schema = schemaOf(reference.raw); } finally { reference.close(); }
    return schema;
  };
})();

export interface BackupDatabase {
  hostId: string;
  householdId: string;
  generation: string;
  seq: number;
  migration: string;
}

export function snapshotDatabase(source: Database | string, destination: string): void {
  const raw = typeof source === "string" ? new Database(source, { readonly: true, strict: true }) : source;
  try {
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.query("VACUUM INTO $destination").run({ destination });
  } finally {
    if (typeof source === "string") raw.close();
  }
}

function schemaOf(db: Database): string {
  return JSON.stringify(db.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all());
}

export function inspectDatabase(path: string): BackupDatabase {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    if (JSON.stringify(db.query("PRAGMA integrity_check").all()) !== '[{"integrity_check":"ok"}]'
      || db.query("PRAGMA foreign_key_check").get()) {
      throw new Error("SQLite 完整性检查失败");
    }
    if (JSON.stringify(db.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all())
      !== JSON.stringify(expectedMigrations) || schemaOf(db) !== expectedSchema()) {
      throw new Error("SQLite 迁移版本不匹配，请使用相同版本的宿主管理器");
    }
    const identity = db.query<BackupDatabase, []>(`
      SELECT h.id AS hostId, f.id AS householdId, s.generation, s.last_seq AS seq
      FROM host_meta AS m JOIN hosts AS h ON h.id = m.value
        JOIN households AS f ON f.id = h.household_id
        JOIN replication_state AS s ON s.source_host_id = h.id
      WHERE m.key='host_id' AND h.deleted_at IS NULL AND f.deleted_at IS NULL
    `).get();
    if (!identity || !Number.isSafeInteger(identity.seq) || identity.seq < 0) {
      throw new Error("SQLite 缺少有效宿主身份或复制水位");
    }
    return { ...identity, migration: migrationVersion.hash };
  } finally {
    db.close();
  }
}

function differs(db: Database, table: string, left: string, right: string) {
  return !!db.query(`SELECT 1 FROM (SELECT * FROM ${left}.${table} EXCEPT SELECT * FROM ${right}.${table}) LIMIT 1`).get();
}

// Checks for facts that cannot legitimately disappear or move backwards
// within the same live installation, including facts deliberately kept
// outside of the replicated business log.
const settledProofs = [
  "SELECT * FROM {db}.peer_inbox",
  "SELECT * FROM {db}.peer_outbox WHERE status IN ('delivered','rejected')",
  "SELECT * FROM {db}.knowledge_source_withdrawals",
  "SELECT * FROM {db}.publication_receipts WHERE status IN ('published','dropped')",
  "SELECT id, status FROM {db}.publication_push_outbox WHERE status IN ('sent','dropped','uncertain')",
  "SELECT * FROM {db}.relay_publications WHERE state IN ('published','dropped')",
  "SELECT id, status FROM {db}.jobs WHERE status IN ('done','dead')",
  "SELECT id, status FROM {db}.turns WHERE status IN ('completed','failed','stopped','superseded')",
  "SELECT household_id, epoch, grant_id, holder_host_id, previous_holder_host_id, previous_grant_id, history_digest FROM {db}.publication_epochs",
  "SELECT household_id, epoch FROM {db}.publication_epochs WHERE acknowledged=1",
];

function assertSettledProofs(db: Database) {
  for (const proof of settledProofs) {
    const selected = proof.replace("{db}", "selected");
    const current = proof.replace("{db}", "main");
    if (db.query(`SELECT 1 FROM (${selected} EXCEPT ${current}) LIMIT 1`).get()) {
      throw new Error("操作前数据库缺少备份中已提交的撤回、收据或执行证明，已拒绝恢复");
    }
  }
}

// The stopped local installation is the authority for effects and revisions.
// Keep the entire consistent checkpoint when it is ahead. Applying isolated
// row patches could split a revocation, an outbox receipt, and their effects.
export function chooseRestoreDatabase(current: string, selected: string, live: BackupDatabase, backup: BackupDatabase) {
  if (live.hostId !== backup.hostId || live.householdId !== backup.householdId) {
    throw new Error("备份属于另一台宿主或家庭");
  }
  if (live.generation !== backup.generation || live.seq < backup.seq) {
    throw new Error("无法证明备份和操作前数据库属于同一段历史");
  }
  const db = new Database(current, { readonly: true, strict: true });
  try {
    db.query("ATTACH DATABASE $selected AS selected").run({ selected });
    const count = (schema: "main" | "selected") => db.query<{ count: number }, [string, string, number]>(`
      SELECT count(*) AS count FROM ${schema}.change_log WHERE source_host_id=? AND generation=? AND seq BETWEEN 1 AND ?
    `).get(backup.hostId, backup.generation, backup.seq)?.count;
    const conflict = db.query(`
      SELECT 1 FROM selected.change_log AS a LEFT JOIN main.change_log AS b
        ON a.source_host_id=b.source_host_id AND a.generation=b.generation AND a.seq=b.seq
      WHERE a.source_host_id=? AND a.generation=? AND a.seq BETWEEN 1 AND ?
        AND (b.seq IS NULL OR a.kind<>b.kind OR a.payload<>b.payload) LIMIT 1
    `).get(backup.hostId, backup.generation, backup.seq);
    if (count("main") !== backup.seq || count("selected") !== backup.seq || conflict) {
      throw new Error("复制历史缺失或发生分叉，已拒绝恢复");
    }
    assertSettledProofs(db);
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all();
    for (const { name } of tables) {
      const table = `"${name.replaceAll('"', '""')}"`;
      if (differs(db, table, "main", "selected") || differs(db, table, "selected", "main")) {
        return "retained_current" as const;
      }
    }
    return "snapshot" as const;
  } finally {
    db.close();
  }
}

export function fenceRestoredDatabase(path: string, hostId: string): string {
  const staged = openStore(path);
  try {
    // Keep group epoch/handoff and committed effects; new processes must earn
    // a fresh peer publication window. Expire only process-local leases.
    const generation = rotateReplicationGeneration(staged.db, hostId).generation;
    writeTransaction(staged, (db) => {
      setHostMeta(db, "phone_sync_generation", generation);
      db.update(leases).set({ expiresAt: 0 }).run();
      db.delete(pairingCodes).run();
    });
    staged.raw.exec("PRAGMA journal_mode = DELETE");
    return generation;
  } finally {
    staged.close();
  }
}

export interface BackupBlob { path: string; bytes: number; sha256?: string }

export function backupBlobs(path: string): BackupBlob[] {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='file_blobs'").get()) return [];
    // Use the same snapshot as the business rows. A content file can be
    // present on disk before file_blobs commits; it isn't verified yet.
    const verified = db.query<{ sha256: string; byte_size: number }, []>(
      "SELECT sha256, byte_size FROM file_blobs ORDER BY sha256",
    ).all().map(({ sha256, byte_size }) => ({ path: `blobs/content/${sha256}`, bytes: byte_size, sha256 }));
    const partial = db.query<{ id: string; byte_size: number }, []>(`
      SELECT u.id, u.byte_size FROM file_uploads AS u LEFT JOIN files AS f ON u.id=f.id
      WHERE f.id IS NULL ORDER BY u.id
    `).all().map(({ id, byte_size }) => ({ path: `blobs/uploads/${id}`, bytes: byte_size }));
    return [...verified, ...partial];
  } finally { db.close(); }
}

export function phoneSyncGeneration(db: Parameters<typeof getHostMeta>[0], hostId: string) {
  return getHostMeta(db, "phone_sync_generation") ?? getReplicationHead(db, hostId).generation;
}
