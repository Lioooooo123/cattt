import "reflect-metadata";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { encodeEnvelope } from "../src/peer-behavior/protocol.ts";
import type { PeerBehaviorEnvelope } from "../src/peer-behavior/protocol.ts";
import type { PeerDescriptor } from "../src/peer/protocol.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { createBoundary } from "../src/store/knowledge.ts";
import { rotateReplicationGeneration } from "../src/store/replication.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const noon = Date.parse("2026-11-22T12:00:00Z");

async function launch(dir: string, initialWallMs = Date.now()) {
  const clock = new ManualClock(crypto.randomUUID(), initialWallMs);
  const gateway = new Gateway({ peerPort: 0, peerHostname: "127.0.0.1" });
  const host = await startConfiguredHost({
    dataDir: dir, port: 0, lanHttpsPort: 0, clock,
    replier: { async *reply() { yield "收到。"; } },
    onError(error, source) { if (source === "gateway:http" || source === "report-router") console.error(source, error); },
  }, gateway, { pollIntervalMs: 20 });
  return Object.assign(host, { dir, clock, gateway });
}

type Running = Awaited<ReturnType<typeof launch>>;

async function http(run: Running, path: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(`http://127.0.0.1:${run.gateway.port}${path}`, {
    method, signal: AbortSignal.timeout(5_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token ?? readFileSync(join(run.dir, "host-admin.token"), "utf8")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function ok(run: Running, path: string, method = "GET", body?: unknown, token?: string) {
  const result = await http(run, path, method, body, token);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function eventually<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, ms = 20_000) {
  const until = performance.now() + ms;
  let current: T;
  do {
    current = await read();
    if (ready(current)) return current;
    await Bun.sleep(40);
  } while (performance.now() < until);
  throw new Error(`等待状态超时：${JSON.stringify(current)}`);
}

async function direct(run: Running, token: string): Promise<string> {
  const listing = await ok(run, "/v2/conversations", "GET", undefined, token);
  return listing.conversations.find((row: { kind: string }) => row.kind === "direct").id;
}

async function say(run: Running, token: string, conversation: string, text: string): Promise<string> {
  const path = `/v2/conversations/${conversation}`;
  const result = await http(run, `${path}/messages`, "POST", {
    client_message_id: crypto.randomUUID(), text,
  }, token);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const stream = await fetch(`http://127.0.0.1:${run.gateway.port}${result.body.turn.stream_url}`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
  });
  expect(await stream.text()).toContain('"status":"completed"');
  return result.body.message.id;
}

function relay(run: Running, token: string, source: string, fields = {}) {
  return http(run, "/v2/relays", "POST", { source_message_id: source, source_revision: 1, ...fields }, token);
}

async function withdraw(run: Running, token: string, source: string) {
  return ok(run, `/v2/relays/sources/${source}/withdraw`, "POST", { source_revision: 1 }, token);
}

async function paired(a: Running, b: Running) {
  const first: PeerDescriptor = await ok(a, "/host/peer-identity");
  const second: PeerDescriptor = await ok(b, "/host/peer-identity");
  await ok(a, `/host/peers/${b.hostId}`, "PUT", {
    identity: second, confirmed_fingerprint: second.fingerprint, allow_join: true,
  });
  await ok(b, "/host/peers/connect", "POST", {
    identity: first, confirmed_fingerprint: first.fingerprint, join_household: true,
  });
}

async function sync(target: Running, source: Running, paused: boolean) {
  await ok(target, `/host/peers/${source.hostId}/sync`, "PUT", { paused });
}

async function caughtUp(target: Running, source: Running) {
  const head = source.store.raw.query("SELECT last_seq AS seq, generation FROM replication_state WHERE source_host_id = ?")
    .get(source.hostId) as { seq: number; generation: string };
  return eventually(async () => (await ok(target, "/host/peers")).peers
    .find((row: { host_id: string }) => row.host_id === source.hostId)?.sync,
  (state) => state?.cursor?.generation === head.generation && state.cursor.seq >= head.seq);
}

function deliveries(run: Running) {
  return run.store.raw.query<{ id: string; status: string; envelope: string; receipt: string | null }, []>(
    "SELECT id, status, envelope, receipt FROM peer_outbox ORDER BY created_at, id",
  ).all();
}

function sent(run: Running, conversation: string) {
  return run.store.raw.query<{ text: string; origin_host_id: string }, [string]>(
    "SELECT text, origin_host_id FROM messages WHERE conversation_id = ? AND author_member_id IS NULL AND turn_id IS NULL ORDER BY hlc, id",
  ).all(conversation);
}

test("同一 Router 发到伴侣单聊，严格许可、拒绝指定不转告、本地额度、紧急及日界", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-relay-local-"));
  let run = await launch(root);
  try {
    run.clock.setWallMs(noon);
    const a = issueTestDevice(run, "阿甲");
    const b = issueTestDevice(run, "阿乙");
    const aChat = await direct(run, a.token);
    const bChat = await direct(run, b.token);
    const source = (text: string) => say(run, a.token, aChat, text);

    const first = await source("帮我转告：晚上一起吃饭");
    expect((await relay(run, b.token, first)).status).toBe(404);
    expect((await relay(run, a.token, first, { urgent: true })).status).toBe(400);
    const requests = await Promise.all(Array.from({ length: 5 }, () => relay(run, a.token, first)));
    expect(requests.every((request) => request.status === 200)).toBe(true);
    expect(new Set(requests.map((request) => request.body.id)).size).toBe(1);
    await eventually(() => sent(run, bChat), (messages) => messages.length === 1);
    expect(sent(run, bChat)).toEqual([{ text: "阿甲托我转告你：晚上一起吃饭", origin_host_id: run.hostId }]);
    expect(sent(run, aChat)).toEqual([]);

    for (const text of ["晚上可能一起吃饭", "帮我紧急转告：改签。别告诉 TA", "帮我转告：谁也不要告诉"]) {
      expect(await relay(run, a.token, await source(text))).toMatchObject({
        status: 409, body: { error: { code: "relay_not_allowed" } },
      });
    }
    for (const text of ["记得带伞", "先去取票"]) {
      expect((await relay(run, a.token, await source(`帮我转告：${text}`))).status).toBe(200);
    }
    const boundarySource = await say(run, b.token, bChat, "别跟我提面试");
    expect(createBoundary(run.store.db, run.clock, {
      householdId: run.householdId, sourceMemberId: b.memberId, subjectMemberId: b.memberId,
      sourceMessageId: boundarySource, sourceRevision: 1, description: "别跟我提面试",
    })).toBeDefined();
    expect((await relay(run, a.token, await source("帮我紧急转告：面试改期了"))).status).toBe(409);
    const fourth = await source("帮我转告：带上钥匙");
    expect(await relay(run, a.token, fourth)).toMatchObject({
      status: 409, body: { error: { code: "relay_daily_limit" } },
    });
    expect((await relay(run, a.token, await source("帮我紧急转告：请改走北门"))).status).toBe(200);
    await eventually(() => sent(run, bChat), (messages) => messages.length === 4);

    await ok(run, "/v2/me/proactive", "PATCH", { allow_proactive: false, time_zone: "Asia/Shanghai" }, a.token);
    run.clock.setWallMs(Date.parse("2026-11-22T16:00:00Z"));
    expect((await relay(run, a.token, fourth)).status).toBe(200);
    expect((await relay(run, a.token, first)).body.id).toBe(requests[0]!.body.id);
    expect(sent(run, bChat)).toHaveLength(4);
    await run.stop();
    run = await launch(root, Date.parse("2026-11-22T16:00:00Z"));
    expect((await relay(run, a.token, fourth)).body).toMatchObject({
      state: "pending", source_day: "2026-11-23", source_time_zone: "Asia/Shanghai",
    });
    run.clock.setWallMs(Date.parse("2026-11-23T01:00:00Z"));
    await eventually(() => sent(run, bChat), (messages) => messages.length === 5);
  } finally {
    await run.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("两份 SQLite 和 mTLS：缺来源等待、真实收据重放、静默撤回、旧世代失效", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-relay-peer-"));
  const a = await launch(join(root, "a"));
  const b = await launch(join(root, "b"));
  try {
    await paired(a, b);
    const first = issueTestDevice(a, "远端阿甲");
    await caughtUp(b, a);
    await caughtUp(a, b);
    const second = issueTestDevice(b, "远端阿乙");
    await caughtUp(a, b);
    const aChat = await direct(a, first.token);
    const bChat = await direct(b, second.token);
    a.clock.setWallMs(noon);
    b.clock.setWallMs(noon);
    const transport = a.gateway.peerTransport!;
    const sendEnvelope = (envelope: PeerBehaviorEnvelope) => transport.request(b.hostId, "inbox", {
      body: encodeEnvelope(envelope).body, headers: { "content-type": "application/json" },
    });

    await sync(b, a, true);
    const source = await say(a, first.token, aChat, "帮我转告：车到站了");
    expect((await relay(a, first.token, source)).body).toMatchObject({ state: "queued", peer_receipt: null });
    const staged = deliveries(a)[0]!;
    const envelope = JSON.parse(staged.envelope) as PeerBehaviorEnvelope;
    expect(await sendEnvelope(envelope).then(async (response) => [response.status, await response.json()]))
      .toEqual([409, { error: { code: "peer_source_pending" } }]);
    expect(deliveries(a)[0]).toMatchObject({ status: "pending", receipt: null });
    expect(sent(b, bChat)).toEqual([]);

    await sync(b, a, false);
    await caughtUp(b, a);
    const forged = { ...envelope, idempotency_key: "forged" };
    expect((await sendEnvelope(forged)).status).toBe(422);
    // A direct request here drops the first successful response from the outbox's perspective.
    const accepted = await sendEnvelope(envelope);
    expect(accepted.status).toBe(200);
    const receipt = await accepted.json();
    expect(await sendEnvelope(envelope).then((response) => response.json())).toEqual(receipt);
    expect((await sendEnvelope({ ...envelope, payload: { ...envelope.payload, source_seq: 1 } })).status).toBe(409);
    a.clock.advance(61_000);
    await eventually(() => deliveries(a)[0], (row) => row?.status === "delivered");
    expect(JSON.parse(deliveries(a)[0]!.receipt!)).toEqual(receipt);
    expect((await relay(a, first.token, source)).body).toMatchObject({ state: "accepted", peer_receipt: receipt });
    await eventually(() => sent(b, bChat), (messages) => messages.length === 1);
    expect(sent(b, bChat)).toEqual([{ text: "远端阿甲托我转告你：车到站了", origin_host_id: b.hostId }]);
    expect(sent(a, aChat)).toEqual([]);

    b.clock.setWallMs(Date.parse("2026-11-22T15:00:00Z"));
    const stopped = await say(a, first.token, aChat, "帮我紧急转告：请在东门见");
    expect((await relay(a, first.token, stopped)).status).toBe(200);
    await caughtUp(b, a);
    a.clock.advance(61_000);
    await eventually(() => deliveries(a)[1], (row) => row?.status === "delivered");
    await withdraw(a, first.token, stopped);
    await caughtUp(b, a);
    b.clock.setWallMs(Date.parse("2026-11-23T01:00:00Z"));
    await eventually(() => b.store.raw.query("SELECT reason FROM relay_publications WHERE state = 'dropped'")
      .all(), (rows) => rows.length === 1);
    expect(b.store.raw.query("SELECT reason FROM relay_publications WHERE state = 'dropped'").get())
      .toEqual({ reason: "source_unavailable" });
    b.clock.setWallMs(Date.parse("2026-11-22T15:00:00Z"));

    const oldGeneration = await say(a, first.token, aChat, "帮我转告：旧世代的消息");
    expect((await relay(a, first.token, oldGeneration)).status).toBe(200);
    await caughtUp(b, a);
    a.clock.advance(61_000);
    await eventually(() => deliveries(a)[2], (row) => row?.status === "delivered");
    const historical = await say(a, first.token, aChat, "帮我转告：曾经的意向");
    rotateReplicationGeneration(a.store.db, a.hostId);
    expect(await relay(a, first.token, historical)).toMatchObject({
      status: 409, body: { error: { code: "relay_not_allowed" } },
    });
    await caughtUp(b, a);
    b.clock.setWallMs(Date.parse("2026-11-23T01:00:00Z"));
    await eventually(() => b.store.raw.query("SELECT count(*) AS n FROM relay_publications WHERE state = 'dropped'")
      .get(), (value) => (value as { n: number }).n === 2);
    expect(b.store.raw.query("SELECT reason FROM relay_publications WHERE state = 'dropped' ORDER BY reason").all())
      .toEqual([{ reason: "source_generation_changed" }, { reason: "source_unavailable" }]);
    expect(sent(b, bChat)).toHaveLength(1);
    expect((await relay(a, first.token, stopped)).body.state).toBe("accepted");
  } finally {
    await Promise.all([a.stop(), b.stop()]);
    rmSync(root, { recursive: true, force: true });
  }
}, 95_000);
