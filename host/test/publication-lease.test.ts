import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManualClock, SystemClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import type { PeerDescriptor } from "../src/peer/protocol.ts";
import { PublicationWindow } from "../src/publication/window.ts";
import { applyReplicaRecord, getPeerCursor, rotateReplicationGeneration } from "../src/store/replication.ts";
import { createPeerSyncService } from "../src/replication/peer-service.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { createHostComponents } from "../src/runtime/components.ts";
import { TurnRunner } from "../src/turns/index.ts";
import type { Replier } from "../src/turns/types.ts";
import { issueTestDevice } from "./identity-fixture.ts";

class OffsetClock extends SystemClock {
  offset = 0;
  override wallMs() { return super.wallMs() + this.offset; }
}

function heldModel() {
  let resume!: (text: string) => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<string>((resolve) => { resume = resolve; });
  const replier: Replier = {
    async *reply({ trigger }) {
      const text = trigger.text.replace(/^团子，/u, "");
      if (text === "终态之前") yield "已经发出的首字";
      if (text === "首字之前" || text === "终态之前") {
        enter();
        yield await held;
      } else {
        yield "团子回应";
      }
    },
  };
  return { entered, resume, replier };
}

async function eventually<T>(read: () => T | Promise<T>, ready: (result: T) => boolean): Promise<T> {
  const deadline = performance.now() + 20_000;
  let last: T;
  do {
    last = await read();
    if (ready(last)) return last;
    await Bun.sleep(50);
  } while (performance.now() < deadline);
  throw new Error(`等待超时：${JSON.stringify(last)}`);
}

async function launch(dir: string, label: string, model = heldModel(), peerPort = 0, production = false) {
  const clock = new OffsetClock(label);
  const options = { peerPort, peerHostname: "127.0.0.1" };
  const runtime = production ? createHostComponents(options) : undefined;
  const gateway = runtime?.gateway ?? new Gateway(options);
  const ctx = await startHost({ dataDir: dir, port: 0, lanHttpsPort: 0, clock, replier: model.replier },
    runtime?.components ?? [gateway, new TurnRunner({ pollMs: 25 })]);

  const token = readFileSync(join(dir, "host-admin.token"), "utf8");
  return { ctx, clock, gateway, token, model, port: gateway.port!, hostId: ctx.hostId };
}
type Running = Awaited<ReturnType<typeof launch>>;
type Client = Pick<Running, "port" | "token" | "hostId">;

async function call(host: Client, path: string, method = "GET", body?: unknown, token = host.token) {
  const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
    method, signal: AbortSignal.timeout(6_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function ok(host: Client, path: string, method = "GET", body?: unknown, token?: string) {
  const reply = await call(host, path, method, body, token);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
}

async function identity(host: Client): Promise<PeerDescriptor> {
  const description: PeerDescriptor = await ok(host, "/host/peer-identity");
  description.address.host = "127.0.0.1";
  return description;
}

function approval(identity: PeerDescriptor) {
  return { identity, confirmed_fingerprint: identity.fingerprint };
}

const leaseStatus = (host: Client) => ok(host, "/host/publication-lease");
const ready = (host: Client, epoch: number) => eventually(() => leaseStatus(host), (state) =>
  state.epoch === epoch && state.status === "ready");

async function group(host: Client, token: string): Promise<string> {
  return (await ok(host, "/v2/conversations", "GET", undefined, token)).conversations
    .find((conversation: { kind: string }) => conversation.kind === "group")!.id;
}

function send(host: Client, groupId: string, token: string, id: string, text = id) {
  return call(host, `/v2/conversations/${groupId}/messages`, "POST", { text, client_message_id: id }, token);
}

function transfer(from: Client, to: Client, requestId: string, epoch: number) {
  return call(from, `/host/peers/${to.hostId}/lease`, "POST", { request_id: requestId, expected_epoch: epoch });
}

function groupFacts(host: Running, id: string) {
  return host.ctx.store.raw.query<{ text: string; publication_epoch: number }, [string]>(
    "SELECT text, publication_epoch FROM messages WHERE conversation_id = ? ORDER BY text",
  ).all(id);
}

function localTurns(host: Running, id: string) {
  return host.ctx.store.raw.query<{ id: string; status: string; draft_text: string }, [string]>(
    "SELECT id, status, draft_text FROM turns WHERE conversation_id = ? ORDER BY id",
  ).all(id);
}

async function statusOfTurn(host: Client, id: string, groupId: string, token: string, state: string) {
  return eventually(() => ok(host, `/v2/conversations/${groupId}/turns/${id}`, "GET", undefined, token),
    (turn) => turn.status === state);
}

test("真实双宿主仅一个发布者，封停首字及终态，补齐历史并从丢失交接回执恢复", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r66-handoff-"));
  const hosts: Running[] = [];
  try {
    let a = await launch(join(root, "a"), "a");
    const b = await launch(join(root, "b"), "b");
    hosts.push(a, b);
    const alice = issueTestDevice(a.ctx, "甲");
    const id = await group(a, alice.token);
    const solo = await send(a, id, alice.token, "独立宿主", "团子，独立宿主");
    expect(solo.status).toBe(201);
    await statusOfTurn(a, solo.body.turn.id, id, alice.token, "completed");
    const [first, joining] = await Promise.all([identity(a), identity(b)]);
    await ok(a, `/host/peers/${b.ctx.hostId}`, "PUT", { ...approval(joining), allow_join: true });
    await ok(b, "/host/peers/connect", "POST", { ...approval(first), join_household: true });
    await ready(a, 1);
    await eventually(() => groupFacts(b, id), (rows) => rows.length === 2);
    const bob = issueTestDevice(b.ctx, "乙");
    expect(await group(b, bob.token)).toBe(id);
    await eventually(() => ok(a, "/v2/members", "GET", undefined, alice.token), (reply) => reply.members.length === 2);
    const before = await Promise.all([
      send(a, id, alice.token, "并发甲", "团子，并发甲"),
      send(b, id, bob.token, "并发乙"),
    ]);
    expect(before.map(({ status }) => status)).toEqual([201, 409]);
    expect(localTurns(b, id)).toEqual([]);
    await statusOfTurn(a, before[0]!.body.turn.id, id, alice.token, "completed");
    await eventually(() => groupFacts(b, id), (rows) => rows.length === 4);

    expect((await call(a, "/peer/lease", "POST", {}, alice.token)).status).toBe(404);
    await ok(b, `/host/peers/${a.ctx.hostId}/sync`, "PUT", { paused: true });
    const pending = await send(a, id, alice.token, "首字之前", "团子，首字之前");
    expect(pending.status).toBe(201);
    await a.model.entered;
    const receiptId = crypto.randomUUID();
    const [outgoing, competing] = await Promise.all([
      transfer(a, b, receiptId, 1), transfer(b, a, crypto.randomUUID(), 1),
    ]);
    expect(outgoing).toMatchObject({ status: 409, body: { error: { code: "publication_history_pending" } } });
    expect(competing).toMatchObject({ status: 409, body: { error: { code: "not_publisher" } } });
    expect(await leaseStatus(a)).toMatchObject({ pending_transfer: { request_id: receiptId, expected_epoch: 1 } });
    expect((await send(a, id, alice.token, "交接后旧方")).status).toBe(409);
    expect((await send(b, id, bob.token, "历史没齐")).status).toBe(409);
    a.model.resume("迟到首字");
    expect(await statusOfTurn(a, pending.body.turn.id, id, alice.token, "failed"))
      .toMatchObject({ error_code: "publication_changed" });
    expect(groupFacts(a, id).map(({ text }) => text)).not.toContain("迟到首字");

    const transport = a.gateway.peerTransport!;
    const original = transport.request.bind(transport);
    let loseReceipt = true;
    let frozenWire: string | undefined;
    transport.request = async (peer, operation, options) => {
      const response = await original(peer, operation, options);
      if (loseReceipt && operation === "lease" && response.ok
        && JSON.parse(String(options?.body)).operation === "accept") {
        loseReceipt = false;
        frozenWire = String(options?.body);
        await response.body?.cancel();
        throw new Error("mTLS 接收方提交后断开回执");
      }
      return response;
    };
    await ok(b, `/host/peers/${a.ctx.hostId}/sync`, "PUT", { paused: false });
    await eventually(() => groupFacts(b, id), (rows) => rows.length === 5);
    expect(await transfer(a, b, receiptId, 1)).toMatchObject({ status: 502 });
    await ready(b, 2);
    const oldPeerPort = a.gateway.peerPort!;
    await a.ctx.stop();
    a = await launch(join(root, "a"), "a", heldModel(), oldPeerPort);
    hosts.push(a);
    const ack = await transfer(a, b, receiptId, 1);
    expect(ack).toMatchObject({ status: 200, body: { receipt: { request_id: receiptId, epoch: 2 } } });
    expect(await transfer(a, b, receiptId, 1)).toEqual(ack);
    expect((await transfer(a, b, crypto.randomUUID(), 1)).status).toBe(409);

    const partial = await send(b, id, bob.token, "终态之前", "团子，终态之前");
    expect(partial.status).toBe(201);
    await b.model.entered;
    expect(localTurns(b, id)).toMatchObject([{ status: "generating", draft_text: "已经发出的首字" }]);
    await eventually(() => groupFacts(a, id), (rows) => rows.length === 6);
    const counter = await transfer(b, a, crypto.randomUUID(), 2);
    expect(counter).toMatchObject({ status: 200, body: { receipt: { epoch: 3 } } });
    await ready(a, 3);
    b.model.resume("迟到终态");
    expect(await statusOfTurn(b, partial.body.turn.id, id, bob.token, "failed"))
      .toMatchObject({ error_code: "publication_changed" });
    expect(groupFacts(b, id)).toHaveLength(6);
    const newest = await send(a, id, alice.token, "新一代", "团子，新一代");
    expect(newest.status).toBe(201);
    await statusOfTurn(a, newest.body.turn.id, id, alice.token, "completed");
    await eventually(() => groupFacts(b, id), (rows) => rows.length === 8);
    expect(groupFacts(b, id)).toEqual(groupFacts(a, id));
    expect(localTurns(b, id)).toHaveLength(1);
    expect(groupFacts(a, id).map((row) => row.publication_epoch).sort()).toEqual([1, 1, 1, 1, 1, 2, 3, 3]);

    const oldProcess = await a.gateway.peerTransport!.request(b.hostId, "lease", {
      headers: { "content-type": "application/json" }, body: frozenWire,
    });
    expect(await oldProcess.json()).toEqual(ack.body);
    expect(await leaseStatus(b)).toMatchObject({ epoch: 3, status: "remote" });
    expect((await send(b, id, bob.token, "回放旧交接后")).status).toBe(409);

    const replayWakes: string[] = [];
    const unsubscribe = b.ctx.bus.subscribe("chat:event", ({ streamId }) => { replayWakes.push(streamId); });
    const recovered = rotateReplicationGeneration(a.ctx.store.db, a.hostId);
    try {
      await eventually(() => getPeerCursor(b.ctx.store.db, a.hostId), (cursor) => cursor?.generation === recovered.generation);
      expect(replayWakes).toEqual([]);
    } finally {
      unsubscribe();
    }
    expect(groupFacts(b, id)).toEqual(groupFacts(a, id));
    expect(localTurns(b, id)).toHaveLength(1);
    const source = { sourceHostId: a.hostId, householdId: a.ctx.householdId, generation: recovered.generation };
    const snapshot = createPeerSyncService(a.ctx.store.db, a.hostId);
    const manifest = snapshot.openSnapshot();
    const records = snapshot.readSnapshotPage({ snapshotId: manifest.data.snapshotId, offset: 0, limit: 500 }).data.records;
    const historical = records.find((record) => record.kind === "message"
      && "publicationEpoch" in record.row && record.row.publicationEpoch === 1)!;
    const replay = (row: typeof historical.row) => b.ctx.store.db.transaction((tx) =>
      applyReplicaRecord(tx, source, { kind: "message", row }), { behavior: "immediate" });
    expect(replay(historical.row)).toBe(false);
    expect(() => replay({
      ...historical.row, id: uuidv7(a.ctx.clock), clientMessageId: crypto.randomUUID(),
    } as typeof historical.row)).toThrow(expect.objectContaining({ code: "unauthorized_writer" }));
    expect(() => replay({ ...historical.row, text: "篡改旧代" } as typeof historical.row))
      .toThrow(expect.objectContaining({ code: "unauthorized_writer" }));
    expect(groupFacts(b, id)).toHaveLength(8);
  } finally {
    await Promise.all(hosts.map((host) => host.ctx.stop()));
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);

test("真实双向分区期间快慢墙钟和重启均不能取得发布权，单聊继续", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r66-partition-"));
  const hosts: Running[] = [];
  try {
    const a = await launch(join(root, "a"), "a");
    let b = await launch(join(root, "b"), "b");
    hosts.push(a, b);
    const alice = issueTestDevice(a.ctx, "甲");
    const id = await group(a, alice.token);
    const [first, joining] = await Promise.all([identity(a), identity(b)]);
    await ok(a, `/host/peers/${b.ctx.hostId}`, "PUT", { ...approval(joining), allow_join: true });
    await ok(b, "/host/peers/connect", "POST", { ...approval(first), join_household: true });
    await ready(a, 1);
    await eventually(() => ok(b, "/host/peers"), (value) => value.peers[0]?.sync.status === "caught_up");
    const bob = issueTestDevice(b.ctx, "乙");
    const live = await Promise.all([identity(a), identity(b)]);
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const deadPort = reserved.port!;
    await reserved.stop(true);
    await Promise.all([
      ok(a, `/host/peers/${b.ctx.hostId}`, "PUT", approval({ ...live[1], address: { host: "127.0.0.1", port: deadPort } })),
      ok(b, `/host/peers/${a.ctx.hostId}`, "PUT", approval({ ...live[0], address: { host: "127.0.0.1", port: deadPort } })),
    ]);
    a.clock.offset = 90_000;
    b.clock.offset = -90_000;
    const both = await Promise.all([send(a, id, alice.token, "快钟"), send(b, id, bob.token, "慢钟")]);
    expect(both.map(({ status }) => status)).toEqual([409, 409]);
    expect(both[0]!.body.error.code).toBe("publication_lease_pending");
    expect(groupFacts(a, id)).toEqual([]);
    expect(groupFacts(b, id)).toEqual([]);
    const direct = (await ok(b, "/v2/conversations", "GET", undefined, bob.token)).conversations
      .find((conversation: { kind: string }) => conversation.kind === "direct").id;
    expect((await send(b, direct, bob.token, "单聊仍运行")).status).toBe(201);

    const bPeerPort = b.gateway.peerPort!;
    await b.ctx.stop();
    b = await launch(join(root, "b"), "b", heldModel(), bPeerPort);
    hosts.push(b);
    expect((await send(b, id, bob.token, "重启抢占")).status).toBe(409);
    const transport = a.gateway.peerTransport!;
    const exchange = transport.request.bind(transport);
    let renewed: { wire: string; receipt: unknown } | undefined;
    transport.request = async (peer, operation, options) => {
      const response = await exchange(peer, operation, options);
      if (operation === "lease" && response.ok) {
        renewed = { wire: String(options?.body), receipt: await response.clone().json() };
      }
      return response;
    };
    await Promise.all([ok(a, `/host/peers/${b.ctx.hostId}`, "PUT", approval(live[1])),
      ok(b, `/host/peers/${a.ctx.hostId}`, "PUT", approval(live[0]))]);
    await ready(a, 1);
    const issued = renewed!;
    const renew = (wire: string) => exchange(b.hostId, "lease", {
      headers: { "content-type": "application/json" }, body: wire,
    });
    expect(await (await renew(issued.wire)).json()).toEqual(issued.receipt);
    const changed = JSON.parse(issued.wire);
    changed.renewal.request_id = crypto.randomUUID();
    expect(await (await renew(JSON.stringify(changed))).json()).toEqual({ error: { code: "publication_request_conflict" } });
    await ok(a, `/host/peers/${b.ctx.hostId}`, "DELETE");
    expect((await send(a, id, alice.token, "撤销后独占")).status).toBe(409);
    expect((await send(b, id, bob.token, "对端撤销后抢占")).status).toBe(409);
    expect(localTurns(a, id)).toEqual([]);
    expect(localTurns(b, id)).toEqual([]);
  } finally {
    await Promise.all(hosts.map((host) => host.ctx.stop()));
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000);


test("本机窗口从发请求起计，到期、墙钟回退及挂起均收回且不能复用", () => {
  const clock = new ManualClock("lease-clock", 100_000);
  let monotonic = 300;
  const window = new PublicationWindow(clock, () => monotonic);
  const fence = { householdId: "home", holderHostId: "a", grantId: "grant", epoch: 2 };
  const start = window.start();
  clock.advance(2_000);
  monotonic += 2_000;
  window.install(fence, "peer", start);
  clock.advance(27_999);
  monotonic += 27_999;
  expect(window.valid(fence, "peer")).toBe(true);
  clock.advance(1);
  monotonic += 1;
  expect(window.valid(fence, "peer")).toBe(false);

  window.install(fence, "peer", window.start());
  clock.advance(2_001);
  expect(window.valid(fence, "peer")).toBe(false);
  clock.advance(-2_001);
  expect(window.valid(fence, "peer")).toBe(false);

  window.install(fence, "peer", window.start());
  clock.advance(-1);
  expect(window.valid(fence, "peer")).toBe(false);
});

test("真实 Bun 宿主封停后被 SIGKILL，重启继续原交接且旧宿主不能发布", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r66-crash-"));
  const peerListeners = Array.from({ length: 2 }, () => Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch: () => new Response(),
  }));
  const [port, peerPort] = peerListeners.map((listener) => listener.port!);
  await Promise.all(peerListeners.map((listener) => listener.stop(true)));
  const dir = join(root, "a");
  const children: Bun.Subprocess[] = [];
  let b: Running | undefined;
  try {
    async function child() {
      const process = Bun.spawn([globalThis.process.execPath, fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
        env: {
          CATTT_DATA_DIR: dir, CATTT_PORT: String(port), CATTT_PEER_HTTPS_PORT: String(peerPort),
          CATTT_LAN_HTTPS_PORT: "0", MODEL_PROVIDER: "mock", MOCK_DELAY_MS: "0",
        },
        stdout: "ignore", stderr: "inherit",
      });
      children.push(process);
      const health = await eventually(async () => {
        if (process.exitCode !== null) throw new Error(`子宿主退出：${process.exitCode}`);
        return fetch(`http://127.0.0.1:${port}/v2/healthz`, { signal: AbortSignal.timeout(500) })
          .then((response) => response.json()).catch(() => null);
      }, (value) => value?.ok);
      return { process, token: readFileSync(join(dir, "host-admin.token"), "utf8"), port: port!, hostId: health.host_id };
    }

    const a = await child();
    b = await launch(join(root, "b"), "b", heldModel(), 0, true);
    const [first, joining] = await Promise.all([identity(a), identity(b)]);
    await ok(a, `/host/peers/${b.hostId}`, "PUT", { ...approval(joining), allow_join: true });
    await ok(b, "/host/peers/connect", "POST", { ...approval(first), join_household: true });
    const { member: alice } = await ok(a, "/host/members", "POST", { display_name: "甲" });
    const { code } = await ok(a, "/host/pairing-codes", "POST", { member_id: alice.id });
    const { device_token: token } = await ok(a, "/v2/pair", "POST", { code, device_name: "甲手机" });
    const id = await group(a, token);
    await ready(a, 1);
    await eventually(() => ok(b!, "/host/peers"), (value) => value.peers[0]?.sync.status === "caught_up"
      && value.peers[0]?.sync.cursor?.seq >= 6);
    const bob = issueTestDevice(b.ctx, "乙");
    await ok(b, `/host/peers/${a.hostId}/sync`, "PUT", { paused: true });
    const writing = await send(a, id, token, "崩溃前的历史", "团子，崩溃前的历史");
    expect(writing.status).toBe(201);
    await statusOfTurn(a, writing.body.turn.id, id, token, "completed");
    const requestId = crypto.randomUUID();
    expect(await transfer(a, b, requestId, 1)).toMatchObject({ status: 409, body: { error: { code: "publication_history_pending" } } });
    a.process.kill("SIGKILL");
    await a.process.exited;
    expect(a.process.signalCode).toBe("SIGKILL");
    const duringCrash = await send(b, id, bob.token, "强杀期间");
    expect(duringCrash).toMatchObject({ status: 202, body: { status: "pending" } });
    const restarted = await child();
    expect(await leaseStatus(restarted)).toMatchObject({ epoch: 2, status: "remote", pending_transfer: { request_id: requestId } });
    const afterCrash = await send(restarted, id, token, "旧宿主进程复活");
    expect(afterCrash).toMatchObject({ status: 202, body: { status: "pending" } });
    expect(await call(restarted, afterCrash.body.receipt_url, "GET", undefined, token)).toMatchObject({ status: 202 });
    await ok(b, `/host/peers/${a.hostId}/sync`, "PUT", { paused: false });
    await eventually(() => groupFacts(b!, id), (rows) => rows.length === 2);
    expect((await transfer(restarted, b, requestId, 1)).status).toBe(200);
    await ready(b, 2);
    const receiver = b;
    expect(await eventually(() => call(receiver, duringCrash.body.receipt_url, "GET", undefined, bob.token),
      ({ status }) => status === 200)).toMatchObject({ body: { status: "accepted", publisher_host_id: b.hostId } });
    expect(await eventually(() => call(restarted, afterCrash.body.receipt_url, "GET", undefined, token),
      ({ status }) => status === 200)).toMatchObject({ body: { status: "accepted", publisher_host_id: b.hostId, turn: null } });
    expect((await send(b, id, bob.token, "新宿主继续")).status).toBe(201);
  } finally {
    for (const process of children) {
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
    }
    await Promise.all([...children.map((process) => process.exited), b?.ctx.stop()]);
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000);
