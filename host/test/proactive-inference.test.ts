import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../src/clock/index.ts";
import type { Message, Turn } from "../src/conversations/types.ts";
import { Gateway } from "../src/gateway/index.ts";
import { modelConfigFromEnv } from "../src/llm/config.ts";
import { ReportRouter } from "../src/router/index.ts";
import { startConfiguredHost } from "../src/runtime/application.ts";
import type { HostContext } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { listConversations } from "../src/store/conversations.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { createBoundary } from "../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../src/store/knowledge-source.ts";
import { getInferenceCandidate } from "../src/store/inference.ts";
import { hosts, mailboxLetters, messages } from "../src/store/schema/index.ts";
import { getTurnRow } from "../src/store/turns.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const noon = Date.parse("2026-11-22T04:00:00Z");
const minute = 60_000;
const event = "我今天12:10面试结束。";
type ChatResponse = { message: Message; turn: Turn | null };
type Card = {
  rule: { id: string; version: number };
  source: { id: string; text: string; memberId: string };
  recent: { id: string; text: string; memberId: string }[];
  event: { topic: string; afterAt: number };
};

function sse(content: string) {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content } }] })
    + '\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
}

function acceptance(card: Card, quote = card.source.text) {
  return { decision: "accept", rule_id: card.rule.id, version: card.rule.version,
    topic: card.event.topic, after_at: card.event.afterAt,
    evidence: [{ message_id: card.source.id, quote }] };
}

async function until(check: () => unknown) {
  const end = Date.now() + 4500;
  while (!check()) {
    if (Date.now() >= end) {
      throw new Error("等待运行时条件超时");
    }
    await Bun.sleep(10);
  }
}

async function withHost(
  work: (f: ReturnType<typeof fixture>) => Promise<void>,
  options: {
    mode?: "observe" | "auto";
    assess?: (card: Card) => unknown | Promise<unknown>;
    authority?: HostContext["config"]["groupPublicationAuthority"];
  } = {},
) {
  const clock = new ManualClock("proactive-test", noon);
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-r54-"));
  const routeCalls: Card[] = [];
  const chatCalls: string[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const payload = await request.json() as { model: string; messages: { content: string }[] };
      if (payload.model === "router-fixture") {
        const card = JSON.parse(payload.messages[1]!.content) as Card;
        routeCalls.push(card);
        return sse(JSON.stringify(await (options.assess?.(card) ?? acceptance(card))));
      }
      chatCalls.push(payload.messages.map(({ content }) => content).join("\n"));
      return sse("团子在。");
    },
  });
  const gateway = new Gateway({ tls: { ips: () => [], hostname: "test" } });
  try {
    const host = await startConfiguredHost({
      dataDir, port: 0, lanHttpsPort: 0, clock,
      groupPublicationAuthority: options.authority,
      ...(options.mode && { askOutcomeRule: { version: 1, mode: options.mode } }),
      model: modelConfigFromEnv({
        MODEL_PROVIDER: "deepseek", CHAT_PROVIDER: "openai-compatible", ROUTER_PROVIDER: "openai-compatible",
        OPENAI_COMPAT_BASE_URL: new URL("/v1", endpoint.url).href,
        CHAT_MODEL: "chat-fixture", ROUTER_MODEL: "router-fixture", MODEL_LOCAL_CONCURRENCY: "2",
      }),
    }, gateway);
    try {
      await work(fixture(host, clock, gateway.port!, routeCalls, chatCalls));
    } finally {
      await host.stop();
    }
  } finally {
    await endpoint.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function fixture(host: HostContext, clock: ManualClock, port: number, routeCalls: Card[], chatCalls: string[]) {
  const { db } = host.store;
  const person = (name: string) => {
    const device = issueTestDevice(host, name);
    const actor = resolveDeviceToken(db, clock, device.token)!;
    const [group, direct] = listConversations(db, actor);
    return { ...device, actor, group: group!, direct: direct! };
  };
  const a = person("阿岚");
  const b = person("小禾");
  const request = (p: typeof a, path: string, method: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/v2${path}`, {
      method, headers: { Authorization: `Bearer ${p.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const permission = async (p: typeof a, allowed: boolean, zone?: string) => {
    const response = await request(p, "/me/proactive", "PATCH", { allow_proactive: allowed, time_zone: zone });
    expect(response.status).toBe(200);
    return await response.json();
  };
  const send = async (p: typeof a, text: string, target = p.direct.id, key = String(crypto.randomUUID()), status = 201) => {
    const response = await request(p, `/conversations/${target}/messages`, "POST", { client_message_id: key, text });
    expect(response.status).toBe(status);
    const result = await response.json() as ChatResponse;
    if (result.turn) {
      await until(() => getTurnRow(db, result.turn!.id)?.status === "completed");
    }
    return result;
  };
  const candidate = (source: Message) => getInferenceCandidate(db, source.id);
  const cats = (conversationId: string) => db.select().from(messages)
    .where(eq(messages.conversationId, conversationId)).all().filter((row) => row.authorMemberId === null);
  return { host, db, clock, a, b, request, permission, send, candidate, routeCalls, chatCalls, cats };
}

test("真实 HTTP 群聊静默保存、重放原收据，明确呼唤才开轮次，两单聊保持独立", () => withHost(async (f) => {
  const { a, b } = f;
  const sent = await f.send(a, "小禾，你几点回来？", a.group.id, "group-a");
  expect(sent.turn).toBeNull();
  expect(await f.send(a, sent.message.text, a.group.id, "group-a", 200)).toEqual(sent);
  expect((await f.send(b, "八点。团子已经在窗边了。", b.group.id)).turn).toBeNull();
  expect(f.chatCalls).toEqual([]);
  expect((await f.send(b, "团子，你想坐哪里？", b.group.id)).turn).not.toBeNull();
  expect(f.chatCalls[0]).toContain("小禾");
  expect(f.chatCalls[0]).toContain("阿岚");
  await f.send(a, "甲独立原话");
  await f.send(b, "乙独立原话");
  expect(f.chatCalls[1]).not.toContain("乙独立原话");
  expect(f.chatCalls[2]).not.toContain("甲独立原话");
  expect((await f.send(a, "晚上好，团子。", a.group.id)).turn).not.toBeNull();
}));

test("默认关闭许可，批准后的默认规则仅观察，跨人及模糊来源不形成候选", () => withHost(async (f) => {
  const { a, b } = f;
  const noPermission = await f.send(b, event);
  expect(f.candidate(noPermission.message)).toBeUndefined();
  await f.permission(a, true);
  for (const text of ["明天面试。", "小禾今天12:10面试结束。", "我今天等小禾12:10面试结束。", "如果我今天12:10面试结束就去找你。"]) {
    const invalid = await f.send(a, text);
    expect(f.candidate(invalid.message)).toBeUndefined();
  }
  const original = await f.send(a, event);
  const other = await f.send(b, "我面试通过了。");
  expect(f.candidate(other.message)).toBeUndefined();
  f.clock.advance(11 * minute);
  await until(() => f.candidate(original.message)?.status === "observed");
  expect(f.routeCalls).toHaveLength(1);
  expect(f.routeCalls[0]!.source.memberId).toBe(a.memberId);
  expect(f.routeCalls[0]!.recent.every((row) => row.memberId === a.memberId)).toBe(true);
  expect(f.cats(a.direct.id)).toHaveLength(5);
  expect(f.db.select().from(mailboxLetters).all()).toEqual([]);
}));

test("许可换代、撤回、回避与来源修订先于评估；无效证据不能授权发布", () => withHost(async (f) => {
  const { a, b, db, clock } = f;
  await f.permission(a, true);
  const old = (await f.send(a, event)).message;
  await f.permission(a, false);
  await f.permission(a, true);
  const withdrawn = (await f.send(a, "我今天12:10答辩结束。")).message;
  withdrawKnowledgeSource(db, clock, a.actor, withdrawn.id, 1);
  const changed = (await f.send(a, "我今天12:10比赛结束。")).message;
  db.update(messages).set({ rev: 2 }).where(eq(messages.id, changed.id)).run();
  const blocked = (await f.send(a, "我今天12:10考试结束。")).message;
  const boundary = (await f.send(a, "以后别和我聊考试。")).message;
  createBoundary(db, clock, { householdId: f.host.householdId, subjectMemberId: a.memberId,
    sourceMemberId: a.memberId, sourceMessageId: boundary.id, sourceRevision: 1, description: "考试" });
  await f.permission(b, true);
  const invalid = (await f.send(b, event)).message;
  clock.advance(11 * minute);
  await until(() => f.candidate(invalid)?.status === "dropped");
  expect([old, withdrawn, changed, blocked].map((source) => f.candidate(source)?.status)).toEqual(Array(4).fill("dropped"));
  expect(f.routeCalls.map((card) => card.source.id)).toEqual([invalid.id]);
  expect(f.db.select().from(mailboxLetters).all()).toEqual([]);
}, { mode: "auto", assess: (card) => acceptance(card, "没有写过的结束时间") }));

test("模型研判期间新消息让旧候选失效；安静延后重查、双 Router 扫描及 HTTP 重放只发布一次", () => {
  const release = Promise.withResolvers<void>();
  return withHost(async (f) => {
    const { a, b, clock } = f;
    await f.permission(a, true);
    await f.permission(b, true, "America/Chicago");
    const old = (await f.send(a, event)).message;
    const quiet = (await f.send(b, "我在2026-11-22T04:10:00Z答辩结束。", b.direct.id, "quiet")).message;
    clock.advance(11 * minute);
    try {
      await until(() => f.routeCalls.some((x) => x.source.id === old.id));
      await f.send(a, "我们换个话题。");
    } finally {
      release.resolve();
    }
    await until(() => f.candidate(old)?.status === "dropped");
    expect(f.candidate(quiet)?.status).toBe("pending");
    expect(f.routeCalls.map((x) => x.source.id)).toEqual([old.id]);
    clock.setWallMs(Date.parse("2026-11-22T15:00:00Z"));
    const duplicate = new ReportRouter({ pollIntervalMs: 5 });
    duplicate.start(f.host);
    try {
      expect((await f.send(b, quiet.text, b.direct.id, "quiet", 200)).message.id).toBe(quiet.id);
      await until(() => f.candidate(quiet)?.status === "published");
      const second = (await f.send(b, "我今天9:01比赛结束。")).message;
      clock.advance(2 * minute);
      await until(() => f.candidate(second)?.status === "dropped");
      expect(f.cats(b.direct.id).filter((row) => row.turnId === null)).toHaveLength(1);
      expect(f.db.select().from(mailboxLetters).all().map(({ forMemberId }) => forMemberId)).toEqual([b.memberId]);
      expect(f.cats(a.direct.id).every((row) => row.turnId !== null)).toBe(true);
    } finally {
      await duplicate.stop();
    }
  }, { mode: "auto", assess: async (card) => {
    if (card.event.topic === "interview") { await release.promise; }
    return acceptance(card);
  } });
});

test("存在第二宿主时群聊写入需要 authority；凭证撤销期间的候选失效，单聊仍可发布", () => {
  let epoch: string | undefined;
  return withHost(async (f) => {
    const { a, b, clock, db, host } = f;
    db.insert(hosts).values({ ...businessRow(clock, host.hostId), householdId: host.householdId, displayName: "另一台 Mac" }).run();
    const denied = await f.request(a, `/conversations/${a.group.id}/messages`, "POST", { text: "团子，你在吗？", client_message_id: "missing-lease" });
    expect(denied.status).toBe(409);
    expect(f.chatCalls).toHaveLength(0);
    epoch = "lease:2";
    const called = await f.send(a, "团子，你好。", a.group.id);
    expect(called.turn).not.toBeNull();
    await until(() => getTurnRow(db, called.turn!.id)?.status === "completed");
    const repliesBefore = f.cats(a.group.id).length;
    await f.permission(a, true);
    await f.permission(b, true);
    const group = (await f.send(a, event, a.group.id)).message;
    expect(f.candidate(group)?.status).toBe("pending");
    epoch = "lease:3";
    const direct = (await f.send(a, event)).message;
    clock.advance(11 * minute);
    await until(() => f.candidate(direct)?.status === "published");
    expect(f.candidate(group)?.status).toBe("dropped");
    expect(f.cats(a.group.id)).toHaveLength(repliesBefore);
    expect(f.cats(a.direct.id)).toHaveLength(2);
  }, { mode: "auto", authority: { currentEpoch: () => epoch } });
});
