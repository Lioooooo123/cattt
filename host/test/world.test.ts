import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { getReplicationHead, readChangePage } from "../src/store/replication.ts";
import { createDevice } from "../src/store/identity.ts";
import { scanCatDiary } from "../src/store/cat-diary.ts";
import { currentSoul } from "../src/store/soul.ts";
import { assembleChatRequest } from "../src/context/chat.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const result = await read();
    if (ready(result)) return result;
    if (performance.now() >= deadline) throw new Error(JSON.stringify(result));
    await Bun.sleep(50);
  }
}

const observation = {
  state_version: 0, scene_version: 4, destination_ids: ["house", "tree", "bed", "grass", "pond", "fence"],
  current_destination_id: "house", target_destination_id: "house", phase: "idle", action: "sit_idle",
  paused: false, runnable: true, companion_seat: "house", bowl_filled_today: true, places_today: ["蘑菇屋门口"],
};

// Give production mTLS renewals a wall clock that runs alongside monotonic time.
class WorldTestClock extends ManualClock {
  private anchor = performance.now();

  override wallMs() {
    return super.wallMs() + Math.floor(performance.now() - this.anchor);
  }

  override setWallMs(ms: number) {
    super.setWallMs(ms);
    this.anchor = performance.now();
  }

  override advance(ms: number) {
    this.setWallMs(this.wallMs() + ms);
  }
}

test("双 SQLite 和 mTLS：成员会话隔离、状态与动作幂等、租约证据、交接与重启", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-world-"));
  const stops: (() => Promise<void>)[] = [];
  const errors: unknown[] = [];
  const calls = { a: 0, b: 0 };
  const offset = 8 * 3600_000;
  const dayEnd = Math.floor((Date.now() + offset - 7 * 60_000) / 86_400_000) * 86_400_000 - offset;
  const diaryDay = new Date(dayEnd + offset - 1).toISOString().slice(0, 10);
  let wall = dayEnd - 4 * 60_000;
  let wallSetAt = performance.now();
  const fixtureNow = () => wall + Math.floor(performance.now() - wallSetAt);
  async function launch(name: "a" | "b", reuse?: { peerPort: number; lanPort: number }) {
    const dir = join(root, name);
    const gateway = new Gateway({ peerPort: reuse?.peerPort ?? 0, peerHostname: "127.0.0.1", lanPort: reuse?.lanPort ?? 0 });
    const clock = new WorldTestClock(crypto.randomUUID(), fixtureNow());
    const host = await startConfiguredHost({
      dataDir: dir, port: 0, clock, onError: (error) => { errors.push(error); },
      dailyDiaryModel: {
        provider: "mock", modelId: "diary-dual-host",
        async generate({ facts }) {
          calls[name]++;
          return { reflection: "心里软软的。", fact_ids: facts.slice(0, 4).map(({ id }) => id) };
        },
      },
    }, gateway);
    stops.push(host.stop);
    const ca = readFileSync(join(dir, "tls/ca.crt"), "utf8");
    const admin = readFileSync(join(dir, "host-admin.token"), "utf8");
    function request(path: string, method = "GET", body?: unknown, token?: string, phone = token !== undefined) {
      const origin = phone ? `https://127.0.0.1:${gateway.lanPort}` : `http://127.0.0.1:${gateway.port}`;
      return fetch(origin + path, {
        method, tls: { ca }, signal: AbortSignal.timeout(15000),
        headers: { ...(phone && !token ? {} : { authorization: `Bearer ${token ?? admin}` }), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch((error) => { throw new Error(`测试请求失败：${name} ${method} ${path.split("?")[0]}`, { cause: error }); });
    }
    async function call(path: string, method?: string, body?: unknown, token?: string, phone?: boolean) {
      const response = await request(path, method, body, token, phone);
      return { status: response.status, body: await response.json() };
    }
    return { host, gateway, clock, request, call };
  }
  try {
    const a = await launch("a");
    const b = await launch("b");
    const first = (await a.call("/host/members", "POST", { display_name: "甲" })).body.member;
    const pair = async (member: string) => {
      const { body } = await a.call("/host/pairing-codes", "POST", { member_id: member });
      return (await a.call("/v2/pair", "POST", { code: body.code, device_name: "手机" }, undefined, true)).body.device_token as string;
    };
    const alice = await pair(first.id);
    const ad = (await a.call("/host/peer-identity")).body;
    const bd = (await b.call("/host/peer-identity")).body;
    expect((await a.call(`/host/peers/${bd.host_id}`, "PUT", {
      identity: bd, confirmed_fingerprint: bd.fingerprint, allow_join: true,
    })).status).toBe(200);
    expect((await b.call("/host/peers/connect", "POST", {
      identity: ad, confirmed_fingerprint: ad.fingerprint, join_household: true,
    })).status).toBe(200);
    const invite = await until(() => b.call("/host/invites", "POST", { display_name: "乙" }), ({ status }) => status === 200);
    const joined = await b.call("/v2/invites/accept", "POST", {
      code: invite.body.code, display_name: "乙", device_name: "乙手机",
    }, undefined, true);
    expect(joined.status).toBe(200);
    const bob = joined.body.device_token as string;
    const world = (node: typeof a, token: string) => (path: string, method?: string, body?: unknown) =>
      node.call(`/v2/world/${path}`, method, body, token);
    const wa = world(a, alice);
    const wb = world(b, bob);
    await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");
    const session = async (client: typeof wa) => {
      const reply = await client("sessions", "POST", { protocol_version: 2 });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      const { session_id, generation } = reply.body;
      return { session_id, generation };
    };
    expect((await a.call("/v2/world/state", "GET", undefined, undefined, true)).status).toBe(401);
    const sa = await session(wa);
    const sb = await session(wb);
    const current = (await wa("state")).body.world;
    const shared = { ...sa, base_revision: current.revision, snapshot: observation };
    const remote = await wb("state", "PUT", { ...shared, ...sb });
    expect(remote).toMatchObject({ status: 409, body: { error: { code: "not_publisher", publisher_host_id: a.host.hostId } } });
    const saved = await wa("state", "PUT", shared);
    expect(saved).toMatchObject({ status: 200, body: { world: { id: current.id, snapshot: { bowl_filled_today: true } } } });
    expect((await wa("state", "PUT", shared)).body.world.revision).toBe(saved.body.world.revision);
    expect((await wa("state", "PUT", { ...shared, snapshot: { ...observation, weather: "rain" } })).body.error.code).toBe("state_version_conflict");

    const streamPath = (s: typeof sa) => `/v2/world/events?${new URLSearchParams(s)}`;
    const stream = await a.request(streamPath(sa), "GET", undefined, alice);
    const reader = stream.body!.getReader();
    const frames = new TextDecoder();
    let received = "";
    const readEvent = (kind: string) => until(async () => {
      const next = await reader.read().catch((error) => {
        throw new Error(`等待世界 SSE 事件失败：${kind}`, { cause: error });
      });
      if (next.done) throw new Error(`世界 SSE 在 ${kind} 之前结束`);
      received += frames.decode(next.value);
      return received;
    }, (value) => value.includes(`event: ${kind}\n`));
    await readEvent("world_state");
    const live = await until(() => wa("state"), ({ body }) => body.presence?.some((row: { member_id: string }) => row.member_id === joined.body.member.id));
    expect(live.body.presence.map((row: { member_id: string }) => row.member_id).sort()).toEqual([first.id, joined.body.member.id].sort());
    // Refresh the renderer observation after waiting for the other host's presence.
    expect((await wa("state", "PUT", shared)).status).toBe(200);
    const move = { ...sa, request_id: crypto.randomUUID(), destination_id: "pond", state_version: 0 };
    const issued = await wa("actions", "POST", move);
    expect(issued).toMatchObject({ status: 200, body: { status: "requested" } });
    const action = issued.body.id;
    expect((await wa("actions", "POST", move)).body.id).toBe(action);
    await readEvent("action").catch(async (error) => {
      const status = await wa(`actions/${action}`);
      throw new Error(`世界 SSE 未投递动作：${JSON.stringify(status)}\n${received.slice(-1600)}\n${errors.map(String).join("\n")}`, { cause: error });
    });
    expect((await wa(`actions/${action}/ack`, "POST", {
      ...sa, status: "accepted", snapshot: observation, occurred_at: new Date(a.clock.wallMs() + 86_400_000).toISOString(),
    })).body.error.code).toBe("invalid_event_time");
    expect((await wa(`actions/${action}/ack`, "POST", { ...sa, status: "accepted", snapshot: observation })).body.status).toBe("accepted");
    await reader.cancel();
    const reconnect = await a.request(streamPath(sa), "GET", undefined, alice);
    const reconnectReader = reconnect.body!.getReader();
    expect(await reconnectReader.read()).toMatchObject({ done: false });
    await reconnectReader.cancel();
    const conversations = (await a.call("/v2/conversations", "GET", undefined, alice)).body.conversations;
    const direct = conversations.find((row: { kind: string }) => row.kind === "direct").id;
    const trigger = (await a.call(`/v2/conversations/${direct}/messages`, "POST", {
      client_message_id: crypto.randomUUID(), text: "叫我阿甲，团子平时可以简短一点。",
    }, alice)).body.message;
    const source = trigger.id;
    const ref = { message_id: source, revision: 1 };
    const confirmed = await a.call("/v2/cat-diary/sources", "POST", { kind: "message", id: source, revision: 1 }, alice);
    expect(confirmed).toMatchObject({ status: 200, body: { confirmed: true } });
    const edit = { expected_version: 1, source: ref, change: { kind: "nickname", value: "阿甲" } };
    const soul = (node: typeof a, token: string, body?: unknown) =>
      node.call("/v2/soul", body ? "POST" : "GET", body, token);
    expect((await soul(a, alice, edit)).body.soul).toMatchObject({ version: 2, relationship: { nickname: "阿甲" } });
    expect((await soul(a, alice, edit)).body.soul.version).toBe(2);
    expect((await soul(a, alice, { expected_version: 2, source: ref,
      change: { kind: "response_length", value: "brief" } })).body.soul.habits).toEqual({ response_length: "brief" });
    expect((await soul(a, alice, { expected_version: 3, source: ref,
      change: { kind: "state", energy: "resting", willingness: "quiet", duration_minutes: 1 } })).body.soul.runtime)
      .toMatchObject({ energy: "resting", willingness: "quiet" });
    const partner = await until(() => soul(b, bob), ({ body }) => body.soul?.version === 4);
    expect(partner.body.soul.habits).toEqual({ response_length: "brief" });
    expect(partner.body.soul.relationship.nickname).toBeNull();
    await until(() => wb("state"), ({ body }) => body.soul?.runtime.energy === "resting");
    expect(currentSoul(b.host.store.db, b.host.householdId, [joined.body.member.id], b.clock.wallMs() + 60_000).runtime.energy)
      .toBe("baseline");
    const directChat = assembleChatRequest(a.host.store.db, {
      conversation: conversations.find(({ id }: { id: string }) => id === direct), trigger, history: [],
      signal: new AbortController().signal,
    }, () => a.clock.wallMs());
    expect(directChat.system).toContain("阿甲");
    expect(directChat.system).toContain("通常简短回应");
    expect(directChat.system).toContain('"energy":"resting"');

    const beforeArrival = getReplicationHead(a.host.store.db, a.host.hostId);
    const arrived = { ...observation, state_version: 1, current_destination_id: "pond", target_destination_id: "pond" };
    const arrival = await wa(`actions/${action}/ack`, "POST", { ...sa, status: "arrived", snapshot: arrived });
    expect(arrival, errors.map(String).join("\n")).toMatchObject({ status: 200, body: { status: "arrived" } });
    expect((await wa(`actions/${action}/ack`, "POST", { ...sa, status: "arrived", snapshot: arrived })).body.status).toBe("arrived");
    expect(() => readChangePage(a.host.store.db, a.host.hostId, beforeArrival, 1)).toThrow();
    const synced = await until(() => wb("state"), ({ body }) => body.world?.snapshot?.current_destination_id === "pond");
    expect(synced.body.world.id).toBe(current.id);
    expect(synced.body.execution_available).toBe(false);
    const change = (await b.call("/v2/changes", "GET", undefined, bob)).body.changes.find((row: { kind: string }) => row.kind === "world");
    expect(change.value.id).toBe(current.id);
    expect(change.value).not.toHaveProperty("presence");

    wall = dayEnd + 6 * 60_000;
    wallSetAt = performance.now();
    a.clock.setWallMs(fixtureNow());
    b.clock.setWallMs(fixtureNow());
    await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");
    scanCatDiary(a.host);
    const firstDiary = await until(() => a.call("/v2/cat-diary", "GET", undefined, alice), ({ body }) => body.entries.length === 1);
    expect(firstDiary.body.entries[0]).toMatchObject({ origin: "daily", local_day: diaryDay });
    expect(firstDiary.body.entries[0].text).toContain("池塘边");
    expect(firstDiary.body.entries[0].text).toContain("叫我阿甲");
    expect(firstDiary.body.entries[0].text).not.toContain("倒水");
    const replicaDiary = await until(() => b.call("/v2/cat-diary", "GET", undefined, bob), ({ body }) => body.entries.length === 1);
    expect(replicaDiary.body.entries).toEqual(firstDiary.body.entries);
    expect(calls).toEqual({ a: 1, b: 0 });

    a.clock.advance(31_000);
    const expired = await wa("state", "PUT", { ...shared, snapshot: { ...arrived, state_version: 2 }, base_revision: synced.body.world.revision });
    expect(expired).toMatchObject({ status: 409, body: { error: { code: "publication_lease_pending" } } });
    a.clock.setWallMs(fixtureNow());
    const handoff = crypto.randomUUID();
    await until(() => a.call(`/host/peers/${b.host.hostId}/lease`, "POST", {
      request_id: handoff, expected_epoch: 1,
    }), ({ status }) => status === 200);
    await until(() => b.call("/host/publication-lease"), ({ body }) => body.status === "ready" && body.epoch === 2);
    expect((await wa("state", "PUT", shared)).body.error.code).toBe("not_publisher");
    scanCatDiary(b.host);
    expect((await b.call("/v2/cat-diary", "GET", undefined, bob)).body.entries).toEqual(firstDiary.body.entries);
    expect(calls).toEqual({ a: 1, b: 0 });
    expect((await soul(a, alice, { expected_version: 4, source: ref, change: { kind: "advice", value: "ask_first" } })).body.error.code)
      .toBe("not_publisher");
    const group = conversations.find((row: { kind: string }) => row.kind === "group").id;
    const bobSource = (await b.call(`/v2/conversations/${group}/messages`, "POST", {
      client_message_id: crypto.randomUUID(), text: "和我相处自然一点，叫我阿乙。",
    }, bob)).body.message.id;
    expect((await soul(b, bob, { expected_version: 4, source: ref,
      change: { kind: "nickname", value: "阿甲" } })).body.error.code).toBe("source_unavailable");
    expect((await soul(b, bob, { expected_version: 4, source: { message_id: bobSource, revision: 1 },
      change: { kind: "relationship", value: "familiar" } })).body.soul.relationship.kind).toBe("familiar");
    expect((await a.call(`/v2/conversations/${direct}/messages/${source}/withdraw`, "POST", {
      request_id: crypto.randomUUID(), expected_revision: 1,
    }, alice)).status).toBe(200);
    expect((await soul(a, alice)).body.soul).toMatchObject({
      habits: {}, relationship: { nickname: null }, runtime: { energy: "baseline" },
    });
    await until(() => soul(b, bob), ({ body }) => !body.soul?.habits.response_length);
    expect((await soul(b, bob)).body.soul.relationship.kind).toBe("familiar");
    const revokedDiary = await until(() => b.call("/v2/cat-diary", "GET", undefined, bob),
      ({ body }) => !body.entries[0].text.includes("叫我阿甲"));
    expect(revokedDiary.body.entries[0]).toMatchObject({
      id: firstDiary.body.entries[0].id, text: expect.stringContaining("池塘边"),
    });
    expect(calls).toEqual({ a: 1, b: 0 });
    const remoteAlice = createDevice(b.host.store.db, b.clock, { memberId: first.id, hostId: b.host.hostId, name: "甲的第二部手机" });
    const wa2 = world(b, remoteAlice.token);
    const sa2 = await session(wa2);
    expect((await wa2("actions", "POST", { ...move, ...sa2 })).body.id).toBe(action);
    const replacement = await session(wa2);
    expect(replacement.generation).not.toBe(sa2.generation);
    expect((await b.request(streamPath(sa2), "GET", undefined, remoteAlice.token)).status).toBe(409);
    const profile = await wb("profile", "PUT", {
      base_revision: synced.body.world.revision, name: "团子", appearance: "orange", temperament: "curious",
      traits: { energy: 2, initiative: 1, directness: 1, closeness: 1 },
    });
    expect(profile).toMatchObject({ status: 200, body: {
      world: { id: current.id, profile: { temperament: "curious" }, snapshot: { current_destination_id: "pond" } },
      behavior: { idle_scale: expect.closeTo(0.45) },
    } });
    const next = await wb("state", "PUT", { ...sb, base_revision: profile.body.world.revision, snapshot: { ...arrived, state_version: 0, weather: "rain" } });
    expect(next).toMatchObject({ status: 200, body: { world: { id: current.id, snapshot: { weather: "rain" } } } });
    await until(() => wa("state"), ({ body }) => body.world?.revision === next.body.world.revision);
    const bobStream = await b.request(streamPath(sb), "GET", undefined, bob);
    const bobReader = bobStream.body!.getReader();
    await bobReader.read();
    expect((await wb("state", "PUT", {
      ...sb, base_revision: next.body.world.revision, snapshot: { ...arrived, state_version: 0, weather: "rain" },
    })).status).toBe(200);
    const awaitingRestart = await wb("actions", "POST", { ...move, ...sb, request_id: crypto.randomUUID() });
    expect(awaitingRestart.body.status).toBe("requested");
    await bobReader.cancel();
    const reuse = { peerPort: b.gateway.peerPort!, lanPort: b.gateway.lanPort! };
    await b.host.stop();
    const restartedNode = await launch("b", reuse);
    const restarted = world(restartedNode, bob);
    expect((await restarted("state")).body).toMatchObject({ execution_available: false, world: { id: current.id, snapshot: { weather: "rain" } } });
    expect((await restarted("state", "PUT", { ...sb, base_revision: next.body.world.revision, snapshot: arrived })).body.error.code).toBe("session_replaced");
    expect((await restarted(`actions/${awaitingRestart.body.id}`)).body).toMatchObject({
      status: "interrupted", reason: "session_replaced",
    });
    wall += 86_400_000;
    wallSetAt = performance.now();
    a.clock.setWallMs(fixtureNow());
    restartedNode.clock.setWallMs(fixtureNow());
    await until(() => restartedNode.call("/host/publication-lease"), ({ body }) => body.status === "ready" && body.epoch === 2);
    scanCatDiary(restartedNode.host);
    const secondDiary = await until(() => restartedNode.call("/v2/cat-diary", "GET", undefined, bob),
      ({ body }) => body.entries.length === 2);
    expect(secondDiary.body.entries[0]).toEqual(revokedDiary.body.entries[0]);
    expect(secondDiary.body.entries[1].local_day).not.toBe(diaryDay);
    expect(calls).toEqual({ a: 1, b: 1 });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(stops.reverse().map((stop) => stop()));
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
