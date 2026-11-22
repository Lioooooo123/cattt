import "reflect-metadata";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { createBackup, finishRestore, prepareRestore, rollbackRestore, validateBackup } from "../src/backup/index.ts";
import { getReplicationHead, readChangePage } from "../src/store/replication.ts";
import { issueTestDevice } from "./identity-fixture.ts";

test("WAL 在线成品、停服检查点、旧世代和已完成行为", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-backup-"));
  const alternate = mkdtempSync(join(tmpdir(), "cattt-backup-other-"));
  const gateway = new Gateway({ lanPort: 0, peerPort: 0 });
  const host = await startHost({ dataDir: root, port: 0 }, [gateway]);
  const other = await startHost({ dataDir: alternate, port: 0 }, [new Gateway({ lanPort: 0 })]);
  const file = join(root, "cattt.db");
  const reader = new Database(file, { readonly: true });
  try {
    reader.exec("BEGIN");
    reader.query("SELECT * FROM host_meta").all();
    const phone = issueTestDevice(host);
    const old = getReplicationHead(host.store.db, host.hostId);
    const saved = createBackup(root, host.store, "manual");
    const backup = validateBackup(root, saved.id);
    const snapshot = new Database(join(backup.directory, "cattt.db"), { readonly: true });
    expect(snapshot.query("SELECT id FROM devices").all()).toEqual([{ id: phone.deviceId }]);
    snapshot.close();
    const db = host.store.raw;
    db.query("INSERT INTO peer_inbox VALUES (?, ?, ?, ?, ?)").run(host.householdId, "peer", "action", "hash", "receipt");
    db.query("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "completed", "fixture", "{}", "done", 1, 1, 1, null, "one", null, 1, 1);
    const env = join(alternate, "env");
    writeFileSync(env, "MODEL_PROVIDER=mock\n");
    const wrong = createBackup(alternate, other.store, "manual");
    await other.stop();
    writeFileSync(env, "MODEL_PROVIDER=mock\nMOCK_DELAY_MS=2\n");
    const exact = prepareRestore(alternate, wrong.id);
    expect(exact.database).toBe("snapshot");
    expect(readFileSync(env, "utf8")).toBe("MODEL_PROVIDER=mock\n");
    finishRestore(alternate);
    reader.close();
    await host.stop();

    cpSync(join(alternate, "backups", wrong.id), join(root, "backups", wrong.id), { recursive: true });
    expect(() => prepareRestore(root, wrong.id)).toThrow("备份属于另一台宿主或家庭");
    expect(() => validateBackup(root, "../" + wrong.id)).toThrow();
    const proof = createBackup(root, undefined, "manual");
    const proofWriter = new Database(file);
    proofWriter.run("DELETE FROM peer_inbox");
    proofWriter.close();
    expect(() => prepareRestore(root, proof.id)).toThrow("缺少备份中已提交");
    const reinsert = new Database(file);
    reinsert.query("INSERT INTO peer_inbox VALUES (?, ?, ?, ?, ?)").run(host.householdId, "peer", "action", "hash", "receipt");
    reinsert.close();
    const prepared = prepareRestore(root, saved.id);
    expect(prepared.database).toBe("retained_current");
    const restored = await startHost({ dataDir: root, port: 0 }, []);
    try {
      expect(() => readChangePage(restored.store.db, host.hostId, old)).toThrow("世代");
      expect(restored.store.raw.query("SELECT receipt FROM peer_inbox").get()).toEqual({ receipt: "receipt" });
      expect(restored.store.raw.query("SELECT status FROM jobs WHERE id='completed'").get()).toEqual({ status: "done" });
    } finally {
      await restored.stop();
    }
    rollbackRestore(root);
    finishRestore(root);
    const reverted = await startHost({ dataDir: root, port: 0 }, []);
    try {
      expect(getReplicationHead(reverted.store.db, host.hostId)).toEqual(old);
      expect(reverted.store.raw.query("SELECT receipt FROM peer_inbox").get()).toEqual({ receipt: "receipt" });
    } finally { await reverted.stop(); }

    const manifestPath = join(backup.directory, "manifest.json");
    const valid = readFileSync(manifestPath);
    const version = JSON.parse(valid.toString());
    writeFileSync(manifestPath, JSON.stringify({ ...version, format: 999 }));
    expect(() => validateBackup(root, saved.id)).toThrow();
    writeFileSync(manifestPath, valid);
    writeFileSync(join(backup.directory, "cattt.db"), "broken");
    expect(() => validateBackup(root, saved.id)).toThrow();
  } finally {
    reader.close();
    await host.stop();
    await other.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(alternate, { recursive: true, force: true });
  }
});
