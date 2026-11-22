import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ManualClock, encodeHlc } from "../src/clock/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { ensureHousehold, removeMember as removeMemberRow, resolveDeviceToken } from "../src/store/identity.ts";
import { bootstrapMember, issueMemberInvite, acceptMemberInvite } from "../src/store/invites.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import {
  applyChangePage, getPeerCursor, getReplicationHead, installReplicationWatermark,
  readChangePage, rotateReplicationGeneration,
} from "../src/store/replication.ts";
import type { ChangePage, ReplicationSource } from "../src/replication/types.ts";
import {
  chatEvents, conversations, deviceCredentials, devices, hosts, households, jobs, members, messages,
  participants, turns,
} from "../src/store/schema/index.ts";
import { testTurn } from "./turn-fixture.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const dirs: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
const running: Awaited<ReturnType<typeof startHost>>[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const store of stores.splice(0)) store.close();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "cattt-replication-"));
  dirs.push(path);
  return path;
}

async function local() {
  const clock = new ManualClock("test", 1_800_000_000_000);
  const host = await startHost({ dataDir: temporaryDirectory(), clock }, []);
  running.push(host);
  return host;
}

function receiver(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  return store;
}

function sourceOf(host: Awaited<ReturnType<typeof local>>): ReplicationSource {
  const { sourceHostId, generation } = getReplicationHead(host.store.db, host.hostId);
  return { sourceHostId, generation, householdId: host.householdId };
}

function section(page: ChangePage, from: number, to: number, changes = page.changes.slice(from, to)): ChangePage {
  return {
    from: { ...page.from, seq: from },
    next: { ...page.next, seq: to },
    changes,
    hasMore: to < page.next.seq,
  };
}

test("生产引导、邀请、聊天与最终回复写原生日志，凭证与运行态不出机", async () => {
  const a = await local();
  const first = bootstrapMember(a.store.db, a.clock, { householdId: a.householdId, displayName: "甲" });
  const invite = issueMemberInvite(a.store.db, a.clock, { householdId: a.householdId });
  const second = acceptMemberInvite(a.store.db, a.clock, { code: invite.code, displayName: "乙", deviceName: "乙的 iPhone" })!;
  const active = testTurn(a, second.token);
  active.delta("只是草稿");
  active.delta("和最终可见部分");
  active.done();
  const page = readChangePage(a.store.db, a.hostId, null);
  expect(page.changes.map(({ seq }) => seq)).toEqual(page.changes.map((_, i) => i + 1));
  expect(new Set(page.changes.map(({ kind }) => kind))).toEqual(new Set([
    "household", "host", "member", "conversation", "participant", "message",
  ]));
  expect(JSON.stringify(page)).not.toContain(second.token);
  expect(JSON.stringify(page)).not.toContain(invite.code);
  expect(JSON.stringify(page)).not.toContain(active.turn.id);
  expect(JSON.stringify(page)).not.toMatch(/turnId|tokenHash|codeHash|lastSeenAt|eventSeq|draftText/);

  const b = receiver();
  expect(applyChangePage(b.db, sourceOf(a), page).status).toBe("applied");
  expect(getPeerCursor(b.db, a.hostId)).toEqual(page.next);
  expect(b.db.select().from(members).all().map((row) => row.id).sort()).toEqual([first.id, second.member.id].sort());
  expect(b.db.select().from(messages).all()).toMatchObject([
    { text: "你好", turnId: null }, { text: "只是草稿和最终可见部分", turnId: null },
  ]);
  expect(b.db.select().from(participants).all()).toHaveLength(4);
  for (const table of [turns, jobs, chatEvents, devices, deviceCredentials]) {
    expect(b.db.select().from(table).all()).toEqual([]);
  }
  expect(resolveDeviceToken(b.db, a.clock, second.token)).toBeUndefined();

  const bId = uuidv7(a.clock);
  setHostMeta(b.db, "host_id", bId);
  expect(ensureHousehold(b.db, a.clock, bId, { householdName: "乙家", hostName: "另一台 Mac" })).not.toBe(a.householdId);
  const own = readChangePage(b.db, bId, null);
  expect(own.changes.map(({ kind }) => kind)).toEqual(["household", "host", "conversation"]);
  expect(own.changes[0]?.seq).toBe(1);
  expect(own.changes.every(({ sourceHostId }) => sourceHostId === bId)).toBe(true);
});

test("业务事务失败、轮次事件写失败和幂等发送均不留下多余日志", async () => {
  const a = await local();
  const initial = getReplicationHead(a.store.db, a.hostId);
  expect(() => writeTransaction(a.store, (tx) => {
    bootstrapMember(tx, a.clock, { householdId: a.householdId, displayName: "回滚" });
    throw new Error("业务失败");
  })).toThrow("业务失败");
  expect(getReplicationHead(a.store.db, a.hostId)).toEqual(initial);
  expect(a.store.db.select().from(members).all()).toEqual([]);

  const device = issueTestDevice(a);
  const actor = resolveDeviceToken(a.store.db, a.clock, device.token)!;
  const direct = listConversations(a.store.db, actor).find((row) => row.kind === "direct")!;
  const request = { clientMessageId: "一次", text: "你好" };
  const before = getReplicationHead(a.store.db, a.hostId);
  expect(() => sendMessage(a.store.db, a.clock, actor, direct.id, request, () => {
    throw new Error("事件失败");
  })).toThrow("事件失败");
  expect(a.store.db.select().from(messages).all()).toEqual([]);
  expect(a.store.db.select().from(turns).all()).toEqual([]);
  expect(getReplicationHead(a.store.db, a.hostId)).toEqual(before);
  expect(sendMessage(a.store.db, a.clock, actor, direct.id, request).created).toBe(true);
  expect(sendMessage(a.store.db, a.clock, actor, direct.id, request).created).toBe(false);
  expect(readChangePage(a.store.db, a.hostId, before).changes.map((row) => row.kind)).toEqual(["message"]);
});

test("游标和整页业务一起回滚，一起跨进程重开持久化", async () => {
  const a = await local();
  issueTestDevice(a);
  const source = sourceOf(a);
  const page = readChangePage(a.store.db, a.hostId, null);
  const path = join(temporaryDirectory(), "replica.db");
  const b = openStore(path);
  try {
    b.raw.exec("CREATE TRIGGER reject_cursor BEFORE INSERT ON peer_cursors BEGIN SELECT RAISE(ABORT, '游标失败'); END");
    expect(() => applyChangePage(b.db, source, page)).toThrow("游标失败");
    expect(b.db.select().from(households).all()).toEqual([]);
    expect(b.db.select().from(members).all()).toEqual([]);
    expect(getPeerCursor(b.db, a.hostId)).toBeNull();
    b.raw.exec("DROP TRIGGER reject_cursor");
    expect(applyChangePage(b.db, source, page).status).toBe("applied");
  } finally {
    b.close();
  }
  const reopened = receiver(path);
  expect(getPeerCursor(reopened.db, a.hostId)).toEqual(page.next);
  expect(reopened.db.select().from(members).all()).toHaveLength(1);
  expect(applyChangePage(reopened.db, source, page)).toMatchObject({ status: "applied", applied: 0 });
});

test("两宿主同号相互独立，错误来源、空洞和旧世代有明确结果", async () => {
  const a = await local();
  const b = await local();
  const target = receiver();
  const fromA = sourceOf(a);
  const fromB = sourceOf(b);
  const pageA = readChangePage(a.store.db, a.hostId, null);
  const pageB = readChangePage(b.store.db, b.hostId, null);
  expect(() => applyChangePage(target.db, fromB, pageA)).toThrow(expect.objectContaining({ code: "source_mismatch" }));
  expect(() => applyChangePage(target.db, fromA, section(pageA, 1, 3))).toThrow(expect.objectContaining({ code: "sequence_gap" }));
  expect(() => readChangePage(a.store.db, a.hostId, pageB.next)).toThrow(expect.objectContaining({ code: "source_mismatch" }));
  expect(() => readChangePage(a.store.db, a.hostId, { ...pageA.next, seq: 1000 })).toThrow(expect.objectContaining({ code: "cursor_ahead" }));
  applyChangePage(target.db, fromA, pageA);
  applyChangePage(target.db, fromB, section(pageB, 0, 1));
  expect(getPeerCursor(target.db, a.hostId)?.seq).toBe(3);
  expect(getPeerCursor(target.db, b.hostId)?.seq).toBe(1);
  applyChangePage(target.db, fromB, pageB);
  expect(getPeerCursor(target.db, b.hostId)?.seq).toBe(3);

  const reset = rotateReplicationGeneration(a.store.db, a.hostId);
  expect(reset.generation).not.toBe(fromA.generation);
  expect(reset.seq).toBe(0);
  expect(() => readChangePage(a.store.db, a.hostId, pageA.next)).toThrow(expect.objectContaining({ code: "reset_required" }));
  expect(() => readChangePage(a.store.db, a.hostId, null)).toThrow(expect.objectContaining({ code: "reset_required" }));
  const newSource = sourceOf(a);
  const afterReset = readChangePage(a.store.db, a.hostId, reset);
  expect(() => applyChangePage(target.db, newSource, afterReset)).toThrow(expect.objectContaining({ code: "reset_required" }));
  target.db.transaction((tx) => installReplicationWatermark(tx, newSource, reset, pageA.next));
  expect(() => applyChangePage(target.db, fromA, pageA)).toThrow(expect.objectContaining({ code: "reset_required" }));
  expect(applyChangePage(target.db, newSource, afterReset).status).toBe("applied");
});

test("依赖未齐整页等待，齐后重试，倒序与墓碑覆盖旧活行后收敛", async () => {
  const a = await local();
  const actor = issueTestDevice(a);
  const beforeRemove = readChangePage(a.store.db, a.hostId, null);
  expect(removeMemberRow(a.store.db, a.clock, a.householdId, actor.memberId)).toBe(true);
  const page = readChangePage(a.store.db, a.hostId, null);
  const source = sourceOf(a);
  const target = receiver();
  const mirrored = receiver();

  const dependencyLate = [...page.changes];
  const household = dependencyLate.shift()!;
  const host = dependencyLate.shift()!;
  const split = section(page, 0, 1, [{ ...host, seq: 1 }]);
  expect(applyChangePage(target.db, source, split)).toMatchObject({
    status: "waiting", missing: [{ kind: "household", id: a.householdId }],
  });
  expect(getPeerCursor(target.db, a.hostId)).toBeNull();
  expect(target.db.select().from(hosts).all()).toEqual([]);
  const reordered = [{ ...host, seq: 1 }, { ...household, seq: 2 }, ...dependencyLate].reverse();
  expect(applyChangePage(target.db, source, { ...page, changes: reordered }).status).toBe("applied");
  applyChangePage(mirrored.db, source, page);
  expect(target.db.select().from(members).all()).toEqual(mirrored.db.select().from(members).all());
  expect(target.db.select().from(participants).all()).toEqual(mirrored.db.select().from(participants).all());
  expect(applyChangePage(target.db, source, beforeRemove).status).toBe("applied");

  const live = beforeRemove.changes.find((row) => row.kind === "member")!;
  const late = {
    ...live, seq: page.next.seq + 1,
    row: { ...live.row, rev: 99, updatedAt: a.clock.wallMs(), hlc: encodeHlc(a.clock.hlc()) },
  };
  const latePage = { from: page.next, next: { ...page.next, seq: late.seq }, changes: [late], hasMore: false };
  expect(applyChangePage(target.db, source, latePage)).toMatchObject({ status: "applied", applied: 0 });
  expect(target.db.select().from(members).where(eq(members.id, actor.memberId)).get()?.deletedAt).not.toBeNull();
});

test("字段白名单、签名来源和聚合归属约束拒绝整页", async () => {
  const a = await local();
  const b = await local();
  const device = issueTestDevice(a);
  const active = testTurn(a, device.token);
  active.delta("只在原机");
  active.done();
  const page = readChangePage(a.store.db, a.hostId, null);
  const source = sourceOf(a);
  const target = receiver();
  const privateField = {
    ...page,
    changes: page.changes.map((change) => change.kind === "message"
      ? { ...change, row: { ...change.row, turnId: active.turn.id } }
      : change),
  };
  expect(() => applyChangePage(target.db, source, privateField)).toThrow(expect.objectContaining({ code: "invalid_record" }));
  expect(getPeerCursor(target.db, a.hostId)).toBeNull();
  expect(target.db.select().from(conversations).all()).toEqual([]);
  applyChangePage(target.db, source, page);
  const replayWithJob = {
    ...page,
    changes: page.changes.map((change) => change.kind === "message" ? { ...change, kind: "jobs" } : change),
  };
  expect(() => applyChangePage(target.db, source, replayWithJob)).toThrow(expect.objectContaining({ code: "unsupported_kind" }));
  const originalMessage = page.changes.find((change) => change.kind === "message")!;
  const revisedFact = {
    ...originalMessage, seq: page.next.seq + 1,
    row: { ...originalMessage.row, rev: 2, hlc: encodeHlc(a.clock.hlc()) },
  };
  expect(() => applyChangePage(target.db, source, {
    from: page.next, next: { ...page.next, seq: revisedFact.seq }, changes: [revisedFact], hasMore: false,
  })).toThrow(expect.objectContaining({ code: "record_conflict" }));
  expect(getPeerCursor(target.db, a.hostId)).toEqual(page.next);

  const forgedSource = { ...sourceOf(b), householdId: a.householdId };
  const forgedCursor = { sourceHostId: forgedSource.sourceHostId, generation: forgedSource.generation, seq: 0 };
  const copied = page.changes.find((change) => change.kind === "message")!;
  const forged = { ...copied, ...forgedCursor, seq: 1, row: { ...copied.row, originHostId: b.hostId } };
  expect(() => applyChangePage(target.db, forgedSource, {
    from: forgedCursor, next: { ...forgedCursor, seq: 1 }, changes: [forged], hasMore: false,
  })).toThrow(expect.objectContaining({ code: "unauthorized_writer" }));
  expect(getPeerCursor(target.db, b.hostId)).toBeNull();
});

test("现有 SQLite 数据重启后回补一次，保留本机消息的轮次", async () => {
  const a = await local();
  const device = issueTestDevice(a);
  const active = testTurn(a, device.token);
  active.delta("已完成");
  active.done();
  // 模拟升级前已有 R3 业务行、尚没有 R6 日志。
  a.store.raw.exec("DELETE FROM change_log; DELETE FROM replication_state");
  await a.stop();
  running.splice(running.indexOf(a), 1);
  const restarted = await startHost({ dataDir: a.config.dataDir, clock: a.clock }, []);
  running.push(restarted);
  const baseline = readChangePage(restarted.store.db, a.hostId, null);
  expect(baseline.changes.filter((change) => change.kind === "message")).toHaveLength(2);
  expect(restarted.store.db.select().from(messages).all().every((row) => row.turnId === active.turn.id)).toBe(true);
  const b = receiver();
  expect(applyChangePage(b.db, sourceOf(restarted), baseline).status).toBe("applied");
  await restarted.stop();
  running.splice(running.indexOf(restarted), 1);
  const again = await startHost({ dataDir: a.config.dataDir, clock: a.clock }, []);
  running.push(again);
  expect(readChangePage(again.store.db, a.hostId, null)).toEqual(baseline);
});

test("同修订先看 HLC，HLC 也相同则稳定并列，两种到达顺序有相同结果", async () => {
  const a = await local();
  const page = readChangePage(a.store.db, a.hostId, null);
  const original = page.changes[0]!;
  if (original.kind !== "household") throw new Error("缺家庭记录");
  const newHlc = encodeHlc(a.clock.hlc());
  const variants = [
    { ...original.row, name: "z", rev: 2 },
    { ...original.row, name: "a", rev: 2, hlc: newHlc },
    { ...original.row, name: "b", rev: 2, hlc: newHlc },
  ];
  for (const order of [variants, [...variants].reverse()]) {
    const target = receiver();
    applyChangePage(target.db, sourceOf(a), page);
    const changes = order.map((row, i) => ({ ...original, row, seq: page.next.seq + i + 1 }));
    applyChangePage(target.db, sourceOf(a), {
      from: page.next, next: { ...page.next, seq: page.next.seq + changes.length }, changes, hasMore: false,
    });
    expect(target.db.select().from(households).all()).toMatchObject([{ name: "b", rev: 2, hlc: newHlc }]);
  }
});

test("同家庭第二个宿主独立写成员、单聊及群聊参与关系，复制历史不会触发运行态", async () => {
  const a = await local();
  const device = issueTestDevice(a);
  const initial = readChangePage(a.store.db, a.hostId, null);
  const bPath = temporaryDirectory();
  const bId = uuidv7(a.clock);
  const preJoin = openStore(join(bPath, "cattt.db"));
  try {
    applyChangePage(preJoin.db, sourceOf(a), initial);
    setHostMeta(preJoin.db, "host_id", bId);
    const origin = preJoin.db.select().from(hosts).where(eq(hosts.id, a.hostId)).get()!;
    preJoin.db.insert(hosts).values({ ...origin, id: bId, originHostId: bId, displayName: "乙的 Mac" }).run();
  } finally {
    preJoin.close();
  }
  const b = await startHost({ dataDir: bPath, clock: new ManualClock("other", a.clock.wallMs()) }, []);
  running.push(b);
  const bMember = issueTestDevice(b, "乙");
  const bHistory = readChangePage(b.store.db, b.hostId, null);
  expect(bHistory.changes.map(({ kind }) => kind)).toEqual(["host", "member", "conversation", "participant", "participant"]);
  expect(bHistory.changes[0]?.seq).toBe(1);
  expect(applyChangePage(a.store.db, sourceOf(b), bHistory).status).toBe("applied");
  expect(a.store.db.select().from(members).where(eq(members.id, bMember.memberId)).get()?.homeHostId).toBe(b.hostId);
  const active = testTurn(a, device.token);
  active.delta("历史事实");
  active.done();
  const inbound = readChangePage(a.store.db, a.hostId, initial.next);
  const signals: string[] = [];
  b.bus.subscribe("jobs:wake", () => { signals.push("jobs"); });
  b.bus.subscribe("turn:wake", () => { signals.push("turn"); });
  b.bus.subscribe("chat:event", () => { signals.push("sse"); });
  expect(applyChangePage(b.store.db, sourceOf(a), inbound).status).toBe("applied");
  await Promise.resolve();
  expect(signals).toEqual([]);
  for (const table of [turns, jobs, chatEvents]) expect(b.store.db.select().from(table).all()).toEqual([]);
  expect(getReplicationHead(b.store.db, b.hostId)).toEqual(bHistory.next);
});
