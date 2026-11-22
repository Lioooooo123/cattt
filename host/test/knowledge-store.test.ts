import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SQLiteBunSession } from "drizzle-orm/bun-sqlite/session";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { migrations } from "../src/store/migrations.generated.ts";
import { businessRow } from "../src/store/business.ts";
import { ManualClock } from "../src/clock/index.ts";
import { listConversations, readMessages, sendMessage } from "../src/store/conversations.ts";
import {
  createDiaryEntry, getDiaryEntry, listAllowedDiaryEntries, reviseDiaryEntry,
  setDiaryCatAllowed, withdrawDiaryEntry,
} from "../src/store/diary.ts";
import { createDevice, createMember, ensureHousehold, resolveDeviceToken } from "../src/store/identity.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { openStore } from "../src/store/index.ts";
import {
  createBoundary, createMemoryBlock, listAvailableBoundaries, listAvailableMemories, reviseBoundary,
  replaceMemory, reviseMemory, saveMemory, withdrawBoundary, withdrawMemory,
} from "../src/store/knowledge.ts";
import { readKnowledgeSource, withdrawKnowledgeSource } from "../src/store/knowledge-source.ts";
import { backfillKnowledgeReplication, readChangePage } from "../src/store/replication.ts";
import { migrateStore } from "../src/store/migrate.ts";
import * as schema from "../src/store/schema/index.ts";
import { messages } from "../src/store/schema/conversations.ts";

let store: ReturnType<typeof openStore>;
beforeEach(() => { store = openStore(":memory:"); });
afterEach(() => { store.close(); });

function fixture(db = store.db) {
  const clock = new ManualClock("knowledge", 100);
  const hostId = uuidv7(clock);
  setHostMeta(db, "host_id", hostId);
  const householdId = ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
  const actorFor = (displayName: string) => {
    const memberId = createMember(db, clock, { householdId, homeHostId: hostId, displayName });
    const { token } = createDevice(db, clock, { memberId, hostId, name: "手机" });
    return resolveDeviceToken(db, clock, token)!;
  };
  const a = actorFor("A");
  const b = actorFor("B");
  const groupId = listConversations(db, a).find((row) => row.kind === "group")!.id;
  const sourceFor = (actor: typeof a, text: string, conversationId = groupId) => {
    const { message } = sendMessage(db, clock, actor, conversationId, {
      clientMessageId: crypto.randomUUID(), text,
    }).body;
    return { householdId, sourceMemberId: actor.memberId, sourceMessageId: message.id, sourceRevision: 1 };
  };
  return { db, clock, householdId, hostId, a, b, sourceFor };
}

test("群聊中来源和主体可不同，相同指纹的相反偏好按成员和来源分开", () => {
  const { db, clock, householdId, a, b, sourceFor } = fixture();
  const fromA = sourceFor(a, "B 不喝咖啡");
  const fromB = sourceFor(b, "A 喜欢咖啡");
  const aboutB = saveMemory(db, clock, {
    ...fromA, subjectMemberId: b.memberId, fingerprint: "coffee", predicate: "咖啡", value: "不喝",
  })!;
  const aboutA = saveMemory(db, clock, {
    ...fromB, subjectMemberId: a.memberId, fingerprint: "coffee", predicate: "咖啡", value: "喜欢",
  })!;
  expect(listAvailableMemories(db, { householdId, subjectMemberId: a.memberId })).toEqual([aboutA]);
  expect(listAvailableMemories(db, { householdId, sourceMemberId: a.memberId })).toEqual([aboutB]);
  expect(listAvailableMemories(db, fromA)).toEqual([aboutB]);
  expect(saveMemory(db, clock, { ...aboutB, sourceMemberId: b.memberId })).toBeUndefined();
  expect(saveMemory(db, clock, { ...aboutB, sourceRevision: 2 })).toBeUndefined();

  const foreignHousehold = { ...businessRow(clock, uuidv7(clock)), name: "别的家" };
  db.insert(schema.households).values(foreignHousehold).run();
  const other = foreignHousehold.id;
  expect(listAvailableMemories(db, { ...fromA, householdId: other })).toEqual([]);
  expect(saveMemory(db, clock, { ...aboutB, householdId: other })).toBeUndefined();
});

test("更正与撤回使用业务修订，同一来源重放不能覆盖更正或复活墓碑", () => {
  const { db, clock, hostId, a, b, sourceFor } = fixture();
  const source = sourceFor(a, "我每天喝茶");
  const input = { ...source, subjectMemberId: a.memberId, fingerprint: "tea", predicate: "喝茶频率", value: "每天" };
  const memory = saveMemory(db, clock, input)!;
  expect(saveMemory(db, clock, input)).toEqual(memory);
  expect(reviseMemory(db, clock, b, memory.id, 1, "周末")).toBeUndefined();
  const updated = reviseMemory(db, clock, a, memory.id, 1, "周末")!;
  expect(updated).toMatchObject({ rev: 2, value: "周末", sourceRevision: 1, originHostId: hostId });
  expect(updated.hlc > memory.hlc).toBe(true);
  expect(reviseMemory(db, clock, a, memory.id, 1, "每天")).toBeUndefined();
  expect(saveMemory(db, clock, input)).toEqual(updated);
  expect(withdrawMemory(db, clock, a, memory.id, 2)).toMatchObject({ rev: 3, deletedAt: clock.wallMs() });
  expect(saveMemory(db, clock, input)).toBeUndefined();
  expect(listAvailableMemories(db, source)).toEqual([]);
});

test("指纹屏蔽只作用于同一成员，现有记忆和迟到的提取均被排除", () => {
  const { db, clock, householdId, a, b, sourceFor } = fixture();
  const shared = sourceFor(a, "我们都喜欢晨跑");
  const input = { ...shared, fingerprint: "running", predicate: "晨跑", value: "喜欢" };
  const aboutA = saveMemory(db, clock, { ...input, subjectMemberId: a.memberId })!;
  const aboutB = saveMemory(db, clock, { ...input, subjectMemberId: b.memberId })!;
  const forget = sourceFor(a, "别记我的晨跑了");
  const block = { ...forget, subjectMemberId: a.memberId, fingerprint: "running" };
  expect(createMemoryBlock(db, clock, block)).toMatchObject(block);
  expect(listAvailableMemories(db, shared)).toEqual([aboutB]);
  expect(reviseMemory(db, clock, a, aboutA.id, 1, "偶尔")).toBeUndefined();
  expect(saveMemory(db, clock, { ...input, subjectMemberId: a.memberId })).toBeUndefined();
  expect(withdrawKnowledgeSource(db, clock, a, forget.sourceMessageId, 1)).toBeDefined();
  expect(listAvailableMemories(db, { householdId, subjectMemberId: a.memberId })).toEqual([]);
});

test("按成员控制边界，撤回原话后重放及后续消息修订均不能恢复该来源", () => {
  const { db, clock, a, b, sourceFor } = fixture();
  const directId = listConversations(db, a).find((row) => row.kind === "direct")!.id;
  const source = sourceFor(a, "我不想聊面试", directId);
  const input = { ...source, subjectMemberId: a.memberId, description: "面试" };
  const boundary = createBoundary(db, clock, input)!;
  expect(listAvailableBoundaries(db, { ...source, subjectMemberId: b.memberId })).toEqual([]);
  expect(reviseBoundary(db, clock, b, boundary.id, 1, "求职")).toBeUndefined();
  expect(reviseBoundary(db, clock, a, boundary.id, 1, "求职")).toMatchObject({ rev: 2, description: "求职" });
  expect(readKnowledgeSource(db, source)).toMatchObject({ text: "我不想聊面试", rev: 1 });
  expect(withdrawKnowledgeSource(db, clock, b, source.sourceMessageId, 1)).toBeUndefined();
  expect(withdrawKnowledgeSource(db, clock, a, source.sourceMessageId, 2)).toBeUndefined();
  const withdrawal = withdrawKnowledgeSource(db, clock, a, source.sourceMessageId, 1)!;
  expect(withdrawal).toMatchObject({ ...source, rev: 1, originHostId: a.hostId });
  expect(withdrawKnowledgeSource(db, clock, a, source.sourceMessageId, 1)).toEqual(withdrawal);
  expect(readKnowledgeSource(db, source)).toBeUndefined();
  expect(listAvailableBoundaries(db, source)).toEqual([]);
  expect(createBoundary(db, clock, input)).toBeUndefined();
  db.update(messages).set({ rev: 2 }).where(eq(messages.id, source.sourceMessageId)).run();
  expect(createBoundary(db, clock, { ...input, sourceRevision: 2 })).toBeUndefined();
  const newSource = sourceFor(a, "我还是不想聊面试");
  const fresh = createBoundary(db, clock, { ...input, ...newSource })!;
  expect(withdrawBoundary(db, clock, a, fresh.id, 1)).toMatchObject({ rev: 2, deletedAt: clock.wallMs() });
  expect(createBoundary(db, clock, { ...input, ...newSource })).toBeUndefined();
});

test("猫消息不是成员事实来源，消息修订后不可再保存旧提取结果", () => {
  const { db, clock, a, sourceFor } = fixture();
  const source = sourceFor(a, "来源原文");
  const input = { ...source, subjectMemberId: a.memberId, fingerprint: "test", predicate: "分类", value: "旧值" };
  expect(saveMemory(db, clock, input)).toBeDefined();
  db.update(messages).set({ rev: 2, text: "修订后的原文" }).where(eq(messages.id, source.sourceMessageId)).run();
  expect(listAvailableMemories(db, { householdId: source.householdId, sourceMessageId: source.sourceMessageId })).toEqual([]);
  expect(saveMemory(db, clock, input)).toBeUndefined();
  db.update(messages).set({ authorMemberId: null }).where(eq(messages.id, source.sourceMessageId)).run();
  expect(saveMemory(db, clock, { ...input, sourceRevision: 2 })).toBeUndefined();
});

test("停用知识来源不改变原话的历史顺序或游标", () => {
  const { db, clock, a, sourceFor } = fixture();
  const groupId = listConversations(db, a).find((row) => row.kind === "group")!.id;
  const first = sourceFor(a, "第一条");
  sourceFor(a, "第二条");
  const before = readMessages(db, a, groupId);
  expect(withdrawKnowledgeSource(db, clock, a, first.sourceMessageId, 1)).toBeDefined();
  expect(readMessages(db, a, groupId)).toEqual(before);
});

test("日记保留原日期和时区，撤回后的旧分享无法恢复读取权限", () => {
  const { db, clock, householdId, a, b } = fixture();
  const entry = createDiaryEntry(db, clock, a, {
    text: "第一版",
    localDay: "2026-11-22",
    timeZone: "UTC",
    recordedAt: Date.parse("2026-11-22T00:20:00Z"),
  });
  const scope = { householdId, ownerMemberId: a.memberId, id: entry.id };
  expect(getDiaryEntry(db, scope)).toMatchObject({
    sourceMemberId: a.memberId, sourceMessageId: null, sourceRevision: null,
    localDay: "2026-11-22", timeZone: "UTC", catAllowed: false,
  });
  expect(listAllowedDiaryEntries(db, scope)).toEqual([]);
  expect(setDiaryCatAllowed(db, clock, b, entry.id, 1, true)).toBeUndefined();
  const allowed = setDiaryCatAllowed(db, clock, a, entry.id, 1, true)!;
  expect(listAllowedDiaryEntries(db, { ...scope, rev: 2 })).toEqual([allowed]);
  expect(listAllowedDiaryEntries(db, { ...scope, ownerMemberId: b.memberId })).toEqual([]);
  const corrected = reviseDiaryEntry(db, clock, a, entry.id, 2, "第二版")!;
  expect(corrected).toMatchObject({ rev: 3, localDay: entry.localDay, timeZone: entry.timeZone, recordedAt: entry.recordedAt });
  expect(listAllowedDiaryEntries(db, { ...scope, rev: 2 })).toEqual([]);
  expect(setDiaryCatAllowed(db, clock, a, entry.id, 3, false)).toMatchObject({ rev: 4 });
  expect(setDiaryCatAllowed(db, clock, a, entry.id, 3, true)).toBeUndefined();
  expect(listAllowedDiaryEntries(db, scope)).toEqual([]);
  expect(getDiaryEntry(db, scope)).toMatchObject({ text: "第二版", catAllowed: false });
  expect(setDiaryCatAllowed(db, clock, a, entry.id, 4, true)).toMatchObject({ rev: 5 });
  expect(listAllowedDiaryEntries(db, { ...scope, rev: 2 })).toEqual([]);
  expect(withdrawDiaryEntry(db, clock, a, entry.id, 5)).toMatchObject({ rev: 6, deletedAt: clock.wallMs() });
  expect(setDiaryCatAllowed(db, clock, a, entry.id, 6, true)).toBeUndefined();
  expect(getDiaryEntry(db, scope)).toBeUndefined();
});

test("来自聊天的日记还要求原话的作者和修订有效", () => {
  const { db, clock, a, b, sourceFor } = fixture();
  const source = sourceFor(a, "今天去海边");
  const input = {
    text: "去海边",
    localDay: "2026-11-22",
    timeZone: "Asia/Kuala_Lumpur",
    recordedAt: Date.parse("2026-11-21T18:20:00Z"),
    source,
    catAllowed: true,
  };
  expect(() => createDiaryEntry(db, clock, b, input)).toThrow();
  const entry = createDiaryEntry(db, clock, a, input);
  const scope = { ...source, ownerMemberId: a.memberId };
  expect(listAllowedDiaryEntries(db, scope)).toEqual([entry]);
  expect(withdrawKnowledgeSource(db, clock, a, source.sourceMessageId, 1)).toBeDefined();
  expect(listAllowedDiaryEntries(db, scope)).toEqual([]);
  expect(() => createDiaryEntry(db, clock, a, input)).toThrow();
});

test("日记的当地日期按记录时区校验", () => {
  const { db, clock, a } = fixture();
  expect(() => createDiaryEntry(db, clock, a, {
    text: "跨过午夜",
    localDay: "2026-11-21",
    timeZone: "Asia/Kuala_Lumpur",
    recordedAt: Date.parse("2026-11-21T18:20:00Z"),
  })).toThrow();
});

test("新原话更正保持来源和旧墓碑，更正再撤回也不会复活旧记录", () => {
  const { db, clock, a, b, sourceFor } = fixture();
  const input = {
    ...sourceFor(a, "我每天喝茶"), subjectMemberId: a.memberId,
    fingerprint: "tea", predicate: "喝茶频率", value: "每天",
  };
  const before = saveMemory(db, clock, input)!;
  const correction = { ...input, ...sourceFor(a, "现在改成周末喝茶"), value: "周末" };
  expect(replaceMemory(db, clock, b, before.id, before.rev, correction)).toBeUndefined();
  const after = replaceMemory(db, clock, a, before.id, before.rev, correction)!;
  expect(after).toMatchObject(correction);
  expect(after.id).not.toBe(before.id);
  expect(replaceMemory(db, clock, a, before.id, before.rev, correction)).toEqual(after);
  expect(saveMemory(db, clock, input)).toBeUndefined();
  expect(withdrawKnowledgeSource(db, clock, a, correction.sourceMessageId, 1)).toBeDefined();
  expect(listAvailableMemories(db, { householdId: a.householdId })).toEqual([]);
  expect(saveMemory(db, clock, input)).toBeUndefined();
});

test("0009 已落盘的成员事实和屏蔽可升级，随后可写家庭主体", () => {
  const raw = new Database(":memory:", { strict: true });
  try {
    raw.exec("PRAGMA foreign_keys = ON");
    const dialect = new SQLiteSyncDialect();
    dialect.migrate(migrations.slice(0, 10),
      new SQLiteBunSession(raw, dialect, undefined));
    const db = drizzle(raw, { schema });
    // 旧库夹具按当时的表形状写入，生产引导会使用升级后才有的复制表。
    const clock = new ManualClock("knowledge-upgrade", 100);
    const hostId = uuidv7(clock);
    const family = { ...businessRow(clock, hostId), name: "家" };
    const householdId = family.id;
    const member = { ...businessRow(clock, hostId), householdId, homeHostId: hostId, displayName: "A" };
    const conversation = { ...businessRow(clock, hostId), householdId, kind: "group" as const, publisherHostId: hostId };
    setHostMeta(db, "host_id", hostId);
    db.insert(schema.households).values(family).run();
    db.insert(schema.hosts).values({ ...businessRow(clock, hostId), id: hostId, householdId, displayName: "Mac" }).run();
    db.insert(schema.members).values(member).run();
    db.insert(schema.conversations).values(conversation).run();
    const source = businessRow(clock, hostId);
    raw.run(`INSERT INTO messages (id, origin_host_id, hlc, rev, created_at, updated_at, conversation_id,
      author_member_id, text, modality, status, client_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '我的老事实', 'text', 'complete', 'old-source')`,
    [source.id, hostId, source.hlc, source.rev, source.createdAt, source.updatedAt, conversation.id, member.id]);
    const input = {
      householdId, sourceMemberId: member.id, sourceMessageId: source.id, sourceRevision: source.rev,
      subjectMemberId: member.id, fingerprint: "keep", predicate: "保留", value: "旧值",
    };
    const old = { ...businessRow(clock, hostId), ...input };
    raw.run(`INSERT INTO memories
      (id, rev, hlc, origin_host_id, created_at, updated_at, household_id, source_member_id,
        source_message_id, source_revision, subject_member_id, fingerprint, predicate, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [old.id, old.rev, old.hlc, old.originHostId, old.createdAt, old.updatedAt, old.householdId, old.sourceMemberId,
      old.sourceMessageId, old.sourceRevision, old.subjectMemberId, old.fingerprint, old.predicate, old.value]);
    const block = { ...businessRow(clock, hostId), householdId, sourceMemberId: member.id,
      sourceMessageId: source.id, sourceRevision: source.rev, subjectMemberId: member.id, fingerprint: "blocked" };
    raw.run(`INSERT INTO memory_blocks
      (id, rev, hlc, origin_host_id, created_at, updated_at, household_id, source_member_id,
        source_message_id, source_revision, subject_member_id, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [block.id, block.rev, block.hlc, block.originHostId, block.createdAt, block.updatedAt, householdId,
      member.id, source.id, source.rev, member.id, block.fingerprint]);
    migrateStore(raw);
    ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
    db.transaction((tx) => backfillKnowledgeReplication(tx, hostId, householdId));
    expect(readChangePage(db, hostId).changes.map(({ kind }) => kind))
      .toEqual(expect.arrayContaining(["memory", "memory_block"]));
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(listAvailableMemories(db, { householdId })).toEqual([{ ...old, correctsPrevious: false }]);
    expect(createMemoryBlock(db, clock, block)).toEqual(block);
    expect(saveMemory(db, clock, { ...input, subjectMemberId: null })).toMatchObject({ subjectMemberId: null });
  } finally {
    raw.close();
  }
});
