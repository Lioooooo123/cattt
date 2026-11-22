import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Message, MessagePage, Turn } from "../src/conversations/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { createDevice, createMember } from "../src/store/identity.ts";
import { conversations, participants } from "../src/store/schema/conversations.ts";
import { hosts } from "../src/store/schema/identity.ts";

test("两监听提供同一对话契约：两单聊一群聊、作者幂等、404 隐藏伴侣单聊与成员维护", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-conversations-http-"));
  const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" } });
  const host = await startHost({ dataDir: directory, port: 0, maxMembers: 3 }, [gateway]);
  const ca = readFileSync(join(directory, "tls/ca.crt"), "utf8");
  const adminToken = readFileSync(join(directory, "host-admin.token"), "utf8");
  const http = `http://127.0.0.1:${gateway.port}`;
  const https = `https://127.0.0.1:${gateway.lanPort}`;
  const admin = (path: string, method: string, body?: unknown) => fetch(http + path, {
    method, headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const memberIds = ["甲", "乙"].map((displayName) => createMember(host.store.db, host.clock, {
    householdId: host.householdId, homeHostId: host.hostId, displayName,
  }));
  const tokens = memberIds.map((memberId) => createDevice(host.store.db, host.clock, { memberId, hostId: host.hostId, name: "手机" }).token);
  let groupId = "";
  try {
    for (const base of [http, https]) {
      const request = (path: string, token?: string, method = "GET", body?: unknown) => fetch(base + path, {
        method, tls: { ca }, headers: {
          "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const unauthorized = await request("/v2/conversations");
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ error: { code: "unauthorized" } });
      const lists: Conversation[][] = [];
      for (const token of tokens) {
        const response = await request("/v2/conversations", token);
        expect(response.status).toBe(200);
        const list = (await response.json() as { conversations: Conversation[] }).conversations;
        expect(list.map((row) => row.kind)).toEqual(["group", "direct"]);
        lists.push(list);
      }
      groupId = lists[0]![0]!.id;
      expect(lists[1]![0]!.id).toBe(groupId);
      expect(lists[0]![1]!.id).not.toBe(lists[1]![1]!.id);
      for (const i of [0, 1]) {
        const own = lists[i]![1]!;
        const other = lists[1 - i]![1]!;
        expect(own.owner_member_id).toBe(memberIds[i]!);
        expect((await request(`/v2/conversations/${own.id}`, tokens[i]!)).status).toBe(200);
        for (const [suffix, method, body] of [["", "GET", undefined], ["/messages", "GET", undefined], ["/messages", "POST", { client_message_id: "steal", text: "不应写入" }]] as const) {
          const denied = await request(`/v2/conversations/${other.id}${suffix}`, tokens[i]!, method, body);
          expect(denied.status).toBe(404);
          expect(await denied.json()).toEqual({ error: { code: "not_found" } });
        }
        const key = `same-key-${base}`;
        const send = () => request(`/v2/conversations/${groupId}/messages`, tokens[i]!, "POST", { client_message_id: key, text: `  ${i}  ` });
        const posted = await send();
        expect(posted.status).toBe(201);
        const result = await posted.json() as { message: Message; turn: Turn | null };
        expect(result.turn).toBeNull();
        expect(result.message.author).toEqual({ kind: "member", member_id: memberIds[i]! });
        expect(result.message.text).toBe(String(i));
        expect(Object.keys(result.message).sort()).toEqual([
          "id", "conversation_id", "cursor", "author", "text", "modality", "status", "client_message_id", "reply_to_message_id", "turn_id", "created_at",
        ].sort());
        const replay = await send();
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(result);
        const conflict = await request(`/v2/conversations/${groupId}/messages`, tokens[i]!, "POST", { client_message_id: key, text: "不同" });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toEqual({ error: { code: "idempotency_conflict" } });
        expect((await request(`/v2/conversations/${own.id}/messages`, tokens[i]!, "POST", { client_message_id: key, text: "自己的单聊" })).status).toBe(201);
      }
      const history = await (await request(`/v2/conversations/${groupId}/messages`, tokens[0])).json() as MessagePage;
      expect(history.messages.slice(-2).map((row) => row.author)).toEqual(memberIds.map((member_id) => ({ kind: "member", member_id })));
      for (const query of ["before=garbage", "after=", "limit=101", "limit=0", "limit=1.5"]) {
        const invalid = await request(`/v2/conversations/${groupId}/messages?${query}`, tokens[0]);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: { code: "invalid_request" } });
      }
      for (const body of [{ client_message_id: "", text: "x" }, { client_message_id: "bad", text: " " }, { client_message_id: "bad", text: "x", author_member_id: memberIds[1] }]) {
        expect((await request(`/v2/conversations/${groupId}/messages`, tokens[0], "POST", body)).status).toBe(400);
      }
      expect((await request("/v2/conversations/not-a-uuid", tokens[0])).status).toBe(400);
      const pendingTurnRoute = await request(`/v2/conversations/${groupId}/turns/${groupId}`, tokens[0]);
      expect(pendingTurnRoute.status).toBe(404);
      expect(await pendingTurnRoute.json()).toEqual({ error: { code: "not_found" } });
    }
    const remote = businessRow(host.clock, host.hostId);
    host.store.db.insert(hosts).values({ ...remote, householdId: host.householdId, displayName: "另一台 Mac" }).run();
    host.store.db.update(conversations).set({ publisherHostId: remote.id }).where(eq(conversations.id, groupId)).run();
    const wrongHost = await fetch(https + `/v2/conversations/${groupId}/messages`, {
      method: "POST", tls: { ca }, headers: { Authorization: `Bearer ${tokens[0]}`, "Content-Type": "application/json" },
      body: JSON.stringify({ client_message_id: "remote", text: "不要双写" }),
    });
    expect(wrongHost.status).toBe(409);
    expect(await wrongHost.json()).toEqual({ error: { code: "publication_lease_pending" } });
    host.store.db.update(conversations).set({ publisherHostId: host.hostId }).where(eq(conversations.id, groupId)).run();
    const invite = await (await admin("/host/invites", "POST")).json() as { code: string };
    const accepted = await fetch(https + "/v2/invites/accept", {
      method: "POST", tls: { ca }, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: invite.code, display_name: "丙", device_name: "手机" }),
    });
    expect(accepted.status).toBe(200);
    const third = await accepted.json() as { member: { id: string }; device_token: string };
    const getGroup = async (base: string, token: string) => await (await fetch(base + `/v2/conversations/${groupId}`, {
      tls: { ca }, headers: { Authorization: `Bearer ${token}` },
    })).json() as Conversation;
    expect((await getGroup(https, third.device_token)).participant_member_ids).toEqual([...memberIds, third.member.id]);
    expect((await admin(`/host/members/${memberIds[1]}`, "DELETE")).status).toBe(200);
    for (const base of [http, https]) {
      expect((await getGroup(base, tokens[0]!)).participant_member_ids).toEqual([memberIds[0]!, third.member.id]);
      expect((await fetch(base + "/v2/conversations", { tls: { ca }, headers: { Authorization: `Bearer ${tokens[1]}` } })).status).toBe(401);
    }
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("启动补齐 R2 已有成员对话与参与者，重复启动不改变行或修订", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-conversations-backfill-"));
  let host = await startHost({ dataDir: directory }, []);
  try {
    for (const displayName of ["甲", "乙"]) {
      createMember(host.store.db, host.clock, { householdId: host.householdId, homeHostId: host.hostId, displayName });
    }
    host.store.db.delete(participants).run();
    host.store.db.delete(conversations).run();
    await host.stop();
    host = await startHost({ dataDir: directory }, []);
    const rows = host.store.db.select().from(conversations).all();
    const links = host.store.db.select().from(participants).all();
    expect(rows).toHaveLength(3);
    expect(links).toHaveLength(4);
    await host.stop();
    host = await startHost({ dataDir: directory }, []);
    expect(host.store.db.select().from(conversations).all()).toEqual(rows);
    expect(host.store.db.select().from(participants).all()).toEqual(links);
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
