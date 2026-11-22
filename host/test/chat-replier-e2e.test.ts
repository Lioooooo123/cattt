import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Message, MessagePage, Turn } from "../src/conversations/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { ModelHttpError } from "../src/llm/errors.ts";
import { createMockModel } from "../src/llm/mock.ts";
import { startHost } from "../src/runtime/index.ts";
import { configFromEnv } from "../src/runtime/config.ts";
import { assembleChatRequest } from "../src/context/chat.ts";
import { TurnRunner } from "../src/turns/index.ts";
import { ChatReplier } from "../src/turns/chat-replier.ts";

test("HTTPS 配对双方、独立单聊和共享群聊经模型完成；提示词不串线、错误恢复保留 retryable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-model-e2e-"));
  const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" } });
  const model = createMockModel(0, true);
  let host: Awaited<ReturnType<typeof startHost>>;
  const replier = new ChatReplier(model, (input) => assembleChatRequest(host.store.db, input));
  host = await startHost({ ...configFromEnv({ MODEL_PROVIDER: "mock", MOCK_DELAY_MS: "0", CATTT_PORT: "0", CATTT_DATA_DIR: directory }), replier }, [new TurnRunner(), gateway]);
  const ca = readFileSync(join(directory, "tls/ca.crt"), "utf8");
  const adminToken = readFileSync(join(directory, "host-admin.token"), "utf8");
  async function json<T>(path: string, token = adminToken, body?: unknown, status = 200): Promise<T> {
    const response = await fetch(`${path.startsWith("/host/") ? `http://127.0.0.1:${gateway.port}` : `https://127.0.0.1:${gateway.lanPort}`}${path}`, {
      method: body === undefined ? "GET" : "POST", tls: { ca }, signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    return await response.json() as T;
  }
  interface Joined { member: { id: string }; device_token: string }
  async function send(conversation: Conversation, token: string, text: string) {
    const result = await json<{ message: Message; turn: Turn }>(`/v2/conversations/${conversation.id}/messages`, token, { client_message_id: crypto.randomUUID(), text }, 201);
    const response = await fetch(`https://127.0.0.1:${gateway.lanPort}${result.turn.stream_url}`, { tls: { ca }, signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return { ...result, stream: await response.text() };
  }
  try {
    const a = await json<Joined>("/host/members", adminToken, { display_name: "阿甲" });
    const pairing = await json<{ code: string }>("/host/pairing-codes", adminToken, { member_id: a.member.id });
    const paired = await json<Joined>("/v2/pair", "", { code: pairing.code, device_name: "甲手机" });
    a.device_token = paired.device_token;
    const invite = await json<{ code: string }>("/v2/invites", a.device_token, { display_name: "阿乙" });
    const b = await json<Joined>("/v2/invites/accept", "", { code: invite.code, display_name: "阿乙", device_name: "乙手机" });
    const listA = await json<{ conversations: Conversation[] }>("/v2/conversations", a.device_token);
    const listB = await json<{ conversations: Conversation[] }>("/v2/conversations", b.device_token);
    const [group, dmA] = listA.conversations as [Conversation, Conversation];
    const dmB = listB.conversations[1]!;
    const sent = [
      await send(dmA, a.device_token, "甲私信_不可混入别处"),
      await send(dmB, b.device_token, "乙私信_不可混入别处"),
      await send(group, a.device_token, "团子，甲群聊_一起坐坐"),
      await send(group, b.device_token, "团子，乙群聊_我也来了"),
    ];
    for (const [index, result] of sent.entries()) {
      expect(result.stream).toContain("event: accepted");
      expect(result.stream).toContain("event: delta");
      expect(result.stream).toContain("event: done");
      expect(result.stream).not.toContain("event: error");
      const token = index === 1 ? b.device_token : a.device_token;
      const turn = await json<Turn>(`/v2/conversations/${result.turn.conversation_id}/turns/${result.turn.id}`, token);
      expect(turn.status).toBe("completed");
      const page = await json<MessagePage>(`/v2/conversations/${result.turn.conversation_id}/messages`, token);
      const cat = page.messages.find((message) => message.id === turn.reply_message_id)!;
      expect(cat).toMatchObject({ author: { kind: "cat" }, reply_to_message_id: result.message.id, turn_id: turn.id, text: "听到了，我在这里陪你。喵。" });
    }
    expect(model.requests).toHaveLength(4);
    const requests = model.requests.map((request) => JSON.stringify({ system: request.system, messages: request.messages }));
    expect(requests[0]).toContain("阿甲"); expect(requests[0]).not.toContain("阿乙");
    expect(requests[0]).not.toContain("乙私信"); expect(requests[0]).not.toContain("群聊_");
    expect(requests[1]).toContain("阿乙"); expect(requests[1]).not.toContain("阿甲");
    expect(requests[1]).not.toContain("甲私信"); expect(requests[1]).not.toContain("群聊_");
    for (const index of [2, 3]) {
      expect(model.requests[index]!.system).toContain('群聊，成员为 "阿甲"、"阿乙"');
      expect(requests[index]).not.toContain("甲私信"); expect(requests[index]).not.toContain("乙私信");
    }
    const groupPrompt = model.requests[3]!.messages.map((message) => message.content).join("\n");
    expect(groupPrompt).toContain('"阿甲"：团子，甲群聊_一起坐坐');
    expect(groupPrompt).toContain('"阿乙"：团子，乙群聊_我也来了');
    expect(sent[2]!.message.author).toEqual({ kind: "member", member_id: a.member.id });
    expect(sent[3]!.message.author).toEqual({ kind: "member", member_id: b.member.id });
    expect(await json(`/v2/conversations/${dmA.id}`, b.device_token, undefined, 404)).toEqual({ error: { code: "not_found" } });
    await json(`/v2/conversations/${dmA.id}/turns/${sent[0]!.turn.id}`, b.device_token, undefined, 404);
    const latest = await json<MessagePage>(`/v2/conversations/${group.id}/messages?limit=2`, a.device_token);
    expect(latest.has_more_before).toBe(true);
    const previous = await json<MessagePage>(`/v2/conversations/${group.id}/messages?limit=2&before=${encodeURIComponent(latest.messages[0]!.cursor)}`, b.device_token);
    expect(previous.has_more_before).toBe(false);
    expect([...previous.messages, ...latest.messages].map((message) => message.author.kind)).toEqual(["member", "cat", "member", "cat"]);
    for (const [status, code, retryable] of [[402, "model_quota", false], [503, "model_error", true]] as const) {
      model.stream = async function* () { throw new ModelHttpError(status); };
      const failed = await send(dmA, a.device_token, "测模型错误");
      const payload = `event: error\ndata: ${JSON.stringify({ code, retryable })}`;
      expect(failed.stream).toContain(payload);
      const turn = await json<Turn>(`/v2/conversations/${dmA.id}/turns/${failed.turn.id}`, a.device_token);
      expect(turn).toMatchObject({ status: "failed", error_code: code, reply_message_id: null });
      const recovered = await fetch(`https://127.0.0.1:${gateway.lanPort}${failed.turn.stream_url}?last_event_id=foreign.1`, { tls: { ca }, headers: { Authorization: `Bearer ${a.device_token}` } });
      const text = await recovered.text();
      expect(text).toContain("event: snapshot"); expect(text).toContain(payload);
    }
  } finally { await host.stop(); rmSync(directory, { recursive: true, force: true }); }
});
