import "reflect-metadata";
import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { uuidv7 } from "../src/ids/index.ts";
import { JobRunner } from "../src/jobs/index.ts";
import type { PeerTransport } from "../src/peer/index.ts";
import { PeerBehaviorChannel } from "../src/peer-behavior/index.ts";
import type { PeerBehaviorDraft, PeerReceipt } from "../src/peer-behavior/protocol.ts";
import { requestPeerHttps } from "../src/peer/https.ts";
import { initializePeerIdentity } from "../src/identity/peer-tls.ts";
import type { PeerDescriptor, PeerProtocol } from "../src/peer/protocol.ts";
import { startHost } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { enqueueJob, getJob } from "../src/store/jobs.ts";
import { getPeerDelivery } from "../src/store/peer-behavior.ts";
import { conversations, hosts, jobs, messages, peerInbox } from "../src/store/schema/index.ts";

const cleanup: Array<() => void | Promise<void>> = [];
const admissionQueue = "test:peer-admission";
const compatibleV1 = { version: 1, readOnlyVersions: [2] };

async function eventually(assertion: () => void) {
  const deadline = performance.now() + 3000;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (performance.now() >= deadline) {
        throw error;
      }
      await Bun.sleep(15);
    }
  }
}

afterEach(async () => {
  for (const finish of cleanup.splice(0).reverse()) {
    await finish();
  }
});

function tempHostDir() {
  const dir = mkdtempSync(join(tmpdir(), "cattt-peer-behavior-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function launch(options: {
  dir?: string;
  protocol?: PeerProtocol;
  intercept?: (response: Response) => Promise<Response>;
  beforeRequest?: () => void;
  disableAdmission?: boolean;
  failAdmission?: boolean;
  beforeAdmission?: (reason: string) => void;
} = {}) {
  const dir = options.dir ?? tempHostDir();
  const clock = new ManualClock("peer-test", Date.now());
  const channel = new PeerBehaviorChannel(() => {
    const transport: PeerTransport | undefined = gateway.peerTransport;
    if (!transport || (!options.intercept && !options.beforeRequest)) {
      return transport;
    }
    return {
      ...transport,
      request: async (...args) => {
        options.beforeRequest?.();
        const response = await transport.request(...args);
        return options.intercept ? options.intercept(response) : response;
      },
    };
  });
  const gateway: Gateway = new Gateway({
    lanPort: 0,
    tls: { ips: () => [], hostname: "peer-test" },
    peerPort: 0,
    peerHostname: "127.0.0.1",
    peerProtocol: options.protocol ?? { version: 1, readOnlyVersions: [] },
    peerBehavior: channel,
  });
  const jobRunner = new JobRunner({ pollIntervalMs: 10, graceMs: 30 });
  channel.registerDelivery(jobRunner);
  if (!options.disableAdmission) {
    channel.register("group_speak", {
      payload: z.strictObject({ conversation_id: z.uuidv7(), note: z.string().min(1) }),
      inspect(db, { envelope, sourceHostId, payload }) {
        const { source } = envelope;
        const row = db.select().from(messages).where(eq(messages.id, source.id)).get();
        if (source.kind !== "message") {
          return "rejected";
        }
        if (!row) {
          return "waiting";
        }
        if (row.originHostId !== sourceHostId || row.deletedAt !== null
          || row.conversationId !== payload.conversation_id || row.rev > source.rev) {
          return "rejected";
        }
        return row.rev < source.rev ? "waiting" : "ready";
      },
      admit(tx, clock, { envelope, sourceHostId, payload }) {
        options.beforeAdmission?.(payload.note);
        const id = enqueueJob(tx, clock, {
          queue: admissionQueue,
          payload: { sourceHostId, source: envelope.source, payload },
        });
        if (options.failAdmission) {
          throw new Error("注入准入事务失败");
        }
        return { id };
      },
    });
  }
  const ctx = await startHost({
    dataDir: dir, port: 0, clock, onError: () => {},
  }, [gateway, jobRunner]);
  cleanup.push(ctx.stop);
  const token = readFileSync(join(dir, "host-admin.token"), "utf8");
  const admin = (path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${gateway.port}/host${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function descriptor(): Promise<PeerDescriptor> {
    const result = await admin("/peer-identity");
    expect(result.status).toBe(200);
    return result.json();
  }
  return { ctx, dir, clock, channel, gateway, admin, descriptor };
}

type Host = Awaited<ReturnType<typeof launch>>;

function approval(identity: PeerDescriptor) {
  return { identity, confirmed_fingerprint: identity.fingerprint };
}

async function pair(a: Host, b: Host) {
  const remote = await b.descriptor();
  const permitted = await a.admin(`/peers/${remote.host_id}`, "PUT", { ...approval(remote), allow_join: true });
  expect(permitted.status, await permitted.text()).toBe(200);
  const connected = await b.admin("/peers/connect", "POST", { ...approval(await a.descriptor()), join_household: true });
  expect(connected.status, await connected.text()).toBe(200);
  const paused = await b.admin(`/peers/${a.ctx.hostId}/sync`, "PUT", { paused: true });
  expect(paused.status, await paused.text()).toBe(200);
  expect(a.ctx.householdId).toEqual(b.ctx.householdId);
  expect(a.ctx.hostId).not.toEqual(b.ctx.hostId);
}

async function reconnect(a: Host, b: Host) {
  const reapproved = await a.admin(`/peers/${b.ctx.hostId}`, "PUT", approval(await b.descriptor()));
  expect(reapproved.status, await reapproved.text()).toBe(200);
  const connected = await b.admin("/peers/connect", "POST", approval(await a.descriptor()));
  expect(connected.status, await connected.text()).toBe(200);
}

function seedConversation(a: Host, b: Host) {
  const aDb = a.ctx.store.db;
  const bDb = b.ctx.store.db;
  const host = aDb.select().from(hosts).where(eq(hosts.id, a.ctx.hostId)).get()!;
  const group = aDb.select().from(conversations).where(and(
    eq(conversations.householdId, a.ctx.householdId), eq(conversations.kind, "group"),
  )).get()!;
  // 模拟复制已经落盘的前置业务事实，R6.4 单独验证复制通道。
  bDb.insert(hosts).values(host).onConflictDoNothing().run();
  bDb.insert(conversations).values(group).onConflictDoNothing().run();
  return group.id;
}

function source(a: Host, b: Host, conversationId: string, note: string) {
  const row = {
    ...businessRow(a.clock, a.ctx.hostId),
    conversationId,
    text: note,
    modality: "text" as const,
    status: "complete" as const,
  };
  const draft: PeerBehaviorDraft = {
    targetHostId: b.ctx.hostId,
    idempotencyKey: uuidv7(a.clock),
    kind: "group_speak",
    source: { kind: "message", id: row.id, rev: row.rev },
    payload: { conversation_id: conversationId, note },
  };
  function write() {
    return a.ctx.store.db.transaction((tx) => {
      tx.insert(messages).values(row).run();
      return a.channel.stage(a.ctx, tx, draft);
    }, { behavior: "immediate" });
  }
  return { row, draft, write };
}

function inboxRows(host: Host) {
  return host.ctx.store.db.select().from(peerInbox).all();
}

function admissionJobs(host: Host) {
  return host.ctx.store.db.select().from(jobs).where(eq(jobs.queue, admissionQueue)).all();
}

async function post(sender: Host, receiver: Host, envelope: unknown) {
  return sender.gateway.peerTransport!.request(receiver.ctx.hostId, "inbox", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
}

test("mTLS 双宿主乱序、来源晚到、原收据丢失及双端重启，只落地一次", async () => {
  const admitted: string[] = [];
  let loseReceipt = false;
  let firstReceipt: PeerReceipt | null = null;
  const a = await launch({
    async intercept(response) {
      if (response.ok && loseReceipt) {
        firstReceipt = await response.json();
        throw new Error("接收方已提交，注入响应丢失");
      }
      return response;
    },
  });
  const b = await launch({ beforeAdmission: (note) => admitted.push(note) });
  await pair(a, b);
  const conversationId = seedConversation(a, b);

  const early = source(a, b, conversationId, "先入队，来源晚到");
  const earlyId = early.write().id;
  const readEarly = (host: Host) => getPeerDelivery(host.ctx.store.db, earlyId)!;
  const readJob = (host: Host) => getJob(host.ctx.store.db, readEarly(host).jobId)!;
  await eventually(() => expect(readJob(a).lastError).toContain("peer_source_pending"));
  expect(readEarly(a)).toMatchObject({ status: "pending", receipt: null });
  expect(inboxRows(b)).toHaveLength(0);

  const later = source(a, b, conversationId, "第二条先到");
  b.ctx.store.db.insert(messages).values(later.row).run();
  const laterId = later.write().id;
  await eventually(() => expect(getPeerDelivery(a.ctx.store.db, laterId)?.status).toBe("delivered"));
  expect(admitted).toEqual(["第二条先到"]);

  loseReceipt = true;
  b.ctx.store.db.insert(messages).values(early.row).run();
  expect(inboxRows(b)).toHaveLength(1);
  a.clock.advance(1001);
  await eventually(() => expect(readJob(a).lastError).toContain("注入响应丢失"));
  expect(readEarly(a)).toMatchObject({ status: "pending", receipt: null });
  expect(admitted).toEqual(["第二条先到", "先入队，来源晚到"]);
  expect(inboxRows(b)).toHaveLength(2);
  expect(admissionJobs(b)).toHaveLength(2);

  const savedFingerprint = (await b.descriptor()).fingerprint;
  await a.ctx.stop();
  await b.ctx.stop();
  const a2 = await launch({ dir: a.dir });
  const b2 = await launch({ dir: b.dir, disableAdmission: true });
  expect((await b2.descriptor()).fingerprint).toBe(savedFingerprint);
  await reconnect(a2, b2);
  // 已准入行为的原有收据不依赖当前来源仍有效或接收方还注册同一个行为。
  b2.ctx.store.db.update(messages).set({ deletedAt: b2.clock.wallMs(), rev: 2 })
    .where(eq(messages.id, early.row.id)).run();
  a2.clock.setWallMs(Math.max(a2.clock.wallMs(), readJob(a2).runAt + 1));
  await eventually(() => expect(readEarly(a2).status).toBe("delivered"));
  expect(readEarly(a2).receipt).toEqual(firstReceipt);
  expect(readJob(a2).status).toBe("done");
  const repeat = await post(a2, b2, readEarly(a2).envelope);
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toEqual(firstReceipt);
  const changed = await post(a2, b2, {
    ...readEarly(a2).envelope, payload: { conversation_id: conversationId, note: "换载荷" },
  });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: { code: "peer_idempotency_conflict" } });
  const extraField = await post(a2, b2, {
    ...readEarly(a2).envelope,
    payload: { ...readEarly(a2).envelope.payload, ["__proto__"]: 1 },
  });
  expect(extraField.status).toBe(409);
  expect(await extraField.json()).toEqual({ error: { code: "peer_idempotency_conflict" } });
  expect(inboxRows(b2)).toHaveLength(2);
  expect(admissionJobs(b2)).toHaveLength(2);
});

test("写入来源、投递和认领在同一事务，拒绝未注册行为并校验目标签发资格", async () => {
  const a = await launch();
  const b = await launch({ disableAdmission: true });
  await pair(a, b);
  const conversationId = seedConversation(a, b);
  const pending = source(a, b, conversationId, "事务回滚");
  const db = a.ctx.store.db;
  let rolledBackId: string | undefined;
  expect(() => db.transaction((tx) => {
    tx.insert(messages).values(pending.row).run();
    rolledBackId = a.channel.stage(a.ctx, tx, pending.draft).id;
    throw new Error("业务事务回滚");
  })).toThrow("业务事务回滚");
  expect(rolledBackId).toBeDefined();
  expect(getPeerDelivery(db, rolledBackId!)).toBeUndefined();
  expect(db.select().from(messages).where(eq(messages.id, pending.row.id)).get()).toBeUndefined();
  expect(db.select().from(jobs).all()).toHaveLength(0);

  expect(() => db.transaction((tx) => a.channel.stage(a.ctx, tx, pending.draft))).toThrow();
  expect(() => db.transaction((tx) => a.channel.stage(a.ctx, tx, { ...pending.draft, kind: "relay" }))).toThrow();
  const staged = pending.write();
  expect(db.transaction((tx) => a.channel.stage(a.ctx, tx, {
    ...pending.draft, payload: { note: pending.row.text, conversation_id: conversationId },
  })).id).toBe(staged.id);
  expect(() => db.transaction((tx) => a.channel.stage(a.ctx, tx, {
    ...pending.draft, payload: { conversation_id: conversationId, note: "不同" },
  }))).toThrow();

  const badHost = await post(a, b, { ...staged.envelope, target_host_id: a.ctx.hostId });
  expect(badHost.status).toBe(403);
  const badHousehold = await post(a, b, { ...staged.envelope, household_id: uuidv7(a.clock) });
  expect(badHousehold.status).toBe(403);
  const badClaim = await post(a, b, { ...staged.envelope, source_host_id: b.ctx.hostId });
  expect(badClaim.status).toBe(400);
  const invalid = await post(a, b, { ...staged.envelope, payload: {} });
  expect(invalid.status).toBe(400);
  const wrongVersion = await post(a, b, { ...staged.envelope, inbox_version: 2 });
  expect(wrongVersion.status).toBe(409);
  const unsupported = await post(a, b, staged.envelope);
  expect(unsupported.status).toBe(422);
  expect(await unsupported.json()).toEqual({ error: { code: "peer_behavior_unsupported" } });

  const stranger = await launch();
  const remote = await b.descriptor();
  const foreignCredential = await initializePeerIdentity(stranger.dir, stranger.clock, stranger.ctx.hostId);
  await expect(requestPeerHttps(foreignCredential.current(), {
    hostId: b.ctx.hostId,
    addressHost: remote.address.host,
    addressPort: remote.address.port,
    caCertificate: remote.ca_certificate,
    fingerprint: remote.fingerprint,
  }, "POST", "/peer/inbox", {
    headers: { "x-cattt-peer-version": "1", "content-type": "application/json" },
    body: JSON.stringify(staged.envelope),
  })).rejects.toThrow();

  await eventually(() => expect(getPeerDelivery(db, staged.id)?.status).toBe("rejected"));
  expect(getPeerDelivery(db, staged.id)?.receipt).toBeNull();
  expect(getJob(db, staged.jobId)?.status).toBe("dead");
  expect(inboxRows(b)).toHaveLength(0);
});

test("准入异常回滚，发送端只确认匹配原请求的持久收据", async () => {
  let tamper = false;
  const a = await launch({
    async intercept(response) {
      if (!tamper || !response.ok) {
        return response;
      }
      return Response.json({ ...(await response.json() as object), request_hash: "0".repeat(64) });
    },
  });
  const b = await launch({ failAdmission: true });
  await pair(a, b);
  const conversationId = seedConversation(a, b);
  const pending = source(a, b, conversationId, "收据核对");
  b.ctx.store.db.insert(messages).values(pending.row).run();
  const staged = pending.write();
  const job = () => getJob(a.ctx.store.db, staged.jobId)!;
  const row = () => getPeerDelivery(a.ctx.store.db, staged.id)!;
  await eventually(() => expect(job().lastError).toContain("500"));
  expect(row().receipt).toBeNull();
  expect(inboxRows(b)).toHaveLength(0);
  expect(admissionJobs(b)).toHaveLength(0);

  await b.ctx.stop();
  const b2 = await launch({ dir: b.dir });
  await reconnect(a, b2);
  tamper = true;
  a.clock.setWallMs(job().runAt + 1);
  await eventually(() => expect(job().lastError).toContain("peer_receipt_invalid"));
  expect(row()).toMatchObject({ status: "pending", receipt: null });
  expect(inboxRows(b2)).toHaveLength(1);
  expect(admissionJobs(b2)).toHaveLength(1);

  tamper = false;
  a.clock.setWallMs(job().runAt + 1);
  await eventually(() => expect(row().status).toBe("delivered"));
  expect(inboxRows(b2)).toHaveLength(1);
  expect(admissionJobs(b2)).toHaveLength(1);
});

test("撤销、只读和不兼容版本不发新行为，已入队行为等重连", async () => {
  let actualRequests = 0;
  const a = await launch({
    protocol: compatibleV1,
    beforeRequest: () => { actualRequests += 1; },
  });
  const b = await launch({ protocol: compatibleV1 });
  await pair(a, b);
  const conversationId = seedConversation(a, b);
  const pending = source(a, b, conversationId, "升级后重连");
  const staged = pending.write();
  const job = () => getJob(a.ctx.store.db, staged.jobId)!;
  await eventually(() => expect(job().lastError).toContain("peer_source_pending"));
  expect(actualRequests).toBe(1);
  await b.ctx.stop();
  const b2 = await launch({ dir: b.dir, protocol: { version: 2, readOnlyVersions: [1] } });
  await reconnect(a, b2);
  expect(() => source(a, b2, conversationId, "只读").write()).toThrow();
  a.clock.setWallMs(job().runAt + 1);
  await eventually(() => expect(job().lastError).toContain("peer_write_unavailable"));
  expect(actualRequests).toBe(1);

  await b2.ctx.stop();
  const b3 = await launch({ dir: b.dir, protocol: { version: 3, readOnlyVersions: [] } });
  const advertised = await b3.descriptor();
  expect((await a.admin("/peers/connect", "POST", approval(advertised))).status).toBe(409);
  expect(() => source(a, b3, conversationId, "未知版本").write()).toThrow();
  a.clock.setWallMs(job().runAt + 1);
  const attempts = job().attempts;
  await eventually(() => {
    expect(job().attempts).toBeGreaterThan(attempts);
    expect(job().status).toBe("queued");
  });
  expect(actualRequests).toBe(1);

  const revoked = await a.admin(`/peers/${b.ctx.hostId}`, "DELETE");
  expect(revoked.status).toBe(200);
  expect(() => source(a, b3, conversationId, "已撤销").write()).toThrow();
  const revokedAttempts = job().attempts;
  a.clock.setWallMs(job().runAt + 1);
  await eventually(() => {
    expect(job().attempts).toBeGreaterThan(revokedAttempts);
    expect(job().status).toBe("queued");
  });
  expect(actualRequests).toBe(1);
  expect(getPeerDelivery(a.ctx.store.db, staged.id)?.status).toBe("pending");
  await b3.ctx.stop();

  const restored = await launch({ dir: b.dir, protocol: compatibleV1 });
  await reconnect(a, restored);
  restored.ctx.store.db.insert(messages).values(pending.row).run();
  a.clock.setWallMs(job().runAt + 1);
  await eventually(() => expect(getPeerDelivery(a.ctx.store.db, staged.id)?.status).toBe("delivered"));
  expect(actualRequests).toBe(2);
  expect(admissionJobs(restored)).toHaveLength(1);
});

test("核对资格与信任后只准入真实且未撤回的来源", async () => {
  const a = await launch();
  const b = await launch();
  await pair(a, b);
  const conversationId = seedConversation(a, b);
  const pending = source(a, b, conversationId, "来源不能冒名");
  const staged = pending.write();
  b.ctx.store.db.insert(messages).values({ ...pending.row, originHostId: b.ctx.hostId }).run();
  const rejected = await post(a, b, staged.envelope);
  expect(rejected.status).toBe(422);
  expect(await rejected.json()).toEqual({ error: { code: "peer_behavior_rejected" } });
  expect(inboxRows(b)).toHaveLength(0);
  expect(admissionJobs(b)).toHaveLength(0);
});
