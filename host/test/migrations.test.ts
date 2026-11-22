import { Database } from "bun:sqlite";
import { SQLiteBunSession } from "drizzle-orm/bun-sqlite/session";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHostMeta } from "../src/store/host-meta.ts";
import { openStore } from "../src/store/index.ts";
import { expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { migrations } from "../src/store/migrations.generated.ts";

test("内嵌迁移与 drizzle SQL、日志和哈希完全一致", () => {
  const authored = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  expect(migrations).toEqual(authored);
});

for (const [previousTag, count] of [["0000_optimal_rhino", 1], ["0008_cute_talisman", 9],
  ["0009_r4_knowledge", 10], ["0010_r4_household_memory", 11], ["0022_r8_15_notifications", 23],
  ["0023_r4_model_runtime", 24], ["0024_r8_shared_world", 25]] as const) {
  test(`SQLite 自 ${previousTag} 升级并可重开，保持旧数据及迁移哈希`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cattt-r4-migration-"));
    const path = join(directory, "host.db");
    try {
      const original = new Database(path);
      try {
        original.exec("PRAGMA foreign_keys = ON");
        const dialect = new SQLiteSyncDialect();
        dialect.migrate(migrations.slice(0, count), new SQLiteBunSession(original, dialect, undefined));
        original.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["upgrade_fixture", previousTag]);
      } finally {
        original.close();
      }
      for (let i = 0; i < 2; i += 1) {
        const store = openStore(path);
        try {
          expect(getHostMeta(store.db, "upgrade_fixture")).toBe(previousTag);
          expect(store.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(store.raw.query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all())
            .toEqual(migrations.map(({ hash, folderMillis }) => ({ hash, created_at: folderMillis })));
          for (const table of ["memories", "pending_memory_extractions", "memory_extraction_dependencies", "model_calls", "cat_facts"]) {
            expect(store.raw.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table))
              .toEqual({ name: table });
          }
        } finally {
          store.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("#53 文件库按统一迁移链升级，原有 R2/R3 资料、轮次及凭证保留", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SQLiteBunSession } = await import("drizzle-orm/bun-sqlite/session");
  const { SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");
  const { startHost } = await import("../src/runtime/index.ts");
  const { readChangePage } = await import("../src/store/replication.ts");
  const directory = mkdtempSync(join(tmpdir(), "cattt-r64-upgrade-"));
  const host = "018bcfe5-6800-7000-8000-000000000001";
  const family = "018bcfe5-6800-7000-8000-000000000002";
  const alice = "018bcfe5-6800-7000-8000-000000000003";
  const group = "018bcfe5-6800-7000-8000-000000000004";
  const direct = "018bcfe5-6800-7000-8000-000000000005";
  const msg = "018bcfe5-6800-7000-8000-000000000006";
  const device = "018bcfe5-6800-7000-8000-000000000007";
  const turn = "018bcfe5-6800-7000-8000-000000000008";
  const { encodeHlc } = await import("../src/clock/index.ts");
  const wall = 1_700_000_000_000;
  const hlc = encodeHlc({ physicalMs: wall, logical: 0, nodeId: host });
  try {
    const raw = new Database(join(directory, "cattt.db"), { strict: true });
    try {
      raw.exec("PRAGMA foreign_keys = ON");
      const dialect = new SQLiteSyncDialect();
      dialect.migrate(migrations.slice(0, 9), new SQLiteBunSession(raw, dialect, undefined));
      const row = (id: string) => [id, host, hlc, 1, wall, wall, null];
      raw.run("INSERT INTO host_meta (key, value) VALUES ('host_id', ?)", [host]);
      raw.run("INSERT INTO households VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [...row(family), "旧家庭"]);
      raw.run("INSERT INTO hosts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [...row(host), family, "旧 Mac"]);
      raw.run("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [...row(alice), family, "甲", host]);
      raw.run("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [...row(group), family, "group", null, host]);
      raw.run("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [...row(direct), family, "direct", alice, host]);
      raw.run("INSERT INTO messages (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, conversation_id, author_member_id, text, modality, status, client_message_id, reply_to_message_id, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', 'complete', ?, NULL, ?)",
        [...row(msg), direct, alice, "原来已有的消息", "v3-idempotency", turn]);
      raw.run("INSERT INTO turns (id, conversation_id, trigger_message_id, status, heartbeat_at, created_at, finished_at, draft_text, event_seq) VALUES (?, ?, ?, 'completed', ?, ?, ?, '', 1)",
        [turn, direct, msg, wall, wall, wall]);
      raw.run("INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)", [...row(device), alice, host, "原手机"]);
      raw.run("INSERT INTO device_credentials VALUES (?, ?)", [device, "旧凭证哈希"]);
    } finally { raw.close(); }
    const upgraded = await startHost({ dataDir: directory }, []);
    let head;
    try {
      expect(upgraded.hostId).toBe(host);
      expect(upgraded.householdId).toBe(family);
      expect(upgraded.store.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(upgraded.store.raw.query("SELECT id, turn_id FROM messages").get()).toEqual({ id: msg, turn_id: turn });
      expect(upgraded.store.raw.query("SELECT id, status FROM turns").get()).toEqual({ id: turn, status: "completed" });
      expect(upgraded.store.raw.query("SELECT token_hash FROM device_credentials").get()).toEqual({ token_hash: "旧凭证哈希" });
      const page = readChangePage(upgraded.store.db, host, null);
      expect(page.changes.find((change) => change.kind === "message")?.row).toMatchObject({ id: msg, text: "原来已有的消息" });
      expect(JSON.stringify(page)).not.toContain("旧凭证哈希");
      expect(upgraded.store.raw.query("SELECT name FROM sqlite_master WHERE name IN ('peers', 'peer_cursors', 'change_log', 'replication_state')").all()).toHaveLength(4);
      head = page.next;
    } finally { await upgraded.stop(); }
    const restarted = await startHost({ dataDir: directory }, []);
    try { expect(readChangePage(restarted.store.db, host, null).next).toEqual(head); }
    finally { await restarted.stop(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const [name, count] of [["R5.5", 19], ["R6.10", 20]] as const) {
  test(`${name} 试验库升级保留事项、信件、已读和发布证明，补录知识不触发工作`, async () => {
    const { startHost } = await import("../src/runtime/index.ts");
    const { encodeHlc } = await import("../src/clock/index.ts");
    const { readChangePage } = await import("../src/store/replication.ts");
    const directory = mkdtempSync(join(tmpdir(), "cattt-r610-upgrade-"));
    const id = (suffix: number) => `018bcfe5-6800-7000-8000-${String(suffix).padStart(12, "0")}`;
    const [hostId, householdId, memberId, conversationId, messageId, ticketId, letterId, reportId, jobId] =
      Array.from({ length: 9 }, (_, index) => id(index + 1));
    const wall = 1_700_000_000_000;
    const hlc = encodeHlc({ physicalMs: wall, logical: 1, nodeId: hostId! });
    const business = (key: string, rev = 1) => [key, hostId!, hlc, rev, wall, wall, null];
    const generation = crypto.randomUUID();
    try {
      const raw = new Database(join(directory, "cattt.db"), { strict: true });
      try {
        raw.exec("PRAGMA foreign_keys = ON");
        const dialect = new SQLiteSyncDialect();
        dialect.migrate(migrations.slice(0, 19), new SQLiteBunSession(raw, dialect, undefined));
        raw.run("INSERT INTO host_meta VALUES ('host_id', ?)", [hostId!]);
        raw.run("INSERT INTO households VALUES (?, ?, ?, ?, ?, ?, ?, '旧家庭')", business(householdId!));
        raw.run("INSERT INTO hosts VALUES (?, ?, ?, ?, ?, ?, ?, ?, '旧 Mac')", [...business(hostId!), householdId!]);
        raw.run("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, '甲', ?)", [...business(memberId!), householdId!, hostId!]);
        raw.run("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'direct', ?, ?)",
          [...business(conversationId!), householdId!, memberId!, hostId!]);
        raw.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '旧约定', 'text', 'complete', 'original', NULL, NULL)",
          [...business(messageId!), conversationId!, memberId!]);
        raw.run("INSERT INTO participants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [...business(id(10)), conversationId!, memberId!]);
        raw.run("INSERT INTO replication_state VALUES (?, ?, 0, 0)", [hostId!, generation]);
        raw.run(`INSERT INTO memories
          (id,origin_host_id,hlc,rev,created_at,updated_at,deleted_at,household_id,source_member_id,
           source_message_id,source_revision,subject_member_id,fingerprint,predicate,value)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,?,'旧偏好','偏好','旧知识')`,
          [...business(id(11)), householdId!, memberId!, messageId!, memberId!]);

        raw.run(`INSERT INTO tickets
          (id,origin_host_id,hlc,rev,created_at,updated_at,deleted_at,household_id,conversation_id,for_member_id,publisher_host_id,
           kind,mandate_kind,source_message_id,source_revision,goal,status,stage,ended_reason,due_at,time_zone)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'followup','explicit',?,1,'旧目标','ended','completed','due',?,'UTC')`,
          [...business(ticketId!, 2), householdId!, conversationId!, memberId!, hostId!, messageId!, wall]);
        raw.run(`INSERT INTO mailbox_letters
          (id,origin_host_id,hlc,rev,created_at,updated_at,deleted_at,household_id,conversation_id,for_member_id,publisher_host_id,
           ticket_id,text,created_hlc,read_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'已看过的旧信',?,?)`,
          [...business(letterId!, 2), householdId!, conversationId!, memberId!, hostId!, ticketId!, hlc, wall]);
        raw.run(`INSERT INTO worker_reports
          (id,ticket_id,ticket_rev,result_ticket_rev,household_id,conversation_id,for_member_id,publisher_host_id,kind,job_id,
           job_attempt,result,source_proofs,dependencies,conversation_head,due_at,time_zone,created_at)
          VALUES (?,?,1,2,?,?,?,?,'followup',?,1,'{"status":"due"}','[]','[]','{}',?,'UTC',?)`,
          [reportId!, ticketId!, householdId!, conversationId!, memberId!, hostId!, jobId!, wall, wall]);
        raw.run(`INSERT INTO publication_receipts
          (report_id,host_id,ticket_id,status,letter_id,resolved_at) VALUES (?,?,?,'published',?,?)`,
          [reportId!, hostId!, ticketId!, letterId!, wall]);
        if (count === 20) {
          dialect.migrate(migrations.slice(19, count), new SQLiteBunSession(raw, dialect, undefined));
        }

      } finally {
        raw.close();
      }
      let originalSeq: number | undefined;
      for (let reopen = 0; reopen < 2; reopen++) {
        const host = await startHost({ dataDir: directory }, []);
        try {
          const page = readChangePage(host.store.db, host.hostId, null, 100);
          expect(page.next.generation).toBe(generation);
          expect(page.changes.filter(({ kind }) => kind === "memory")).toMatchObject([
            { row: { id: id(11), value: "旧知识", originHostId: hostId, dependencies: [] } },
          ]);

          expect(page.changes.filter(({ kind }) => kind.startsWith("ticket") || kind.startsWith("mailbox"))
            .map(({ kind }) => kind)).toEqual(["ticket", "mailbox_letter", "mailbox_read", "ticket_publication"]);
          expect(page.changes.find(({ kind }) => kind === "mailbox_read")?.row).toMatchObject({ id: letterId, readAt: wall });
          expect(page.changes.find(({ kind }) => kind === "ticket_publication")?.row).toMatchObject({ ticketId, ticketRev: 2 });
          expect(host.store.raw.query("SELECT id FROM worker_reports").all()).toEqual([{ id: reportId }]);
          expect(host.store.raw.query("SELECT status FROM publication_receipts").all()).toEqual([{ status: "published" }]);
          expect(host.store.raw.query("SELECT id FROM jobs").all()).toEqual([]);
          expect(host.store.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
          if (originalSeq !== undefined) expect(page.next.seq).toBe(originalSeq);
          originalSeq = page.next.seq;
        } finally {
          await host.stop();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("0021 的旧猫与小院归档升级为一家一猫，旧会话、Soul 与动作留档", async () => {
  const { startHost } = await import("../src/runtime/index.ts");
  const { projectWorld } = await import("../src/store/world-state.ts");
  const { encodeHlc } = await import("../src/clock/index.ts");
  const { createHash } = await import("node:crypto");
  const directory = mkdtempSync(join(tmpdir(), "cattt-world-0021-"));
  const hostId = "018bcfe5-6800-7000-8000-000000000001";
  const householdId = "018bcfe5-6800-7000-8000-000000000002";
  const catId = "20000000-0000-4000-8000-000000000001";
  const userId = "10000000-0000-4000-8000-000000000001";
  const time = 1_700_000_000_000;
  const at = new Date(time).toISOString();
  const hlc = encodeHlc({ physicalMs: time, logical: 0, nodeId: hostId });
  const row = (id: string) => [id, hostId, hlc, 1, time, time, null];
  const records = [
    ["cats", catId, { id: catId, user_id: userId, name: "豆包", appearance: "cow", temperament: "curious", traits: { energy: 2 }, created_at: at }],
    ["world_sessions", "40000000-0000-4000-8000-000000000001", { cat_id: catId, observed_at: at, snapshot: {
      stateVersion: 4, sceneVersion: 4, destinationIds: ["house", "fence"], currentDestinationId: "fence",
      targetDestinationId: "house", phase: "moving", action: "walk", paused: false, runnable: true, bowlFilledToday: true,
    } }],
    ["world_actions", "50000000-0000-4000-8000-000000000001", { cat_id: catId, status: "running" }],
    ["soul_versions", "60000000-0000-4000-8000-000000000001", { cat_id: catId, version: 43 }],
  ] as const;
  try {
    const db = new Database(join(directory, "cattt.db"), { strict: true });
    try {
      const dialect = new SQLiteSyncDialect();
      dialect.migrate(migrations.slice(0, 22), new SQLiteBunSession(db, dialect, undefined));
      db.run("INSERT INTO host_meta VALUES ('host_id', ?)", [hostId]);
      db.run("INSERT INTO households VALUES (?, ?, ?, ?, ?, ?, ?, '旧家庭')", row(householdId));
      db.run("INSERT INTO hosts VALUES (?, ?, ?, ?, ?, ?, ?, ?, '旧 Mac')", [...row(hostId), householdId]);
      db.run("INSERT INTO pg_import_receipts VALUES (1, 'fixture', ?)", [JSON.stringify({
        formatVersion: 1, status: "imported", sourceSha256: "fixture",
        sourceCatId: catId, sourceUserId: userId, hostId, householdId,
      })]);
      for (const [table, id, data] of records) {
        const evidence = JSON.stringify(data);
        db.run("INSERT INTO pg_import_archive VALUES (?, ?, ?, NULL, 'world_and_soul_pending', ?)",
          [table, id, createHash("sha256").update(evidence).digest("hex"), evidence]);
      }
    } finally { db.close(); }
    let restored: ReturnType<typeof projectWorld> = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const host = await startHost({ dataDir: directory }, []);
      try {
        const world = projectWorld(host.store.db, householdId);
        expect(world).toMatchObject({
          profile: { legacy_id: catId, name: "豆包", appearance: "cow", temperament: "curious", traits: { energy: 2 } },
          snapshot: { current_destination_id: "fence", target_destination_id: "fence", phase: "idle", runnable: false, bowl_filled_today: true },
        });
        if (attempt === 1) expect(world).toEqual(restored);
        restored = world;
        for (const table of ["world_sessions", "world_actions", "jobs", "peer_outbox"]) {
          expect(host.store.raw.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
        }
        expect(host.store.raw.query("SELECT count(*) AS n FROM pg_import_archive").get()).toEqual({ n: 4 });
      } finally { await host.stop(); }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
