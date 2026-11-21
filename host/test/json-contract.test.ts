import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Message, Turn } from "../src/conversations/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startHost } from "../src/runtime/index.ts";

function snakeKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(snakeKeys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      expect(key).not.toMatch(/[A-Z]/);
      snakeKeys(child);
    }
  }
}

interface Joined {
  member: { id: string; household_id: string; display_name: string; home_host_id: string };
  household: { id: string; name: string };
  device_id: string;
  device_token: string;
}

test("遍历全部 /v2 与 /host 路由 JSON（含 SSE data）：键名无大写、错误均为 code 对象", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cattt-json-"));
  const gateway = new Gateway({ lanPort: 0, tls: { ips: () => [], hostname: "test" } });
  const errors: unknown[] = [];
  const host = await startHost({ dataDir: directory, port: 0, maxMembers: 3, onError: (error) => { errors.push(error); } }, [gateway]);
  const adminToken = readFileSync(join(directory, "host-admin.token"), "utf8");
  const ca = readFileSync(join(directory, "tls/ca.crt"), "utf8");
  const seen = new Set<string>();
  const normalize = (path: string) => path.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, ":id");
  async function request<T = unknown>(path: string, options: { method?: string; body?: unknown; token?: string; status?: number } = {}): Promise<T> {
    const method = options.method ?? (options.body === undefined ? "GET" : "POST");
    const token = options.token ?? (path.startsWith("/host/") ? adminToken : "");
    const response = await fetch(`${path.startsWith("/host/") ? `http://127.0.0.1:${gateway.port}` : `https://127.0.0.1:${gateway.lanPort}`}${path}`, {
      method, tls: { ca }, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    expect(response.status).toBe(options.status ?? 200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    snakeKeys(body);
    if (response.status >= 400) {
      expect(body).toEqual({ error: expect.objectContaining({ code: expect.any(String) }) });
      expect(Object.keys(body.error).every((key) => key === "code" || key === "message")).toBe(true);
      if ("message" in body.error) { expect(typeof body.error.message).toBe("string"); }
    }
    seen.add(`${method} ${normalize(path)}`);
    return body as T;
  }
  try {
    await request("/v2/healthz");
    await request("/v2/me", { status: 401 });
    await request("/host/status", { token: "", status: 401 });
    await request("/host/members", { body: { displayName: "不接受旧键" }, status: 400 });
    const first = await request<{ member: Joined["member"] }>("/host/members", { body: { display_name: "甲" } });
    expect(first.member).toMatchObject({ display_name: "甲", household_id: host.householdId, home_host_id: host.hostId });
    const profileKeys = ["id", "household_id", "display_name", "home_host_id"];
    const recordKeys = [...profileKeys, "origin_host_id", "hlc", "rev", "created_at", "updated_at", "deleted_at"].sort();
    expect(Object.keys(first.member).sort()).toEqual(recordKeys);
    await request("/host/members", { body: { display_name: "已初始化" }, status: 409 });
    await request("/host/pairing-codes", { body: { memberId: first.member.id }, status: 400 });
    const pairing = await request<{ code: string }>("/host/pairing-codes", { body: { member_id: first.member.id } });
    await request("/v2/pair", { body: { code: pairing.code, deviceName: "不接受旧键" }, status: 400 });
    const a = await request<Joined>("/v2/pair", { body: { code: pairing.code, device_name: "甲手机" } });
    expect(Object.keys(a.member).sort()).toEqual([...profileKeys].sort());
    await request("/v2/pair", { body: { code: pairing.code, device_name: "重复" }, status: 401 });
    await request("/v2/me", { token: a.device_token });
    await request("/v2/invites", { token: a.device_token, body: { displayName: "不接受旧键" }, status: 400 });
    const invite = await request<{ invite_id: string; code: string }>("/v2/invites", { token: a.device_token, body: { display_name: "乙" } });
    await request("/v2/invites/accept", { body: { code: invite.code, displayName: "乙", device_name: "手机" }, status: 400 });
    const b = await request<Joined>("/v2/invites/accept", { body: { code: invite.code, display_name: "乙", device_name: "乙手机" } });
    expect(Object.keys(b.member).sort()).toEqual(recordKeys);
    await request("/v2/invites/accept", { body: { code: invite.code, display_name: "重复", device_name: "手机" }, status: 401 });
    await request("/v2/members", { token: a.device_token });
    await request("/v2/me", { token: b.device_token });
    const revoked = await request<{ invite_id: string }>("/v2/invites", { token: a.device_token, body: {} });
    await request(`/v2/invites/${revoked.invite_id}`, { method: "DELETE", token: b.device_token, status: 403 });
    await request(`/v2/invites/${revoked.invite_id}`, { method: "DELETE", token: a.device_token });
    const adminInvite = await request<{ invite_id: string }>("/host/invites", { body: {} });
    await request(`/host/invites/${adminInvite.invite_id}`, { method: "DELETE" });
    const list = await request<{ conversations: Conversation[] }>("/v2/conversations", { token: a.device_token });
    const path = `/v2/conversations/${list.conversations[0]!.id}`;
    await request(path, { token: a.device_token });
    await request(path + "/messages", { token: a.device_token });
    await request(path + "/messages", { token: a.device_token, body: { clientMessageId: "bad", text: "旧键" }, status: 400 });
    const message = await request<{ message: Message; turn: Turn }>(path + "/messages", {
      token: a.device_token, body: { client_message_id: "snake", text: "Hello 大写值合法" }, status: 201,
    });
    await request(path + "/messages", { token: a.device_token });
    const turnPath = path + `/turns/${message.turn.id}`;
    await request(turnPath, { token: a.device_token });
    await request(turnPath + "/cancel", { token: a.device_token, body: { visibleLength: 0 }, status: 400 });
    await request(turnPath + "/cancel", { token: a.device_token, body: { visible_length: 0 } });
    const stream = await fetch(`https://127.0.0.1:${gateway.lanPort}${message.turn.stream_url}`, { tls: { ca }, headers: { Authorization: `Bearer ${a.device_token}` } });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const data = (await stream.text()).split("\n").filter((line) => line.startsWith("data: "));
    expect(data).toHaveLength(2);
    data.forEach((line) => snakeKeys(JSON.parse(line.slice(6))));
    seen.add("GET " + normalize(message.turn.stream_url));
    const reply = path + `/messages/${message.message.id}/reply`;
    await request(reply, { token: a.device_token, body: { requestId: crypto.randomUUID() }, status: 400 });
    await request(reply, { token: a.device_token, body: { request_id: crypto.randomUUID() }, status: 201 });
    await request("/host/devices");
    await request("/host/status");
    await request(`/host/devices/${b.device_id}`, { method: "DELETE" });
    const spareCode = await request<{ code: string }>("/host/pairing-codes", { body: { member_id: b.member.id } });
    const spare = await request<Joined>("/v2/pair", { body: { code: spareCode.code, device_name: "备用" } });
    await request("/v2/device/unpair", { token: spare.device_token, body: {} });
    await request("/v2/me", { token: spare.device_token, status: 401 });
    await request(`/host/members/${b.member.id}`, { method: "DELETE" });
    for (const unknown of ["/v2/missing", "/host/missing", path + "/missing"]) {
      await request(unknown, { token: unknown.startsWith("/host/") ? adminToken : a.device_token, status: 404 });
    }
    const wallMs = host.clock.wallMs.bind(host.clock);
    host.clock.wallMs = () => { throw new Error("内部故障不应发给客户端"); };
    try {
      expect(await request("/v2/me", { token: a.device_token, status: 500 })).toEqual({ error: { code: "internal_error" } });
      expect(await request("/host/pairing-codes", { body: { member_id: a.member.id }, status: 500 })).toEqual({ error: { code: "internal_error" } });
    } finally { host.clock.wallMs = wallMs; }
    expect(errors).toHaveLength(2);
    const routes = [
      "GET /v2/healthz", "GET /v2/me", "GET /v2/members", "POST /v2/pair", "POST /v2/device/unpair",
      "POST /v2/invites", "POST /v2/invites/accept", "DELETE /v2/invites/:id",
      "POST /host/members", "DELETE /host/members/:id", "POST /host/invites", "DELETE /host/invites/:id",
      "POST /host/pairing-codes", "GET /host/devices", "DELETE /host/devices/:id", "GET /host/status",
      "GET /v2/conversations", "GET /v2/conversations/:id", "GET /v2/conversations/:id/messages", "POST /v2/conversations/:id/messages",
      "GET /v2/conversations/:id/turns/:id", "GET /v2/conversations/:id/turns/:id/stream", "POST /v2/conversations/:id/turns/:id/cancel",
      "POST /v2/conversations/:id/messages/:id/reply",
    ];
    expect(routes.filter((route) => !seen.has(route))).toEqual([]);
  } finally {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
