import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatEvents } from "../src/chat-events/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import { conversationRoutes } from "../src/conversations/routes.ts";
import type { Message } from "../src/conversations/types.ts";
import { JobRunner } from "../src/jobs/index.ts";
import type { ModelClient, ModelRequest } from "../src/llm/types.ts";
import { registerMemoryExtraction } from "../src/memory/jobs.ts";
import { startHost } from "../src/runtime/index.ts";
import type { HostContext } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { hasValidExtractionDependencies } from "../src/store/extraction-evidence.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { getJob } from "../src/store/jobs.ts";
import { listAvailableMemories } from "../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../src/store/knowledge-source.ts";
import { listPendingExtractions } from "../src/store/memory-extraction.ts";
import { jobs } from "../src/store/schema/index.ts";
import { messages } from "../src/store/schema/conversations.ts";
import { hosts } from "../src/store/schema/identity.ts";
import { memories } from "../src/store/schema/knowledge.ts";
import { issueTestDevice } from "./identity-fixture.ts";
import { testTurn } from "./turn-fixture.ts";

const queue = "memory-extraction";
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "cattt-memory-jobs-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const clock = new ManualClock("memory-jobs", 1_700_000_000_000);
  const host = await startHost({ dataDir, clock }, []);
  cleanup.push(host.stop);
  const han = issueTestDevice(host, "Han");
  const lin = issueTestDevice(host, "Lin");
  const actor = resolveDeviceToken(host.store.db, host.clock, han.token)!;
  const group = listConversations(host.store.db, actor).find((item) => item.kind === "group")!;
  const direct = listConversations(host.store.db, actor).find((item) => item.kind === "direct")!;
  const otherActor = resolveDeviceToken(host.store.db, host.clock, lin.token)!;
  const otherDirect = listConversations(host.store.db, otherActor).find((item) => item.kind === "direct")!;
  const app = conversationRoutes(host, () => new Response());
  const post = (text: string, id: string = crypto.randomUUID(), conversationId = group.id, token = han.token) =>
    app.request(`/conversations/${conversationId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, client_message_id: id }),
    });
  const send = async (text: string, id?: string, conversationId?: string, token?: string) => {
    const response = await post(text, id, conversationId, token);
    expect(response.status).toBe(201);
    return (await response.json() as { message: Message }).message;
  };
  const queued = () => host.store.db.select().from(jobs).where(eq(jobs.queue, queue)).all();
  const recall = () => listAvailableMemories(host.store.db, { householdId: host.householdId });
  const withdraw = (id: string) => withdrawKnowledgeSource(host.store.db, host.clock, actor, id, 1);
  return { host, dataDir, clock, han, lin, actor, group, direct, otherDirect, post, send, queued, recall, withdraw };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 150; i += 1) {
    if (predicate()) { return; }
    await Bun.sleep(5);
  }
  throw new Error("等待记忆作业超时");
}

type Prompt = {
  current: { messageId: string; authorMemberId: string; authorName: string; text: string };
  history: { messageId: string; authorMemberId: string | null; text: string }[];
};
function model(respond: (prompt: Prompt) => unknown | Promise<unknown>): ModelClient {
  return {
    provider: "mock",
    modelId: "mock-extraction-job",
    async *stream(request: ModelRequest) {
      const output = await respond(JSON.parse(request.messages[0]!.content) as Prompt);
      yield { type: "text-delta", delta: JSON.stringify(output) };
      yield { type: "finish", finishReason: "stop" };
    },
  };
}

type Subject = { kind: "member"; memberId: string } | { kind: "pair" };
function fact(
  prompt: Prompt,
  subject: Subject,
  quote: string,
  value: string,
  messageId = prompt.current.messageId,
) {
  return {
    subject, subjectEvidence: { messageId, quote }, sourceQuote: prompt.current.text,
    key: "饮料", value, kind: "preference", sensitivity: "low", correction: false,
  };
}

function own(prompt: Prompt, value: string) {
  return { confirmed: [fact(prompt, { kind: "member", memberId: prompt.current.authorMemberId }, "我", value)], pending: [] };
}

function run(host: HostContext, client: ModelClient, options?: Parameters<typeof registerMemoryExtraction>[1]) {
  const runner = new JobRunner({ pollIntervalMs: 5 });
  registerMemoryExtraction(runner, { ...options, model: client });
  runner.start(host);
  cleanup.push(() => runner.stop());
  return runner;
}

test("生产发送原子入队，送达重放、复制消息和团子落库均无新抽取", async () => {
  const f = await fixture();
  const wakes: string[] = [];
  f.host.bus.subscribe("jobs:wake", ({ queue: name }) => {
    if (name === queue) { wakes.push(f.queued()[0]?.status ?? "missing"); }
  });
  const source = await f.send("我喜欢原叶茶", "native");
  expect((await f.post(source.text, "native")).status).toBe(200);
  const [first] = f.queued();
  expect(f.queued()).toHaveLength(1);
  expect(first).toMatchObject({ status: "queued" });
  expect(JSON.parse(first!.payload)).toMatchObject({
    sourceMessageId: source.id, sourceMemberId: f.han.memberId, sourceRevision: 1, conversationId: f.group.id,
  });
  expect(wakes).toEqual(["queued"]);

  const history = businessRow(f.clock, f.host.hostId);
  f.host.store.db.insert(hosts).values({ ...history, householdId: f.host.householdId, displayName: "复制来源" }).run();
  f.host.store.db.insert(messages).values({
    ...businessRow(f.clock, history.id), conversationId: f.group.id, authorMemberId: f.han.memberId,
    text: "外来历史", clientMessageId: "replicated", modality: "text", status: "complete",
  }).run();
  expect((await f.post("外来历史", "replicated")).status).toBe(200);
  expect(f.queued()).toHaveLength(1);
  const turn = testTurn(f.host, f.han.token);
  expect(f.queued()).toHaveLength(2);
  turn.delta("测试回复");
  turn.done();
  expect(f.queued()).toHaveLength(2);
});

test("作业插入失败会回滚同事务中的原话", async () => {
  const f = await fixture();
  f.host.store.raw.exec(`CREATE TRIGGER fail_extraction BEFORE INSERT ON jobs
    WHEN NEW.queue = 'memory-extraction' BEGIN SELECT RAISE(ABORT, 'job-failed'); END`);
  expect(() => new ChatEvents(f.host).write((db, append) =>
    sendMessage(db, f.clock, f.actor, f.group.id, { clientMessageId: "rollback", text: "我喜欢茶" }, append)))
    .toThrow();
  expect(f.queued()).toHaveLength(0);
  expect(f.host.store.db.select().from(messages).where(eq(messages.clientMessageId, "rollback")).get()).toBeUndefined();
});

test("重启补扫，模型失败重试，成功后保存一份；已完成的发送重放仍不入队", async () => {
  const f = await fixture();
  const source = await f.send("我喜欢红茶", "retry");
  const [job] = f.queued();
  await f.host.stop();
  let calls = 0;
  const runner = new JobRunner({ pollIntervalMs: 5 });
  registerMemoryExtraction(runner, { model: model((prompt) => {
    calls += 1;
    if (calls === 1) { throw new Error("临时故障"); }
    return own(prompt, "红茶");
  }) });
  const recovered = await startHost({ dataDir: f.dataDir, clock: f.clock }, [runner]);
  cleanup.push(recovered.stop);
  const current = () => getJob(recovered.store.db, job!.id)!;
  await until(() => current().status === "queued" && current().attempts === 1);
  f.clock.setWallMs(current().runAt);
  await until(() => current().status === "done");
  expect(current().attempts).toBe(2);
  expect(calls).toBe(2);
  expect(listAvailableMemories(recovered.store.db, { householdId: recovered.householdId })).toMatchObject([
    { sourceMessageId: source.id, sourceRevision: 1, sourceMemberId: f.han.memberId, value: "红茶" },
  ]);
  const routes = conversationRoutes(recovered, () => new Response());
  expect((await routes.request(`/conversations/${f.group.id}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${f.han.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: source.text, client_message_id: "retry" }),
  })).status).toBe(200);
  expect(recovered.store.db.select().from(jobs).all()).toHaveLength(1);
});

test("开工前撤回，或原话修订与入队版本不同，均不调用模型", async () => {
  const f = await fixture();
  const withdrawn = await f.send("我喜欢白茶");
  const edited = await f.send("我喜欢绿茶");
  expect(f.withdraw(withdrawn.id)).toBeDefined();
  f.host.store.db.update(messages).set({ rev: 2 }).where(eq(messages.id, edited.id)).run();
  let calls = 0;
  run(f.host, model(() => {
    calls += 1;
    return { confirmed: [], pending: [] };
  }));
  await until(() => f.queued().every((job) => job.status === "done"));
  expect(calls).toBe(0);
});

test("模型等待时可写库，来源撤回后 confirmed 和 pending 均不落库", async () => {
  const f = await fixture();
  const source = await f.send("我喜欢红茶。听说还有人喝薄荷茶。");
  const entered = deferred();
  const release = deferred();
  run(f.host, model(async (prompt) => {
    expect(f.host.store.raw.inTransaction).toBe(false);
    entered.resolve();
    await release.promise;
    return {
      confirmed: [{ ...own(prompt, "红茶").confirmed[0], sourceQuote: "我喜欢红茶" }],
      pending: [{ reason: "source", sourceQuote: "听说还有人喝薄荷茶", key: "饮料", value: "薄荷茶" }],
    };
  }));
  try {
    await entered.promise;
    expect(f.withdraw(source.id)).toBeDefined();
  } finally {
    release.resolve();
  }
  await until(() => f.queued()[0]?.status === "done");
  expect(f.recall()).toEqual([]);
  expect(listPendingExtractions(f.host.store.db, f.host.householdId)).toEqual([]);
});

test("只装配源消息以前同会话的可用原话，主语为 Lin，来源保持 Han，pending 不参与召回", async () => {
  const f = await fixture();
  const removed = await f.send("已撤回的历史");
  const other = await f.send("别的会话", undefined, f.otherDirect.id, f.lin.token);
  const source = await f.send("Lin 喜欢绿茶。先不说名字，她也喝白茶。");
  const later = await f.send("比原话更新");
  expect(f.withdraw(removed.id)).toBeDefined();
  const seen: Prompt[] = [];
  run(f.host, model((prompt) => {
    if (prompt.current.messageId !== source.id) { return { confirmed: [], pending: [] }; }
    seen.push(prompt);
    return {
      confirmed: [{ ...fact(prompt, { kind: "member", memberId: f.lin.memberId }, "Lin", "绿茶"), sourceQuote: "Lin 喜欢绿茶" }],
      pending: [{ reason: "subject", sourceQuote: "先不说名字，她也喝白茶", key: "饮料", value: "白茶" }],
    };
  }));
  await until(() => f.queued().every((job) => job.status === "done"));
  expect(seen).toHaveLength(1);
  expect(seen[0]!.current).toMatchObject({ authorMemberId: f.han.memberId, authorName: "Han" });
  expect(seen[0]!.history.map((item) => item.messageId)).not.toContain(removed.id);
  expect(seen[0]!.history.map((item) => item.messageId)).not.toContain(other.id);
  expect(seen[0]!.history.map((item) => item.messageId)).not.toContain(later.id);
  expect(f.recall()).toMatchObject([{ subjectMemberId: f.lin.memberId, sourceMemberId: f.han.memberId, sourceMessageId: source.id, value: "绿茶" }]);
  expect(listPendingExtractions(f.host.store.db, f.host.householdId)).toMatchObject([
    { sourceMemberId: f.han.memberId, sourceMessageId: source.id, sourceRevision: 1, reason: "subject", value: "白茶" },
  ]);
  expect(f.withdraw(source.id)).toBeDefined();
  expect(listPendingExtractions(f.host.store.db, f.host.householdId)).toEqual([]);
});

test.each(["withdraw", "revise"] as const)("提交时拒绝上下文依赖变化 %s", async (change) => {
  const f = await fixture();
  const dependency = await f.send("刚才说的是 Lin。");
  const source = await f.send("她喜欢原叶茶");
  const attach = deferred();
  const release = deferred();
  run(f.host, model(async (prompt) => {
    if (prompt.current.messageId !== source.id) { return { confirmed: [], pending: [] }; }
    expect(prompt.history.at(-1)?.messageId).toBe(dependency.id);
    attach.resolve();
    await release.promise;
    return { confirmed: [fact(prompt, { kind: "member", memberId: f.lin.memberId }, "Lin", "原叶茶", dependency.id)], pending: [] };
  }));
  try {
    await attach.promise;
    if (change === "withdraw") { expect(f.withdraw(dependency.id)).toBeDefined(); }
    else { f.host.store.db.update(messages).set({ rev: 2 }).where(eq(messages.id, dependency.id)).run(); }
  } finally {
    release.resolve();
  }
  await until(() => f.queued().every((job) => job.status === "done"));
  expect(f.recall()).toEqual([]);
});

test("已提交的派生事实能按持久上下文证明排除，独立事实仍可用", async () => {
  const f = await fixture();
  const dependency = await f.send("刚才说的是 Lin。");
  const source = await f.send("她喜欢原叶茶。我喜欢绿茶。");
  run(f.host, model((prompt) => {
    if (prompt.current.messageId !== source.id) { return { confirmed: [], pending: [] }; }
    return {
      confirmed: [
        { ...fact(prompt, { kind: "member", memberId: f.lin.memberId }, "Lin", "原叶茶", dependency.id), sourceQuote: "她喜欢原叶茶" },
        { ...fact(prompt, { kind: "member", memberId: f.han.memberId }, "我", "绿茶"), sourceQuote: "我喜欢绿茶" },
      ],
      pending: [],
    };
  }));
  await until(() => f.queued().every((job) => job.status === "done"));
  const before = f.recall();
  expect(before).toHaveLength(2);
  const withValidProof = () => f.host.store.db.select({ value: memories.value }).from(memories)
    .where(and(eq(memories.sourceMessageId, source.id), hasValidExtractionDependencies(f.host.store.db, memories.id)))
    .all().map(({ value }) => value);
  expect(withValidProof().sort()).toEqual(["原叶茶", "绿茶"]);
  expect(f.withdraw(dependency.id)).toBeDefined();
  expect(withValidProof()).toEqual(["绿茶"]);
});

test("共享事实向适配器提交一次，保留来源与共同主体", async () => {
  const f = await fixture();
  const source = await f.send("我们俩一起喝红茶");
  const seen: unknown[] = [];
  run(f.host, model((prompt) => ({
    confirmed: [fact(prompt, { kind: "pair" }, "我们俩", "红茶")], pending: [],
  })), {
    writePair(_db, _clock, fact) {
      seen.push(fact);
      return undefined;
    },
  });
  await until(() => f.queued().every((job) => job.status === "done"));
  expect(seen).toMatchObject([{
    subject: { kind: "pair" }, householdId: f.host.householdId, sourceMemberId: f.han.memberId,
    sourceMessageId: source.id, sourceRevision: 1, predicate: "饮料", value: "红茶",
  }]);
  expect(f.recall()).toEqual([]);
});

test("过期执行在新代次认领后返回，无法写入其候选", async () => {
  const f = await fixture();
  await f.send("我喜欢红茶和绿茶");
  const entered = deferred();
  const release = deferred();
  const first = run(f.host, model(async (prompt) => {
    entered.resolve();
    await release.promise;
    return own(prompt, "红茶");
  }));
  try {
    await entered.promise;
    f.clock.setWallMs(f.queued()[0]!.lockedUntil!);
    run(f.host, model((prompt) => own(prompt, "绿茶")));
    await until(() => f.queued()[0]?.status === "done");
  } finally {
    release.resolve();
  }
  await first.stop();
  expect(f.queued()[0]).toMatchObject({ status: "done", attempts: 2 });
  expect(f.recall()).toMatchObject([{ value: "绿茶" }]);
});

test("旧原话重试晚于本人更正时，旧值不会重新进入召回", async () => {
  const f = await fixture();
  const calls: string[] = [];
  run(f.host, model((prompt) => {
    const { text, messageId } = prompt.current;
    if (text.includes("原叶") && !calls.includes(messageId)) {
      calls.push(messageId);
      throw new Error("暂时失败");
    }
    calls.push(messageId);
    const correcting = text.includes("更正");
    const subject = { kind: "member", memberId: prompt.current.authorMemberId } as const;
    return {
      confirmed: [{ ...fact(prompt, subject, "我", correcting ? "无糖豆浆" : "原叶茶"), correction: correcting }],
      pending: [],
    };
  }));
  const old = await f.send("我喜欢原叶茶");
  await until(() => f.queued().some(({ dedupeKey, status, attempts }) => dedupeKey === old.id + ":1"
    && status === "queued" && attempts === 1));
  const corrected = await f.send("更正，我现在爱喝无糖豆浆");
  await until(() => f.queued().some(({ dedupeKey, status }) => dedupeKey === corrected.id + ":1" && status === "done"));
  f.clock.advance(1001);
  await until(() => f.queued().every(({ status }) => status === "done"));
  expect(calls).toEqual([old.id, corrected.id, old.id]);
  expect(f.recall().map(({ value }) => value)).toEqual(["无糖豆浆"]);
});
