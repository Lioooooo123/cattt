import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Turn } from "../src/conversations/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import { configFromEnv } from "../src/runtime/config.ts";
import { listConversations } from "../src/store/conversations.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { listAvailableMemories } from "../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../src/store/knowledge-source.ts";
import { listPendingExtractions } from "../src/store/memory-extraction.ts";
import { memories } from "../src/store/schema/knowledge.ts";
import { jobs } from "../src/store/schema/index.ts";
import { getTurnRow } from "../src/store/turns.ts";
import { issueTestDevice } from "./identity-fixture.ts";

type Payload = {
  model: string;
  messages: { role: string; content: string }[];
};
type ExtractPrompt = {
  current: { messageId: string; authorMemberId: string; text: string };
  history: { messageId: string; text: string }[];
  members: { id: string; name: string }[];
};

function sse(text: string, finish = true) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'
    + (finish ? 'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' : "");
}

function releaseGate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  do {
    if (predicate()) { return; }
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  throw new Error("等待 R4 状态超时");
}

async function withHost(
  serve: (payload: Payload) => Response | Promise<Response>,
  work: (host: Awaited<ReturnType<typeof startConfiguredHost>>, baseURL: string) => Promise<void>,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-r4-runtime-"));
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") { return new Response(null, { status: 404 }); }
      return await serve(await request.json() as Payload);
    },
  });
  try {
    const gateway = new Gateway({ tls: { ips: () => [], hostname: "test" } });
    const host = await startConfiguredHost(configFromEnv({
      CATTT_DATA_DIR: dataDir, CATTT_PORT: "0", CATTT_LAN_HTTPS_PORT: "0",
      MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: new URL("/v1", endpoint.url).href,
      CHAT_MODEL: "chat-fixture", EXTRACT_MODEL: "extract-fixture", MODEL_LOCAL_CONCURRENCY: "2",
    }), gateway);
    try {
      await work(host, `http://127.0.0.1:${gateway.port}`);
    } finally {
      await host.stop();
    }
  } finally {
    await endpoint.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function conversations(host: Awaited<ReturnType<typeof startConfiguredHost>>, baseURL: string) {
  const a = issueTestDevice(host, "阿岚");
  const b = issueTestDevice(host, "小禾");
  const actor = resolveDeviceToken(host.store.db, host.clock, a.token)!;
  const other = resolveDeviceToken(host.store.db, host.clock, b.token)!;
  const group = listConversations(host.store.db, actor).find(({ kind }) => kind === "group")!;
  const dmA = listConversations(host.store.db, actor).find(({ kind }) => kind === "direct")!;
  const dmB = listConversations(host.store.db, other).find(({ kind }) => kind === "direct")!;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  const send = async (text: string, conversationId = group.id, token = a.token, clientMessageId = crypto.randomUUID(), status = 201) => {
    const response = await fetch(`${baseURL}/v2/conversations/${conversationId}/messages`, {
      method: "POST", headers: auth(token), body: JSON.stringify({ text, client_message_id: clientMessageId }),
    });
    expect(response.status).toBe(status);
    return await response.json() as { message: Message; turn: Turn };
  };
  const stream = async (turn: Turn, token = a.token, cursor?: string) => {
    const response = await fetch(baseURL + turn.stream_url + (cursor ? `?last_event_id=${cursor}` : ""), {
      headers: auth(token), signal: AbortSignal.timeout(4500),
    });
    expect(response.status).toBe(200);
    return response.text();
  };
  const job = (source: Message) => host.store.db.select().from(jobs)
    .where(eq(jobs.dedupeKey, `${source.id}:1`)).get();
  return { a, b, actor, group, dmA, dmB, send, stream, job };
}

function candidate(
  prompt: ExtractPrompt, subject: { kind: "member"; memberId: string } | { kind: "pair" },
  quote: string, key: string, value: string, correction = false, messageId = prompt.current.messageId,
) {
  return { subject, subjectEvidence: { messageId, quote }, sourceQuote: prompt.current.text, key, value,
    kind: "preference", sensitivity: "low", correction };
}

test("生产启动在同一进程抽取共同事实、单人更正和待确认，再跨会话冷启动召回", async () => {
  const extractionCalls: string[] = [];
  const chats: Payload[] = [];
  const releaseCorrection = releaseGate();
  await withHost(async (payload) => {
    if (payload.model === "chat-fixture") {
      chats.push(payload);
      return new Response(sse("收到。"));
    }
    expect(payload.model).toBe("extract-fixture");
    const prompt = JSON.parse(payload.messages[1]!.content) as ExtractPrompt;
    const { text, authorMemberId, messageId } = prompt.current;
    if (text === "更正我的奶茶改成三分糖") await releaseCorrection.wait;
    extractionCalls.push(messageId);
    const self = { kind: "member", memberId: authorMemberId } as const;
    const pending = text === "听说小禾喜欢茶糕" ? [{ reason: "source", key: "茶点", value: "茶糕", sourceQuote: text }] : [];
    const confirmed = text === "我们俩的早餐选豆浆"
      ? [candidate(prompt, { kind: "pair" }, "我们俩", "共同早餐", "豆浆")]
      : text === "我的奶茶加糖" ? [candidate(prompt, self, "我的", "奶茶甜度", "加糖")]
        : text === "更正我的奶茶改成三分糖" ? [candidate(prompt, self, "我的", "奶茶甜度", "三分糖", true)] : [];
    return new Response(sse(JSON.stringify({ confirmed, pending })));
  }, async (host, baseURL) => {
    const f = conversations(host, baseURL);
    const db = host.store.db;
    const send = async (text: string, id?: `${string}-${string}-${string}-${string}-${string}`) => {
      const result = await f.send(text, f.dmA.id, f.a.token, id);
      await until(() => f.job(result.message)?.status === "done");
      expect(await f.stream(result.turn)).toContain("event: done");
      return result.message;
    };
    const key = crypto.randomUUID();
    const joint = await send("我们俩的早餐选豆浆", key);
    expect((await f.send(joint.text, f.dmA.id, f.a.token, key, 200)).message.id).toBe(joint.id);
    const old = await send("我的奶茶加糖");
    // The next test covers an invalidation during streaming. Here the
    // fixture controls the order so this test covers persistence and recall.
    const correcting = await f.send("更正我的奶茶改成三分糖", f.dmA.id, f.a.token);
    try {
      expect(await f.stream(correcting.turn)).toContain("event: done");
    } finally {
      releaseCorrection.release();
    }
    const correction = correcting.message;
    await until(() => f.job(correction)?.status === "done");
    const uncertain = await send("听说小禾喜欢茶糕");
    const filter = { householdId: host.householdId };
    expect(listAvailableMemories(db, filter)).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectMemberId: null, sourceMemberId: f.a.memberId, sourceMessageId: joint.id, value: "豆浆" }),
      expect.objectContaining({ subjectMemberId: f.a.memberId, sourceMemberId: f.a.memberId, sourceMessageId: correction.id, value: "三分糖" }),
    ]));
    expect(listAvailableMemories(db, filter)).toHaveLength(2);
    expect(db.select().from(memories).where(eq(memories.sourceMessageId, old.id)).get()).toMatchObject({ rev: 2, deletedAt: expect.any(Number) });
    expect(listPendingExtractions(db, host.householdId)).toEqual([
      expect.objectContaining({ sourceMessageId: uncertain.id, reason: "source", value: "茶糕" }),
    ]);
    expect(extractionCalls).toEqual([joint.id, old.id, correction.id, uncertain.id]);

    const query = await f.send("共同早餐和阿岚的奶茶甜度是什么？", f.dmB.id, f.b.token);
    expect(await f.stream(query.turn, f.b.token)).toContain("event: done");
    const request = chats.at(-1)!;
    expect(request.messages.slice(1)).toHaveLength(1);
    expect(request.messages[0]!.content).toContain('"value":"豆浆"');
    expect(request.messages[0]!.content).toContain('"value":"三分糖"');
    expect(request.messages[0]!.content).toContain(joint.id);
    expect(request.messages[0]!.content).not.toContain("茶糕");
    expect(request.messages[0]!.content).not.toContain(old.id);
  });
});

test("已召回的指代依赖撤回后，丢弃流中剩余内容和最终回复，下一轮也不召回", async () => {
  const requested = releaseGate();
  const finish = releaseGate();
  const antecedentReply = releaseGate();
  let guardedRequest: Payload | undefined;
  let lastRequest: Payload | undefined;
  try {
    await withHost(async (payload) => {
      if (payload.model === "extract-fixture") {
        const prompt = JSON.parse(payload.messages[1]!.content) as ExtractPrompt;
        const antecedent = prompt.history.at(-1);
        const lin = prompt.members.find(({ name }) => name === "小禾")!;
        const confirmed = prompt.current.text === "她周末都爱骑车" && antecedent
          ? [candidate(prompt, { kind: "member", memberId: lin.id }, "小禾", "周末运动", "骑车", false, antecedent.messageId)] : [];
        return new Response(sse(JSON.stringify({ confirmed, pending: [] })));
      }
      lastRequest = payload;
      if (payload.messages.at(-1)?.content.endsWith("说起小禾")) { await antecedentReply.wait; }
      if (payload.messages.at(-1)?.content.includes("先回答")) {
        return new Response(sse("小禾周末骑车。"));
      }
      if (!payload.messages.at(-1)?.content.includes("触发复核")) {
        return new Response(sse("收到。"));
      }
      guardedRequest = payload;
      requested.release();
      const encode = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encode.encode(sse("让我想想。", false)));
          void finish.wait.then(() => {
            controller.enqueue(encode.encode(sse("小禾周末骑车。")));
            controller.close();
          }).catch(() => {});
        },
      }));
    }, async (host, baseURL) => {
      const f = conversations(host, baseURL);
      try {
        const antecedent = await f.send("说起小禾");
        const derived = await f.send("她周末都爱骑车");
        antecedentReply.release();
        await until(() => f.job(derived.message)?.status === "done");
        expect(listAvailableMemories(host.store.db, { householdId: host.householdId })).toHaveLength(1);
        const earlier = await f.send("先回答，小禾的周末运动是什么？", f.dmB.id, f.b.token);
        expect(await f.stream(earlier.turn, f.b.token)).toContain("小禾周末骑车");
        const during = await f.send("触发复核，小禾的周末运动是什么？", f.dmB.id, f.b.token);
        const feed = f.stream(during.turn, f.b.token);
        await requested.wait;
        expect(guardedRequest?.messages[0]?.content).toContain('"value":"骑车"');
        await until(() => getTurnRow(host.store.db, during.turn.id)?.firstTokenAt != null);
        expect(withdrawKnowledgeSource(host.store.db, host.clock, f.actor, antecedent.message.id, 1)).toBeDefined();
        finish.release();
        const events = await feed;
        expect(events).toContain("event: error");
        expect(events).not.toContain("小禾周末骑车");
        expect(events).not.toContain("event: done");
        expect(await f.stream(during.turn, f.b.token, "foreign.1")).not.toContain("让我想想");
        expect(listAvailableMemories(host.store.db, { householdId: host.householdId })).toEqual([]);

        const clean = await f.send("小禾的周末运动是什么？", f.dmB.id, f.b.token);
        expect(await f.stream(clean.turn, f.b.token)).toContain("event: done");
        expect(JSON.stringify(lastRequest?.messages)).not.toContain("骑车");
      } finally {
        finish.release();
      }
    });
  } finally {
    antecedentReply.release();
    finish.release();
  }
});
