import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock } from "../src/clock/index.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { saveMemory } from "../src/store/knowledge.ts";
import { getPeerCursor, rotateReplicationGeneration } from "../src/store/replication.ts";
import { jobs, mailboxLetters, peerInbox, turns } from "../src/store/schema/index.ts";

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error(`等待超时：${JSON.stringify(value)}`);
    await Bun.sleep(40);
  }
}

test("产品入口同时运行群聊转投和交接、转告、知识附件、事项信箱与手机游标", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r611-"));
  const stops: (() => Promise<void>)[] = [];
  const errors: unknown[] = [];
  const offset = 12 - new Date().getUTCHours();
  const timeZone = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
  async function launch(name: string) {
    const dir = join(root, name);
    const gateway = new Gateway({ peerPort: 0, peerHostname: "127.0.0.1", lanPort: 0 });
    const host = await startConfiguredHost({
      dataDir: dir, port: 0, clock: new SystemClock(crypto.randomUUID()),
      onError: (error) => { errors.push(error); },
      model: modelConfigFromEnv({ MODEL_PROVIDER: "mock", MOCK_DELAY_MS: "0" }),
      replier: { async *reply() { yield "团子在这里"; } },
      ticketAdmission: { publicationTimeZone: () => timeZone },
    }, gateway);
    stops.push(host.stop);
    const ca = readFileSync(join(dir, "tls/ca.crt"), "utf8");
    const admin = readFileSync(join(dir, "host-admin.token"), "utf8");
    async function request(path: string, method = "GET", body?: unknown, token?: string, headers = {}, phone = token !== undefined) {
      const origin = phone ? `https://127.0.0.1:${gateway.lanPort}` : `http://127.0.0.1:${gateway.port}`;
      return fetch(origin + path, {
        method, tls: { ca }, signal: AbortSignal.timeout(7000),
        headers: {
          ...(phone && !token ? {} : { authorization: `Bearer ${token ?? admin}` }),
          "content-type": "application/json", ...headers,
        },
        body: body instanceof Uint8Array ? new Uint8Array(body) : body === undefined ? undefined : JSON.stringify(body),
      });
    }
    async function call(path: string, method?: string, body?: unknown, token?: string) {
      const response = await request(path, method, body, token);
      return { status: response.status, body: await response.json() };
    }
    return { host, db: host.store.db, call, request };
  }

  try {
    const a = await launch("a");
    const b = await launch("b");
    const first = await a.call("/host/members", "POST", { display_name: "甲" });
    expect(first.status).toBe(200);
    const code = await a.call("/host/pairing-codes", "POST", { member_id: first.body.member.id });
    const paired = await a.request("/v2/pair", "POST", {
      code: code.body.code, device_name: "甲手机",
    }, undefined, {}, true);
    expect(paired.status).toBe(200);
    const alice = await paired.json() as { device_token: string; member: { id: string } };
    const ad = (await a.call("/host/peer-identity")).body;
    const bd = (await b.call("/host/peer-identity")).body;
    expect((await a.call(`/host/peers/${bd.host_id}`, "PUT", {
      identity: bd, confirmed_fingerprint: bd.fingerprint, allow_join: true,
    })).status).toBe(200);
    expect((await b.call("/host/peers/connect", "POST", {
      identity: ad, confirmed_fingerprint: ad.fingerprint, join_household: true,
    })).status).toBe(200);
    const invite = await until(() => b.call("/host/invites", "POST", { display_name: "乙" }),
      ({ status }) => status === 200);
    const joined = await b.request("/v2/invites/accept", "POST", {
      code: invite.body.code, display_name: "乙", device_name: "乙手机",
    }, undefined, {}, true);
    expect(joined.status).toBe(200);
    const bob = await joined.json() as typeof alice;
    const phone = (node: typeof a, token: string) => (path: string, method?: string, body?: unknown) =>
      node.call(`/v2${path}`, method, body, token);
    const pa = phone(a, alice.device_token);
    const pb = phone(b, bob.device_token);
    const conversations = async (p: typeof pa) => (await p("/conversations")).body.conversations as { id: string; kind: string }[];
    const group = (await conversations(pa)).find((row) => row.kind === "group")!.id;
    const directA = (await conversations(pa)).find((row) => row.kind === "direct")!.id;
    const directB = (await conversations(pb)).find((row) => row.kind === "direct")!.id;
    await until(() => conversations(pb), (rows) => rows.some((row) => row.id === group));
    await until(() => a.call("/host/publication-lease"), ({ body }) => body.status === "ready");

    const send = (p: typeof pa, id: string, text: string) => p(`/conversations/${id}/messages`, "POST", {
      text, client_message_id: crypto.randomUUID(),
    });
    const forwarded = await send(pb, group, "团子，来和我们打个招呼");
    expect(forwarded.status).toBe(202);
    const receipt = await until(() => b.call(forwarded.body.receipt_url, "GET", undefined, bob.device_token),
      ({ status }) => status === 200);
    const groupMessage = receipt.body.message.id as string;
    await until(() => a.db.select().from(turns).where(eq(turns.triggerMessageId, groupMessage)).get(),
      (row) => row?.status === "completed");
    expect(b.db.select().from(turns).where(eq(turns.triggerMessageId, groupMessage)).get()).toBeUndefined();

    expect((await pb("/me/proactive", "PATCH", { allow_proactive: false, time_zone: timeZone })).status).toBe(200);
    const privateMessage = (await send(pa, directA, "帮我转告：带上雨伞")).body.message.id as string;
    const relay = await pa("/relays", "POST", { source_message_id: privateMessage, source_revision: 1 });
    expect(relay.status, JSON.stringify(relay.body)).toBe(200);
    await until(() => pb(`/conversations/${directB}/messages`), ({ body }) =>
      body.messages.some((row: { text: string }) => row.text === "甲托我转告你：带上雨伞"));

    const memory = saveMemory(a.db, a.host.clock, {
      householdId: a.host.householdId, sourceMemberId: alice.member.id, sourceMessageId: privateMessage,
      sourceRevision: 1, subjectMemberId: bob.member.id, fingerprint: "umbrella", predicate: "雨具", value: "带伞",
    })!;
    expect(memory.originHostId).toBe(a.host.hostId);
    const diary = await pa("/diary", "POST", {
      request_id: crypto.randomUUID(), text: "雨天日记", recorded_at: Date.UTC(2026, 10, 22),
      local_day: "2026-11-22", time_zone: "UTC", cat_allowed: true,
      source: { conversation_id: directA, message_id: privateMessage, revision: 1 },
    });
    expect(diary.status).toBe(201);
    const diaryId = diary.body.entry.id as string;
    const bytes = new TextEncoder().encode("R6.11 附件");
    const upload = await pa("/files/uploads", "POST", {
      client_upload_id: crypto.randomUUID(), conversation_id: group, file_name: "雨伞.txt",
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), byte_size: bytes.length,
      media_type: "text/plain",
    });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const uploadPath = `/v2/files/uploads/${upload.body.id}`;
    expect((await a.request(uploadPath, "PATCH", bytes, alice.device_token, {
      "content-type": "application/octet-stream", "upload-offset": "0",
    })).status).toBe(200);
    const finished = await a.call(uploadPath + "/complete", "POST", undefined, alice.device_token);
    expect(finished.status).toBe(201);
    const fileId = finished.body.file.id as string;
    await until(() => pb(`/files/${fileId}`), ({ body }) => body.file?.available === true);
    const downloaded = await b.request(`/v2/files/${fileId}/content`, "GET", undefined, bob.device_token);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    const bobMessage = (await send(pb, directB, "到时聊聊周末带的东西")).body.message.id;
    await until(() => b.db.select().from(turns).where(eq(turns.triggerMessageId, bobMessage)).get(),
      (row) => row?.status === "completed");
    const ticket = await pb("/tickets", "POST", {
      kind: "schedule", about: "整理出门清单", when: new Date(b.host.clock.wallMs() + 1500).toISOString(),
      conversation_id: directB, source_message_id: bobMessage, source_revision: 1,
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const ticketId = ticket.body.ticket_id as string;
    const mailbox = await until(() => pb("/mailbox"), ({ body }) =>
      body.letters.some((row: { ticket_id: string }) => row.ticket_id === ticketId));
    const letter = mailbox.body.letters.find((row: { ticket_id: string }) => row.ticket_id === ticketId);
    const baseline = await pb("/changes");
    expect(baseline.body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "memory", id: memory.id, value: expect.objectContaining({ source: null }) }),
      expect.objectContaining({ kind: "diary", id: diaryId, value: expect.objectContaining({ source: null, cat_readable: true }) }),
      expect.objectContaining({ kind: "file", id: fileId, value: expect.objectContaining({ available: true }) }),
      expect.objectContaining({ kind: "ticket", id: ticketId }),
      expect.objectContaining({ kind: "mailbox_letter", id: letter.id, value: expect.objectContaining({ read_at: null }) }),
    ]));
    for (const hidden of [privateMessage, directA, "帮我转告：带上雨伞", "peer_inbox", "originHostId"]) {
      expect(JSON.stringify(baseline.body)).not.toContain(hidden);
    }
    expect(JSON.stringify((await pa("/changes")).body)).not.toContain(ticketId);
    await pb(`/mailbox/${letter.id}/read`, "POST");
    expect((await pa(`/conversations/${directA}/messages/${privateMessage}/withdraw`, "POST", {
      request_id: crypto.randomUUID(), expected_revision: 1,
    })).status).toBe(200);
    const delta = await until(() => pb(`/changes?cursor=${encodeURIComponent(baseline.body.next)}`), ({ body }) =>
      body.changes?.some((row: { kind: string; id: string; op: string }) =>
        row.kind === "memory" && row.id === memory.id && row.op === "delete"));
    expect(delta.body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "diary", id: diaryId, value: expect.objectContaining({ cat_readable: false }) }),
      expect.objectContaining({ kind: "mailbox_letter", id: letter.id, value: expect.objectContaining({ read_at: expect.any(Number) }) }),
    ]));

    const handoff = crypto.randomUUID();
    await until(() => a.call(`/host/peers/${b.host.hostId}/lease`, "POST", {
      request_id: handoff, expected_epoch: 1,
    }), ({ status }) => status === 200);
    await until(() => b.call("/host/publication-lease"), ({ body }) => body.epoch === 2 && body.status === "ready");
    const after = await send(pa, group, "团子，换到这边说话");
    expect(after.status).toBe(202);
    const afterReceipt = await until(() => a.call(after.body.receipt_url, "GET", undefined, alice.device_token),
      ({ status }) => status === 200);
    await until(() => b.db.select().from(turns).where(eq(turns.triggerMessageId, afterReceipt.body.message.id)).get(),
      (row) => row?.status === "completed");
    expect(a.db.select().from(turns).where(eq(turns.triggerMessageId, afterReceipt.body.message.id)).get()).toBeUndefined();

    const counts = () => [a, b].map(({ db }) => [
      db.select().from(peerInbox).all().length, db.select().from(jobs).all().length,
      db.select().from(turns).all().length,
    ]);
    await until(() => a.db.select().from(mailboxLetters).where(eq(mailboxLetters.id, letter.id)).get(), Boolean);
    const previous = counts();
    const rotated = rotateReplicationGeneration(a.db, a.host.hostId);
    await until(() => getPeerCursor(b.db, a.host.hostId), (cursor) => cursor?.generation === rotated.generation);
    expect(counts()).toEqual(previous);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);
