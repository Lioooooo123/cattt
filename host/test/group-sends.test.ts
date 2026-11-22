import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostComponents } from "../src/runtime/components.ts";
import { defaultGroupReply } from "../src/store/conversations.ts";
import { startHost } from "../src/runtime/index.ts";
import type { PeerDescriptor } from "../src/peer/protocol.ts";
import { issueTestDevice } from "./identity-fixture.ts";

async function launch(dir: string, peerPort = 0) {
  const { gateway, components } = createHostComponents({ peerPort, peerHostname: "127.0.0.1", lanPort: 0 }, defaultGroupReply);
  const replies: string[] = [];
  const ctx = await startHost({
    dataDir: dir, port: 0,
    replier: {
      async *reply({ trigger }) {
        replies.push(trigger.text);
        yield "团子回应";
      },
    },
  }, components);
  const admin = readFileSync(join(dir, "host-admin.token"), "utf8");
  const ca = readFileSync(join(dir, "tls/ca.crt"), "utf8");
  async function call(path: string, method = "GET", body?: unknown, phone?: string) {
    const origin = phone ? `https://127.0.0.1:${gateway.lanPort}` : `http://127.0.0.1:${gateway.port}`;
    const response = await fetch(origin + path, {
      method, signal: AbortSignal.timeout(6000), tls: { ca },
      headers: { authorization: `Bearer ${phone ?? admin}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { ctx, gateway, call, replies, dir };
}

type Running = Awaited<ReturnType<typeof launch>>;
async function eventually<T>(read: () => Promise<T> | T, ready: (value: T) => boolean) {
  const deadline = performance.now() + 20_000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error(`等待超时：${JSON.stringify(value)}`);
    await Bun.sleep(40);
  }
}

async function descriptor(host: Running): Promise<PeerDescriptor> {
  const reply = await host.call("/host/peer-identity");
  expect(reply.status).toBe(200);
  return reply.body;
}
const approval = (identity: PeerDescriptor) => ({ identity, confirmed_fingerprint: identity.fingerprint });
const ready = (host: Running, epoch: number) =>
  eventually(() => host.call("/host/publication-lease"), ({ body }) => body.epoch === epoch && body.status === "ready");

function counts(host: Running, groupId: string, key: string, memberId?: string) {
  return host.ctx.store.raw.query<{ id: string; origin_host_id: string; publication_epoch: number; turns: number }, [string, string, string | null]>(
    `SELECT m.id, m.origin_host_id, m.publication_epoch,
      (SELECT count(*) FROM turns WHERE trigger_message_id=m.id) turns
    FROM messages m WHERE m.conversation_id=? AND m.client_message_id=? AND m.author_member_id=coalesce(?, m.author_member_id) ORDER BY m.id`,
  ).all(groupId, key, memberId ?? null);
}

test("手机通过本方 HTTPS、双宿主 mTLS 发送，历史重放、丢回执、断线重启和换代均不重发", async () => {
  const root = mkdtempSync(join(tmpdir(), "cattt-r68-"));
  const hosts: Running[] = [];
  try {
    const a = await launch(join(root, "a"));
    hosts.push(a);
    let b = await launch(join(root, "b"));
    hosts.push(b);
    const alice = issueTestDevice(a.ctx, "甲");
    const initial = await a.call("/v2/conversations", "GET", undefined, alice.token);
    const group = initial.body.conversations.find((row: { kind: string }) => row.kind === "group").id as string;
    const path = `/v2/conversations/${group}/messages`;
    const send = (host: Running, token: string, key: string, text = key) =>
      host.call(path, "POST", { client_message_id: key, text }, token);
    expect(await send(a, alice.token, "单机原路径")).toMatchObject({ status: 201, body: { turn: { status: "queued" } } });

    const [aid, bid] = await Promise.all([descriptor(a), descriptor(b)]);
    expect((await a.call(`/host/peers/${bid.host_id}`, "PUT", { ...approval(bid), allow_join: true })).status).toBe(200);
    expect((await b.call("/host/peers/connect", "POST", { ...approval(aid), join_household: true })).status).toBe(200);
    await ready(a, 1);
    await eventually(() => counts(b, group, "单机原路径"), (rows) => rows.length === 1);
    expect(b.replies).toEqual([]);
    const bob = issueTestDevice(b.ctx, "乙");
    const direct = (await b.call("/v2/conversations", "GET", undefined, bob.token)).body.conversations
      .find((row: { kind: string }) => row.kind === "direct");
    expect(await b.call(`/v2/conversations/${direct.id}/messages`, "POST", {
      client_message_id: "本人单聊", text: "本人单聊",
    }, bob.token)).toMatchObject({ status: 201, body: { message: { author: { member_id: bob.memberId } } } });

    const sync = (reader: Running, source: Running, paused: boolean) =>
      reader.call(`/host/peers/${source.ctx.hostId}/sync`, "PUT", { paused });
    const transfer = (from: Running, to: Running, epoch: number, requestId: string) =>
      from.call(`/host/peers/${to.ctx.hostId}/lease`, "POST", { request_id: requestId, expected_epoch: epoch });
    let lost = 0;
    let lostWire: string | undefined;
    const transport = b.gateway.peerTransport!;
    const request = transport.request.bind(transport);
    transport.request = async (peer, operation, options) => {
      if (operation === "inbox") {
        const response = await request(peer, operation, options);
        if (response.ok) {
          lost += 1;
          lostWire = String(options?.body);
          await response.body?.cancel();
          throw new Error("测试主动丢弃目标事务提交后的 HTTP 回执");
        }
        return response;
      }
      return request(peer, operation, options);
    };

    expect((await sync(a, b, true)).status).toBe(200);
    expect((await sync(b, a, true)).status).toBe(200);
    const pending = await send(b, bob.token, "丢收据");
    expect(pending).toMatchObject({ status: 202, body: { status: "pending", client_message_id: "丢收据" } });
    const receiptUrl = pending.body.receipt_url as string;
    expect((await b.call(receiptUrl, "GET", undefined, bob.token)).status).toBe(202);
    expect((await b.call(receiptUrl)).status).toBe(401);
    expect((await a.call(receiptUrl, "GET", undefined, alice.token)).status).toBe(404);
    expect(await send(b, bob.token, "丢收据", "改了正文")).toMatchObject({ status: 409 });
    expect(counts(a, group, "丢收据", bob.memberId)).toHaveLength(0);
    expect(counts(b, group, "丢收据", bob.memberId)).toHaveLength(0);
    expect((await sync(a, b, false)).status).toBe(200);
    await eventually(() => lost, (value) => value >= 1);
    const old = counts(a, group, "丢收据", bob.memberId);
    expect(old).toMatchObject([{ origin_host_id: a.ctx.hostId, publication_epoch: 1, turns: 1 }]);
    expect(await b.call(receiptUrl, "GET", undefined, bob.token)).toMatchObject({ status: 202 });
    expect((await a.call(path, "POST", { text: "甲在第一代发言", client_message_id: "丢收据" }, alice.token)).status).toBe(201);

    const handoff = crypto.randomUUID();
    expect(await transfer(a, b, 1, handoff)).toMatchObject({ status: 409, body: { error: { code: "publication_history_pending" } } });
    // A is fenced, B lacks the old history, so a new send must survive in waiting.
    const waiting = await send(b, bob.token, "交接中等待");
    expect(waiting.status).toBe(202);
    const saved = (host: Running, url: string) => host.call(url, "GET", undefined, bob.token);
    expect(await saved(b, receiptUrl)).toMatchObject({ status: 202 });

    const port = b.gateway.peerPort!;
    await b.ctx.stop();
    const duringDisconnect = await send(a, alice.token, "对方断线时发送");
    expect(duringDisconnect.status).toBe(202);
    b = await launch(b.dir, port);
    hosts.push(b);
    expect(await saved(b, receiptUrl)).toMatchObject({ status: 202 });
    expect(await saved(b, waiting.body.receipt_url)).toMatchObject({ status: 202 });
    expect((await sync(b, a, false)).status).toBe(200);
    await eventually(() => transfer(a, b, 1, handoff), ({ status }) => status === 200);
    await ready(b, 2);

    expect(await eventually(() => saved(b, receiptUrl), ({ status }) => status === 200)).toMatchObject({
      body: { status: "accepted", publisher_host_id: a.ctx.hostId, message: { id: old[0]!.id }, turn: null },
    });
    expect(await send(b, bob.token, "丢收据")).toMatchObject({ status: 200, body: { message: { id: old[0]!.id }, turn: null } });
    expect(counts(b, group, "丢收据", bob.memberId)).toEqual([{ ...old[0]!, turns: 0 }]);
    expect(b.replies).not.toContain("丢收据");

    const waitingReceipt = await eventually(() => saved(b, waiting.body.receipt_url), ({ status }) => status === 200);
    expect(waitingReceipt).toMatchObject({ body: { status: "accepted", publisher_host_id: b.ctx.hostId, turn: { id: expect.any(String) } } });
    const remote = await eventually(
      () => a.call(duringDisconnect.body.receipt_url, "GET", undefined, alice.token), ({ status }) => status === 200,
    );
    expect(remote).toMatchObject({ body: { status: "accepted", publisher_host_id: b.ctx.hostId, turn: null } });
    const count = counts(b, group, "对方断线时发送");
    expect(count).toMatchObject([{ origin_host_id: b.ctx.hostId, publication_epoch: 2, turns: 1 }]);
    expect(counts(a, group, "对方断线时发送")).toEqual([{ ...count[0]!, turns: 0 }]);

    const replay = await b.gateway.peerTransport!.request(a.ctx.hostId, "inbox", {
      headers: { "content-type": "application/json" }, body: lostWire,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ admission_id: old[0]!.id, target_host_id: a.ctx.hostId });
    expect(counts(a, group, "丢收据", bob.memberId)).toEqual(old);
    const foreignStream = await a.call(waitingReceipt.body.turn.stream_url, "GET", undefined, alice.token);
    expect(foreignStream, waitingReceipt.body.turn.stream_url).toEqual({ status: 404, body: { error: { code: "not_found" } } });
  } finally {
    for (const host of hosts.reverse()) await host.ctx.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 100_000);
