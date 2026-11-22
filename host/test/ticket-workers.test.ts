import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ManualClock } from "../src/clock/index.ts";
import { JobRunner } from "../src/jobs/index.ts";
import type { ToolModel, ToolResponse } from "../src/llm/tool-loop.ts";
import { startHost } from "../src/runtime/index.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { claimJob, enqueueJob, getJob } from "../src/store/jobs.ts";
import { jobs, messages, runs, runSteps, tickets } from "../src/store/schema/index.ts";
import { listWorkerReports } from "../src/store/ticket-worker.ts";
import { dispatchTicketCommand } from "../src/tickets/index.ts";
import { registerTicketWorkers, TicketQueueAdmission } from "../src/ticket-workers/index.ts";
import type { TicketWorkerServices } from "../src/ticket-workers/types.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const start = Date.parse("2026-11-22T03:00:00Z");
const clock = new ManualClock("ticket-worker", start);
let dataDir: string;
let host: Awaited<ReturnType<typeof startHost>>;
let actor: NonNullable<ReturnType<typeof resolveDeviceToken>>;
let conversationId: string;
let runner: JobRunner;
let withdrawn = new Set<string>();

beforeEach(async () => {
  clock.setWallMs(start);
  withdrawn = new Set();
  dataDir = mkdtempSync(join(tmpdir(), "cattt-ticket-worker-"));
  host = await open();
  const device = issueTestDevice(host, "小甲");
  actor = resolveDeviceToken(host.store.db, clock, device.token)!;
  conversationId = listConversations(host.store.db, actor).find((row) => row.kind === "direct")!.id;
});

afterEach(async () => {
  await runner?.stop();
  await host?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function open(components: Parameters<typeof startHost>[1] = []) {
  return startHost({
    dataDir, clock,
    ticketAdmission: {
      readKnowledgeSource(db, proof) {
        if (!withdrawn.has(proof.sourceMessageId)) {
          return db.select().from(messages).where(eq(messages.id, proof.sourceMessageId)).get();
        }
      },
    },
  }, components);
}

function startWorkers(services: TicketWorkerServices = {}) {
  runner = new JobRunner({ pollIntervalMs: 5, graceMs: 0 });
  registerTicketWorkers(runner, services);
  runner.start(host);
}

function said(text: string) {
  const message = sendMessage(host.store.db, clock, actor, conversationId, {
    clientMessageId: crypto.randomUUID(), text,
  }).body.message;
  return { source: "chat" as const, messageId: message.id, revision: 1 };
}

function errand(goal = "帮我整理准备事项") {
  const origin = said(goal);
  const receipt = dispatchTicketCommand(host, { actor, conversationId, origin }, { kind: "start", goal });
  return { ...receipt, origin };
}

function current(ticketId: string) {
  return host.store.db.select().from(tickets).where(eq(tickets.id, ticketId)).get()!;
}

function steps() {
  return host.store.db.select().from(runSteps).all();
}

function reports() {
  return listWorkerReports(host.store.db, host.hostId);
}

function calls(...entries: Array<[string, string, unknown]>): ToolResponse {
  return {
    finishReason: "tool-calls", text: "", reasoning: "内部推理", outputTokens: 50,
    calls: entries.map(([id, name, input]) => ({ id, name, input })),
  };
}

function model(script: ToolModel["complete"]): ToolModel {
  return { complete: script };
}

async function until(assertion: () => void) {
  // 多步预算用例逐步写 SQLite 检查点，给整套测试中的磁盘竞争留出时间。
  const deadline = performance.now() + 15_000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (performance.now() >= deadline) {
        throw error;
      }
      await Bun.sleep(5);
    }
  }
}

test("重启从持久检查点继续，原工具不重跑，结果及检查点一次提交", async () => {
  const ticket = errand();
  let firstCalls = 0;
  startWorkers({
    model: model(async (_request, signal) => {
      if (++firstCalls === 1) {
        return calls(["clock-1", "get_time", {}]);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason;
    }),
  });
  await until(() => expect(firstCalls).toBe(2));
  expect(steps()).toHaveLength(1);
  const oldJob = host.store.db.select().from(jobs).where(eq(jobs.queue, "errand")).get()!;
  await runner.stop();
  await host.stop();
  clock.setWallMs(oldJob.lockedUntil! + 1);
  host = await open();
  startWorkers({
    model: model(async (request) => {
      expect(JSON.stringify(request.messages)).toContain("clock-1");
      expect(JSON.stringify(request.messages)).toContain("内部推理");
      return calls(["ready-1", "report", { status: "ready", result: "已经整理完" }]);
    }),
  });
  await until(() => expect(reports()).toHaveLength(1));
  expect(steps()).toHaveLength(2);
  expect(current(ticket.ticket_id).stage).toBe("completed");
  // 重投相同 payload 也不能再出一份业务汇报。
  enqueueJob(host.store.db, clock, { queue: "errand", payload: JSON.parse(oldJob.payload) });
  host.bus.publish("jobs:wake", { queue: "errand" });
  await until(() => expect(host.store.db.select().from(jobs).where(eq(jobs.queue, "errand")).all().every((job) => job.status === "done")).toBe(true));
  expect(reports()).toHaveLength(1);
  expect(reports()[0]!.result).toEqual({ status: "ready", result: "已经整理完" });
});

test("整批预检拒绝、有界修正跨重启不重置", async () => {
  errand();
  let requests = 0;
  let toolExecutions = 0;
  const context: TicketWorkerServices["context"] = {
    prepare: () => ({
      tools: {
        lookup: awaitedTool(),
      },
    }),
    permits: () => true,
  };
  function awaitedTool() {
    return {
      description: "读允许的原话",
      schema: z.strictObject({}),
      read: () => {
        toolExecutions++;
        return { value: 42 };
      },
    };
  }
  startWorkers({
    context,
    model: model(async (_request, signal) => {
      if (++requests === 1) {
        return calls(["valid", "lookup", {}], ["unknown", "unknown", {}]);
      }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason;
    }),
  });
  await until(() => expect(requests).toBe(2));
  expect(toolExecutions).toBe(0);
  expect(steps()[0]!.usage.toolValidationFailed).toBe(true);
  const old = host.store.db.select().from(jobs).where(eq(jobs.queue, "errand")).get()!;
  await runner.stop();
  await host.stop();
  clock.setWallMs(old.lockedUntil! + 1);
  host = await open();
  startWorkers({
    context,
    model: model(async (request) => {
      expect(request.system).toContain("整体拒绝");
      return calls(["invalid", "lookup", { wrong: true }]);
    }),
  });
  await until(() => expect(reports()[0]?.result.status).toBe("failed"));
  expect(steps()).toHaveLength(1);
  expect(toolExecutions).toBe(0);
});

test("来源撤回、取消和旧认领无法提交模型返回的内容", async () => {
  const cancelled = errand("这件取消");
  const revoked = errand("这句撤回");
  const pending: Array<(response: ToolResponse) => void> = [];
  startWorkers({ model: model(async () => new Promise((resolve) => pending.push(resolve))) });
  await until(() => expect(pending).toHaveLength(2));
  dispatchTicketCommand(host, {
    actor, origin: { source: "app", requestId: "cancel" },
  }, { kind: "cancel", ticketId: cancelled.ticket_id });
  withdrawn.add(revoked.origin.messageId);
  for (const finish of pending) {
    finish(calls(["x", "report", { status: "ready", result: "旧结果" }]));
  }
  await until(() => expect(current(revoked.ticket_id).stage).toBe("discarded"));
  expect(current(cancelled.ticket_id).stage).toBe("cancelled");
  expect(steps()).toHaveLength(0);
  expect(reports()).toHaveLength(0);
});

test("同一作业失去认领后，迟到结果由 Job attempt fencing 拒绝", async () => {
  errand();
  let finish: ((response: ToolResponse) => void) | undefined;
  startWorkers({ model: model(async () => new Promise((resolve) => { finish = resolve; })) });
  await until(() => expect(finish).toBeDefined());
  const old = host.store.db.select().from(jobs).where(eq(jobs.queue, "errand")).get()!;
  clock.setWallMs(old.lockedUntil! + 1);
  expect(claimJob(host.store.db, clock, "errand", 45_000)!.attempts).toBe(2);
  finish!(calls(["late", "report", { status: "ready", result: "过期" }]));
  await Bun.sleep(30);
  expect(steps()).toHaveLength(0);
  expect(reports()).toHaveLength(0);
  expect(getJob(host.store.db, old.id)!.attempts).toBe(2);
});

test("等待补充后继续同代，失败后保留旧报告并切换新代，排队会转正", async () => {
  const a = errand("第一件");
  errand("第二件");
  const c = errand("第三件");
  expect(c.queued).toBe(true);
  const observed = new Map<string, number>();
  startWorkers({
    model: model(async (request) => {
      const goal = ["第一件", "第二件", "第三件"].find((g) => JSON.stringify(request.messages[0]).includes(g))!;
      const n = (observed.get(goal) ?? 0) + 1;
      observed.set(goal, n);
      if (goal === "第一件" && n === 1) {
        return calls(["question", "report", { status: "waiting", question: "你更想整理哪个部分？" }]);
      }
      if (goal === "第一件" && n === 2) {
        expect(JSON.stringify(request.messages)).toContain("用户补充");
        return calls(["blocked", "report", { status: "blocked", reason: "还缺一页" }]);
      }
      if (goal === "第一件") {
        expect(JSON.stringify(request.messages)).not.toContain("question");
      }
      return calls([`ready-${n}`, "report", { status: "ready", result: "好了" }]);
    }),
  });
  const admission = new TicketQueueAdmission(5);
  admission.start(host);
  try {
    await until(() => expect(current(c.ticket_id).stage).toBe("completed"));
    expect(current(a.ticket_id).stage).toBe("waiting");
    for (const [text, stage] of [["补充一页", "blocked"], ["再补另一页", "completed"]] as const) {
      dispatchTicketCommand(host, { actor, conversationId, origin: said(text) }, {
        kind: "append", ticketId: a.ticket_id, text,
      });
      await until(() => expect(current(a.ticket_id).stage).toBe(stage));
    }
    const history = reports().filter((item) => item.ticketId === a.ticket_id);
    expect(history.map((item) => [item.generation, item.result.status])).toEqual([[0, "waiting"], [0, "blocked"], [1, "ready"]]);
    expect(history[0]!.quietAfter).toBe(start + 86_400_000);
    expect(listWorkerReports(host.store.db, host.hostId, history[1]!.sequence)).toEqual([history[2]!]);
  } finally {
    admission.stop();
  }
});

test("步骤、token、活动时间独立限额，暂态错误只重试三次", async () => {
  const a = errand("输出限制");
  const b = errand("步骤限制");
  const seen = new Map<string, number>();
  startWorkers({
    retryDelay: async () => {},
    model: model(async (request) => {
      const goal = JSON.stringify(request.messages[0]);
      const n = (seen.get(goal) ?? 0) + 1;
      seen.set(goal, n);
      if (goal.includes("输出限制") && n <= 3) {
        throw Object.assign(new Error("network"), { statusCode: 503 });
      }
      return {
        ...calls([`progress-${n}`, "report", { status: "progress" }]),
        outputTokens: goal.includes("输出限制") ? request.maxOutputTokens : 1,
      };
    }),
  });
  await until(() => expect(reports()).toHaveLength(2));
  const run = (id: string) => host.store.db.select().from(runs).where(eq(runs.ticketId, id)).get()!;
  expect(run(a.ticket_id).outputTokens).toBe(8000);
  expect([...seen.values()].sort((x, y) => x - y)).toEqual([8, 20]);
  expect(steps().filter((step) => step.runId === run(b.ticket_id).id)).toHaveLength(20);
  await runner.stop();
  const c = errand("时间限制");
  host.store.db.update(runs).set({ elapsedMs: 599_000 }).where(eq(runs.ticketId, c.ticket_id)).run();
  startWorkers({
    model: model(async () => {
      clock.advance(1000);
      return calls(["outside", "report", { status: "ready", result: "超时后完成" }]);
    }),
  });
  await until(() => expect(current(c.ticket_id).stage).toBe("failed"));
  expect(run(c.ticket_id).elapsedMs).toBe(600_000);
});

test("约定在静默时段推迟，重启后超过 24 小时只向 Router 报告信箱候选", async () => {
  const receipt = dispatchTicketCommand(host, { actor, conversationId, origin: said("今晚想再聊学校") }, {
    kind: "schedule", about: "学校", when: "2026-11-22T22:15:00+08:00",
  });
  clock.setWallMs(Date.parse("2026-11-22T14:15:00Z"));
  startWorkers();
  const job = host.store.db.select().from(jobs).where(eq(jobs.queue, "followup")).get()!;
  await until(() => expect(getJob(host.store.db, job.id)?.runAt).toBe(Date.parse("2026-11-23T01:00:00Z")));
  expect(reports()).toHaveLength(0);
  await runner.stop();
  await host.stop();
  clock.setWallMs(Date.parse("2026-11-23T14:16:00Z"));
  host = await open();
  startWorkers();
  await until(() => expect(reports()).toHaveLength(1));
  expect(reports()[0]).toMatchObject({
    ticketId: receipt.ticket_id, kind: "followup", forMemberId: actor.memberId,
    conversationId, timeZone: "Asia/Shanghai",
    result: { status: "due", about: "学校", delivery: "mailbox_only" },
  });
  expect(host.store.db.select().from(messages).all()).toHaveLength(1);
});
