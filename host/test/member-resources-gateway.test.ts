import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessKnowledgeUse } from "../src/context/policy.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { saveMemory } from "../src/store/knowledge.ts";
import { rotateReplicationGeneration } from "../src/store/replication.ts";
import { participants } from "../src/store/schema/conversations.ts";

type Body = Record<string, unknown>;
type Phone = (path: string, method?: string, body?: Body) => Promise<Response>;
type Joined = { member: { id: string }; device_token: string; device_id: string };

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as T;
  expect({ status: response.status, body }).toMatchObject({ status });
  return body;
}

async function error(response: Response, status: number, code: string) {
  expect(await json(response, status)).toMatchObject({ error: { code } });
}

function change(expected_revision = 1, fields: Body = {}) {
  return { request_id: crypto.randomUUID(), expected_revision, ...fields };
}

function source(conversation_id: string, message_id: string, revision = 1) {
  return { conversation_id, message_id, revision };
}

async function fixture(work: (fixture: {
  host: Awaited<ReturnType<typeof startHost>>;
  a: Joined; b: Joined; phoneA: Phone; phoneB: Phone; anonymous: Phone;
  group: string; directA: string; directB: string;
  send: (phone: Phone, conversation: string, text: string) => Promise<string>;
  restart: () => Promise<void>;
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "cattt-member-resources-"));
  const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" } });
  const start = () => startHost({ dataDir: directory, port: 0 }, [gateway]);
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    host = await start();
    const ca = readFileSync(join(directory, "tls/ca.crt"), "utf8");
    const adminToken = readFileSync(join(directory, "host-admin.token"), "utf8");
    const request = (token?: string, admin = false): Phone => (path, method = "GET", body) => {
      const base = admin ? `http://127.0.0.1:${gateway.port}` : `https://127.0.0.1:${gateway.lanPort}`;
      return fetch(base + path, {
        method, tls: { ca },
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    const admin = request(adminToken, true);
    const anonymous = request();
    const first = await json<{ member: { id: string } }>(await admin("/host/members", "POST", { display_name: "甲" }));
    const pair = await json<{ code: string }>(await admin("/host/pairing-codes", "POST", { member_id: first.member.id }));
    const a = await json<Joined>(await anonymous("/v2/pair", "POST", { code: pair.code, device_name: "甲手机" }));
    const phoneA = request(a.device_token);
    const invite = await json<{ code: string }>(await phoneA("/v2/invites", "POST", {}));
    const b = await json<Joined>(await anonymous("/v2/invites/accept", "POST", {
      code: invite.code, display_name: "乙", device_name: "乙手机",
    }));
    const phoneB = request(b.device_token);
    const conversations = async (phone: Phone) => (await json<{
      conversations: { kind: string; id: string }[];
    }>(await phone("/v2/conversations"))).conversations;
    const rowsA = await conversations(phoneA);
    const rowsB = await conversations(phoneB);
    await work({
      host, a, b, phoneA, phoneB, anonymous,
      group: rowsA.find(({ kind }) => kind === "group")!.id,
      directA: rowsA.find(({ kind }) => kind === "direct")!.id,
      directB: rowsB.find(({ kind }) => kind === "direct")!.id,
      send: async (phone, conversation, text) => (await json<{ message: { id: string } }>(
        await phone(`/v2/conversations/${conversation}/messages`, "POST", { text, client_message_id: crypto.randomUUID() }), 201,
      )).message.id,
      restart: async () => {
        await host!.stop();
        host = await start();
      },
    });
  } finally {
    await host?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("已配对设备按主体管理记忆，隐藏伴侣单聊出处，撤回屏蔽旧事实重放", async () => {
  await fixture(async ({ host, a, b, phoneA, phoneB, anonymous, group, directA, directB, send }) => {
    const privateText = "只有乙和团子可查看的原话，提到甲喝茶";
    const privateMessage = await send(phoneB, directB, privateText);
    const groupMessage = await send(phoneB, group, "甲喜欢绿茶");
    const older = await send(phoneA, directA, "我喜欢龙井");
    const { db } = host.store;
    const seed = (sourceMemberId: string, sourceMessageId: string, subjectMemberId: string | null, fingerprint: string) => ({
      householdId: host.householdId, sourceMemberId, sourceMessageId, sourceRevision: 1, subjectMemberId,
      fingerprint, predicate: "茶", value: "绿茶",
    });
    const privateSeed = seed(b.member.id, privateMessage, a.member.id, "tea");
    const mine = saveMemory(db, host.clock, privateSeed)!;
    const oldSeed = seed(a.member.id, older, a.member.id, "tea");
    saveMemory(db, host.clock, oldSeed);
    const shared = saveMemory(db, host.clock, seed(b.member.id, groupMessage, null, "shared-tea"))!;
    const othersShared = saveMemory(db, host.clock, seed(a.member.id, older, null, "shared-tea"))!;
    const partnerMemory = saveMemory(db, host.clock, seed(b.member.id, privateMessage, b.member.id, "partner-tea"))!;
    const minePath = `/v2/memories/${mine.id}`;
    await error(await anonymous("/v2/memories"), 401, "unauthorized");
    await error(await phoneA(`/v2/memories/${partnerMemory.id}`), 404, "not_found");
    const listed = await json<{ memories: { id: string; source: unknown }[] }>(await phoneA("/v2/memories"));
    expect(listed.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mine.id, subject_member_id: a.member.id, source: null, can_edit: true }),
      expect.objectContaining({ id: shared.id, subject_member_id: null, can_edit: false, source: {
        member_id: b.member.id, conversation_id: group, message_id: groupMessage, revision: 1,
      } }),
    ]));
    for (const hidden of [privateText, privateMessage, directB, partnerMemory.id]) {
      expect(JSON.stringify(listed)).not.toContain(hidden);
    }
    await error(await phoneB(minePath, "PATCH", change(1, { value: "越权" })), 404, "not_found");
    await error(await phoneA(`/v2/memories/${shared.id}`, "DELETE", change()), 404, "not_found");
    const sharedWithdraw = await json<{ memory: Body }>(await phoneB(`/v2/memories/${shared.id}`, "DELETE", change()));
    expect(sharedWithdraw.memory).toMatchObject({ id: shared.id, revision: 2, deleted_at: expect.any(Number) });
    expect((await phoneA(`/v2/memories/${othersShared.id}`)).status).toBe(200);
    const edit = change(1, { value: "乌龙" });
    expect(await json(await phoneA(minePath, "PATCH", edit))).toMatchObject({ memory: { revision: 2, value: "乌龙" } });
    expect(await json(await phoneA(minePath, "PATCH", edit))).toMatchObject({ memory: { revision: 2, value: "乌龙" } });
    await error(await phoneA(minePath, "PATCH", { ...edit, value: "改用同一个键" }), 409, "idempotency_conflict");
    await error(await phoneA(minePath, "PATCH", change(1, { value: "旧编辑" })), 409, "revision_conflict");
    const withdrawal = change(2);
    const removed = await json<{ memory: Body }>(await phoneA(minePath, "DELETE", withdrawal));
    expect(removed.memory).toMatchObject({ id: mine.id, revision: 3, deleted_at: expect.any(Number) });
    expect(removed.memory).not.toHaveProperty("value");
    expect(await json(await phoneA(minePath, "DELETE", withdrawal))).toEqual(removed);
    expect(await json(await phoneA(minePath, "PATCH", edit))).toEqual(removed);
    await error(await phoneA(minePath, "PATCH", change(3, { value: "旧值复活" })), 404, "not_found");
    await error(await phoneA(minePath), 404, "not_found");
    expect(saveMemory(db, host.clock, privateSeed)).toBeUndefined();
    expect(saveMemory(db, host.clock, oldSeed)).toBeUndefined();
    expect(assessKnowledgeUse(db, {
      householdId: host.householdId, audienceMemberIds: [a.member.id], evidence: [{ kind: "memory", id: mine.id, rev: 2 }],
    })).toBe("source_unavailable");
  });
});

test("来源操作核对会话、消息作者与修订，回避仅作用于自己的受众", async () => {
  await fixture(async ({ host, a, b, phoneA, phoneB, group, directA, send }) => {
    const groupMessage = await send(phoneA, group, "我想回避面试");
    const ownMessage = await send(phoneA, directA, "这段原话用于日记");
    const row = saveMemory(host.store.db, host.clock, {
      householdId: host.householdId, sourceMemberId: a.member.id, sourceMessageId: ownMessage, sourceRevision: 1,
      subjectMemberId: b.member.id, fingerprint: "holiday", predicate: "假期", value: "海边",
    })!;
    expect(await json(await phoneB(`/v2/memories/${row.id}`))).toMatchObject({ memory: { source: null } });
    await error(await phoneB("/v2/boundaries", "POST", {
      request_id: crypto.randomUUID(), description: "面试", source: source(group, groupMessage),
    }), 404, "not_found");
    const request = { request_id: crypto.randomUUID(), description: "面试", source: source(group, groupMessage) };
    const created = await json<{ boundary: { id: string } }>(await phoneA("/v2/boundaries", "POST", request), 201);
    expect(await json(await phoneA("/v2/boundaries", "POST", request))).toEqual(created);
    expect(await json(await phoneB("/v2/boundaries"))).toEqual({ boundaries: [] });
    const boundaryPath = `/v2/boundaries/${created.boundary.id}`;
    await error(await phoneB(boundaryPath, "PATCH", change(1, { description: "越权" })), 404, "not_found");
    const policy = (memberId: string, text: string) => assessKnowledgeUse(host.store.db, {
      householdId: host.householdId, audienceMemberIds: [memberId], evidence: [], text,
    });
    expect(policy(a.member.id, "准备面试")).toBe("avoided_topic");
    expect(policy(b.member.id, "准备面试")).toBe("allowed");
    expect(await json(await phoneA(boundaryPath, "PATCH", change(1, { description: "考试" })))).toMatchObject({
      boundary: { revision: 2, description: "考试" },
    });
    expect(policy(a.member.id, "准备考试")).toBe("avoided_topic");
    const withdrawal = change(2);
    expect(await json(await phoneA(boundaryPath, "DELETE", withdrawal))).toMatchObject({ boundary: { revision: 3 } });
    expect(policy(a.member.id, "准备考试")).toBe("allowed");
    expect(await json(await phoneA("/v2/boundaries", "POST", request))).toMatchObject({
      boundary: { id: created.boundary.id, revision: 3, deleted_at: expect.any(Number) },
    });
    await error(await phoneA("/v2/boundaries", "POST", { ...request, request_id: crypto.randomUUID() }), 409, "revision_conflict");
    const usage = `/v2/conversations/${directA}/messages/${ownMessage}/usage`;
    const withdrawPath = `/v2/conversations/${directA}/messages/${ownMessage}/withdraw`;
    await error(await phoneB(usage), 404, "not_found");
    await error(await phoneB(`/v2/conversations/${group}/messages/${groupMessage}/withdraw`, "POST", change()), 404, "not_found");
    await error(await phoneA(`/v2/conversations/${group}/messages/${ownMessage}/withdraw`, "POST", change()), 404, "not_found");
    await error(await phoneA(withdrawPath, "POST", change(2)), 409, "revision_conflict");
    expect(await json(await phoneA(usage))).toMatchObject({ source: { revision: 1, allowed: true } });
    const revoke = change();
    const revoked = await json(await phoneA(withdrawPath, "POST", revoke));
    expect(revoked).toMatchObject({ source: { revision: 1, allowed: false } });
    expect(await json(await phoneA(withdrawPath, "POST", revoke))).toEqual(revoked);
    expect(await json(await phoneA(usage))).toEqual(revoked);
    await error(await phoneB(`/v2/memories/${row.id}`), 404, "not_found");
    const history = await json<{ messages: { id: string }[] }>(await phoneA(`/v2/conversations/${directA}/messages`));
    expect(history.messages.some(({ id }) => id === ownMessage)).toBe(true);
  });
});

test("共享日记可互读，作者控制正文和猫读许可，旧变更跨重启也不能复活撤回历史", async () => {
  await fixture(async ({ host, a, b, phoneA, phoneB, directA, directB, send, restart }) => {
    const message = await send(phoneA, directA, "甲的单聊出处");
    const foreign = await send(phoneB, directB, "乙的单聊出处");
    const input = {
      request_id: crypto.randomUUID(), text: "今天的共享日记", local_day: "2026-11-22",
      time_zone: "Asia/Kuala_Lumpur", recorded_at: Date.parse("2026-11-21T18:20:00Z"),
      source: source(directA, message),
    };
    await error(await phoneA("/v2/diary", "POST", { ...input, owner_member_id: b.member.id }), 400, "invalid_request");
    await error(await phoneA("/v2/diary", "POST", { ...input, source: source(directB, foreign) }), 404, "not_found");
    await error(await phoneA("/v2/diary", "POST", { ...input, local_day: "2026-11-21" }), 400, "invalid_request");
    const created = await json<{ entry: { id: string } }>(await phoneA("/v2/diary", "POST", input), 201);
    const id = created.entry.id;
    const path = `/v2/diary/${id}`;
    expect(await json(await phoneA("/v2/diary", "POST", input))).toEqual(created);
    const visible = await json(await phoneB(path));
    expect(visible).toMatchObject({ entry: {
      id, owner_member_id: a.member.id, text: input.text, revision: 1, cat_allowed: false, cat_readable: false,
      can_edit: false, source: null, local_day: input.local_day, time_zone: input.time_zone, recorded_at: input.recorded_at,
    } });
    expect(JSON.stringify(visible)).not.toContain(message);
    expect(await json(await phoneB("/v2/diary"))).toEqual({ entries: [(visible as { entry: Body }).entry] });
    for (const [target, method, body] of [
      [path, "PATCH", change(1, { text: "越权" })],
      [path + "/cat-allowed", "PATCH", change(1, { cat_allowed: true })],
      [path, "DELETE", change()],
    ] as const) {
      await error(await phoneB(target, method, body), 404, "not_found");
    }
    const canCatRead = (revision: number) => assessKnowledgeUse(host.store.db, {
      householdId: host.householdId, audienceMemberIds: [b.member.id], evidence: [{ kind: "diary", id, rev: revision }],
    });
    expect(canCatRead(1)).toBe("source_unavailable");
    const grant = change(1, { cat_allowed: true });
    await json(await phoneA(path + "/cat-allowed", "PATCH", grant));
    expect(canCatRead(2)).toBe("allowed");
    await json(await phoneA(path, "PATCH", change(2, { text: "改过的日记" })));
    expect(canCatRead(2)).toBe("source_unavailable");
    expect(canCatRead(3)).toBe("allowed");
    await json(await phoneA(path + "/cat-allowed", "PATCH", change(3, { cat_allowed: false })));
    expect(await json(await phoneA(path + "/cat-allowed", "PATCH", grant))).toMatchObject({
      entry: { revision: 4, cat_allowed: false, cat_readable: false },
    });
    await error(await phoneA(path + "/cat-allowed", "PATCH", change(1, { cat_allowed: true })), 409, "revision_conflict");
    await json(await phoneA(path + "/cat-allowed", "PATCH", change(4, { cat_allowed: true })));
    await json(await phoneA(`/v2/conversations/${directA}/messages/${message}/withdraw`, "POST", change()));
    expect(canCatRead(5)).toBe("source_unavailable");
    expect(await json(await phoneB(path))).toMatchObject({ entry: {
      text: "改过的日记", cat_allowed: true, cat_readable: false, revision: 5,
    } });
    await error(await phoneA(path + "/cat-allowed", "PATCH", change(5, { cat_allowed: true })), 409, "source_unavailable");
    const remove = change(5);
    const deleted = await json<{ entry: Body }>(await phoneA(path, "DELETE", remove));
    expect(deleted.entry).toMatchObject({ id, revision: 6, deleted_at: expect.any(Number) });
    expect(deleted.entry).not.toHaveProperty("text");
    await restart();
    expect(await json(await phoneA(path, "DELETE", remove))).toEqual(deleted);
    expect(await json(await phoneA("/v2/diary", "POST", input))).toEqual(deleted);
    expect(await json(await phoneA(path + "/cat-allowed", "PATCH", grant))).toEqual(deleted);
    await error(await phoneA(path + "/cat-allowed", "PATCH", change(6, { cat_allowed: true })), 404, "not_found");
    await error(await phoneB(path), 404, "not_found");
    expect(await json(await phoneB("/v2/diary"))).toEqual({ entries: [] });
  });
});

type ChangePage = {
  changes: { sequence: number; kind: string; id: string; op: string; value?: Body }[];
  next: string;
  has_more: boolean;
  generation: string;
  reset: false;
};

function changesPath(cursor?: string, limit = 50) {
  return `/v2/changes?limit=${limit}${cursor === undefined ? "" : "&cursor=" + encodeURIComponent(cursor)}`;
}

test("手机增量游标按成员隔离，分页期间只发布当前可见投影，重启保留位置", async () => {
  await fixture(async ({ host, a, b, phoneA, phoneB, anonymous, group, directA, directB, send, restart }) => {
    const publicId = await send(phoneA, group, "合成群聊原话");
    const privateId = await send(phoneB, directB, "合成伴侣单聊原话");
    const { db } = host.store;
    const seed = (member: string, id: string, subject: string | null, fingerprint: string) => saveMemory(db, host.clock, {
      householdId: host.householdId, sourceMemberId: member, sourceMessageId: id, sourceRevision: 1,
      subjectMemberId: subject, fingerprint, predicate: "测试偏好", value: "合成摘要",
    })!;
    const memory = seed(b.member.id, privateId, a.member.id, "visible");
    const hiddenMemory = seed(b.member.id, privateId, b.member.id, "hidden");
    const boundary = await json<{ boundary: { id: string } }>(await phoneA("/v2/boundaries", "POST", {
      request_id: crypto.randomUUID(), source: source(group, publicId), description: "需要在翻页前撤回的回避",
    }), 201);
    const create = async (text: string) => (await json<{ entry: { id: string } }>(await phoneA("/v2/diary", "POST", {
      request_id: crypto.randomUUID(), text, local_day: "2026-11-22", time_zone: "UTC",
      recorded_at: Date.UTC(2026, 10, 22), cat_allowed: true, source: source(group, publicId),
    }), 201)).entry.id;
    const firstDiary = await create("较早的日记");
    const secondDiary = await create("较晚的日记");
    const readA = async (cursor?: string, limit?: number) => {
      const response = await phoneA(changesPath(cursor, limit));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      return json<ChangePage>(response);
    };
    await error(await anonymous(changesPath()), 401, "unauthorized");
    await error(await phoneA(changesPath("broken")), 400, "invalid_request");
    await error(await phoneA("/v2/changes?cursor=&limit=100"), 400, "invalid_request");
    await error(await phoneA("/v2/changes?limit=1&limit=2"), 400, "invalid_request");
    await error(await phoneA("/v2/changes?limit=101"), 400, "invalid_request");
    const first = await readA(undefined, 1);
    expect(first).toMatchObject({ reset: false, has_more: true, changes: [
      { kind: "memory", id: memory.id, op: "upsert", value: { source: null, revision: 1 } },
    ] });
    const firstSequence = first.changes[0]!.sequence;
    const reset = { error: { code: "cursor_reset_required" }, reset: true, generation: first.generation };
    expect(await json(await phoneB(changesPath(first.next)), 409)).toEqual(reset);
    const changedCursor = first.next.slice(0, 8) + (first.next[8] === "a" ? "b" : "a") + first.next.slice(9);
    expect(await json(await phoneA(changesPath(changedCursor)), 409)).toEqual(reset);
    expect(JSON.stringify(first)).not.toContain(privateId);
    expect(JSON.stringify(first)).not.toContain(directB);
    expect(JSON.stringify(first)).not.toContain(hiddenMemory.id);
    expect(JSON.stringify(first)).not.toContain(a.device_token);

    await json(await phoneA(`/v2/conversations/${group}/messages/${publicId}/withdraw`, "POST", change()));
    const added = await createUnlinkedDiary(phoneA, "分页期间新日记");
    const observed: ChangePage["changes"] = [...first.changes];
    let page = first;
    for (let i = 0; page.has_more && i < 10; i++) {
      page = await readA(page.next, 1);
      observed.push(...page.changes);
    }
    expect(page.has_more).toBe(false);
    expect(observed.map(({ sequence }) => sequence)).toEqual(
      [...new Set(observed.map(({ sequence }) => sequence))].sort((left, right) => left - right),
    );
    expect(observed).toHaveLength(5);
    expect(observed.find(({ id }) => id === boundary.boundary.id))
      .toEqual({ kind: "boundary", id: boundary.boundary.id, op: "delete", sequence: expect.any(Number) });
    for (const id of [firstDiary, secondDiary]) {
      expect(observed.find((row) => row.id === id)).toMatchObject({
        op: "upsert", value: { revision: 1, source: null, cat_allowed: true, cat_readable: false },
      });
    }
    expect(observed.find(({ id }) => id === added)).toMatchObject({ op: "upsert", kind: "diary" });
    expect(JSON.stringify(observed)).not.toContain("需要在翻页前撤回的回避");
    expect(JSON.stringify(observed)).not.toContain(privateId);
    expect(JSON.stringify(observed)).not.toContain(hiddenMemory.id);
    expect(observed[1]!.sequence).toBeGreaterThan(firstSequence);
    const replay = await readA(first.next, 1);
    expect(replay.changes).toEqual([]);
    expect(replay.has_more).toBe(true);
    expect(await readA(page.next)).toEqual({ ...page, changes: [] });

    const removed = await json(await phoneA(`/v2/diary/${secondDiary}`, "DELETE", change()));
    expect(removed).toMatchObject({ entry: { id: secondDiary, revision: 2 } });
    await restart();
    const tail = await readA(page.next);
    expect(tail.changes).toEqual([{ kind: "diary", id: secondDiary, op: "delete", sequence: expect.any(Number) }]);
    expect((await readA(tail.next)).changes).toEqual([]);
    expect((await json<{ conversations: Body[] }>(await phoneA("/v2/conversations"))).conversations)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: directA })]));
  });
});

async function createUnlinkedDiary(phone: Phone, text: string) {
  return (await json<{ entry: { id: string } }>(await phone("/v2/diary", "POST", {
    request_id: crypto.randomUUID(), text, local_day: "2026-11-22", time_zone: "UTC",
    recorded_at: Date.UTC(2026, 10, 22),
  }), 201)).entry.id;
}

test("会话许可变化以同业务 revision 重投影，恢复世代拒绝旧游标并重建活跃列表", async () => {
  await fixture(async ({ host, a, b, phoneA, phoneB, group, send, restart }) => {
    const message = await send(phoneA, group, "可见性变化的合成出处");
    const created = await json<{ entry: { id: string } }>(await phoneA("/v2/diary", "POST", {
      request_id: crypto.randomUUID(), text: "共享正文", local_day: "2026-11-22", time_zone: "UTC",
      recorded_at: Date.UTC(2026, 10, 22), cat_allowed: true, source: source(group, message),
    }), 201);
    const { id } = created.entry;
    const read = async (cursor?: string) => json<ChangePage>(await phoneB(changesPath(cursor)));
    const original = await read();
    const pointer = { member_id: a.member.id, conversation_id: group, message_id: message, revision: 1 };
    expect(original.changes).toEqual([{
      id, op: "upsert", kind: "diary", sequence: expect.any(Number),
      value: expect.objectContaining({ revision: 1, source: pointer, cat_readable: true }),
    }]);
    const participant = host.store.db.select().from(participants).where(eq(participants.memberId, b.member.id)).all()
      .find(({ conversationId }) => conversationId === group)!;
    const setAccess = (deletedAt: number | null) =>
      host.store.db.update(participants).set({ deletedAt }).where(eq(participants.id, participant.id)).run();
    setAccess(host.clock.wallMs());
    const denied = await read(original.next);
    expect(denied.changes).toMatchObject([{ id, op: "upsert", value: { revision: 1, source: null } }]);
    expect(denied.changes[0]!.sequence).toBeGreaterThan(original.changes[0]!.sequence);
    setAccess(null);
    const restored = await read(denied.next);
    expect(restored.changes).toMatchObject([{ id, op: "upsert", value: { revision: 1, source: pointer } }]);
    expect(restored.changes[0]!.sequence).toBeGreaterThan(denied.changes[0]!.sequence);
    await json(await phoneA(`/v2/diary/${id}`, "DELETE", change()));
    expect((await read(restored.next)).changes).toMatchObject([{ id, op: "delete" }]);
    const surviving = await createUnlinkedDiary(phoneB, "恢复后可读日记");
    const generation = rotateReplicationGeneration(host.store.db, host.hostId).generation;
    await restart();
    expect(await json(await phoneB(changesPath(restored.next)), 409)).toEqual({
      error: { code: "cursor_reset_required" }, reset: true, generation,
    });
    const clean = await read();
    expect(clean).toMatchObject({ generation, has_more: false, changes: [{ id: surviving, op: "upsert", kind: "diary" }] });
    expect(clean.changes).toHaveLength(1);
    expect((await read(clean.next)).changes).toEqual([]);
  });
});
