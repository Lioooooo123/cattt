import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ManualClock } from "../src/clock/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { createPeerPullClient, PeerSyncTransportError } from "../src/replication/peer-pull.ts";
import { createPeerSyncService } from "../src/replication/peer-service.ts";
import type { PeerSyncTransport } from "../src/replication/peer-types.ts";
import { startHost } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { createDevice, createMember, removeMember, resolveDeviceToken } from "../src/store/identity.ts";
import { openStore } from "../src/store/index.ts";
import { getPeerCursor, getReplicationHead, initializeNativeReplication, rotateReplicationGeneration } from "../src/store/replication.ts";
import * as schema from "../src/store/schema/index.ts";
import { issueTestDevice } from "./identity-fixture.ts";
import { testTurn } from "./turn-fixture.ts";

const dirs: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
const running: Awaited<ReturnType<typeof startHost>>[] = [];

afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const store of stores.splice(0)) store.close();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "cattt-peer-pull-"));
  dirs.push(path);
  return path;
}

function openReplica(path = join(temporaryDirectory(), "replica.sqlite")) {
  const store = openStore(path);
  stores.push(store);
  return store;
}

async function sourceHost() {
  const dataDir = temporaryDirectory();
  const clock = new ManualClock("peer-test", 1_800_000_000_000);
  const host = await startHost({ dataDir, clock }, []);
  running.push(host);
  return { ...host, service: createPeerSyncService(host.store.db, host.hostId) };
}

type SourceHost = Awaited<ReturnType<typeof sourceHost>>;

function peerOf(host: Pick<SourceHost, "hostId" | "householdId">) {
  return { sourceHostId: host.hostId, householdId: host.householdId };
}

function transport(service: ReturnType<typeof createPeerSyncService>): PeerSyncTransport {
  // Traverse the same JSON representation as the future HTTPS adapter.
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  return {
    openSnapshot: async () => wire(service.openSnapshot()),
    readSnapshotPage: async (request) => wire(service.readSnapshotPage(wire(request))),
    readChanges: async (request) => wire(service.readChanges(wire(request))),
  };
}

function client(
  target: ReturnType<typeof openStore>, source: Pick<SourceHost, "hostId" | "householdId" | "service">,
  overrides: Partial<PeerSyncTransport> = {},
) {
  return createPeerPullClient(target.db, peerOf(source), { ...transport(source.service), ...overrides }, {
    pageSize: 2, maxChangePages: 2, maxAttempts: 2,
  });
}

function send(host: Pick<SourceHost, "store" | "clock">, token: string, text: string) {
  const actor = resolveDeviceToken(host.store.db, host.clock, token)!;
  const direct = listConversations(host.store.db, actor).find((row) => row.kind === "direct")!;
  return sendMessage(host.store.db, host.clock, actor, direct.id, { clientMessageId: text, text });
}

function joinHousehold(a: SourceHost, b: ReturnType<typeof openStore>) {
  const hostId = uuidv7(a.clock);
  b.db.transaction((tx) => {
    tx.insert(schema.hostMeta).values({ key: "host_id", value: hostId }).run();
    tx.insert(schema.hosts).values({
      ...businessRow(a.clock, hostId), id: hostId, householdId: a.householdId, displayName: "乙的 Mac",
    }).run();
    initializeNativeReplication(tx, hostId, a.householdId);
  });
  return { hostId, householdId: a.householdId, clock: a.clock, store: b, service: createPeerSyncService(b.db, hostId) };
}

test("WAL 快照先固定水位，再与同库另一连接的写入并发，快照页与后续增量无遗漏", async () => {
  const a = await sourceHost();
  const device = issueTestDevice(a);
  const turn = testTurn(a, device.token);
  turn.delta("已发布");
  turn.done();
  const before = getReplicationHead(a.store.db, a.hostId);
  const dbPath = a.store.raw.query("PRAGMA database_list").get() as { file: string };
  const reader = openReplica(dbPath.file);
  let inserted = false;
  const readingDb = drizzle(reader.raw, {
    schema,
    logger: {
      logQuery(query) {
        // The committed head has already pinned the reader's WAL transaction.
        if (!inserted && /^select .* from "messages"/i.test(query)) {
          inserted = true;
          send(a, device.token, "读取快照时新写");
        }
      },
    },
  });
  const service = createPeerSyncService(readingDb, a.hostId);
  const b = openReplica();
  const remote = transport(service);
  const texts: string[] = [];
  let snapshotRequests = 0;
  const pull = client(b, a, {
    openSnapshot: async (signal) => {
      const opened = await remote.openSnapshot(signal);
      expect(opened.data.watermark).toEqual(before);
      return opened;
    },
    readSnapshotPage: async (request, signal) => {
      const page = await remote.readSnapshotPage(request, signal);
      snapshotRequests++;
      for (const { kind, row } of page.data.records) {
        if (kind === "message" && "text" in row && typeof row.text === "string") {
          texts.push(row.text);
        }
      }
      expect(JSON.stringify(page)).not.toMatch(/turnId|tokenHash|codeHash|lastSeenAt/);
      expect(JSON.stringify(page)).not.toContain(device.token);
      return page;
    },
  });
  expect(await pull.pull()).toMatchObject({ status: "caught_up", cursor: { seq: before.seq + 1 } });
  expect(inserted).toBe(true);
  expect(snapshotRequests).toBeGreaterThan(1);
  expect(texts).toEqual(["你好", "已发布"]);
  expect(b.db.select().from(schema.messages).all()).toMatchObject([
    { text: "你好", turnId: null }, { text: "已发布", turnId: null }, { text: "读取快照时新写", turnId: null },
  ]);
  for (const table of [schema.turns, schema.jobs, schema.chatEvents, schema.leases, schema.devices, schema.deviceCredentials, schema.changeLog]) {
    expect(b.db.select().from(table).all()).toEqual([]);
  }
});

test("恢复旧游标明确 reset，安装新世代后持久续拉，旧活行和缺行不能覆盖墓碑或本机离线事实", async () => {
  const a = await sourceHost();
  const aDevice = issueTestDevice(a, "甲");
  const backupPath = join(temporaryDirectory(), "backup.sqlite");
  a.store.raw.query("VACUUM INTO ?").run(backupPath);
  send(a, aDevice.token, "甲的历史");
  const b = openReplica();
  expect((await client(b, a).pull()).status).toBe("caught_up");
  const own = joinHousehold(a, b);
  const localMember = createMember(b.db, own.clock, { householdId: own.householdId, displayName: "乙", homeHostId: own.hostId });
  const localDevice = createDevice(b.db, own.clock, { memberId: localMember, hostId: own.hostId, name: "乙的手机" });
  const offline = send(own, localDevice.token, "乙的离线消息");
  const ownHead = getReplicationHead(b.db, own.hostId);
  const nativeLog = b.db.select().from(schema.changeLog).all();

  removeMember(a.store.db, a.clock, a.householdId, aDevice.memberId);
  let result = await client(b, a).pull();
  while (result.status === "more") result = await client(b, a).pull();
  expect(result.status).toBe("caught_up");
  const old = getPeerCursor(b.db, a.hostId)!;
  const restoredStore = openReplica(backupPath);
  const restored = { ...a, service: createPeerSyncService(restoredStore.db, a.hostId) };
  const next = rotateReplicationGeneration(restoredStore.db, a.hostId);
  expect(restored.service.readChanges({ cursor: old, limit: 2 }).data).toEqual({ status: "reset_required", head: next });

  expect(await client(b, restored).pull()).toMatchObject({ status: "caught_up", cursor: next });
  expect(b.db.select().from(schema.members).where(eq(schema.members.id, aDevice.memberId)).get()?.deletedAt).not.toBeNull();
  expect(b.db.select().from(schema.messages).all().map((row) => row.text)).toEqual(["甲的历史", "乙的离线消息"]);
  expect(b.db.select().from(schema.messages).where(eq(schema.messages.id, offline.body.message.id)).get()?.turnId)
    .toBe(offline.body.turn?.id ?? null);
  expect(getReplicationHead(b.db, own.hostId)).toEqual(ownHead);
  expect(b.db.select().from(schema.changeLog).all()).toEqual(nativeLog);

  const reopened = openReplica((b.raw.query("PRAGMA database_list").get() as { file: string }).file);
  expect(await client(reopened, restored, { openSnapshot: async () => { throw new Error("已持久化，不应重拉快照"); } }).pull())
    .toMatchObject({ status: "caught_up", cursor: next, applied: 0 });
});

test("快照截断、伪造写者、换世代与提交失败均不留半份结果，重拉与重放安全", async () => {
  const a = await sourceHost();
  issueTestDevice(a);
  const b = openReplica();
  const remote = transport(a.service);
  const malformed = async (alter: (reply: Awaited<ReturnType<PeerSyncTransport["readSnapshotPage"]>>) =>
    Awaited<ReturnType<PeerSyncTransport["readSnapshotPage"]>>) => client(b, a, {
    readSnapshotPage: async (request, signal) => alter(await remote.readSnapshotPage(request, signal)),
  }).pull();
  const empty = () => {
    expect(getPeerCursor(b.db, a.hostId)).toBeNull();
    expect(b.db.select().from(schema.households).all()).toEqual([]);
  };

  expect(await malformed((reply) => ({ ...reply, data: { ...reply.data, records: reply.data.records.slice(1) } })))
    .toMatchObject({ status: "stopped" });
  empty();
  expect(await malformed((reply) => ({
    ...reply,
    data: { ...reply.data, records: reply.data.records.map((record) => ({
      ...record, row: { ...record.row, originHostId: uuidv7(a.clock) },
    })) },
  }))).toMatchObject({ status: "stopped", code: "unauthorized_writer" });
  empty();
  expect(await client(b, a, {
    readChanges: async (request, signal) => {
      rotateReplicationGeneration(a.store.db, a.hostId);
      return remote.readChanges(request, signal);
    },
  }).pull()).toMatchObject({ status: "stopped", code: "reset_required" });
  empty();

  b.raw.exec("CREATE TRIGGER reject_cursor BEFORE INSERT ON peer_cursors BEGIN SELECT RAISE(ABORT, '测试水位写入失败'); END");
  expect(await client(b, a).pull()).toMatchObject({ status: "stopped" });
  empty();
  b.raw.exec("DROP TRIGGER reject_cursor");
  expect((await client(b, a).pull()).status).toBe("caught_up");
  const before = b.db.select().from(schema.members).all();
  expect(await client(b, a).pull()).toMatchObject({ status: "caught_up", applied: 0 });
  expect(b.db.select().from(schema.members).all()).toEqual(before);
});

test("跨来源缺依赖时回滚等待，按原始写者分别重拉且同序号互不覆盖", async () => {
  const a = await sourceHost();
  const b = openReplica();
  expect((await client(b, a).pull()).status).toBe("caught_up");
  const own = joinHousehold(a, b);
  const bMember = createMember(b.db, own.clock, { householdId: own.householdId, displayName: "乙", homeHostId: own.hostId });
  const joinHead = getReplicationHead(b.db, own.hostId);
  const target = openReplica();

  expect(await client(target, own).pull()).toMatchObject({
    status: "waiting", cursor: null, missing: expect.arrayContaining([{ kind: "household", id: a.householdId }]),
  });
  expect(getPeerCursor(target.db, own.hostId)).toBeNull();
  expect(target.db.select().from(schema.members).all()).toEqual([]);
  expect((await client(target, a).pull()).status).toBe("caught_up");
  expect((await client(target, own).pull()).status).toBe("caught_up");
  const aHead = getReplicationHead(a.store.db, a.hostId);
  expect(getPeerCursor(target.db, a.hostId)).toEqual(aHead);
  expect(getPeerCursor(target.db, own.hostId)).toEqual(joinHead);
  expect(target.db.select().from(schema.members).all()).toMatchObject([{ id: bMember, originHostId: own.hostId }]);
});

test("增量分页按持久游标恢复，传输重试有上限，截断页和取消保持已提交进度", async () => {
  const a = await sourceHost();
  const device = issueTestDevice(a);
  const b = openReplica();
  await client(b, a).pull();
  const before = getPeerCursor(b.db, a.hostId)!;
  for (let i = 0; i < 7; i++) send(a, device.token, `离线消息 ${i}`);

  const remote = transport(a.service);
  let calls = 0;
  expect(await client(b, a, {
    readChanges: async () => {
      calls++;
      throw new PeerSyncTransportError("连接中断");
    },
  }).pull()).toMatchObject({ status: "stopped", reason: "retry_exhausted", cursor: before });
  expect(calls).toBe(2);

  expect(await client(b, a, {
    readChanges: async (request, signal) => {
      const reply = await remote.readChanges(request, signal);
      if (reply.data.status !== "changes") return reply;
      return { ...reply, data: { ...reply.data, page: { ...reply.data.page, changes: [] } } };
    },
  }).pull()).toMatchObject({ status: "stopped", code: "sequence_gap", cursor: before });

  const resumed = await client(b, a, {
    readChanges: async (request, signal) => {
      if (calls++ === 2) throw new PeerSyncTransportError("首次失败");
      return remote.readChanges(request, signal);
    },
  }).pull();
  expect(resumed).toMatchObject({ status: "more", cursor: { seq: before.seq + 4 } });
  expect(calls).toBe(5);
  const controller = new AbortController();
  controller.abort();
  expect(await client(b, a).pull(controller.signal)).toMatchObject({
    status: "stopped", reason: "aborted", cursor: { seq: before.seq + 4 },
  });
  expect(await client(b, a).pull()).toMatchObject({ status: "caught_up", cursor: { seq: before.seq + 7 } });
  expect(b.db.select().from(schema.messages).all()).toHaveLength(7);
});
