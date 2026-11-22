import "reflect-metadata";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { configFromEnv } from "../src/runtime/config.ts";
import { createDevice } from "../src/store/identity.ts";
import { applyReplicaSnapshot, readNativeSnapshot } from "../src/store/replication-snapshot.ts";
import { openStore } from "../src/store/index.ts";
import { readChangePage } from "../src/store/replication.ts";
import { listRecallMemories } from "../src/store/knowledge.ts";
import { recallKnowledge } from "../src/context/knowledge.ts";
import { currentSoul } from "../src/store/soul.ts";
import { listModelVisibleMessages } from "../src/store/model-visible-messages.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = join(root, "host/src/main.ts");
const sqlDir = join(root, "server/drizzle");
const fixture = fileURLToPath(new URL("./fixtures/import-pg.sql", import.meta.url));
const pgTest = process.env.CATTT_TEST_PG === "1" ? test : test.skip;

function run(args: string[], options: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  return Bun.spawnSync(args, {
    cwd: options.cwd, env: options.env ?? process.env, stdin: options.input === undefined ? "ignore" : Buffer.from(options.input),
    stdout: "pipe", stderr: "pipe",
  });
}

function ok(result: ReturnType<typeof run>) {
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

async function unusedPort() {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = listener.port;
  await listener.stop(true);
  return port;
}

test("import-pg 子命令要求独立目录和显式 PG 连接", () => {
  const result = run([process.execPath, "--no-env-file", entry, "import-pg"], { env: { PATH: process.env.PATH! } });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("--target-dir");
});

pgTest("真实 PG 迁移、只读账号、源码与二进制重试、账本、启动读路径和原子拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cattt-import-pg-test-"));
  const data = join(dir, "legacy");
  const port = await unusedPort();
  const target = join(dir, "target");
  const binary = join(dir, "cattt");
  const pg = ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(port), "-U", "fixture_admin", "-d", "postgres"];
  const env = { PATH: process.env.PATH!, CATTT_IMPORT_PG_URL: `postgres://fixture_reader@127.0.0.1:${port}/postgres` };
  let started = false;
  try {
    ok(run(["initdb", "-D", data, "-U", "fixture_admin", "-A", "trust", "--no-locale", "-E", "UTF8"]));
    const pgLog = join(dir, "pg.log");
    const startup = run(["pg_ctl", "-D", data, "-l", pgLog, "-o", `-h 127.0.0.1 -p ${port} -k ${dir}`, "-w", "start"]);
    expect(startup.exitCode, startup.stderr.toString() + (existsSync(pgLog) ? readFileSync(pgLog, "utf8") : "")).toBe(0);
    started = true;
    // Reuse one client while retaining a separate transaction for each legacy migration.
    const migrations = readdirSync(sqlDir).filter((name) => name.endsWith(".sql")).sort();
    ok(run([...pg, ...migrations.flatMap((name) => ["-c", "BEGIN", "-f", join(sqlDir, name), "-c", "COMMIT"])]));
    ok(run([...pg, "-f", fixture]));
    ok(run(pg, { input: "CREATE ROLE fixture_reader LOGIN; GRANT SELECT ON ALL TABLES IN SCHEMA public TO fixture_reader;" }));
    const srcArgs = [process.execPath, "--no-env-file", entry, "import-pg", "--target-dir", target];
    const imported = JSON.parse(ok(run(srcArgs, { cwd: dir, env })));
    expect(imported.status).toBe("imported");
    expect(imported.tables.messages).toMatchObject({ sourceCount: 6, liveCount: 6 });
    expect(imported.tables.memories).toMatchObject({
      sourceCount: 4, liveCount: 1, archiveCount: 3,
      reasons: { source_withdrawn: 1, source_unproven: 1, subject_unmapped: 1 },
    });
    expect(imported.tables.paired_devices).toMatchObject({ sourceCount: 1, liveCount: 0, archiveCount: 0 });
    for (const table of Object.values(imported.tables) as { sourceSha256: string; targetSha256: string }[]) {
      expect(table.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(table.targetSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    ok(run([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", entry, join(root, "host/src/ticket-workers/compute-worker.ts"), "--outfile", binary]));
    const repeated = JSON.parse(ok(run([binary, "import-pg", "--target-dir", target], { cwd: dir, env })));
    expect(repeated).toEqual({ ...imported, status: "verified" });
    const parallelTarget = join(dir, "second");
    const second = JSON.parse(ok(run([binary, "import-pg", "--target-dir", parallelTarget], { cwd: dir, env })));
    expect(second).toEqual(imported);

    const sqlitePath = join(target, "cattt.db");
    const bytes = readFileSync(sqlitePath);
    expect(bytes.includes(Buffer.from("must-not-copy"))).toBe(false);
    expect(bytes.includes(Buffer.from("旁人的原话"))).toBe(false);
    expect(bytes.includes(Buffer.from("历史执行结果"))).toBe(true);
    const prior = join(dir, "existing");
    mkdirSync(prior);
    writeFileSync(join(prior, "cattt.db"), "owned by user");
    expect(run([binary, "import-pg", "--target-dir", prior], { cwd: dir, env }).exitCode).not.toBe(0);
    expect(readFileSync(join(prior, "cattt.db"), "utf8")).toBe("owned by user");
    ok(run(pg, { input: "UPDATE public.messages SET text = '字句变了' WHERE id = '40000000-0000-4000-8000-000000000001';" }));
    expect(run(srcArgs, { cwd: dir, env }).exitCode).not.toBe(0);
    expect(readFileSync(sqlitePath)).toEqual(bytes);
    ok(run(pg, { input: "UPDATE public.messages SET created_at = '1800-01-01Z' WHERE id = '40000000-0000-4000-8000-000000000001';" }));
    const bad = join(dir, "failed-target");
    expect(run([binary, "import-pg", "--target-dir", bad], { cwd: dir, env }).exitCode).not.toBe(0);
    expect(existsSync(join(bad, "cattt.db"))).toBe(false);

    const host = await startConfiguredHost(configFromEnv({
      CATTT_DATA_DIR: target, CATTT_PORT: String(await unusedPort()), CATTT_LAN_HTTPS_PORT: String(await unusedPort()),
      CATTT_PEER_HTTPS_PORT: String(await unusedPort()), MODEL_PROVIDER: "mock",
    }));
    try {
      const device = createDevice(host.store.db, host.clock, {
        memberId: imported.memberId, hostId: host.hostId, name: "新配对设备",
      });
      const request = (path: string, method = "GET", body?: object, token = device.token) =>
        fetch(`https://127.0.0.1:${host.config.lanHttpsPort}/v2${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          tls: { ca: readFileSync(join(target, "tls/ca.crt"), "utf8") },
        });
      const api = async (path: string) => {
        const response = await request(path);
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await api("/soul")).toMatchObject({
        soul: { habits: { response_length: "brief" }, legacy: { version: 3, unmapped: 1 },
          runtime: { energy: "baseline" } },
      });
      expect(await api("/cat-diary")).toMatchObject({
        entries: [{ origin: "legacy", text: "团子的院子日记" }],
      });
      expect(await api("/world/state")).toMatchObject({
        execution_available: false, presence: [],
        world: {
          profile: { legacy_id: imported.sourceCatId, name: "团子", appearance: "orange", temperament: "quiet" },
          snapshot: { current_destination_id: "pond", target_destination_id: "pond", phase: "idle",
            runnable: false, bowl_filled_today: true, last_drink_at: "2025-01-06T12:00:00Z" },
        },
      });
      const chats = await api("/conversations");
      expect(chats.conversations).toHaveLength(2);
      const history = await api(`/conversations/${imported.conversationId}/messages`);
      expect(history.messages.map((message: { text: string }) => message.text)).toEqual([
        "记住我喜欢乌龙茶", "我记住了", "已经撤回的秘密", "帮我整理面试，下周接着聊", "整理好的结果", "复述过撤回的秘密",
      ]);
      const recalled = recallKnowledge("我喜欢的茶是什么", listRecallMemories(host.store.db, {
        householdId: host.householdId,
      }), [], new Map([[imported.memberId, "Han"]]), () => false);
      expect(recalled.text).toContain("乌龙茶");
      expect(recalled.evidence).toHaveLength(1);
      const ids = history.messages.map(({ id }: { id: string }) => id);
      const visible = (store: ReturnType<typeof openStore>) => listModelVisibleMessages(store.db,
        host.householdId, imported.conversationId, ids).map(({ text }) => text);
      expect(visible(host.store)).not.toContain("已经撤回的秘密");
      expect(visible(host.store)).not.toContain("复述过撤回的秘密");
      expect((await api("/diary")).entries).toMatchObject([{ text: "这是私人日记", cat_allowed: false, revision: 3 }]);
      expect((await api("/cat-diary")).entries).toMatchObject([{ text: "团子的院子日记", local_day: "2025-01-04" }]);
      const tickets = (await api("/tickets?status=all")).tickets;
      expect(tickets).toHaveLength(3);
      expect(tickets.find((row: { kind: string }) => row.kind === "followup")).toMatchObject({ status: "open", stage: "quiet_waiting" });
      expect((await api("/mailbox")).letters).toMatchObject([{ text: "旧信箱里的结果", read_at: Date.parse("2025-01-06") }]);
      const snapshot = readNativeSnapshot(host.store.db, host.hostId);
      expect(snapshot.records.map(({ kind }) => kind)).toContain("knowledge_source_withdrawal");
      expect(snapshot.records.map(({ kind }) => kind)).toContain("ticket_publication");
      expect(snapshot.records.map(({ kind }) => kind)).toContain("ticket_decision");
      expect(snapshot.records.map(({ kind }) => kind)).toContain("legacy_cat_diary");
      expect(snapshot.records.map(({ kind }) => kind)).toContain("legacy_memory_block");
      expect(snapshot.records.map(({ kind }) => kind)).toContain("world_state");
      expect(snapshot.records.map(({ kind }) => kind)).not.toContain("world_action");
      expect(() => readChangePage(host.store.db, host.hostId, null, 20)).toThrow();
      const peer = openStore(join(dir, "peer.db"));
      try {
        const applied = applyReplicaSnapshot(peer.db, snapshot.source, null, {
          snapshotId: crypto.randomUUID(), watermark: snapshot.watermark, recordCount: snapshot.records.length,
        }, JSON.parse(JSON.stringify(snapshot.records)));
        expect(applied.status).toBe("applied");
        expect(visible(peer)).toEqual(visible(host.store));
        const archivedState = (instant: string) => currentSoul(peer.db, host.householdId, [imported.memberId], Date.parse(instant)).runtime;
        expect(archivedState("2025-01-04T23:59:59Z").energy).toBe("baseline");
        expect(archivedState("2025-01-05T00:30:00Z")).toMatchObject({ energy: "resting", willingness: "quiet" });
        expect(archivedState("2025-01-05T01:00:00Z").energy).toBe("baseline");
      } finally { peer.close(); }
      const db = new Database(sqlitePath, { readonly: true });
      try {
        for (const table of ["jobs", "publication_push_outbox", "peer_outbox", "worker_reports", "pending_memory_extractions"]) {
          expect(db.query(`select count(*) as n from ${table}`).get()).toEqual({ n: 0 });
        }
        expect(db.query("select status, generation, output_tokens from runs order by generation").all())
          .toEqual([{ status: "ended", generation: 0, output_tokens: 0 }, { status: "ended", generation: 2, output_tokens: 23 }]);
      } finally { db.close(); }
      await checkLegacyDiary(request, imported.sourceUserId, imported.memberId);
    } finally { await host.stop(); }
  } finally {
    if (started) ok(run(["pg_ctl", "-D", data, "-m", "fast", "-w", "stop"]));
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

async function checkLegacyDiary(
  request: (path: string, method?: string, body?: object, token?: string) => Promise<Response>,
  source_account_id: string, ownerID: string,
) {
  const json = async (path: string, method = "GET", body?: object, token?: string, status = 200) => {
    const response = await request(path, method, body, token);
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(status);
    return payload;
  };
  const first = (await json("/diary")).entries[0];
  expect(await json("/diary/legacy")).toEqual({ source_account_id });
  const { code } = await json("/invites", "POST", {});
  const { device_token: partner } = await json("/invites/accept", "POST",
    { code, display_name: "另一成员", device_name: "合成手机" }, "");
  expect(await json("/diary/legacy", "GET", undefined, partner)).toEqual({ source_account_id: null });
  const draft = { text: "尚未送达的旧草稿", recorded_at: Date.parse("2025-01-03T18:00:00Z"),
    local_day: "2025-01-04", time_zone: "Asia/Kuala_Lumpur", cat_allowed: true };
  const legacy = (client_id: string, options: object = {}) => ({
    request_id: crypto.randomUUID(), source_account_id, client_id, ...options,
  });
  const stage = async (body: object) => (await json("/diary/legacy", "PUT", body)).entry;
  await json("/diary/legacy", "PUT", legacy("partner-draft", { draft }), partner, 404);
  await json("/diary/legacy", "PUT", legacy("unknown", { cloud_id: crypto.randomUUID() }), undefined, 404);
  const change = async (row: { id: string; revision: number }, suffix: string, method: string, fields = {}) =>
    (await json(`/diary/${row.id}${suffix}`, method,
      { request_id: crypto.randomUUID(), expected_revision: row.revision, ...fields })).entry;
  const current = await change(first, "", "PATCH", { text: "v2 新正文" });
  const cloud_id = "60000000-0000-4000-8000-000000000001";
  expect(await stage(legacy("text-1", { draft }))).toEqual(current); // lost v1 save response
  expect(await stage(legacy("text-1", { cloud_id }))).toEqual(current);
  await json("/diary/legacy", "PUT", legacy("wrong-client", { cloud_id }), undefined, 404);
  const granted = await change(current, "/cat-allowed", "PATCH", { cat_allowed: true });
  const withdrawal = legacy("text-1", { cloud_id, revoke_cat_access: true });
  const revoked = await stage(withdrawal);
  expect(revoked).toMatchObject({ text: "v2 新正文", cat_allowed: false, revision: granted.revision + 1 });
  const grantedAgain = await change(revoked, "/cat-allowed", "PATCH", { cat_allowed: true });
  expect(await stage(withdrawal)).toEqual(grantedAgain); // replay cannot undo a later choice
  const cursor = (await json("/changes")).next;
  const tombstone = await change(grantedAgain, "", "DELETE");
  expect(await stage(legacy("text-1", { draft }))).toEqual(tombstone);
  expect(await stage(withdrawal)).toEqual(tombstone);
  const queued = legacy("new-phone-diary", { draft });
  const saved = await stage(queued);
  expect(saved).toMatchObject({ ...draft, owner_member_id: ownerID, revision: 1 });
  expect(await stage(queued)).toEqual(saved);
  expect(await stage(legacy("new-phone-diary", { draft: { ...draft, text: "不同的旧快照" } }))).toEqual(saved);
  expect((await json("/diary")).entries).toEqual([saved]);
  expect(await json(`/changes?cursor=${cursor}`)).toMatchObject({ changes: expect.arrayContaining([
    expect.objectContaining({ kind: "diary", id: tombstone.id, op: "delete" }),
    expect.objectContaining({ kind: "diary", id: saved.id, op: "upsert" }),
  ]) });
}
