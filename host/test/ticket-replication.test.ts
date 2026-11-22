import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createHostComponents } from "../src/runtime/components.ts";
import { startHost } from "../src/runtime/index.ts";
import { quietGroupReply } from "../src/store/conversations.ts";
import { readKnowledgeSource } from "../src/store/knowledge-source.ts";
import { SystemClock } from "../src/clock/index.ts";
import { ExecutionStopped } from "../src/store/ticket-worker.ts";
import { claimJob, completeJob } from "../src/store/jobs.ts";
import { commitWorkerResult, readConversationHead } from "../src/store/ticket-worker.ts";
import { discoverReports, publishReport } from "../src/store/report-publications.ts";
import { replicaAdapters } from "../src/store/replica-records.ts";
import { revision } from "../src/store/business.ts";
import { getNativeReplicationSource, getPeerCursor, readChangePage, rotateReplicationGeneration } from "../src/store/replication.ts";
import { readNativeSnapshot } from "../src/store/replication-snapshot.ts";
import { reviseTicket } from "../src/store/tickets.ts";
import { conversations, decisions, jobs, mailboxLetters, peerInbox, runs, ticketInputs, tickets, triggers, turns, workerReports } from "../src/store/schema/index.ts";
import type { TicketJob } from "../src/tickets/types.ts";
import { createDevice } from "../src/store/identity.ts";
import type { HostContext } from "../src/runtime/index.ts";
import { issueTestDevice } from "./identity-fixture.ts";

async function launch(dir: string) {
  const { gateway, components } = createHostComponents({ peerPort: 0, peerHostname: "127.0.0.1", lanPort: 0 }, quietGroupReply);
  const clock = new SystemClock(crypto.randomUUID());
  const errors: unknown[] = [];
  const host = await startHost({
    dataDir: dir, port: 0, clock,
    ticketAdmission: { readKnowledgeSource, publicationTimeZone: () => "Asia/Shanghai" },
    onError: (error) => { errors.push(error); },
    replier: { async *reply() { yield "我在"; } },
  }, components);
  const admin = readFileSync(join(dir, "host-admin.token"), "utf8");
  const ca = readFileSync(join(dir, "tls/ca.crt"), "utf8");
  async function call(path: string, method = "GET", data?: unknown, token?: string) {
    const origin = token ? `https://127.0.0.1:${gateway.lanPort}` : `http://127.0.0.1:${gateway.port}`;
    const reply = await fetch(origin + path, {
      method, tls: { ca }, signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token ?? admin}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: reply.status, body: await reply.json() };
  }
  return { host, call, db: host.store.db, clock, errors };
}

function issueTestDeviceForMember(host: HostContext, memberId: string) {
  return createDevice(host.store.db, host.clock, { memberId, hostId: host.hostId, name: "临时设备" }).token;
}

async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (performance.now() >= deadline) throw new Error(`等待超时：${JSON.stringify(value)}`);
    await Bun.sleep(35);
  }
}

test("两个设备经各自 HTTPS 读取事项及信箱，mTLS 同步保留来源、已读和墓碑，交接封住旧报告", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r610-"));
  const a = await launch(join(root, "a"));
  let b: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const other = b = await launch(join(root, "b"));
    const alice = issueTestDevice(a.host, "甲");
    const ad = (await a.call("/host/peer-identity")).body;
    const bd = (await other.call("/host/peer-identity")).body;
    expect((await a.call(`/host/peers/${bd.host_id}`, "PUT", {
      identity: bd, confirmed_fingerprint: bd.fingerprint, allow_join: true,
    })).status).toBe(200);
    expect((await other.call("/host/peers/connect", "POST", {
      identity: ad, confirmed_fingerprint: ad.fingerprint, join_household: true,
    })).status).toBe(200);
    const aliceConversations = (await a.call("/v2/conversations", "GET", undefined, alice.token)).body.conversations;
    const group: string = aliceConversations.find((row: { kind: string }) => row.kind === "group").id;
    const aliceDirect: string = aliceConversations.find((row: { kind: string }) => row.kind === "direct").id;
    await until(() => other.db.select().from(conversations).where(eq(conversations.id, group)).get(), Boolean);
    const bob = issueTestDevice(other.host, "乙");
    const bobDirect: string = (await other.call("/v2/conversations", "GET", undefined, bob.token)).body.conversations
      .find((row: { kind: string }) => row.kind === "direct").id;
    await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");
    const send = (node: typeof a, token: string, id: string, text: string) => node.call(
      `/v2/conversations/${id}/messages`, "POST", { text, client_message_id: crypto.randomUUID() }, token,
    );
    await until(() => other.call("/v2/conversations", "GET", undefined, bob.token),
      ({ body }) => body.conversations.some((row: { id: string }) => row.id === group));
    const ordinary = await send(other, bob.token, group, "今天阳光很好。");
    expect(ordinary.status).toBe(202);
    const receipt = await until(() => other.call(ordinary.body.receipt_url, "GET", undefined, bob.token),
      ({ status }) => status === 200);
    expect(receipt.body.turn).toBeNull();
    expect(a.db.select().from(turns).where(eq(turns.triggerMessageId, receipt.body.message.id)).get()).toBeUndefined();
    const called = await send(other, bob.token, group, "团子，来和我们打声招呼。");
    const calledReceipt = await until(() => other.call(called.body.receipt_url, "GET", undefined, bob.token),
      ({ status }) => status === 200);
    await until(() => a.db.select().from(turns).where(eq(turns.triggerMessageId, calledReceipt.body.message.id)).get(),
      (row) => row?.status === "completed");
    expect(other.db.select().from(turns).where(eq(turns.triggerMessageId, calledReceipt.body.message.id)).get()).toBeUndefined();

    async function schedule(node: typeof a, token: string, conversation: string, source: string) {
      const result = await node.call("/v2/tickets", "POST", {
        kind: "schedule", conversation_id: conversation, source_message_id: source, source_revision: 1,
        when: new Date(node.clock.wallMs() + 4 * 86_400_000).toISOString(), about: "搬家",
      }, token);
      expect(result.status).toBe(201);
      return result.body.ticket_id as string;
    }
    const aliceMessage = (await send(a, alice.token, aliceDirect, "记得聊搬家")).body.message;
    const bobMessage = (await send(other, bob.token, bobDirect, "之后聊搬家")).body.message;
    const aliceTicket = await schedule(a, alice.token, aliceDirect, aliceMessage.id);
    const bobTicket = await schedule(other, bob.token, bobDirect, bobMessage.id);
    const groupTicket = await schedule(a, alice.token, group, (await send(a, alice.token, group, "一起聊搬家")).body.message.id);
    await until(() => a.db.select().from(tickets).where(eq(tickets.id, bobTicket)).get(), Boolean);
    await until(() => other.db.select().from(tickets).where(eq(tickets.id, groupTicket)).get(), Boolean);
    expect((await a.call(`/v2/tickets/${bobTicket}`, "GET", undefined, alice.token)).status).toBe(404);
    expect((await other.call(`/v2/tickets/${groupTicket}`, "GET", undefined, bob.token)).status).toBe(404);

    // Replica merging settles same-revision forks, then a tombstone wins even at that revision.
    const source = getNativeReplicationSource(a.db, a.host.hostId);
    const ticket = await until(() => other.db.select().from(tickets).where(eq(tickets.id, aliceTicket)).get(), Boolean);
    other.db.transaction((tx) => {
      const newer = { ...ticket!, ...revision(a.clock), goal: "改过的目标" };
      expect(replicaAdapters.ticket.apply(tx, source, newer)).toBe(true);
      expect(replicaAdapters.ticket.apply(tx, source, { ...newer, deletedAt: newer.updatedAt })).toBe(true);
      expect(replicaAdapters.ticket.apply(tx, source, newer)).toBe(false);
      expect(tx.select().from(tickets).where(eq(tickets.id, aliceTicket)).get()?.goal).toBe("改过的目标");
    });
    // Use the real repository mutation with the job still scheduled in the future.
    for (const node of [a, other]) {
      const id = node === a ? aliceTicket : bobTicket;
      const row = node.db.select().from(tickets).where(eq(tickets.id, id)).get()!;
      node.db.transaction((tx) => reviseTicket(tx, node.clock, row, { deletedAt: node.clock.wallMs() }));
    }
    await until(() => other.db.select().from(tickets).where(eq(tickets.id, aliceTicket)).get(), (row) => !!row?.deletedAt);
    await until(() => a.db.select().from(tickets).where(eq(tickets.id, bobTicket)).get(), (row) => !!row?.deletedAt);
    for (const node of [a, other]) {
      const snapshot = readNativeSnapshot(node.db, node.host.hostId);
      expect(snapshot.records.some(({ kind }) => kind === "ticket")).toBe(true);
      const page = readChangePage(node.db, node.host.hostId, null, 100);
      expect(page.changes.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["ticket", "ticket_trigger", "ticket_decision"]));
      expect(page.changes.map(({ kind }) => kind)).not.toEqual(expect.arrayContaining(["run"]));
    }
    await until(() => other.db.select().from(decisions).all(), (rows) => rows.length === 3);
    const submit = async (node: typeof a, token: string, conversation: string, source: string) => {
      const response = await node.call("/v2/tickets", "POST", {
        kind: "start", goal: "整理搬家清单", conversation_id: conversation, source_message_id: source, source_revision: 1,
      }, token);
      expect(response.status).toBe(201);
      return response.body.ticket_id as string;
    };
    // Put the report in the daytime of the injected timezone without changing wall time.
    for (const node of [a, other]) {
      const utcHour = new Date(node.clock.wallMs()).getUTCHours();
      const offset = 12 - utcHour;
      node.host.config.ticketAdmission!.publicationTimeZone = () => offset === 0 ? "UTC"
        : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    }
    const settle = (node: typeof a, id: string, text: string) => {
      const attempt = claimJob(node.db, node.clock, "errand", 45_000)!;
      const payload = JSON.parse(attempt.payload) as TicketJob;
      expect(payload.ticketId).toBe(id);
      const ticket = node.db.select().from(tickets).where(eq(tickets.id, id)).get()!;
      const fence = { attempt, payload, clock: node.clock, policy: node.host.config.ticketAdmission, publication: node.host.publication };
      const head = readConversationHead(node.db, ticket, node.clock, undefined, node.host.publication);
      return () => {
        const report = commitWorkerResult(node.db, fence, {
          result: { status: "ready", result: text }, dependencies: [], head,
        })!;
        completeJob(node.db, node.clock, attempt);
        discoverReports(node.host);
        return report;
      };
    };
    const remoteBob = await send(other, bob.token, group, "请整理搬家清单");
    const bobSource = (await until(() => other.call(remoteBob.body.receipt_url, "GET", undefined, bob.token),
      ({ status }) => status === 200)).body.message.id;
    await until(() => a.db.select().from(triggers).all(), (rows) => rows.length === 3);
    await until(() => other.db.select().from(turns).where(eq(turns.triggerMessageId, bobMessage.id)).get(),
      (row) => row?.status === "completed");
    const bobAtA = issueTestDeviceForMember(a.host, bob.memberId);
    const remoteTicket = await submit(a, bobAtA, group, bobSource);
    expect((await a.call(`/v2/tickets/${remoteTicket}`, "PATCH", { text: "只看周末" }, bobAtA)).status).toBe(200);
    const directTicket = await submit(other, bob.token, bobDirect, bobMessage.id);
    await until(() => a.db.select().from(turns).all(), (rows) =>
      rows.every((row) => row.status !== "queued" && row.status !== "generating"));
    const ownAliceTicket = await submit(a, alice.token, aliceDirect, aliceMessage.id);
    const aliceProof = settle(a, remoteTicket, "群聊事项的信")();
    const bobProof = settle(other, directTicket, "乙单聊事项的信")();
    const ownAliceProof = settle(a, ownAliceTicket, "甲单聊事项的信")();
    const firstLetter = publishReport(a.host, aliceProof.id)!;
    expect(publishReport(a.host, ownAliceProof.id)).toMatchObject({ status: "published" });
    const secondLetter = publishReport(other.host, bobProof.id)!;
    expect(firstLetter.status).toBe("published");
    expect(typeof firstLetter.letterId).toBe("string");
    expect(secondLetter.status).toBe("published");
    expect(typeof secondLetter.letterId).toBe("string");
    await until(() => other.db.select().from(ticketInputs).where(eq(ticketInputs.ticketId, remoteTicket)).get(),
      (row) => row?.text === "只看周末");
    await until(() => other.db.select().from(mailboxLetters).where(eq(mailboxLetters.id, firstLetter.letterId!)).get(), Boolean);
    await until(() => a.db.select().from(mailboxLetters).where(eq(mailboxLetters.id, secondLetter.letterId!)).get(), Boolean);
    const mail = (node: typeof a, token: string) => node.call("/v2/mailbox", "GET", undefined, token);
    expect((await mail(a, alice.token)).body.letters.map((row: { text: string }) => row.text)).toEqual(["甲单聊事项的信"]);
    await until(() => other.db.select().from(mailboxLetters).all(), (rows) => rows.length === 3);
    expect((await mail(other, bob.token)).body.letters.map((letter: { text: string }) => letter.text).sort())
      .toEqual(["乙单聊事项的信", "群聊事项的信"].sort());
    const read = await other.call(`/v2/mailbox/${firstLetter.letterId}/read`, "POST", undefined, bob.token);
    expect(read.status).toBe(200);
    expect(typeof read.body.letter.read_at).toBe("number");
    await until(() => mail(a, bobAtA), ({ body }) => body.letters.some(
      (letter: { id: string; read_at: number }) => letter.id === firstLetter.letterId && letter.read_at === read.body.letter.read_at));
    expect(readNativeSnapshot(other.db, other.host.hostId).records.map(({ kind }) => kind))
      .toEqual(expect.arrayContaining(["mailbox_read", "ticket_publication"]));
    expect(other.db.select().from(workerReports).all()).toHaveLength(1);
    expect(other.db.select().from(runs).all()).toHaveLength(1);
    expect(other.db.select().from(jobs).all().filter((row) => row.queue === "errand")).toHaveLength(1);

    const staleSource = (await send(a, alice.token, group, "再整理另一个清单")).body.message.id;
    const oldId = await submit(a, alice.token, group, staleSource);
    const oldReport = settle(a, oldId, "旧代不能发出的信")();
    const inFlight = await submit(a, alice.token, group, staleSource);
    const staleCommit = settle(a, inFlight, "不能用新凭据提交的旧计算");
    const waitingForOldWorker = await submit(a, alice.token, group, staleSource);
    expect(a.db.select().from(tickets).where(eq(tickets.id, waitingForOldWorker)).get()?.stage).toBe("thinking");
    const handoff = crypto.randomUUID();
    await until(() => a.call(`/host/peers/${other.host.hostId}/lease`, "POST", {
      request_id: handoff, expected_epoch: 1,
    }), ({ status }) => status === 200);
    expect(publishReport(a.host, oldReport.id)).toMatchObject({ status: "dropped", letterId: null, messageId: null });
    await until(() => other.call("/host/publication-lease"), ({ body }) => body.epoch === 2 && body.status === "ready");
    expect(staleCommit).toThrow(ExecutionStopped);
    const afterHandoff = await submit(a, alice.token, aliceDirect, aliceMessage.id);
    expect(a.db.select().from(tickets).where(eq(tickets.id, afterHandoff)).get()?.stage).toBe("thinking");
    const newSource = await send(other, bob.token, group, "接下来再聊新安排");
    expect(newSource.status).toBe(201);
    const newTicket = await schedule(other, bob.token, group, newSource.body.message.id);
    await until(() => a.db.select().from(tickets).where(eq(tickets.id, newTicket)).get(),
      (row) => row?.publicationEpoch === 2 && row.publisherHostId === other.host.hostId);
    expect(other.db.select().from(tickets).where(eq(tickets.id, oldId)).get()).toBeDefined();
    const peerBefore = a.db.select().from(peerInbox).all().length;
    const aJobsBefore = a.db.select().from(jobs).all().length;
    const bJobsBefore = other.db.select().from(jobs).all().length;
    const rotated = rotateReplicationGeneration(a.db, a.host.hostId);
    await until(() => getPeerCursor(other.db, a.host.hostId),
      (cursor) => cursor?.generation === rotated.generation);
    expect(a.db.select().from(peerInbox).all()).toHaveLength(peerBefore);
    expect(a.db.select().from(jobs).all()).toHaveLength(aJobsBefore);
    expect(other.db.select().from(jobs).all()).toHaveLength(bJobsBefore);
    const oldTicket = other.db.select().from(tickets).where(eq(tickets.id, oldId)).get()!;
    other.db.transaction((tx) => {
      expect(replicaAdapters.ticket.apply(tx, getNativeReplicationSource(a.db, a.host.hostId), oldTicket)).toBe(false);
      expect(() => replicaAdapters.ticket.apply(tx, getNativeReplicationSource(a.db, a.host.hostId),
        { ...oldTicket, ...revision(a.clock), rev: oldTicket.rev + 1, goal: "封停后新写入" })).toThrow("来源宿主无权写入");
    });
    expect(a.db.select().from(peerInbox).all().length).toBeGreaterThanOrEqual(2);
    expect([...a.errors, ...other.errors]).toEqual([]);
  } finally {
    await b?.host.stop();
    await a.host.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);
