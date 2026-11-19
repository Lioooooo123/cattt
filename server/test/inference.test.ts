import { processDailyDiary } from './report-pipeline.ts';
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
import { and, eq, asc, inArray } from "drizzle-orm";
import { db, sql } from "../src/db/client.ts";
import {
  users,
  cats,
  conversations,
  messages,
  triggers,
  decisions,
  tickets,
  outbox,
  mailboxLetters,
  asyncJobs,
  proactiveRules,
  inferenceWatches,
  inferenceObservations,
  inferredPublications,
} from "../src/db/schema.ts";
import {
  recordInferenceSource,
  processInference,
  scanInferenceClock,
  outcomeMetrics,
  readInferenceSnapshot,
} from "../src/agent/inference.ts";
import { setProactivePermission } from "../src/agent/proactive-permission.ts";
import { scheduleFollowup } from "../src/agent/tickets.ts";
import { scanFollowups, processFollowup } from "../src/agent/followup.ts";
import {
  scanDailyDiaries,
} from "../src/agent/daily-diary.ts";
import { app } from "../src/api/app.ts";
import { hashToken } from "../src/auth-token.ts";
import { closeQueues } from "../src/queue.ts";
import { config } from "../src/config.ts";
const now = new Date("2026-11-12T12:00:00Z");
let userId: string,
  catId: string,
  convId: string,
  token: string,
  ruleId: string;
const accounts: string[] = [],
  rules: string[] = [];
beforeEach(async () => {
  token = randomUUID();
  const [u] = await db
    .insert(users)
    .values({ devTokenHash: hashToken(token), timeZone: "UTC" })
    .returning();
  userId = u!.id;
  accounts.push(userId);
  const [c] = await db
    .insert(cats)
    .values({
      userId,
      name: "团子",
      appearance: "orange",
      temperament: "slow",
      traits: { energy: 1, initiative: 1, directness: 1, closeness: 1 },
      createdAt: new Date("2026-11-12T00:00Z"),
    })
    .returning();
  catId = c!.id;
  const [v] = await db.insert(conversations).values({ catId }).returning();
  convId = v!.id;
  ruleId = "ask_outcome-test-" + randomUUID();
  rules.push(ruleId);
  await db.insert(proactiveRules).values({
    ruleId,
    version: 1,
    text: "近期重要的事结束后问结果",
    mode: "observe",
  });
});
afterAll(async () => {
  for (const id of accounts) {
    await sql`delete from async_jobs where source_id in(select t.id from triggers t join cats c on c.id=t.cat_id where c.user_id=${id}) or source_id in(select m.id from messages m join conversations v on v.id=m.conversation_id join cats c on c.id=v.cat_id where c.user_id=${id})`;
    await db.delete(users).where(eq(users.id, id));
  }
  if (rules.length)
    await db
      .delete(proactiveRules)
      .where(inArray(proactiveRules.ruleId, rules));
  await closeQueues();

  await sql.end();
});
const source = async (
  text = "我的重要面试在2026-11-12T11:00:00Z结束",
  extra: Record<string, unknown> = {},
) =>
  (
    await db
      .insert(messages)
      .values({
        conversationId: convId,
        role: "user",
        text,
        createdAt: new Date("2026-11-12T10:00Z"),
        ...extra,
      })
      .returning()
  )[0]!;
const event = async (m: typeof messages.$inferSelect) => {
  await recordInferenceSource(catId, m.id, { ruleId });
  return (
    await db
      .select()
      .from(triggers)
      .where(and(eq(triggers.catId, catId), eq(triggers.source, "chat")))
      .orderBy(asc(triggers.receivedAt))
  ).at(-1);
};
const run = (
  id: string,
  options: Parameters<typeof processInference>[1] = {},
) => processInference(id, { now, ruleId, ...options });
const publications = () =>
  db
    .select()
    .from(inferredPublications)
    .where(eq(inferredPublications.catId, catId));
const said = () =>
  db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, convId), eq(messages.role, "cat")));
const enable = () => setProactivePermission(catId, true);
const auto = () =>
  db
    .insert(proactiveRules)
    .values({ ruleId, version: 2, text: "受控auto夹具", mode: "auto" });
const accept = (
  s: NonNullable<Awaited<ReturnType<typeof readInferenceSnapshot>>>,
) => ({
  decision: "accept",
  rule_assessments: [
    { rule_id: s.rule.ruleId, version: s.rule.version, matched: true },
  ],
  evidence: [{ message_id: s.source.id, quote: s.source.text }],
  topic: s.event!.topic,
  after_at: s.event!.afterAt.toISOString(),
  resolved: false,
});
const req = (method = "GET", body?: unknown, auth = token) =>
  app.request("/v1/me/proactive", {
    method,
    headers: {
      authorization: "Bearer " + auth,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
it("默认关闭、鉴权GET/PATCH持久化且无全局规则修改权；关闭不建来源不调用", async () => {
  expect((await (await req()).json()).allow_proactive).toBe(false);
  expect(
    (await req("PATCH", { allow_proactive: true, mode: "auto" })).status,
  ).toBe(400);
  expect((await req("GET", undefined, randomUUID())).status).toBe(401);
  const m = await source();
  expect(await event(m)).toBeUndefined();
  expect((await req("PATCH", { allow_proactive: true })).status).toBe(200);
  expect((await (await req()).json()).allow_proactive).toBe(true);
});
it("observe的accept记本来会问ignore，无事项/聊天/信件/推送，重复投递不重计", async () => {
  await enable();
  const e = (await event(await source()))!;
  await run(e.id);
  await run(e.id);
  expect(await said()).toHaveLength(0);
  expect(
    await db.select().from(tickets).where(eq(tickets.catId, catId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(outbox).where(eq(outbox.catId, catId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(mailboxLetters)
      .where(eq(mailboxLetters.catId, catId)),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(inferenceObservations)
      .where(eq(inferenceObservations.catId, catId)),
  ).toHaveLength(1);
  const d = await db
    .select()
    .from(decisions)
    .where(eq(decisions.triggerId, e.id));
  expect(d[0]!.outcome).toBe("ignore");
  expect(JSON.stringify(d)).toContain("observe_would_ask");
  expect(JSON.stringify(d)).not.toContain("我的重要面试");
});
it("关闭总开关与最新off规则均零调用，旧事件终止而非无限重试", async () => {
  await enable();
  const e = (await event(await source()))!;
  await db
    .insert(proactiveRules)
    .values({ ruleId, version: 2, text: "关闭夹具", mode: "off" });
  let calls = 0;
  await run(e.id, {
    route: async (s) => {
      calls++;
      return accept(s);
    },
  });
  expect(calls).toBe(0);
  await db
    .insert(proactiveRules)
    .values({ ruleId, version: 3, text: "观察夹具", mode: "observe" });
  const next = (await event(await source("考试在2026-11-12T11:30:00Z结束")))!;
  await setProactivePermission(catId, false);
  await run(next.id, {
    route: async (s) => {
      calls++;
      return accept(s);
    },
  });
  expect(calls).toBe(0);
  expect(await said()).toHaveLength(0);
});
it.each(["unknown", "foreign", "cat", "quote", "missing"] as const)(
  "伪造证据%s不能接单或计指标",
  async (kind) => {
    await enable();
    await auto();
    const m = await source();
    const e = (await event(m))!;
    const other = (
      await db
        .insert(messages)
        .values({ conversationId: convId, role: "cat", text: m.text })
        .returning()
    )[0]!;
    await run(e.id, {
      route: async (s) => {
        const r = accept(s);
        if (kind === "unknown") r.evidence[0]!.message_id = randomUUID();
        if (kind === "foreign") {
          const foreign = accounts[0]!;
          const [c] = await db
            .select()
            .from(cats)
            .where(eq(cats.userId, foreign));
          const [v] = await db
            .select()
            .from(conversations)
            .where(eq(conversations.catId, c!.id));
          const [x] = await db
            .insert(messages)
            .values({ conversationId: v!.id, role: "user", text: m.text })
            .returning();
          r.evidence[0]!.message_id = x!.id;
        }
        if (kind === "cat") r.evidence[0]!.message_id = other.id;
        if (kind === "quote") r.evidence[0]!.quote = "不存在的原话";
        if (kind === "missing") r.evidence = [];
        return r;
      },
    });
    expect(await publications()).toHaveLength(0);
    expect(
      await db.select().from(tickets).where(eq(tickets.catId, catId)),
    ).toHaveLength(0);
  },
);
it.each(["withdraw", "boundary", "memory"] as const)(
  "来源%s在硬门被挡，零调用",
  async (kind) => {
    await enable();
    const m = await source();
    const e = (await event(m))!;
    if (kind === "withdraw")
      await db
        .update(messages)
        .set({ contextAllowed: false })
        .where(eq(messages.id, m.id));
    if (kind === "boundary") {
      const { boundaries } = await import("../src/db/schema.ts");
      await db
        .insert(boundaries)
        .values({ catId, sourceMessageId: m.id, description: "面试" });
    }
    if (kind === "memory")
      await db
        .update(cats)
        .set({ useMemories: false })
        .where(eq(cats.id, catId));
    let calls = 0;
    await run(e.id, {
      route: async (s) => {
        calls++;
        return accept(s);
      },
    });
    expect(calls).toBe(0);
  },
);
it("时间不明确不乱猜，模型失败/结构非法/无证据均ignore，无explicit兜底", async () => {
  await enable();
  await auto();
  const unclear = (await event(await source("明天面试，挺重要的")))!;
  let calls = 0;
  await run(unclear.id, {
    route: async (s) => {
      calls++;
      return accept(s);
    },
  });
  expect(calls).toBe(0);
  const fail = (await event(await source()))!;
  await run(fail.id, {
    route: async () => {
      throw new Error("model failed");
    },
  });
  const invalid = (await event(await source()))!;
  await run(invalid.id, {
    route: async () => ({ decision: "accept", text: "别忘了回我" }),
  });
  expect(await said()).toHaveLength(0);
});
it("未来事后时刻先等待，clock到点才研判；observe无发布事项", async () => {
  await enable();
  const m = await source("我的重要面试在2026-11-13T12:00:00Z结束");
  const e = (await event(m))!;
  await run(e.id);
  expect(
    await db
      .select()
      .from(inferenceWatches)
      .where(eq(inferenceWatches.catId, catId)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(inferenceObservations)
      .where(eq(inferenceObservations.catId, catId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(tickets).where(eq(tickets.catId, catId)),
  ).toHaveLength(0);
  await scanInferenceClock(new Date("2026-11-13T11:59:59Z"), catId);
  expect(
    await db
      .select()
      .from(triggers)
      .where(and(eq(triggers.catId, catId), eq(triggers.source, "clock"))),
  ).toHaveLength(0);
  await scanInferenceClock(new Date("2026-11-13T12:00:01Z"), catId);
  for (const c of await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.catId, catId), eq(triggers.source, "clock"))))
    await run(c.id, { now: new Date("2026-11-13T12:00:01Z") });
  expect(await said()).toHaveLength(0);
  expect(
    await db
      .select()
      .from(inferenceObservations)
      .where(eq(inferenceObservations.catId, catId)),
  ).toHaveLength(1);
});
it("用户主动说结果后不再问，哪怕结果不在短快照最近六条", async () => {
  await enable();
  await auto();
  const e = (await event(await source()))!;
  await source("面试通过了！", { createdAt: new Date("2026-11-12T11:30Z") });
  for (let i = 0; i < 8; i++)
    await source("别的闲聊" + i, { createdAt: new Date("2026-11-12T11:45Z") });
  let calls = 0;
  await run(e.id, {
    route: async (s) => {
      calls++;
      return accept(s);
    },
  });
  expect(calls).toBe(0);
  expect(await said()).toHaveLength(0);
});
it("受控auto并发/重复投递每本地日只一次，经publisher写聊天/信，无推送，时区同日不重开", async () => {
  await enable();
  await auto();
  const a = (await event(await source()))!,
    b = (await event(await source("我的重要考试在2026-11-12T11:10:00Z结束")))!;
  await Promise.all([run(a.id), run(b.id)]);
  await run(a.id);
  await run(b.id);
  expect(await publications()).toHaveLength(1);
  expect(await said()).toHaveLength(1);
  expect(
    await db
      .select()
      .from(mailboxLetters)
      .where(eq(mailboxLetters.catId, catId)),
  ).toHaveLength(1);
  expect(
    (await db.select().from(outbox).where(eq(outbox.catId, catId))).some(
      (o) => o.kind === "push",
    ),
  ).toBe(false);
  await db
    .update(users)
    .set({ timeZone: "Europe/London" })
    .where(eq(users.id, userId));
  const e = (await event(
    await source("我的重要比赛在2026-11-12T11:20:00Z结束"),
  ))!;
  await run(e.id);
  expect(await said()).toHaveLength(1);
});
it("安静时间延期，新鲜度/来源/许可/记忆变化不能出版旧候选", async () => {
  await enable();
  await auto();
  const e = (await event(await source()))!;
  await run(e.id, { now: new Date("2026-11-12T23:00Z") });
  expect(await said()).toHaveLength(0);
  const source2 = await source("重要考试在2026-11-12T11:20:00Z结束");
  const e2 = (await event(source2))!;
  await run(e2.id, {
    beforePublish: async () => {
      await setProactivePermission(catId, false);
    },
  });
  expect(await said()).toHaveLength(0);
});
it("评估等待时规则新增版本会重新研判，新增off则终止；不信旧payload版本", async () => {
  await enable();
  const e = (await event(await source()))!;
  let calls = 0;
  await run(e.id, {
    route: async (s) => {
      calls++;
      if (calls === 1)
        await db
          .insert(proactiveRules)
          .values({ ruleId, version: 2, text: "新观察夹具", mode: "observe" });
      return accept(s);
    },
  });
  expect(calls).toBe(2);
  expect(await said()).toHaveLength(0);
  const [d] = await db
    .select()
    .from(decisions)
    .where(eq(decisions.triggerId, e.id));
  expect(d!.ruleVersion).toBe(2);
  const e2 = (await event(await source("重要考试在2026-11-12T11:20:00Z结束")))!;
  await run(e2.id, {
    route: async (s) => {
      await db
        .insert(proactiveRules)
        .values({ ruleId, version: 3, text: "关闭夹具", mode: "off" });
      return accept(s);
    },
  });
  expect(await said()).toHaveLength(0);
});
it("AGENT_ENABLED=false无推断/发布；总开关关闭不误伤explicit或daily_diary", async () => {
  await enable();
  await auto();
  const m = await source();
  const e = (await event(m))!;
  const old = config.AGENT_ENABLED;
  try {
    config.AGENT_ENABLED = "false";
    let calls = 0;
    await run(e.id, {
      route: async (s) => {
        calls++;
        return accept(s);
      },
    });
    expect(calls).toBe(0);
    expect(await said()).toHaveLength(0);
  } finally {
    config.AGENT_ENABLED = old;
  }
  await setProactivePermission(catId, false);
  await scheduleFollowup(
    catId,
    m.id,
    "2026-11-12T11:59Z",
    "面试怎么样",
    new Date("2026-11-11"),
  );
  await scanFollowups(now, catId);
  for (const c of await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.catId, catId), eq(triggers.source, "clock"))))
    await processFollowup(c.id, { now });
  expect(await said()).toHaveLength(1);
  await scanDailyDiaries(new Date("2026-11-13T00:05Z"), catId);
  for (const c of await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.catId, catId), eq(triggers.source, "clock"))))
    if (c.payload.local_day) await processDailyDiary(c.id);
  const { diaryEntries } = await import("../src/db/schema.ts");
  expect(
    await db.select().from(diaryEntries).where(eq(diaryEntries.catId, catId)),
  ).toHaveLength(1);
});
it("指标只输出聚合；48小时成熟分母、随后自述结果归因，来源撤回/修订后移除", async () => {
  await enable();
  const m = await source();
  const e = (await event(m))!;
  await run(e.id);
  await source("面试通过了！", { createdAt: new Date("2026-11-13T12:00Z") });
  let stats = await outcomeMetrics({
    now: new Date("2026-11-13T12:00Z"),
    catId,
  });
  expect(stats.would_ask_total).toBe(1);
  expect(stats.matured).toBe(0);
  expect(stats.ratio).toBeNull();
  stats = await outcomeMetrics({ now: new Date("2026-11-15T12:00Z"), catId });
  expect(stats.matured).toBe(1);
  expect(stats.volunteered).toBe(1);
  expect(stats.ratio).toBe(1);
  expect(JSON.stringify(stats)).not.toMatch(
    /我的重要面试|面试通过|团子|source|goal|cat_id/,
  );
  await db
    .update(messages)
    .set({ contextAllowed: false })
    .where(eq(messages.id, m.id));
  expect(
    (await outcomeMetrics({ now: new Date("2026-11-15T12:00Z"), catId }))
      .would_ask_total,
  ).toBe(0);
});
it.each(["version", "source", "revision", "boundary"] as const)(
  "出版前%s变化，旧候选失效，必要时重新研判",
  async (kind) => {
    await enable();
    await auto();
    const m = await source();
    const e = (await event(m))!;
    let changed = false,
      calls = 0;
    await run(e.id, {
      route: async (s) => {
        calls++;
        return accept(s);
      },
      beforePublish: async () => {
        if (changed) return;
        changed = true;
        if (kind === "version")
          await db
            .update(conversations)
            .set({ version: 1 })
            .where(eq(conversations.id, convId));
        if (kind === "source")
          await db
            .update(messages)
            .set({ contextAllowed: false })
            .where(eq(messages.id, m.id));
        if (kind === "revision")
          await db
            .update(cats)
            .set({ memoryRevision: 1 })
            .where(eq(cats.id, catId));
        if (kind === "boundary") {
          const { boundaries } = await import("../src/db/schema.ts");
          await db
            .insert(boundaries)
            .values({ catId, sourceMessageId: m.id, description: "面试" });
        }
      },
    });
    if (kind === "version" || kind === "revision") {
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(await said()).toHaveLength(1);
    } else expect(await said()).toHaveLength(0);
  },
);
it("出口前撤回后终止已建auto事项，重启不遗留可发布旧事项", async () => {
  await enable();
  await auto();
  const m = await source();
  const e = (await event(m))!;
  let changed = false;
  await run(e.id, {
    beforePublish: async () => {
      if (!changed) {
        changed = true;
        await db
          .update(messages)
          .set({ contextAllowed: false })
          .where(eq(messages.id, m.id));
      }
    },
  });
  expect(
    await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.catId, catId), eq(tickets.status, "open"))),
  ).toHaveLength(0);
  await run(e.id);
  expect(await said()).toHaveLength(0);
});
it("未来auto到点前无外发，clock到点复核后才发；过期推断安静结束不套explicit留信", async () => {
  await enable();
  await auto();
  const e = (await event(await source("重要面试在2026-11-13T12:00:00Z结束")))!;
  await run(e.id);
  expect(await said()).toHaveLength(0);
  await scanInferenceClock(new Date("2026-11-13T12:00:01Z"), catId);
  for (const c of await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.catId, catId), eq(triggers.source, "clock"))))
    await run(c.id, { now: new Date("2026-11-13T12:00:01Z") });
  expect(await said()).toHaveLength(1);
  const old = (await event(
    await source("重要比赛在2026-11-12T11:00:00Z结束"),
  ))!;
  await run(old.id, { now: new Date("2026-11-14T12:00Z") });
  expect(
    await db
      .select()
      .from(mailboxLetters)
      .where(eq(mailboxLetters.catId, catId)),
  ).toHaveLength(1);
});
it("关闭后重新打开不复活旧epoch；待评估时用户说结果或规则改off立即忽略", async () => {
  await enable();
  const e = (await event(await source()))!;
  await setProactivePermission(catId, false);
  await enable();
  let calls = 0;
  await run(e.id, {
    route: async (s) => {
      calls++;
      return accept(s);
    },
  });
  expect(calls).toBe(0);
  const f = (await event(await source("重要考试在2026-11-12T11:00:00Z结束")))!;
  await run(f.id, {
    route: async (s) => {
      calls++;
      await source("考试考得不错");
      return accept(s);
    },
  });
  expect(await said()).toHaveLength(0);
  expect(
    await db
      .select()
      .from(inferenceObservations)
      .where(eq(inferenceObservations.catId, catId)),
  ).toHaveLength(0);
});
it("auto已建事项遇到新observe/off版本或AGENT关闭，出口停止且不遗留open", async () => {
  await enable();
  await auto();
  const e = (await event(await source()))!;
  let once = false;
  await run(e.id, {
    beforePublish: async () => {
      if (!once) {
        once = true;
        await db
          .insert(proactiveRules)
          .values({ ruleId, version: 3, text: "重新观察", mode: "observe" });
      }
    },
  });
  expect(await said()).toHaveLength(0);
  expect(
    await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.catId, catId), eq(tickets.status, "open"))),
  ).toHaveLength(0);
});
it("异步inference绑定正式账号额度上下文，超过硬上限安静ignore不绕预算", async () => {
  const { executeJob } = await import("../src/jobs/store.ts");
  const { modelReservations } = await import("../src/db/schema.ts");
  await enable();
  const env = config.APP_ENV,
    limit = config.MODEL_DAILY_CALL_LIMIT;
  try {
    config.APP_ENV = "staging";
    config.MODEL_DAILY_CALL_LIMIT = 1;
    const first = (await event(await source()))!;
    const [job] = await db
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.sourceId, first.id));
    await executeJob(job!.id, (j) =>
      processInference(j.objectId, { now, ruleId }),
    );
    const charged = await db
      .select()
      .from(modelReservations)
      .where(eq(modelReservations.userId, userId));
    expect(charged).toHaveLength(1);
    expect(charged[0]!.purpose).toBe("route");
    expect(
      await db
        .select()
        .from(inferenceObservations)
        .where(eq(inferenceObservations.catId, catId)),
    ).toHaveLength(1);
    const second = (await event(
      await source("重要考试在2026-11-12T11:00:00Z结束"),
    ))!;
    const [next] = await db
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.sourceId, second.id));
    await executeJob(next!.id, (j) =>
      processInference(j.objectId, { now, ruleId }),
    );
    expect(
      await db
        .select()
        .from(modelReservations)
        .where(eq(modelReservations.userId, userId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(inferenceObservations)
        .where(eq(inferenceObservations.catId, catId)),
    ).toHaveLength(1);
    expect(await said()).toHaveLength(0);
  } finally {
    config.APP_ENV = env;
    config.MODEL_DAILY_CALL_LIMIT = limit;
  }
});
it("带毫秒和偏移的原话时刻保持绝对时间，不能按当前时区截短导致提前", async () => {
  const { outcomeEvent } = await import("../src/agent/inference.ts");
  expect(
    outcomeEvent(
      "重要面试在2026-11-12T13:00:00.123Z结束",
      new Date("2026-11-12T10:00Z"),
      "Asia/Shanghai",
    )?.afterAt.toISOString(),
  ).toBe("2026-11-12T13:00:00.123Z");
  expect(
    outcomeEvent(
      "重要面试在2026-11-12T13:00:00.123+08:00结束",
      new Date("2026-11-12T00:00Z"),
      "UTC",
    )?.afterAt.toISOString(),
  ).toBe("2026-11-12T05:00:00.123Z");
});
it("用户切时区不会把原话的本地结束时间提前；clock沿用来源时区，到点用当前时区做注意力门", async () => {
  await enable();
  const e = (await event(await source("重要面试今天13点结束")))!;
  await db
    .update(users)
    .set({ timeZone: "Asia/Shanghai" })
    .where(eq(users.id, userId));
  await run(e.id);
  const [watch] = await db
    .select()
    .from(inferenceWatches)
    .where(eq(inferenceWatches.catId, catId));
  expect(watch?.dueAt.toISOString()).toBe("2026-11-12T13:00:00.000Z");
  expect(
    await db
      .select()
      .from(inferenceObservations)
      .where(eq(inferenceObservations.catId, catId)),
  ).toHaveLength(0);
  await scanInferenceClock(new Date("2026-11-12T13:01Z"), catId);
  for (const c of await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.catId, catId), eq(triggers.source, "clock"))))
    await run(c.id, { now: new Date("2026-11-12T13:01Z") });
  expect(
    await db
      .select()
      .from(inferenceObservations)
      .where(eq(inferenceObservations.catId, catId)),
  ).toHaveLength(1);
});
it("后台Router等待时快聊仍能出首字，不占用对话锁或把研判放在快聊前", async () => {
  const { createSendTurn } = await import("../src/turns/create.ts");
  const { turns } = await import("../src/db/schema.ts");
  await enable();
  const e = (await event(await source()))!;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const background = run(e.id, {
    route: async (s) => {
      entered();
      await waiting;
      return accept(s);
    },
  });
  await started;
  try {
    const reply = await createSendTurn(
      { userId, catId, conversationId: convId },
      randomUUID(),
      "我来坐坐",
    );
    let first = false,
      ended = false;
    for (let i = 0; i < 200; i++) {
      const [turn] = await db
        .select()
        .from(turns)
        .where(eq(turns.id, reply.turnId));
      first = !!turn?.firstTokenAt;
      ended = ["completed", "failed", "stopped"].includes(turn?.status ?? "");
      if (ended) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(first).toBe(true);
    expect(ended).toBe(true);
  } finally {
    release();
    await background;
  }
});
it("auto规则重评换事项后再撤回来源，也终止新事项且重启不遗留open", async () => {
  await enable();
  await auto();
  const m = await source();
  const e = (await event(m))!;
  let step = 0;
  await run(e.id, {
    beforePublish: async () => {
      step++;
      if (step === 1)
        await db
          .insert(proactiveRules)
          .values({ ruleId, version: 3, text: "新auto夹具", mode: "auto" });
      if (step === 2)
        await db
          .update(messages)
          .set({ contextAllowed: false })
          .where(eq(messages.id, m.id));
    },
  });
  expect(
    await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.catId, catId), eq(tickets.status, "open"))),
  ).toHaveLength(0);
  expect(await said()).toHaveLength(0);
  await run(e.id);
  expect(await said()).toHaveLength(0);
});
