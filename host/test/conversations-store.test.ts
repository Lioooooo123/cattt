import { afterEach, expect, test } from "bun:test";
import { and, asc, eq, isNull } from "drizzle-orm";
import { encodeHlc, ManualClock } from "../src/clock/index.ts";
import { canSeeConversation } from "../src/identity/access.ts";
import { businessRow } from "../src/store/business.ts";
import { reconcileConversations } from "../src/store/conversation-lifecycle.ts";
import { ConversationNotFoundError, getConversation, IdempotencyConflictError, InvalidChatRequestError, listConversations, NotPublisherError, readMessages, sendMessage } from "../src/store/conversations.ts";
import { setHostMeta } from "../src/store/host-meta.ts";
import { createDevice, createMember, ensureHousehold, removeMember, resolveDeviceToken } from "../src/store/identity.ts";
import { openStore, writeTransaction } from "../src/store/index.ts";
import type { Store } from "../src/store/index.ts";
import { conversations, messages, participants } from "../src/store/schema/conversations.ts";
import { hosts, members } from "../src/store/schema/identity.ts";
import { uuidv7 } from "../src/ids/index.ts";

const stores: Store[] = [];

function setup() {
  const store = openStore(":memory:");
  stores.push(store);
  const db = store.db;
  const clock = new ManualClock("test", 100);
  const hostId = uuidv7(clock);
  setHostMeta(db, "host_id", hostId);
  const householdId = ensureHousehold(db, clock, hostId, { householdName: "家", hostName: "Mac" });
  const create = (displayName: string, maxMembers = 2) => {
    const memberId = createMember(db, clock, { householdId, homeHostId: hostId, displayName, maxMembers });
    const device = createDevice(db, clock, { memberId, hostId, name: "手机" });
    return { ...device, actor: resolveDeviceToken(db, clock, device.token)! };
  };
  const a = create("甲");
  const b = create("乙");
  const [group, direct] = listConversations(db, a.actor);
  return { store, db, clock, hostId, householdId, create, a, b, group: group!, direct: direct! };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

test("两成员恰有一群两单聊，单聊仅拥有者可见；第三人加入群聊，移除保留墓碑", () => {
  const { db, clock, a, b, create, group, direct, householdId, hostId } = setup();
  expect(db.select().from(conversations).all()).toHaveLength(3);
  expect(group).toMatchObject({ kind: "group", owner_member_id: null, participant_member_ids: [a.actor.memberId, b.actor.memberId], publisher_host_id: hostId, last_message: null });
  expect(direct).toMatchObject({ kind: "direct", owner_member_id: a.actor.memberId, participant_member_ids: [a.actor.memberId] });
  expect(listConversations(db, b.actor).map((row) => row.kind)).toEqual(["group", "direct"]);
  expect(() => getConversation(db, b.actor, direct.id)).toThrow(ConversationNotFoundError);
  expect(canSeeConversation(a.actor, { householdId, kind: "group", ownerMemberId: null, participantMemberIds: [] })).toBe(false);
  expect(canSeeConversation({ ...a.actor, householdId: "other" }, { householdId, kind: "direct", ownerMemberId: a.actor.memberId, participantMemberIds: [] })).toBe(false);
  const c = create("丙", 3);
  expect(getConversation(db, c.actor, group.id).participant_member_ids).toEqual([a.actor.memberId, b.actor.memberId, c.actor.memberId]);
  expect(db.select().from(conversations).all()).toHaveLength(4);
  removeMember(db, clock, householdId, b.actor.memberId);
  expect(resolveDeviceToken(db, clock, b.token)).toBeUndefined();
  expect(getConversation(db, a.actor, group.id).participant_member_ids).toEqual([a.actor.memberId, c.actor.memberId]);
  const removed = db.select().from(participants).where(and(eq(participants.conversationId, group.id), eq(participants.memberId, b.actor.memberId))).get()!;
  expect(removed.deletedAt).toBe(100);
  expect(removed.rev).toBe(2);
  expect(() => getConversation(db, b.actor, group.id)).toThrow(ConversationNotFoundError);
});

test("自动维护与成员写入同事务，补齐幂等且唯一约束保护群聊、单聊与参与者", () => {
  const { store, db, clock, group, direct, householdId, hostId } = setup();
  const before = db.select().from(conversations).all();
  expect(() => writeTransaction(store, (tx) => {
    createMember(tx, clock, { householdId, homeHostId: hostId, displayName: "回滚", maxMembers: 3 });
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(db.select().from(conversations).all()).toEqual(before);
  const rows = db.select().from(participants).all();
  reconcileConversations(db, clock, hostId, householdId);
  expect(db.select().from(participants).all()).toEqual(rows);
  for (const id of [group.id, direct.id]) {
    const row = db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    expect(() => db.insert(conversations).values({ ...row, ...businessRow(clock, hostId) }).run()).toThrow();
  }
  expect(() => db.insert(participants).values({ ...rows[0]!, ...businessRow(clock, hostId) }).run()).toThrow();
});

test("署名由 Actor 决定，幂等键按作者与会话隔离，冲突与外层回滚不产生重复事实", () => {
  const { store, db, clock, a, b, group, direct } = setup();
  const input = { clientMessageId: "one", text: "  你好  " };
  const first = sendMessage(db, clock, a.actor, group.id, input);
  expect(first.created).toBe(true);
  expect(first.body.turn).toBeNull();
  expect(first.body.message.author).toEqual({ kind: "member", member_id: a.actor.memberId });
  expect(first.body.message.text).toBe("你好");
  expect(sendMessage(db, clock, a.actor, group.id, { ...input, text: "你好" })).toEqual({ ...first, created: false });
  expect(() => sendMessage(db, clock, a.actor, group.id, { ...input, text: "不同" })).toThrow(IdempotencyConflictError);
  const second = sendMessage(db, clock, b.actor, group.id, input);
  expect(second.body.message.author).toEqual({ kind: "member", member_id: b.actor.memberId });
  expect(sendMessage(db, clock, a.actor, direct.id, input).created).toBe(true);
  expect(getConversation(db, a.actor, group.id).last_message).toEqual(second.body.message);
  expect(() => sendMessage(db, clock, b.actor, direct.id, input)).toThrow(ConversationNotFoundError);
  expect(() => writeTransaction(store, (tx) => {
    sendMessage(tx, clock, a.actor, group.id, { clientMessageId: "rollback", text: "不保存" });
    throw new Error("回滚");
  })).toThrow("回滚");
  expect(readMessages(db, a.actor, group.id).messages).toHaveLength(2);
});

test("超过百条分页以 HLC、ID 稳定排序，双边界严格、同 HLC 并列和空页均可恢复", () => {
  const { db, clock, a, group } = setup();
  for (let i = 0; i < 137; i += 1) {
    sendMessage(db, clock, a.actor, group.id, { clientMessageId: String(i), text: String(i) });
  }
  const same = encodeHlc({ physicalMs: 100, logical: 0, nodeId: "test" });
  db.update(messages).set({ hlc: same }).run();
  const latestId = db.select().from(messages).orderBy(asc(messages.id)).all().at(-1)!.id;
  db.update(messages).set({ hlc: encodeHlc({ physicalMs: 99, logical: 0, nodeId: "test" }) }).where(eq(messages.id, latestId)).run();
  const expected = db.select().from(messages).orderBy(asc(messages.hlc), asc(messages.id)).all().map((row) => row.id);
  expect(expected[0]).toBe(latestId);
  let page = readMessages(db, a.actor, group.id);
  expect(page.messages).toHaveLength(50);
  expect(page.has_more_after).toBe(false);
  const backward = [...page.messages];
  while (page.has_more_before) {
    page = readMessages(db, a.actor, group.id, { before: page.messages[0]!.cursor });
    backward.unshift(...page.messages);
  }
  expect(backward.map((row) => row.id)).toEqual(expected);
  const forward = [backward[0]!];
  do {
    page = readMessages(db, a.actor, group.id, { after: forward.at(-1)!.cursor, limit: 100 });
    forward.push(...page.messages);
  } while (page.has_more_after);
  expect(forward.map((row) => row.id)).toEqual(expected);
  const bounded = readMessages(db, a.actor, group.id, { after: backward[20]!.cursor, before: backward[100]!.cursor, limit: 100 });
  expect(bounded.messages.map((row) => row.id)).toEqual(expected.slice(21, 100));
  expect([bounded.has_more_before, bounded.has_more_after]).toEqual([true, true]);
  expect(readMessages(db, a.actor, group.id, { after: backward.at(-1)!.cursor })).toMatchObject({ messages: [], has_more_before: true, has_more_after: false });
  expect(readMessages(db, a.actor, group.id, { before: backward[0]!.cursor })).toMatchObject({ messages: [], has_more_before: false, has_more_after: true });
});

test("空历史、坏游标、坏正文与非发布宿主有明确行为，猫消息 DTO 不伪造作者", () => {
  const { db, clock, a, group, direct, householdId, hostId } = setup();
  expect(readMessages(db, a.actor, group.id)).toEqual({ messages: [], has_more_before: false, has_more_after: false });
  for (const value of ["", "garbage", "m1.%%%", `m1.${Buffer.from('["bad","bad"]').toString("base64url")}`]) {
    expect(() => readMessages(db, a.actor, group.id, { before: value })).toThrow(InvalidChatRequestError);
  }
  for (const limit of [0, 101, 1.5]) {
    expect(() => readMessages(db, a.actor, group.id, { limit })).toThrow(InvalidChatRequestError);
  }
  expect(() => sendMessage(db, clock, a.actor, group.id, { text: " ", clientMessageId: "x" })).toThrow(InvalidChatRequestError);
  const memberMessage = sendMessage(db, clock, a.actor, group.id, { text: "你好", clientMessageId: "x" });
  const cat = db.insert(messages).values({
    ...businessRow(clock, hostId), conversationId: group.id, authorMemberId: null, text: "喵", modality: "text", status: "stopped",
    clientMessageId: null, replyToMessageId: memberMessage.body.message.id, turnId: uuidv7(clock),
  }).returning().get()!;
  expect(getConversation(db, a.actor, group.id).last_message).toMatchObject({ id: cat.id, author: { kind: "cat" }, status: "stopped" });
  const remote = businessRow(clock, hostId);
  db.insert(hosts).values({ ...remote, householdId, displayName: "另一台 Mac" }).run();
  db.update(members).set({ homeHostId: remote.id }).where(eq(members.id, a.actor.memberId)).run();
  expect(getConversation(db, a.actor, direct.id).publisher_host_id).toBe(remote.id);
  expect(() => sendMessage(db, clock, a.actor, direct.id, { text: "远端", clientMessageId: "remote" })).toThrow(NotPublisherError);
  db.update(conversations).set({ publisherHostId: remote.id }).where(eq(conversations.id, group.id)).run();
  expect(() => sendMessage(db, clock, a.actor, group.id, { text: "你好", clientMessageId: "x" })).toThrow(NotPublisherError);
  expect(db.select().from(messages).where(isNull(messages.deletedAt)).all()).toHaveLength(2);
});
