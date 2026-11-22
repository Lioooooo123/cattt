import "reflect-metadata";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { BlobStorage } from "../src/files/blobs.ts";
import { MAX_CHUNK_BYTES } from "../src/files/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { JobRunner } from "../src/jobs/index.ts";
import { registerMemoryActions } from "../src/member-resources/memory-actions.ts";
import { PeerBehaviorChannel } from "../src/peer-behavior/index.ts";
import type { PeerTransport } from "../src/peer/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { peerBlobHandler } from "../src/replication/peer-blobs.ts";
import { typedChangesHandler, typedPeerTransport } from "../src/replication/peer-http.ts";
import { createPeerSyncService } from "../src/replication/peer-service.ts";
import { readChangePage, rotateReplicationGeneration } from "../src/store/replication.ts";
import { applyReplicaSnapshot, readNativeSnapshot } from "../src/store/replication-snapshot.ts";
import { listAllowedDiaryEntries } from "../src/store/diary.ts";
import { createBoundary, getMemoryRecord, listAvailableBoundaries, listAvailableMemories, listMemoryBlocks, saveMemory } from "../src/store/knowledge.ts";
import { readKnowledgeEvidenceText } from "../src/store/knowledge-use.ts";
import { finishTurn } from "../src/store/turns.ts";
import { listModelVisibleMessages } from "../src/store/model-visible-messages.ts";
import { applyChangePage, getPeerCursor } from "../src/store/replication.ts";
import { sendMessage } from "../src/store/conversations.ts";
import { readVerifiedFileDescription } from "../src/store/file-descriptions.ts";
import { createDevice, removeMember, resolveDeviceToken } from "../src/store/identity.ts";
import { openStore } from "../src/store/index.ts";
import { messages } from "../src/store/schema/conversations.ts";
import { issueTestDevice } from "./identity-fixture.ts";
import { testTurn } from "./turn-fixture.ts";
import type { HostContext } from "../src/runtime/index.ts";
import type { PeerDescriptor } from "../src/peer/protocol.ts";

type Running = { hostId: string; dir: string; port: number; stop(): Promise<void> };

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = performance.now() + 18_000;
  let last: T;
  do {
    last = await read();
    if (ready(last)) return last;
    await Bun.sleep(50);
  } while (performance.now() < end);
  throw new Error(`等待同步超时：${JSON.stringify(last)}`);
}

async function http(run: Running, path: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(`http://127.0.0.1:${run.port}${path}`, {
    method, signal: AbortSignal.timeout(12_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token ?? readFileSync(join(run.dir, "host-admin.token"), "utf8")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => { throw new Error(`测试请求失败：${method} ${path}`, { cause: error }); });
  return { status: response.status, body: await response.json() };
}

async function json(run: Running, path: string, method = "GET", body?: unknown, token?: string) {
  const result = await http(run, path, method, body, token);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

async function mobileChanges(run: Running & { gateway: Gateway }, token: string, cursor?: string, status = 200) {
  const query = cursor === undefined ? "" : "?cursor=" + encodeURIComponent(cursor);
  const response = await fetch(`https://127.0.0.1:${run.gateway.lanPort}/v2/changes${query}`, {
    signal: AbortSignal.timeout(5000),
    tls: { ca: readFileSync(join(run.dir, "tls/ca.crt"), "utf8") },
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

function approval(identity: PeerDescriptor) {
  return { identity, confirmed_fingerprint: identity.fingerprint };
}

async function pair(a: Running, b: Running) {
  const primary: PeerDescriptor = await json(a, "/host/peer-identity");
  const joining: PeerDescriptor = await json(b, "/host/peer-identity");
  primary.address.host = "127.0.0.1";
  joining.address.host = "127.0.0.1";
  const request = { ...approval(primary), join_household: true };
  expect((await http(b, "/host/peers/connect", "POST", request)).status).toBe(502);
  expect((await json(b, "/host/peer-identity")).household_id).toBe(joining.household_id);
  await json(a, `/host/peers/${b.hostId}`, "PUT", { ...approval(joining), allow_join: true });
  await json(b, "/host/peers/connect", "POST", request);
  return { primary, joining };
}

async function sync(target: Running, source: Running) {
  const { peers } = await json(target, "/host/peers");
  return peers.find((row: { host_id: string }) => row.host_id === source.hostId)?.sync;
}

function inspect<T>(run: Running, read: (db: Database) => T) {
  const db = new Database(join(run.dir, "cattt.db"), { readonly: true, strict: true });
  try { return read(db); } finally { db.close(); }
}

function nativeHead(run: Running) {
  return inspect(run, (db) => db.query<{ generation: string; seq: number }, [string]>(
    "SELECT generation, last_seq AS seq FROM replication_state WHERE source_host_id = ?",
  ).get(run.hostId)!);
}

function caughtUp(target: Running, source: Running) {
  const head = nativeHead(source);
  return eventually(() => sync(target, source), (state) =>
    state?.status === "caught_up" && state.cursor?.generation === head.generation && state.cursor?.seq === head.seq);
}

function localExecution(run: Running) {
  return inspect(run, (db) => ["turns", "chat_events", "jobs", "change_log", "device_credentials"]
    .map((table) => db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n));
}

async function send(run: Running, id: string, token: string, text: string) {
  const { status, body } = await http(run, `/v2/conversations/${id}/messages`, "POST", {
    client_message_id: text, text,
  }, token);
  expect(status, JSON.stringify(body)).toBe(201);
  const response = await fetch(`http://127.0.0.1:${run.port}${body.turn.stream_url}`, {
    signal: AbortSignal.timeout(5_000), headers: { authorization: `Bearer ${token}` },
  });
  expect(await response.text()).toContain('"status":"completed"');
}

async function reservePorts() {
  const listeners = Array.from({ length: 4 }, () => Bun.serve({
    hostname: "127.0.0.1", port: 0, fetch: () => new Response(),
  }));
  const ports = listeners.map((listener) => listener.port!);
  await Promise.all(listeners.map((listener) => listener.stop(true)));
  return ports;
}

test("两个独立编译宿主在 mTLS 上同步、断线重启、换世代、保护视图且不重触发", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r64-binary-"));
  const binary = join(root, "cattt-host");
  const stops: Array<() => Promise<void>> = [];
  try {
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const build = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", binary], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const [buildCode, output] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect(buildCode, output).toBe(0);
    const [aHttp, aPeer, bHttp, bPeer] = await reservePorts();
    const launch = async (name: string, port: number, peer: number): Promise<Running> => {
      const dir = join(root, name);
      const child = Bun.spawn([binary], {
        cwd: root,
        env: {
          CATTT_DATA_DIR: dir, CATTT_PORT: String(port), CATTT_PEER_HTTPS_PORT: String(peer),
          CATTT_LAN_HTTPS_PORT: "0", CATTT_HOST_NAME: name, MODEL_PROVIDER: "mock", MOCK_DELAY_MS: "0",
        },
        stdout: "ignore", stderr: "pipe",
      });
      const errors = new Response(child.stderr).text();
      const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          const exit = await withTimeout(child.exited, 5000).catch(() => {
            child.kill("SIGKILL");
            return child.exited;
          });
          expect(exit, await errors).toBe(0);
        }
      };
      stops.push(stop);
      const health = await eventually(async () => {
        if (child.exitCode !== null) throw new Error(await errors);
        return fetch(`http://127.0.0.1:${port}/v2/healthz`, { signal: AbortSignal.timeout(300) })
          .then((response) => response.json()).catch(() => null);
      }, (value) => !!value?.ok);
      return { hostId: health.host_id, port, dir, stop };
    };

    let a = await launch("甲", aHttp!, aPeer!);
    let b = await launch("乙", bHttp!, bPeer!);
    const blankHead = nativeHead(b);
    const { primary, joining } = await pair(a, b);
    expect(nativeHead(b).generation).not.toBe(blankHead.generation);
    expect(inspect(b, (db) => db.query("SELECT id FROM households").all())).toEqual([{ id: primary.household_id }]);
    expect(inspect(b, (db) => db.query("SELECT kind, payload FROM change_log").all())).toMatchObject([{ kind: "host" }]);
    expect(JSON.stringify(inspect(b, (db) => db.query("SELECT payload FROM change_log").all())))
      .not.toContain(joining.household_id);
    expect(await http(b, "/host/invites", "POST", { display_name: "乙" })).toMatchObject({
      status: 409, body: { error: { code: "peer_sync_pending" } },
    });

    const { member: first } = await json(a, "/host/members", "POST", { display_name: "甲" });
    const { code: pairCode } = await json(a, "/host/pairing-codes", "POST", { member_id: first.id });
    const { device_token: tokenA } = await json(a, "/v2/pair", "POST", { code: pairCode, device_name: "甲手机" });
    const directA = (await json(a, "/v2/conversations", "GET", undefined, tokenA))
      .conversations.find((c: { kind: string }) => c.kind === "direct").id;
    await caughtUp(b, a);
    await caughtUp(a, b);
    const localBefore = localExecution(b);
    await send(a, directA, tokenA, "甲的历史");
    await caughtUp(b, a);
    expect(localExecution(b)).toEqual(localBefore);
    expect(inspect(b, (db) => db.query("SELECT count(*) AS n FROM messages WHERE turn_id IS NULL").get())).toEqual({ n: 2 });

    const cancelled = await json(b, "/host/invites", "POST", { display_name: "乙" });
    expect(await http(a, "/host/invites", "POST")).toEqual({
      status: 409, body: { error: { code: "member_limit" } },
    });
    await json(b, `/host/invites/${cancelled.invite_id}`, "DELETE");
    const { code } = await json(b, "/host/invites", "POST", { display_name: "乙" });
    await json(a, `/host/peers/${b.hostId}/sync`, "PUT", { paused: true });
    await a.stop();
    expect(await http(b, "/v2/invites/accept", "POST", {
      code, display_name: "乙", device_name: "乙手机",
    })).toEqual({
      status: 503, body: { error: { code: "member_seat_authority_pending" } },
    });
    expect(localExecution(b)).toEqual(localBefore);
    a = await launch("甲", aHttp!, aPeer!);
    const { member: second, device_token: tokenB } = await json(b, "/v2/invites/accept", "POST", {
      code, display_name: "乙", device_name: "乙手机",
    });
    const verifyHomes = async (run: Running, token: string) => {
      const { members } = await json(run, "/v2/members", "GET", undefined, token);
      expect(members.map((m: { home_host_id: string }) => m.home_host_id).sort()).toEqual([a.hostId, b.hostId].sort());
    };
    expect(second.home_host_id).toBe(b.hostId);
    expect(await http(a, "/host/invites", "POST")).toEqual({
      status: 409, body: { error: { code: "member_limit" } },
    });
    await json(a, `/host/peers/${b.hostId}/sync`, "PUT", { paused: false });
    await caughtUp(a, b);
    await verifyHomes(a, tokenA);
    await verifyHomes(b, tokenB);
    const { conversations } = await json(b, "/v2/conversations", "GET", undefined, tokenB);
    expect(conversations.map((c: { kind: string }) => c.kind).sort()).toEqual(["direct", "group"]);
    expect(conversations.find((c: { kind: string }) => c.kind === "group").publisher_host_id).toBe(a.hostId);
    expect(conversations.find((c: { kind: string }) => c.kind === "direct").publisher_host_id).toBe(b.hostId);
    expect((await http(b, `/v2/conversations/${directA}/messages`, "GET", undefined, tokenB)).status).toBe(404);
    expect((await http(b, "/host/pairing-codes", "POST", { member_id: first.id })).status).toBe(400);
    expect((await http(a, "/host/pairing-codes", "POST", { member_id: second.id })).status).toBe(400);
    expect((await http(b, "/host/peers", "GET", undefined, tokenB)).status).toBe(401);
    const directB = conversations.find((c: { kind: string }) => c.kind === "direct").id;
    const localBeforeA = localExecution(a);
    await send(b, directB, tokenB, "乙的原生单聊");
    await caughtUp(a, b);
    expect(localExecution(a)).toEqual(localBeforeA);

    const before = await caughtUp(b, a);
    await b.stop();
    await send(a, directA, tokenA, "乙停机期间");
    b = await launch("乙", bHttp!, bPeer!);
    expect(b.hostId).toBe(joining.host_id);
    const rejoined = await caughtUp(b, a);
    expect(rejoined.cursor.generation).toBe(before.cursor.generation);
    expect(rejoined.cursor.seq).toBeGreaterThan(before.cursor.seq);

    await json(b, `/host/peers/${a.hostId}/sync`, "PUT", { paused: true });
    await a.stop();
    const store = openStore(join(a.dir, "cattt.db"));
    const rotated = rotateReplicationGeneration(store.db, a.hostId);
    store.close();
    await b.stop();
    b = await launch("乙", bHttp!, bPeer!);
    expect(await sync(b, a)).toMatchObject({ status: "paused", cursor: rejoined.cursor });
    a = await launch("甲", aHttp!, aPeer!);
    await send(a, directA, tokenA, "甲恢复世代之后");
    expect((await sync(b, a)).cursor).toEqual(rejoined.cursor);
    const noReplay = localExecution(b);
    await json(b, `/host/peers/${a.hostId}/sync`, "PUT", { paused: false });
    expect((await caughtUp(b, a)).cursor.generation).toBe(rotated.generation);
    expect(localExecution(b)).toEqual(noReplay);
    await json(b, `/host/peers/${a.hostId}`, "DELETE");
    const revoked = await sync(b, a);
    await send(a, directA, tokenA, "甲撤销之后");
    await Bun.sleep(5_200);
    expect(await sync(b, a)).toEqual(revoked);
    expect(revoked.status).toBe("revoked");
    expect(revoked.cursor.generation).toBe(rotated.generation);
  } finally {
    try { await Promise.all(stops.map((stop) => stop())); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 110_000);

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("超时")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test("mTLS 拒绝不兼容 typed 版本和越页，掉线后倒序记录仍从持久水位追齐", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r64-wire-"));
  const stops: Array<() => Promise<void>> = [];
  let sourceService: ReturnType<typeof createPeerSyncService>;
  let sourceContext: HostContext;
  let mode: "normal" | "gap" | "drop" | "reverse" = "normal";
  let observed: number[] = [];
  try {
    const launch = async (name: string) => {
      const gateway = new Gateway({
        peerPort: 0, peerHostname: "127.0.0.1",
        peerHandlers: name === "甲" ? {
          typedChanges(request) {
            const params = new URL(request.url).searchParams;
            switch (params.get("op")) {
              case "snapshot": return Response.json(sourceService.openSnapshot());
              case "snapshot_page": return Response.json(sourceService.readSnapshotPage({
                snapshotId: params.get("snapshot_id")!, offset: Number(params.get("offset")), limit: Number(params.get("limit")),
              }));
              default: {
                const cursor = JSON.parse(params.get("cursor")!);
                observed.push(cursor.seq);
                const reply = sourceService.readChanges({ cursor, limit: Number(params.get("limit")) });
                if (mode === "drop") {
                  return new Response(new ReadableStream({ start(controller) { controller.error(new Error("模拟断线")); } }));
                }
                if (reply.data.status !== "changes") return Response.json(reply);
                const page = reply.data.page;
                if (page.changes.length && mode === "gap") {
                  return Response.json({ ...reply, data: { ...reply.data, page: { ...page, changes: page.changes.slice(1) } } });
                }
                return Response.json(mode === "reverse"
                  ? { ...reply, data: { ...reply.data, page: { ...page, changes: page.changes.toReversed() } } } : reply);
              }
            }
          },
        } : undefined,
      });
      const dir = join(root, name);
      const ctx = await startHost({ dataDir: dir, port: 0, lanHttpsPort: 0, onError() {} }, [gateway]);
      stops.push(ctx.stop);
      return { hostId: ctx.hostId, dir, port: gateway.port!, stop: ctx.stop, gateway, ctx };
    };
    const a = await launch("甲");
    sourceContext = a.ctx;
    sourceService = createPeerSyncService(sourceContext.store.db, sourceContext.hostId);
    const b = await launch("乙");
    const device = issueTestDevice(a.ctx);
    await pair(a, b);
    const transport = a.gateway.peerTransport!;
    const query = { op: "snapshot", protocol_version: "234" };
    const incompatible = await transport.request(b.hostId, "typedChanges", { query });
    expect(incompatible.status).toBe(409);
    expect(await incompatible.json()).toEqual({ error: { code: "unsupported_protocol" } });
    const baseline = await caughtUp(b, a);
    expect(await transport.request(b.hostId, "typedChanges", {
      query: { op: "changes", protocol_version: "1", cursor: "broken", limit: "1" },
    }).then(async (response) => { await response.text(); return response.status; })).toBe(400);
    const before = localExecution(b);
    mode = "gap";
    const turn = testTurn(a.ctx, device.token);
    turn.delta("乱序到达并重试");
    turn.done();
    await eventually(() => sync(b, a), (state) => state?.error_code === "sequence_gap");
    expect((await sync(b, a)).cursor).toEqual(baseline.cursor);
    mode = "drop";
    await eventually(() => sync(b, a), (state) => state?.error_code === "retry_exhausted");
    expect((await sync(b, a)).cursor).toEqual(baseline.cursor);
    observed = [];
    mode = "reverse";
    await caughtUp(b, a);
    expect(observed[0]).toBe(baseline.cursor.seq);
    expect(localExecution(b)).toEqual(before);
    expect(inspect(b, (db) => db.query("SELECT count(*) AS n FROM messages").get())).toEqual({ n: 2 });
    expect(readChangePage(a.ctx.store.db, a.hostId, {
      sourceHostId: a.hostId, generation: baseline.cursor.generation, seq: baseline.cursor.seq,
    }).changes).toHaveLength(2);
  } finally {
    try { await Promise.all(stops.map((stop) => stop())); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 65_000);

test("附件清单和本地描述通过 mTLS 同步，断传重启续拉，坏哈希和撤回不发布", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r67-mtls-"));
  const stops: Array<() => Promise<void>> = [];
  const corruptBytes = new Uint8Array(43).fill(42);
  const corruptHash = new Bun.CryptoHasher("sha256").update(corruptBytes).digest("hex");
  let mode: "normal" | "drop" | "corrupt" = "drop";
  let staleSnapshot: ReturnType<typeof readNativeSnapshot> | undefined;
  let reverseSnapshotPages = false;
  const staleSnapshotId = crypto.randomUUID();
  const ranges: string[] = [];
  let modelCalls = 0;
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    modelCalls++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "一张合成测试图片" } }] });
  } });
  try {
    const launch = async (name: string, peerPort = 0) => {
      const dir = join(root, name);
      let serveBlob: ReturnType<typeof peerBlobHandler>;
      let serveChanges: ReturnType<typeof typedChangesHandler>;
      const gateway = new Gateway({
        peerPort, peerHostname: "127.0.0.1", lanPort: 0, tls: { ips: () => [], hostname: "test" },
        peerHandlers: name === "a" ? {
          async typedChanges(request, actor) {
            const snapshot = staleSnapshot;
            const params = new URL(request.url).searchParams;
            if (snapshot && params.get("op") === "snapshot") {
              return Response.json({ protocol_version: 1, source: snapshot.source, data: {
                snapshotId: staleSnapshotId, watermark: snapshot.watermark, recordCount: snapshot.records.length,
              } });
            }
            if (snapshot && params.get("snapshot_id") === staleSnapshotId) {
              const offset = Number(params.get("offset"));
              return Response.json({ protocol_version: 1, source: snapshot.source, data: {
                snapshotId: staleSnapshotId, offset,
                records: snapshot.records.toReversed().slice(offset, offset + Number(params.get("limit"))),
              } });
            }
            const reply = serveChanges(request, actor);
            if (reverseSnapshotPages && params.get("op") === "snapshot_page" && reply.ok) {
              const page = await reply.json();
              return Response.json({ ...page, data: { ...page.data, records: page.data.records.toReversed() } });
            }
            return reply;
          },
          async blob(request, actor) {
            const range = request.headers.get("range") ?? "";
            ranges.push(range);
            const served = serveBlob(request, actor);
            if (served.status !== 206) return served;
            if (mode === "drop" && !range.startsWith("bytes=0-")) {
              const reader = served.body!.getReader();
              const first = await reader.read();
              await reader.cancel();
              return new Response(new ReadableStream({
                start(controller) { controller.enqueue(first.value!.subarray(0, 1)); },
                pull(controller) { controller.error(new Error("测试：mTLS 在 Range 中断开")); },
              }), { status: 206, headers: served.headers });
            }
            if (mode === "corrupt" && new URL(request.url).pathname.endsWith("/" + corruptHash)) {
              await served.body?.cancel();
              return new Response(new Uint8Array(Number(served.headers.get("content-length"))), {
                status: 206, headers: served.headers,
              });
            }
            return served;
          },
        } : undefined,
      });
      const ctx = await startHost({
        dataDir: dir, port: 0, lanHttpsPort: 0, onError() {},
        localVision: { baseURL: `http://127.0.0.1:${model.port}/v1`, modelId: "synthetic" },
      }, [gateway]);
      serveBlob = peerBlobHandler(ctx, new BlobStorage(join(dir, "blobs")));
      serveChanges = typedChangesHandler(ctx);
      stops.push(ctx.stop);
      return { hostId: ctx.hostId, dir, port: gateway.port!, stop: ctx.stop, gateway, ctx };
    };

    let a = await launch("a");
    let b = await launch("b");
    const deviceA = issueTestDevice(a.ctx, "甲");
    await pair(a, b);
    await caughtUp(b, a);
    const deviceB = issueTestDevice(b.ctx, "乙");
    await caughtUp(a, b);

    const group = (await json(a, "/v2/conversations", "GET", undefined, deviceA.token))
      .conversations.find((row: { kind: string }) => row.kind === "group").id;
    const groupFiles = `/v2/files?conversation_id=${group}`;
    const pause = (paused: boolean) => json(b, `/host/peers/${a.hostId}/sync`, "PUT", { paused });
    const availability = async (id: string) => (await http(b, `/v2/files/${id}`, "GET", undefined, deviceB.token)).body.file?.available;
    const upload = async (bytes: Uint8Array<ArrayBuffer>, mediaType: string, source?: { id: string; rev: number }) => {
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const upload = await http(a, "/v2/files/uploads", "POST", {
        conversation_id: group, client_upload_id: crypto.randomUUID(), sha256,
        byte_size: bytes.length, file_name: "合成附件", media_type: mediaType,
        source_message_id: source?.id, source_message_rev: source?.rev,
      }, deviceA.token);
      expect(upload.status, JSON.stringify(upload.body)).toBe(201);
      const uploadPath = `/v2/files/uploads/${upload.body.id}`;
      for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
        const response = await fetch(`http://127.0.0.1:${a.port}${uploadPath}`, {
          method: "PATCH", headers: {
            authorization: `Bearer ${deviceA.token}`, "content-type": "application/octet-stream", "upload-offset": String(offset),
          }, body: bytes.slice(offset, offset + MAX_CHUNK_BYTES),
        });
        expect(response.status, await response.text()).toBe(200);
      }
      const completed = await http(a, uploadPath + "/complete", "POST", undefined, deviceA.token);
      expect(completed.status, JSON.stringify(completed.body)).toBe(201);
      return completed.body.file as { id: string; rev: number; sha256: string };
    };
    const revoke = async (fileId: string) => {
      const response = await fetch(`http://127.0.0.1:${a.port}/v2/files/${fileId}`, {
        method: "DELETE", headers: { authorization: `Bearer ${deviceA.token}` },
      });
      expect(response.status).toBe(204);
    };
    const pathOnB = (sha: string) => join(b.dir, "blobs", "content", sha);
    const peerRequest = (sha256: string, range: string) => b.gateway.peerTransport!.request(a.hostId, "blob", {
      sha256, headers: { range, "if-range": `"${sha256}"` },
    });

    await eventually(() => json(a, "/host/publication-lease"), (lease) => lease.status === "ready");
    await pause(true);
    const bytes = new Uint8Array(MAX_CHUNK_BYTES + 37).fill(17);
    bytes.set(Buffer.from("89504e470d0a1a0a", "hex"));
    const owner = resolveDeviceToken(a.ctx.store.db, a.ctx.clock, deviceA.token)!;
    const { message: photoSource } = sendMessage(a.ctx.store.db, a.ctx.clock, owner, group, {
      clientMessageId: crypto.randomUUID(), text: "这张图可以用作上下文",
    }, undefined, a.ctx.publication).body;
    const first = await upload(bytes, "image/png", { id: photoSource.id, rev: 1 });
    await json(a, `/v2/files/${first.id}/description`, "POST", { file_rev: first.rev }, deviceA.token);
    expect(modelCalls).toBe(1);
    const snapshot = readNativeSnapshot(a.ctx.store.db, a.hostId);
    expect(snapshot.records.map(({ kind }) => kind)).toContain("file");
    expect(snapshot.records.map(({ kind }) => kind)).toContain("file_description");
    expect(JSON.stringify(snapshot.records)).not.toMatch(/clientUploadId|verifiedAt|deviceToken/);
    expect(inspect(a, (db) => db.query("SELECT kind FROM change_log WHERE kind LIKE 'file%' ORDER BY seq").all()))
      .toEqual([{ kind: "file" }, { kind: "file_description" }]);

    const actor = resolveDeviceToken(a.ctx.store.db, a.ctx.clock, deviceA.token)!;
    const { body: { message } } = sendMessage(a.ctx.store.db, a.ctx.clock, actor, group, {
      clientMessageId: crypto.randomUUID(), text: "合成附件来源",
    }, undefined, a.ctx.publication);
    const expired = await upload(new Uint8Array(61).fill(9), "application/octet-stream", { id: message.id, rev: 1 });
    a.ctx.store.db.update(messages).set({ rev: 2 }).where(eq(messages.id, message.id)).run();
    rotateReplicationGeneration(a.ctx.store.db, a.hostId);
    reverseSnapshotPages = true;

    await pause(false);
    await eventually(async () => ({ available: await availability(first.id), ranges: [...ranges] }), (state) =>
      state.available === false && state.ranges.includes(`bytes=${MAX_CHUNK_BYTES}-${bytes.length - 1}`));
    expect(existsSync(pathOnB(first.sha256))).toBe(false);
    expect(inspect(b, (db) => db.query("SELECT count(*) AS n FROM file_blobs").get())).toEqual({ n: 0 });
    expect((await json(b, groupFiles, "GET", undefined, deviceB.token)).files)
      .toMatchObject([{ id: first.id, available: false }]);
    expect((await json(b, `/v2/files/${first.id}/description`, "GET", undefined, deviceB.token)).description.text)
      .toBe("一张合成测试图片");
    const incomplete = await mobileChanges(b, deviceB.token);
    expect(incomplete.changes).toMatchObject([
      { kind: "file", id: first.id, op: "upsert", value: { rev: 1, available: false } },
      { kind: "file_description", op: "upsert", value: { file_id: first.id, file_rev: 1, text: "一张合成测试图片" } },
    ]);
    const descriptionId = incomplete.changes[1].id;
    expect(modelCalls).toBe(1);
    expect(inspect(b, (db) => db.query("SELECT count(*) AS n FROM file_uploads").get())).toEqual({ n: 0 });
    expect((await http(b, `/v2/files/${first.id}/content`, "GET", undefined, deviceB.token)).status).toBe(404);
    expect(inspect(b, (db) => db.query("SELECT source_message_rev FROM files WHERE id = ?").get(expired.id)))
      .toEqual({ source_message_rev: 1 });
    expect((await http(b, `/v2/files/${expired.id}`, "GET", undefined, deviceB.token)).status).toBe(404);
    const expiredBlob = await peerRequest(expired.sha256, "bytes=0-0");
    expect(expiredBlob.status).toBe(404);
    await expiredBlob.text();

    const bPeerPort = b.gateway.peerPort!;
    await b.stop();
    ranges.length = 0;
    mode = "normal";
    b = await launch("b", bPeerPort);
    await eventually(() => availability(first.id), (available) => available === true);
    expect(ranges[0]).toBe(`bytes=${MAX_CHUNK_BYTES}-${bytes.length - 1}`);
    expect(readFileSync(pathOnB(first.sha256))).toEqual(Buffer.from(bytes));
    const downloaded = await mobileChanges(b, deviceB.token, incomplete.next);
    expect(downloaded.changes).toMatchObject([
      { kind: "file", id: first.id, op: "upsert", value: { rev: 1, available: true } },
    ]);
    const otherDirection = await a.gateway.peerTransport!.request(b.hostId, "blob", {
      sha256: first.sha256, headers: { range: "bytes=-3" },
    });
    expect(otherDirection.status).toBe(206);
    expect(otherDirection.headers.get("content-range")).toBe(`bytes ${bytes.length - 3}-${bytes.length - 1}/${bytes.length}`);
    expect(new Uint8Array(await otherDirection.arrayBuffer())).toEqual(bytes.slice(-3));
    const invalid = await peerRequest(first.sha256, "bytes=0-1,3-4");
    expect(invalid.status).toBe(416);
    await invalid.text();
    expect((await http(a, `/peer/blobs/${first.sha256}`, "GET", undefined, deviceA.token)).status).toBe(404);

    mode = "corrupt";
    ranges.length = 0;
    const bad = await upload(corruptBytes, "application/octet-stream");
    await eventually(async () => ({ available: await availability(bad.id), ranges: [...ranges] }), (state) =>
      state.available === false && state.ranges.filter((range) => range === "bytes=0-42").length >= 2);
    expect(existsSync(pathOnB(bad.sha256))).toBe(false);
    expect(inspect(b, (db) => db.query("SELECT sha256 FROM file_blobs").all())).toEqual([{ sha256: first.sha256 }]);
    const aPeerPort = a.gateway.peerPort!;
    await a.stop();
    expect(await availability(first.id)).toBe(true);
    expect(await availability(bad.id)).toBe(false);
    const offlineContent = await fetch(`http://127.0.0.1:${b.port}/v2/files/${first.id}/content`, {
      headers: { authorization: `Bearer ${deviceB.token}` },
    });
    expect(new Uint8Array(await offlineContent.arrayBuffer())).toEqual(bytes);
    a = await launch("a", aPeerPort);
    await pause(true);
    const beforeLoss = await mobileChanges(b, deviceB.token, downloaded.next);
    rmSync(pathOnB(first.sha256));
    const lost = await mobileChanges(b, deviceB.token, beforeLoss.next);
    expect(lost.changes).toMatchObject([
      { kind: "file", id: first.id, op: "upsert", value: { rev: 1, available: false } },
    ]);
    await pause(false);
    await eventually(() => availability(first.id), (available) => available === true);
    const reacquired = await mobileChanges(b, deviceB.token, lost.next);
    expect(reacquired.changes).toMatchObject([
      { kind: "file", id: first.id, op: "upsert", value: { rev: 1, available: true } },
    ]);
    const evidence = { kind: "file_description", id: first.id, rev: first.rev } as const;
    expect(readKnowledgeEvidenceText(b.ctx.store.db, b.ctx.householdId, evidence)).toBe("一张合成测试图片");
    expect((await http(a, `/v2/conversations/${group}/messages/${photoSource.id}/withdraw`, "POST", {
      request_id: crypto.randomUUID(), expected_revision: 1,
    }, deviceA.token)).status).toBe(200);
    await caughtUp(b, a);
    expect(readKnowledgeEvidenceText(b.ctx.store.db, b.ctx.householdId, evidence)).toBeUndefined();
    expect((await http(b, `/v2/files/${first.id}/description`, "GET", undefined, deviceB.token)).status).toBe(404);
    expect(await availability(first.id)).toBe(true);
    const descriptionRemoved = await mobileChanges(b, deviceB.token, reacquired.next);
    expect(descriptionRemoved.changes).toEqual([
      { kind: "file_description", id: descriptionId, op: "delete", sequence: expect.any(Number) },
    ]);

    mode = "drop";
    const withdrawnWhilePartial = await upload(new Uint8Array(MAX_CHUNK_BYTES + 91).fill(93), "application/octet-stream");
    const stage = join(b.dir, "blobs", "peer-downloads", a.hostId, withdrawnWhilePartial.sha256);
    await eventually(async () => ({ available: await availability(withdrawnWhilePartial.id), staged: existsSync(stage) }),
      ({ available, staged }) => available === false && staged);
    const old = readNativeSnapshot(a.ctx.store.db, a.hostId);
    await revoke(withdrawnWhilePartial.id);
    await revoke(first.id);
    await revoke(bad.id);
    await caughtUp(b, a);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(pathOnB(withdrawnWhilePartial.sha256))).toBe(false);
    expect((await json(b, groupFiles, "GET", undefined, deviceB.token)).files).toEqual([]);
    const filesRemoved = await mobileChanges(b, deviceB.token, descriptionRemoved.next);
    expect(filesRemoved.changes).toEqual(expect.arrayContaining([
      { kind: "file", id: first.id, op: "delete", sequence: expect.any(Number) },
    ]));
    expect(readVerifiedFileDescription(b.ctx.store.db, { fileId: first.id, fileRev: first.rev })).toBeUndefined();
    const missing = await peerRequest(first.sha256, "bytes=0-0");
    expect(missing.status).toBe(404);
    await missing.text();
    const hiddenReplica = await a.gateway.peerTransport!.request(b.hostId, "blob", { sha256: first.sha256 });
    expect(hiddenReplica.status).toBe(404);
    await hiddenReplica.text();

    // Simulate retained backup data arriving in a new generation, in dependency-reversed order.
    await pause(true);
    const watermark = rotateReplicationGeneration(a.ctx.store.db, a.hostId);
    const staleSource = { ...old.source, generation: watermark.generation };
    staleSnapshot = { source: staleSource, watermark, records: old.records };
    await pause(false);
    await caughtUp(b, a);
    const typed = typedPeerTransport(b.gateway.peerTransport!, a.hostId);
    const signal = AbortSignal.timeout(5000);
    const { source, data: manifest } = await typed.openSnapshot(signal);
    const { data: replayed } = await typed.readSnapshotPage({ snapshotId: manifest.snapshotId, offset: 0, limit: 100 }, signal);
    expect(replayed.records[0]!.kind).toBe("file_description");
    expect(applyReplicaSnapshot(b.ctx.store.db, source, watermark, manifest, replayed.records))
      .toMatchObject({ status: "applied", applied: 0 });
    expect((await json(b, groupFiles, "GET", undefined, deviceB.token)).files).toEqual([]);
    expect(inspect(b, (db) => db.query("SELECT deleted_at FROM file_descriptions").get())).toMatchObject({
      deleted_at: expect.any(Number),
    });
    expect(modelCalls).toBe(1);
  } finally {
    try {
      await Promise.all(stops.map((stop) => stop()));
      await model.stop(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 85_000);

test("R6.12 本方受理跨宿主记忆操作，真实 mTLS 重试、拒绝与复制后才确认完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r612-mtls-"));
  const stops: Array<() => Promise<void>> = [];
  let dropReceipt = false;
  let dropped = 0;
  try {
    const launch = async (name: string, peerPort = 0) => {
      const dir = join(root, name);
      const clock = new ManualClock(name, Date.now());
      const channel = new PeerBehaviorChannel(() => {
        const transport: PeerTransport | undefined = gateway.peerTransport;
        if (!transport || name !== "subject") return transport;
        return {
          ...transport,
          async request(...args) {
            const response = await transport.request(...args);
            if (args[1] === "inbox" && response.ok && dropReceipt) {
              dropped++;
              await response.text();
              throw new Error("测试丢弃已提交回执");
            }
            return response;
          },
        };
      });
      const gateway = new Gateway({
        peerPort, peerHostname: "127.0.0.1", lanPort: 0, tls: { ips: () => [], hostname: "test" },
        peerBehavior: channel,
      });
      const jobs = new JobRunner({ pollIntervalMs: 15 });
      registerMemoryActions(channel);
      channel.registerDelivery(jobs);
      const ctx = await startHost({ dataDir: dir, port: 0, clock, onError: () => {} }, [gateway, jobs]);
      stops.push(ctx.stop);
      return { hostId: ctx.hostId, dir, port: gateway.port!, stop: ctx.stop, gateway, ctx, clock };
    };
    let a = await launch("writer");
    const b = await launch("subject");
    await pair(a, b);
    const author = issueTestDevice(a.ctx, "甲");
    const subject = issueTestDevice(b.ctx, "乙");
    await caughtUp(a, b);
    const conversation = (await json(a, "/v2/conversations", "GET", undefined, author.token))
      .conversations.find((row: { kind: string }) => row.kind === "direct").id as string;
    const householdId = a.ctx.householdId;
    const seed = (fingerprint: string, subjectMemberId: string | null = subject.memberId) => {
      const { db } = a.ctx.store;
      const actor = resolveDeviceToken(db, a.clock, author.token)!;
      const message = sendMessage(db, a.clock, actor, conversation, {
        clientMessageId: crypto.randomUUID(), text: "仅甲可见的原话 " + fingerprint,
      }).body.message;
      return saveMemory(db, a.clock, {
        householdId, sourceMemberId: author.memberId, sourceMessageId: message.id,
        sourceRevision: 1, subjectMemberId, fingerprint, predicate: fingerprint, value: "原值",
      })!;
    };
    const first = seed("更正");
    const revoked = seed("停用");
    const shared = seed("共同", null);
    const oldGeneration = seed("恢复世代");
    const removedMember = seed("成员撤权");
    await caughtUp(b, a);
    const record = (run: typeof a, id: string) => getMemoryRecord(run.ctx.store.db, { householdId, id })!;
    const mutate = (row: typeof first, method = "PATCH", value = "乙更正", key = crypto.randomUUID(), revision = 1) => {
      const payload = { request_id: key, expected_revision: revision, ...(method === "PATCH" ? { value } : {}) };
      const path = `/v2/memories/${row.id}`;
      return {
        path, payload, url: `${path}/requests/${key}`,
        submit: (token = subject.token, host = b) => http(host, path, method, payload, token),
      };
    };
    const status = (request: ReturnType<typeof mutate>, token = subject.token) =>
      http(b, request.url, "GET", undefined, token);
    const wait = (request: ReturnType<typeof mutate>, state: string) =>
      eventually(() => status(request), (result) => result.body.action?.status === state);
    const resumeDelivery = () => b.clock.advance(65_000);
    const pauseProjection = async (paused: boolean) => {
      await json(b, `/host/peers/${a.hostId}/sync`, "PUT", { paused });
    };
    const readInboxCount = (run: typeof a) =>
      inspect(run, (db) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM peer_inbox").get()!.n);

    expect((await mutate(shared).submit()).status).toBe(404);
    const wrongHost = createDevice(a.ctx.store.db, a.clock, {
      memberId: subject.memberId, hostId: a.hostId, name: "测试手机",
    });
    expect(await mutate(first).submit(wrongHost.token, a)).toMatchObject({
      status: 409, body: { error: { code: "wrong_home_host" } },
    });
    const baseline = await mobileChanges(b, subject.token);
    await pauseProjection(true);
    const oldPeerPort = a.gateway.peerPort!;
    await a.stop();
    const change = mutate(first);
    const accepted = await change.submit();
    expect(accepted).toMatchObject({ status: 202, body: { action: {
      request_id: change.payload.request_id, memory_id: first.id, receipt_url: change.url, writer_host_id: a.hostId,
    } } });
    expect(JSON.stringify(accepted)).not.toContain(conversation);
    expect(JSON.stringify(accepted)).not.toContain(first.sourceMessageId);
    expect(JSON.stringify(accepted)).not.toContain("仅甲可见");
    expect((await change.submit()).status).toBe(202);
    expect(await mutate(first, "PATCH", "同键换内容", change.payload.request_id).submit()).toMatchObject({
      status: 409, body: { error: { code: "idempotency_conflict" } },
    });
    expect((await http(b, change.url.replace(first.id, shared.id), "GET", undefined, subject.token)).status).toBe(404);
    expect((await status(change, author.token)).status).toBe(401);
    await wait(change, "waiting_for_peer");
    expect(record(b, first.id)).toMatchObject({ rev: 1, value: "原值" });
    const concurrent = mutate(first, "PATCH", "另一处更正");
    expect((await concurrent.submit()).status).toBe(202);
    await wait(concurrent, "waiting_for_peer");
    dropReceipt = true;
    a = await launch("writer", oldPeerPort);
    resumeDelivery();
    await eventually(async () => dropped, (count) => count > 0);
    expect(record(a, first.id)).toMatchObject({ rev: 2, value: "乙更正" });
    expect(readInboxCount(a)).toBe(1);
    expect((await wait(concurrent, "rejected")).body.action.error_code).toBe("revision_conflict");
    expect((await status(change)).status).toBe(202);
    dropReceipt = false;
    resumeDelivery();
    await wait(change, "waiting_for_replication");
    expect(record(b, first.id).rev).toBe(1);
    await pauseProjection(false);
    await caughtUp(b, a);
    expect(await wait(change, "applied")).toMatchObject({ status: 200, body: { action: { resulting_revision: 2 } } });
    expect(readInboxCount(a)).toBe(1);
    expect(await json(b, change.path, "GET", undefined, subject.token)).toMatchObject({
      memory: { revision: 2, value: "乙更正", source: null },
    });

    const withdraw = mutate(first, "DELETE", "", crypto.randomUUID(), 2);
    dropReceipt = true;
    expect((await withdraw.submit()).status).toBe(202);
    await wait(withdraw, "waiting_for_peer");
    expect(record(a, first.id)).toMatchObject({ rev: 3, deletedAt: expect.any(Number) });
    expect(listMemoryBlocks(b.ctx.store.db, { householdId })).toEqual([]);
    dropReceipt = false;
    resumeDelivery();
    await wait(withdraw, "applied");
    expect(record(a, first.id)).toMatchObject({ rev: 3, deletedAt: expect.any(Number) });
    expect(record(b, first.id)).toMatchObject({ rev: 3, deletedAt: expect.any(Number) });
    await caughtUp(a, b);
    for (const run of [a, b]) {
      expect(listMemoryBlocks(run.ctx.store.db, { householdId })).toMatchObject([
        { subjectMemberId: subject.memberId, originHostId: b.hostId, fingerprint: first.fingerprint },
      ]);
    }
    expect((await mobileChanges(b, subject.token, baseline.next)).changes).toContainEqual(expect.objectContaining({
      id: first.id, op: "delete",
    }));
    expect((await withdraw.submit()).status).toBe(200);
    expect(readInboxCount(a)).toBe(2);

    await pauseProjection(true);
    expect(await http(a, `/v2/conversations/${conversation}/messages/${revoked.sourceMessageId}/withdraw`, "POST", {
      request_id: crypto.randomUUID(), expected_revision: revoked.sourceRevision,
    }, author.token)).toMatchObject({ status: 200 });
    const revokedRequest = mutate(revoked);
    const beforeReject = readInboxCount(a);
    expect((await revokedRequest.submit()).status).toBe(202);
    expect((await wait(revokedRequest, "rejected")).body.action.error_code).toBe("source_unavailable");
    expect(record(a, revoked.id).rev).toBe(1);

    // A paired Mac cannot use another member's identity or substitute private source proof.
    const acceptedEnvelope = inspect(b, (db) => db.query<{ envelope: string }, [string]>(
      "SELECT envelope FROM peer_outbox WHERE idempotency_key LIKE ?",
    ).get("%" + change.payload.request_id)!.envelope);
    const envelope = JSON.parse(acceptedEnvelope);
    const forged = async (payload: Record<string, unknown>, id: string) => {
      const key = crypto.randomUUID();
      return b.gateway.peerTransport!.request(a.hostId, "inbox", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...envelope,
          idempotency_key: `memory_action:${payload.actor_member_id}:${key}`,
          source: { ...envelope.source, id },
          payload: { ...payload, request_id: key },
        }),
      });
    };
    const removedProof = { ...envelope.payload, source_message_id: removedMember.sourceMessageId, memory_hlc: removedMember.hlc };
    const badSource = await forged({ ...removedProof, source_message_id: uuidv7(a.clock) }, removedMember.id);
    expect(badSource.status).toBe(422);
    const badActor = await forged({ ...removedProof, actor_member_id: author.memberId }, removedMember.id);
    expect(badActor.status).toBe(422);
    expect(record(a, removedMember.id).rev).toBe(1);
    expect(readInboxCount(a)).toBe(beforeReject);

    rotateReplicationGeneration(a.ctx.store.db, a.hostId);
    const rollback = mutate(oldGeneration);
    expect((await rollback.submit()).status).toBe(202);
    expect((await wait(rollback, "rejected")).body.action.error_code).toBe("revision_conflict");
    expect(record(a, oldGeneration.id).rev).toBe(1);
    await pauseProjection(false);
    await caughtUp(b, a);
    expect(removeMember(b.ctx.store.db, b.clock, householdId, subject.memberId)).toBe(true);
    await caughtUp(a, b);
    const removed = await forged({ ...removedProof, writer_generation: nativeHead(a).generation }, removedMember.id);
    expect(removed.status).toBe(422);
    expect((await status(change)).status).toBe(401);
    expect(record(a, removedMember.id).rev).toBe(1);
  } finally {
    await Promise.allSettled(stops.map((stop) => stop()));
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

test("R6.9 通过 mTLS 合并主体与来源、回复证明、日记许可和撤回，且不执行复制工作", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r69-mtls-"));
  const stops: Array<() => Promise<void>> = [];
  const restoredSnapshotId = crypto.randomUUID();
  let restoredSnapshot: ReturnType<typeof readNativeSnapshot> | undefined;
  try {
    const launch = async (name: string) => {
      const dir = join(root, name);
      let serveChanges: ReturnType<typeof typedChangesHandler>;
      const gateway = new Gateway({
        peerPort: 0, peerHostname: "127.0.0.1", lanPort: 0, tls: { ips: () => [], hostname: "test" },
        peerHandlers: name === "甲" ? {
          typedChanges(request, actor) {
            const snapshot = restoredSnapshot;
            const query = new URL(request.url).searchParams;
            if (snapshot && query.get("op") === "snapshot") {
              return Response.json({ protocol_version: 1, source: snapshot.source, data: {
                snapshotId: restoredSnapshotId, watermark: snapshot.watermark, recordCount: snapshot.records.length,
              } });
            }
            if (snapshot && query.get("snapshot_id") === restoredSnapshotId) {
              const offset = Number(query.get("offset"));
              return Response.json({ protocol_version: 1, source: snapshot.source, data: {
                snapshotId: restoredSnapshotId, offset,
                records: snapshot.records.toReversed().slice(offset, offset + Number(query.get("limit"))),
              } });
            }
            return serveChanges(request, actor);
          },
        } : undefined,
      });
      const ctx = await startHost({ dataDir: dir, port: 0, lanHttpsPort: 0 }, [gateway]);
      serveChanges = typedChangesHandler(ctx);
      stops.push(ctx.stop);
      return { hostId: ctx.hostId, dir, port: gateway.port!, stop: ctx.stop, gateway, ctx };
    };
    const a = await launch("甲");
    const b = await launch("乙");
    await pair(a, b);
    await caughtUp(b, a);
    await caughtUp(a, b);
    const deviceA = issueTestDevice(a.ctx, "甲");
    const deviceB = issueTestDevice(b.ctx, "乙");
    await caughtUp(b, a);
    await caughtUp(a, b);
    const before = localExecution(b);
    const { db } = a.ctx.store;
    const seedA = readNativeSnapshot(db, a.hostId);
    const householdId = a.ctx.householdId;
    const actorA = resolveDeviceToken(db, a.ctx.clock, deviceA.token)!;
    const id = (await json(a, "/v2/conversations", "GET", undefined, deviceA.token))
      .conversations.find((row: { kind: string }) => row.kind === "direct").id as string;
    const post = (text: string) => sendMessage(db, a.ctx.clock, actorA, id, {
      clientMessageId: crypto.randomUUID(), text,
    }).body.message;
    const pointer = (message: ReturnType<typeof post>) => ({
      householdId, sourceMemberId: deviceA.memberId, sourceMessageId: message.id, sourceRevision: 1,
    });
    const prior = post("我们在周末打球");
    const withdrawn = post("乙午后喝咖啡");
    const shared = post("我们都喜欢散步");
    const boundarySource = post("别跟我聊面试");
    const memory = saveMemory(db, a.ctx.clock, {
      ...pointer(withdrawn), subjectMemberId: deviceB.memberId, fingerprint: "coffee",
      predicate: "咖啡", value: "午后喝",
    }, [{ id: prior.id, rev: 1 }])!;
    const pairMemory = saveMemory(db, a.ctx.clock, {
      ...pointer(shared), subjectMemberId: null, fingerprint: "walk", predicate: "散步", value: "都喜欢",
    })!;
    const boundary = createBoundary(db, a.ctx.clock, {
      ...pointer(boundarySource), subjectMemberId: deviceA.memberId, description: "面试",
    })!;
    const diary = await http(a, "/v2/diary", "POST", {
      request_id: crypto.randomUUID(), text: "从聊天整理成日记",
      recorded_at: Date.UTC(2026, 10, 22), local_day: "2026-11-22", time_zone: "UTC", cat_allowed: true,
      source: { conversation_id: id, message_id: prior.id, revision: 1 },
    }, deviceA.token);
    expect(diary.status).toBe(201);
    const diaryId = diary.body.entry.id as string;
    const wrongHost = createDevice(db, a.ctx.clock, { memberId: deviceB.memberId, hostId: a.hostId, name: "测试手机" });
    expect((await http(a, "/v2/diary", "POST", {
      request_id: crypto.randomUUID(), text: "只能写到乙的宿主",
      recorded_at: Date.UTC(2026, 10, 22), local_day: "2026-11-22", time_zone: "UTC",
    }, wrongHost.token))).toMatchObject({ status: 409, body: { error: {
      code: "wrong_home_host", writer_host_id: b.hostId,
    } } });
    expect(await mobileChanges(a, wrongHost.token, undefined, 409)).toEqual({
      error: { code: "wrong_home_host", writer_host_id: b.hostId },
    });
    const turn = testTurn(a.ctx, deviceA.token);
    turn.delta("参考聊天整理的日记");
    const evidence = [{ kind: "diary", id: diaryId, rev: 1 }] as const;
    finishTurn(db, a.ctx.clock, turn.turn.id, {
      status: "completed", fence: turn.fence, knowledgeEvidence: [...evidence],
    });
    const reply = db.select().from(messages).where(eq(messages.turnId, turn.turn.id)).all()
      .find((message) => message.authorMemberId === null)!;
    await caughtUp(b, a);
    const replica = b.ctx.store.db;
    expect(listAvailableMemories(replica, { householdId })).toMatchObject([
      { id: memory.id, subjectMemberId: deviceB.memberId, sourceMemberId: deviceA.memberId },
      { id: pairMemory.id, subjectMemberId: null },
    ]);
    expect(listAvailableBoundaries(replica, { householdId })).toMatchObject([{ id: boundary.id }]);
    expect(listAllowedDiaryEntries(replica, { householdId })).toMatchObject([{ id: diaryId }]);
    expect(listModelVisibleMessages(replica, householdId, id, [reply.id]))
      .toMatchObject([{ id: reply.id, knowledgeEvidence: evidence }]);
    expect((await json(b, `/v2/memories/${memory.id}`, "GET", undefined, deviceB.token)).memory.source).toBeNull();
    const baseline = await mobileChanges(b, deviceB.token);
    const homeBaseline = await mobileChanges(a, deviceA.token);
    expect(baseline.changes).toMatchObject([
      { kind: "memory", id: memory.id, value: { source: null, revision: 1, can_edit: true } },
      { kind: "memory", id: pairMemory.id, value: { source: null, revision: 1, can_edit: false } },
      { kind: "diary", id: diaryId, value: { source: null, revision: 1, cat_readable: true } },
    ]);
    expect(JSON.stringify(baseline)).not.toContain(boundary.id);
    expect(JSON.stringify(baseline)).not.toContain(prior.id);
    expect(JSON.stringify(baseline)).not.toContain(id);
    expect(JSON.stringify(baseline)).not.toContain(reply.id);
    expect(await mobileChanges(b, deviceB.token, homeBaseline.next, 409)).toEqual({
      error: { code: "cursor_reset_required" }, reset: true, generation: baseline.generation,
    });
    expect((await http(b, `/v2/conversations/${id}/messages`, "GET", undefined, deviceB.token)).status).toBe(404);
    expect((await http(b, `/v2/memories/${memory.id}`, "PATCH", {
      request_id: crypto.randomUUID(), expected_revision: memory.rev, value: "改成晚上",
    }, deviceB.token))).toMatchObject({ status: 409, body: { error: {
      code: "peer_write_unavailable", writer_host_id: a.hostId,
    } } });

    const old = readNativeSnapshot(db, a.hostId);
    const beforeRevocation = getPeerCursor(replica, a.hostId)!;
    expect((await http(a, `/v2/conversations/${id}/messages/${prior.id}/withdraw`, "POST", {
      request_id: crypto.randomUUID(), expected_revision: 1,
    }, deviceA.token)).status).toBe(200);
    await caughtUp(b, a);
    const secondary = await mobileChanges(b, deviceB.token, baseline.next);
    expect(secondary.changes).toMatchObject([
      { kind: "diary", id: diaryId, op: "upsert", value: { revision: 1, cat_allowed: true, cat_readable: false } },
      { kind: "memory", id: memory.id, op: "delete" },
    ]);
    expect((await http(a, `/v2/diary/${diaryId}/cat-allowed`, "PATCH", {
      request_id: crypto.randomUUID(), expected_revision: 1, cat_allowed: false,
    }, deviceA.token)).status).toBe(200);
    const beforeForget = readChangePage(db, a.hostId).next;
    expect((await http(a, `/v2/memories/${pairMemory.id}`, "DELETE", {
      request_id: crypto.randomUUID(), expected_revision: pairMemory.rev,
    }, deviceA.token)).status).toBe(200);
    const typed = typedPeerTransport(b.gateway.peerTransport!, a.hostId);
    const signal = AbortSignal.timeout(45_000);
    expect((await typed.readChanges({ cursor: beforeForget, limit: 1 }, signal)).data.status).toBe("reset_required");
    const whole = await typed.readChanges({ cursor: beforeForget, limit: 2 }, signal);
    expect(whole.data).toMatchObject({ status: "changes", page: { changes: [
      { seq: beforeForget.seq + 1, kind: "memory_block" },
      { seq: beforeForget.seq + 2, kind: "memory", row: { deletedAt: expect.any(Number) } },
    ] } });
    await caughtUp(b, a);
    expect(listAvailableMemories(replica, { householdId })).toEqual([]);
    expect(listAllowedDiaryEntries(replica, { householdId })).toEqual([]);
    expect(listModelVisibleMessages(replica, householdId, id, [prior.id, withdrawn.id, reply.id])).toEqual([]);
    expect((await json(b, `/v2/diary/${diaryId}`, "GET", undefined, deviceB.token)).entry)
      .toMatchObject({ cat_allowed: false, cat_readable: false, source: null });
    const final = await mobileChanges(b, deviceB.token, secondary.next);
    expect(final.changes).toMatchObject([
      { kind: "diary", id: diaryId, op: "upsert", value: { revision: 2, cat_allowed: false } },
      { kind: "memory", id: pairMemory.id, op: "delete" },
    ]);

    const replay = await typed.readChanges({ cursor: beforeRevocation, limit: 500 }, AbortSignal.timeout(5000));
    expect(replay.data.status).toBe("changes");
    if (replay.data.status === "changes") {
      expect(applyChangePage(replica, replay.source, replay.data.page)).toMatchObject({ status: "applied", applied: 0 });
    }
    const restored = rotateReplicationGeneration(db, a.hostId);
    restoredSnapshot = {
      ...old, watermark: restored, source: { ...old.source, generation: restored.generation },
    };
    await caughtUp(b, a);
    restoredSnapshot = undefined;
    const current = getPeerCursor(replica, a.hostId)!;
    expect(() => applyReplicaSnapshot(replica, old.source, current, {
      snapshotId: crypto.randomUUID(), watermark: old.watermark, recordCount: old.records.length,
    }, old.records)).toThrow();
    expect(listAvailableMemories(replica, { householdId })).toEqual([]);
    expect(listAllowedDiaryEntries(replica, { householdId })).toEqual([]);
    expect(await mobileChanges(b, deviceB.token, final.next)).toEqual({ ...final, changes: [] });
    expect(await mobileChanges(a, deviceA.token, homeBaseline.next, 409)).toMatchObject({
      error: { code: "cursor_reset_required" }, reset: true, generation: restored.generation,
    });
    const group = (await json(a, "/v2/conversations", "GET", undefined, deviceA.token))
      .conversations.find((row: { kind: string }) => row.kind === "group").id as string;
    const baseA = readNativeSnapshot(db, a.hostId);
    const baseB = readNativeSnapshot(replica, b.hostId);
    const actorBAtPublisher = resolveDeviceToken(db, a.ctx.clock, wrongHost.token)!;
    await eventually(() => json(a, "/host/publication-lease"), (lease) => lease.status === "ready");
    const sourceB = sendMessage(db, a.ctx.clock, actorBAtPublisher, group, {
      clientMessageId: crypto.randomUUID(), text: "乙不想再聊竞赛",
    }, undefined, a.ctx.publication).body.message;
    await caughtUp(b, a);
    const bBoundary = await http(b, "/v2/boundaries", "POST", {
      request_id: crypto.randomUUID(), description: "竞赛",
      source: { conversation_id: group, message_id: sourceB.id, revision: 1 },
    }, deviceB.token);
    expect(bBoundary.status).toBe(201);
    await caughtUp(a, b);
    expect(listAvailableBoundaries(db, { householdId, subjectMemberId: deviceB.memberId }))
      .toMatchObject([{ id: bBoundary.body.boundary.id, originHostId: b.hostId }]);

    // A lagging copy receives the authentic B page before A's group message.
    const lagging = openStore(":memory:");
    try {
      for (const base of [seedA, baseB, baseA]) {
        expect(applyReplicaSnapshot(lagging.db, base.source, base === baseA ? seedA.watermark : null, {
          snapshotId: crypto.randomUUID(), watermark: base.watermark, recordCount: base.records.length,
        }, base.records)).toMatchObject({ status: "applied" });
      }
      const fromB = typedPeerTransport(a.gateway.peerTransport!, b.hostId);
      const bChanges = await fromB.readChanges({ cursor: baseB.watermark, limit: 500 }, signal);
      const aChanges = await typed.readChanges({ cursor: baseA.watermark, limit: 500 }, signal);
      if (bChanges.data.status !== "changes" || aChanges.data.status !== "changes") {
        throw new Error("需要两份增量页");
      }
      expect(applyChangePage(lagging.db, bChanges.source, bChanges.data.page)).toMatchObject({
        status: "waiting", cursor: baseB.watermark, missing: [{ kind: "message", id: sourceB.id }],
      });
      expect(listAvailableBoundaries(lagging.db, { householdId, subjectMemberId: deviceB.memberId })).toEqual([]);
      expect(applyChangePage(lagging.db, aChanges.source, aChanges.data.page)).toMatchObject({ status: "applied" });
      expect(applyChangePage(lagging.db, bChanges.source, bChanges.data.page)).toMatchObject({ status: "applied" });
      expect(applyChangePage(lagging.db, bChanges.source, bChanges.data.page)).toMatchObject({ status: "applied", applied: 0 });
      expect(listAvailableBoundaries(lagging.db, { householdId, subjectMemberId: deviceB.memberId }))
        .toMatchObject([{ sourceMemberId: deviceB.memberId, sourceMessageId: sourceB.id }]);
      expect(lagging.raw.query("SELECT count(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    } finally { lagging.close(); }
    const after = localExecution(b);
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
    expect(after.slice(4)).toEqual(before.slice(4));
    expect(after[3]).toBe(before[3]! + 1);
    expect(inspect(b, (raw) => raw.query("SELECT count(*) AS n FROM member_resource_receipts").get())).toEqual({ n: 1 });
  } finally {
    try { await Promise.all(stops.map((stop) => stop())); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}, 65_000);
