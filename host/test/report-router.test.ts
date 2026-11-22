import "reflect-metadata";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ManualClock } from "../src/clock/index.ts";
import { Gateway } from "../src/gateway/index.ts";
import { JobRunner } from "../src/jobs/index.ts";
import { ReportRouter } from "../src/router/index.ts";
import { startHost } from "../src/runtime/index.ts";
import type { HostConfig } from "../src/runtime/index.ts";
import { businessRow } from "../src/store/business.ts";
import { listConversations, readMessages, sendMessage } from "../src/store/conversations.ts";
import { createDevice, resolveDeviceToken, revokeDevice } from "../src/store/identity.ts";
import { publishReport } from "../src/store/report-publications.ts";
import { claimJob, completeJob } from "../src/store/jobs.ts";
import { hosts, mailboxLetters, mailboxReads, messages, publicationReceipts, pushOutbox, runs, tickets } from "../src/store/schema/index.ts";
import { commitWorkerResult, listWorkerReports, readConversationHead } from "../src/store/ticket-worker.ts";
import { cancelTurn } from "../src/store/turns.ts";
import { registerTicketWorkers } from "../src/ticket-workers/index.ts";
import type { WorkerDependency, WorkerResult } from "../src/ticket-workers/types.ts";
import { dispatchTicketCommand } from "../src/tickets/index.ts";
import type { TicketJob } from "../src/tickets/types.ts";
import { TurnRunner } from "../src/turns/index.ts";
import { DevelopmentEchoReplier } from "../src/turns/development-replier.ts";
import { issueTestDevice } from "./identity-fixture.ts";

const noon = Date.parse("2026-11-22T04:00:00Z");
const clock = new ManualClock("report-router", noon);
let dataDir: string;
let host: Awaited<ReturnType<typeof startHost>>;
let config: HostConfig;
let denied: Set<string>;
let withdrawn: Set<string>;
let permittedDependencies: Set<string>;

function open(components: Parameters<typeof startHost>[1] = []) {
  return startHost(config, components);
}

beforeEach(async () => {
  clock.setWallMs(noon);
  denied = new Set();
  withdrawn = new Set();
  permittedDependencies = new Set();
  dataDir = mkdtempSync(join(tmpdir(), "cattt-report-router-"));
  config = {
    dataDir, clock, port: 0, lanHttpsPort: 0, replier: new DevelopmentEchoReplier(),
    ticketAdmission: {
      readKnowledgeSource(db, proof) {
        if (!withdrawn.has(proof.sourceMessageId)) {
          return db.select().from(messages).where(eq(messages.id, proof.sourceMessageId)).get();
        }
      },
      allowsTopic: (_db, input) => ![...denied].some((word) => input.text.includes(word)),
    },
    ticketWorkerContext: {
      prepare: () => ({}),
      permits: (_db, _ticket, dependencies) => dependencies.every((item) => permittedDependencies.has(item.id)),
    },
  };
  host = await open();
});

afterEach(async () => {
  await host?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function member(name: string, kind: "direct" | "group" = "direct") {
  const { token } = issueTestDevice(host, name);
  const actor = resolveDeviceToken(host.store.db, clock, token)!;
  const conversationId = listConversations(host.store.db, actor).find((row) => row.kind === kind)!.id;
  return { actor, conversationId, token };
}

function say(person: ReturnType<typeof member>, text: string, stop = true) {
  const { actor, conversationId } = person;
  const { message, turn } = sendMessage(host.store.db, clock, actor, conversationId, {
    text, clientMessageId: crypto.randomUUID(),
  }).body;
  if (stop && turn) {
    cancelTurn(host.store.db, clock, actor, conversationId, turn!.id);
  }
  return { source: "chat" as const, messageId: message.id, revision: 1 };
}

function errand(person: ReturnType<typeof member>, goal: string, stop = true) {
  const origin = say(person, goal, stop);
  const receipt = dispatchTicketCommand(host, { ...person, origin }, { kind: "start", goal });
  return { ...receipt, origin };
}

function followup(person: ReturnType<typeof member>, topic: string, dueAt = clock.wallMs() + 60_000) {
  const origin = say(person, topic);
  const receipt = dispatchTicketCommand(host, { ...person, origin }, {
    kind: "schedule", when: new Date(dueAt).toISOString(), about: topic,
  });
  clock.setWallMs(dueAt);
  return receipt;
}

function persist(kind: TicketJob["kind"], result: WorkerResult, dependencies: WorkerDependency[] = []) {
  const db = host.store.db;
  const job = claimJob(db, clock, kind, 45_000)!;
  const payload = JSON.parse(job.payload) as TicketJob;
  const ticket = db.select().from(tickets).where(eq(tickets.id, payload.ticketId)).get()!;
  const report = commitWorkerResult(db, {
    attempt: job, payload, clock, policy: config.ticketAdmission, context: config.ticketWorkerContext,
  }, { result, dependencies, head: readConversationHead(db, ticket, clock, host.config.groupPublicationAuthority) })!;
  completeJob(db, clock, job);
  return report;
}

function receipts() { return host.store.db.select().from(publicationReceipts).all(); }
function outbox() { return host.store.db.select().from(pushOutbox).all(); }
function letters() { return host.store.db.select().from(mailboxLetters).all(); }

function chat(person: ReturnType<typeof member>) {
  return readMessages(host.store.db, person.actor, person.conversationId, {}).messages
    .filter((message) => message.author.kind === "cat");
}

async function until(assertion: () => void) {
  const deadline = performance.now() + 2500;
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

test("实际 worker 持久汇报后停机，Router 从游标追上，真实 HTTP 只读本人的信并幂等已读", async () => {
  const a = member("小甲");
  const b = member("小乙");
  errand(a, "帮我整理旅行计划");
  const jobs = new JobRunner({ pollIntervalMs: 5 });
  registerTicketWorkers(jobs, { model: { async complete() {
    return {
      finishReason: "tool-calls", text: "", reasoning: "", outputTokens: 10,
      calls: [{ id: "report-1", name: "report", input: { status: "ready", result: "甲的计划正文" } }],
    };
  } } });
  jobs.start(host);
  try {
    await until(() => expect(listWorkerReports(host.store.db, host.hostId)).toHaveLength(1));
    expect(chat(a)).toHaveLength(0);
  } finally {
    await jobs.stop();
  }
  await host.stop();
  const gateway = new Gateway();
  host = await open([new ReportRouter({ pollIntervalMs: 5 }), gateway]);
  await until(() => expect(receipts()[0]?.status).toBe("published"));
  const request = (person: typeof a, path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${gateway.port}/v2${path}`, {
      method, headers: { authorization: `Bearer ${person.token}` },
    });
  const aPage = await request(a, "/mailbox?limit=1");
  expect(aPage.status).toBe(200);
  const page = await aPage.json();
  const [letter] = page.letters;
  expect((await (await request(a, `/mailbox?after=${page.next_cursor}`)).json()).letters).toEqual([]);
  expect((await request(b, `/mailbox?after=${page.next_cursor}`)).status).toBe(400);
  expect(letter).toMatchObject({ text: "甲的计划正文", for_member_id: a.actor.memberId, read_at: null });
  expect((await (await request(b, "/mailbox")).json()).letters).toEqual([]);
  expect((await request(b, `/mailbox/${letter.id}/read`, "POST")).status).toBe(404);
  const read = await request(a, `/mailbox/${letter.id}/read`, "POST");
  const first = await read.json();
  clock.setWallMs(clock.wallMs() + 1);
  expect(await (await request(a, `/mailbox/${letter.id}/read`, "POST")).json()).toEqual(first);
  expect(first.letter.read_at).toBe(noon);
  expect(letters()[0]!.rev).toBe(1);
  expect(host.store.db.select().from(mailboxReads).all()).toMatchObject([{ letterId: letter.id, rev: 1, readAt: noon }]);
  const history = await request(a, `/conversations/${a.conversationId}/messages`);
  expect((await history.json()).messages.find((message: { author: { kind: string } }) => message.author.kind === "cat")?.text).toContain("信箱");
  expect(chat(b)).toEqual([]);

  const report = listWorkerReports(host.store.db, host.hostId)[0]!;
  expect(publishReport(host, report.id)).toEqual(receipts()[0]);
  host.bus.publish("worker:report", { reportId: report.id }); // 发布已提交但调用方未收到回执。
  await host.stop();
  host = await open([new ReportRouter({ pollIntervalMs: 5 })]);
  expect(receipts()).toHaveLength(1);
  expect(chat(a)).toHaveLength(1);
  expect(letters()).toHaveLength(1);
});

test("扫描跨过静默中的报告，重启保留重试；错过超过一天的约定只留信", async () => {
  const a = member("小甲");
  const b = member("小乙");
  const quiet = Date.parse("2026-11-22T14:10:00Z");
  const first = followup(a, "晚上复盘", quiet - 60_000);
  const scheduled = persist("followup", { status: "due", about: "晚上复盘", delivery: "scheduled" });
  clock.setWallMs(quiet);
  await host.stop();
  host = await open([new ReportRouter({ pollIntervalMs: 5 })]);
  expect(receipts()).toMatchObject([{ reportId: scheduled.id, status: "pending", retryAt: Date.parse("2026-11-23T01:00:00Z") }]);
  expect(chat(a)).toHaveLength(0);
  host.config.ticketAdmission!.publicationTimeZone = (_db, scope) =>
    scope.memberId === b.actor.memberId ? "UTC" : undefined;
  errand(b, "整理书单");
  const newer = persist("errand", { status: "ready", result: "乙的书单" });
  await until(() => expect(receipts().find((row) => row.reportId === newer.id)?.status).toBe("published"));
  expect(receipts().find((row) => row.reportId === scheduled.id)?.status).toBe("pending");
  const nextMorning = Date.parse("2026-11-23T01:00:00Z");
  await host.stop();
  clock.setWallMs(nextMorning);
  host = await open([new ReportRouter({ pollIntervalMs: 5 })]);
  await until(() => expect(chat(a)).toHaveLength(1));
  await host.stop();
  host = await open();
  const beforeLate = chat(b).length;
  const late = followup(b, "明天准备");
  const overdue = persist("followup", { status: "due", about: "明天准备", delivery: "scheduled" });
  await host.stop();
  clock.setWallMs(overdue.dueAt! + 86_400_001);
  host = await open([new ReportRouter({ pollIntervalMs: 5 })]);
  await until(() => expect(letters()).toHaveLength(3));
  expect(letters().map((letter) => letter.ticketId)).toEqual(expect.arrayContaining([first.ticket_id, late.ticket_id]));
  expect(chat(a)).toHaveLength(1);
  expect(chat(b)).toHaveLength(beforeLate);
  expect(outbox()).toHaveLength(0);
});

test("等待正常轮次结束，接受该轮新增的猫回复；漏唤醒仍能追上", async () => {
  const a = member("小甲");
  errand(a, "帮我整理旅行计划", false);
  const pending = persist("errand", { status: "ready", result: "准备清单" });
  const router = new ReportRouter({ pollIntervalMs: 5 });
  router.start(host);
  const turns = new TurnRunner();
  try {
    expect(receipts()).toMatchObject([{ status: "pending", reason: "conversation_busy" }]);
    turns.start(host);
    await until(() => expect(chat(a)).toHaveLength(1));
    clock.setWallMs(noon + 1001);
    await until(() => expect(receipts()).toMatchObject([{ reportId: pending.id, status: "published" }]));
    expect(chat(a)).toHaveLength(2);
  } finally {
    await turns.stop();
    await router.stop();
  }
});

test("发布事务重查撤回、代次、会话新鲜度、回避与非本机发布权限", async () => {
  const a = member("小甲");
  const b = member("小乙");
  const old = errand(a, "准备会议");
  const prior = persist("errand", { status: "failed", reason: "缺少材料" });
  const addition = say(a, "带上团队的清单");
  dispatchTicketCommand(host, { ...a, origin: addition }, { kind: "append", ticketId: old.ticket_id, text: "带上团队的清单" });
  expect(host.store.db.select().from(runs).all().map((run) => run.generation)).toEqual([0, 1]);
  permittedDependencies.add("diary-1");
  const invalidDependency = persist("errand", { status: "ready", result: "新的清单" }, [
    { kind: "diary", id: "diary-1", memberId: a.actor.memberId, revision: 1 },
  ]);
  permittedDependencies.clear();

  const withdrawnTicket = followup(b, "回看课件");
  const invalidSource = persist("followup", { status: "due", about: "回看课件", delivery: "scheduled" });
  withdrawn.add(invalidSource.sourceProofs[0]!.sourceMessageId);
  expect(withdrawnTicket.ticket_id).toBe(invalidSource.ticketId);

  followup(a, "另一个约定");
  const stale = persist("followup", { status: "due", about: "另一个约定", delivery: "scheduled" });
  say(a, "先聊点新的");
  followup(b, "回避主题");
  const avoided = persist("followup", { status: "due", about: "回避主题", delivery: "scheduled" });
  denied.add("回避主题");

  const router = new ReportRouter({ pollIntervalMs: 5 });
  router.start(host);
  try {
    expect(Object.fromEntries(receipts().map((row) => [row.reportId, row.reason]))).toMatchObject({
      [prior.id]: "ticket_changed", [invalidDependency.id]: "source_unavailable",
      [invalidSource.id]: "source_unavailable", [stale.id]: "conversation_changed",
      [avoided.id]: "permission_denied",
    });
    followup(a, "只在家里的电脑发");
    const wrongHost = persist("followup", { status: "due", about: "只在家里的电脑发", delivery: "scheduled" });
    const remote = host.store.db.insert(hosts).values({
      ...businessRow(clock, host.hostId), householdId: host.householdId, displayName: "第二台 Mac",
    }).returning().get()!;
    host.store.raw.query("UPDATE members SET home_host_id = ? WHERE id = ?").run(remote.id, a.actor.memberId);
    await until(() => expect(receipts().find((row) => row.reportId === wrongHost.id)?.reason).toBe("wrong_publisher"));
    expect(letters()).toHaveLength(0);
    expect(chat(a)).toHaveLength(0);
    expect(chat(b)).toHaveLength(0);
  } finally {
    await router.stop();
  }
});

test("写 outbox 失败回滚正文与收据，落盘后延期投递仍复核来源", async () => {
  const a = member("小甲");
  const reportTicket = followup(a, "午后看书");
  const report = persist("followup", { status: "due", about: "午后看书", delivery: "scheduled" });
  let delivered = 0;
  host.config.publicationPush = async () => { delivered += 1; return "sent"; };
  host.config.onError = () => {};
  host.store.raw.exec("CREATE TRIGGER abort_outbox BEFORE INSERT ON publication_push_outbox BEGIN SELECT RAISE(ABORT,'test fault'); END");
  const router = new ReportRouter({ pollIntervalMs: 5 });
  router.start(host);
  try {
    expect(chat(a)).toHaveLength(0);
    expect(letters()).toHaveLength(0);
    expect(receipts()).toMatchObject([{ reportId: report.id, status: "pending" }]);
    expect(outbox()).toEqual([]);
    host.store.raw.exec("DROP TRIGGER abort_outbox");
    await until(() => expect(outbox()).toMatchObject([{ status: "sent" }]));
    expect(delivered).toBe(1);
    expect(receipts()).toMatchObject([{ ticketId: reportTicket.ticket_id, status: "published" }]);
    expect(chat(a)).toHaveLength(1);
    expect(letters()).toHaveLength(1);

    const b = member("小乙");
    followup(b, "明天会开窗");
    const next = persist("followup", { status: "due", about: "明天会开窗", delivery: "scheduled" });
    host.config.publicationPush = async () => ({ retryAt: clock.wallMs() + 60_000 });
    await until(() => expect(outbox().find((row) => row.reportId === next.id)?.budgetDay).toBe("2026-11-22"));
    withdrawn.add(next.sourceProofs[0]!.sourceMessageId);
    host.config.publicationPush = async () => { delivered += 1; return "sent"; };
    clock.setWallMs(clock.wallMs() + 60_001);
    await until(() => expect(outbox().find((row) => row.reportId === next.id)?.status).toBe("dropped"));
    expect(delivered).toBe(1);
  } finally {
    await router.stop();
  }
});

test("推送日频率按成员计数，第 3 条仍可写聊天和信箱", async () => {
  const a = member("小甲");
  const b = member("小乙");
  const delivered: string[] = [];
  host.config.publicationPush = async (intent) => {
    delivered.push(intent.memberId);
    return "sent";
  };
  const router = new ReportRouter({ pollIntervalMs: 5 });
  router.start(host);
  try {
    for (const [index, person] of [a, a, a, b].entries()) {
      const about = `第 ${index + 1} 个约定`;
      followup(person, about);
      const report = persist("followup", { status: "due", about, delivery: "scheduled" });
      await until(() => expect(receipts().find((row) => row.reportId === report.id)?.status).toBe("published"));
    }
    expect(delivered).toEqual([a.actor.memberId, a.actor.memberId, b.actor.memberId]);
    expect(outbox().filter((row) => row.status === "dropped")).toHaveLength(1);
    expect(chat(a)).toHaveLength(3);
    expect(chat(b)).toHaveLength(1);
    expect(letters()).toHaveLength(4);
  } finally {
    await router.stop();
  }
});

test("群聊登记的发布宿主不能代替租约，逾期追问转为静默等待", async () => {
  const a = member("小甲", "group");
  const b = member("小乙");
  followup(a, "群聊约定");
  const group = persist("followup", { status: "due", about: "群聊约定", delivery: "scheduled" });
  const waiting = errand(b, "帮我收集几条想法");
  const report = persist("errand", { status: "waiting", question: "你希望先了解哪一项？" });
  host.store.db.insert(hosts).values({
    ...businessRow(clock, host.hostId), householdId: host.householdId, displayName: "另一台 Mac",
  }).run();
  clock.setWallMs(report.quietAfter!);
  const router = new ReportRouter({ pollIntervalMs: 5 });
  router.start(host);
  try {
    expect(receipts().find((row) => row.reportId === group.id)?.reason).toBe("group_lease_unavailable");
    expect(receipts().find((row) => row.reportId === report.id)?.reason).toBe("question_expired");
    expect(host.store.db.select().from(tickets).where(eq(tickets.id, waiting.ticket_id)).get()?.stage).toBe("quiet_waiting");
    expect(chat(a)).toHaveLength(0);
    expect(chat(b)).toHaveLength(0);
    expect(letters()).toHaveLength(0);
  } finally {
    await router.stop();
  }
});

test("APNs 只向本人仍配对的设备投递，重试复用设备收据、撤销后不重放", async () => {
  const { createPublicationPush } = await import("../src/push/index.ts");
  const { pushRoutes } = await import("../src/push/routes.ts");
  const a = member("小甲");
  const b = member("小乙");
  const second = createDevice(host.store.db, clock, { memberId: a.actor.memberId, hostId: host.hostId, name: "第二部手机" });
  const requests: import("../src/push/apns.ts").PushRequest[] = [];
  host.config.apns = { topic: "test.cattt", send: async (request) => {
    requests.push(request);
    return { status: request.token === "b".repeat(64) ? 503 : 200 };
  } };
  host.config.publicationPush = createPublicationPush(host);
  const app = pushRoutes(host);
  const request = (token: string, method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const register = (bearer: string, character: string, fields = {}) => request(bearer, "PUT", "/device/push", {
    token: character.repeat(64), environment: "sandbox", topic: "test.cattt", ...fields,
  });
  expect((await register("unknown", "a")).status).toBe(401);
  expect((await register(a.token, "a", { device_id: b.actor.deviceId })).status).toBe(400);
  expect((await register(a.token, "a")).status).toBe(204);
  expect((await register(second.token, "b")).status).toBe(204);
  expect((await register(b.token, "c")).status).toBe(204);

  const router = new ReportRouter({ pollIntervalMs: 5 });
  router.start(host);
  try {
    followup(a, "隔离通知");
    const report = persist("followup", { status: "due", about: "隔离通知", delivery: "scheduled" });
    await until(() => expect(requests).toHaveLength(2));
    await until(() => expect(outbox().find((row) => row.reportId === report.id)?.status).toBe("pending"));
    expect(requests.map((r) => r.token).sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
    const pending = outbox().find((row) => row.reportId === report.id)!;
    const receipt = receipts().find((row) => row.reportId === report.id)!;
    expect(requests[0]!.payload).toMatchObject({
      notification_id: pending.id, member_id: a.actor.memberId, household_id: host.householdId, host_id: host.hostId,
    });
    expect(JSON.stringify(requests[0]!.payload)).not.toContain("隔离通知");
    expect((await request(b.token, "GET", "/notifications/" + pending.id)).status).toBe(404);
    const target = await request(a.token, "GET", "/notifications/" + pending.id);
    expect(await target.json()).toMatchObject({ route: "chat", conversation_id: a.conversationId, message_id: receipt.messageId });

    clock.setWallMs(pending.retryAt);
    await until(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.apnsId).toBe(requests.find((r) => r.token === "b".repeat(64))!.apnsId);
    await until(() => expect(outbox().find((row) => row.id === pending.id)?.status).toBe("pending"));
    expect(revokeDevice(host.store.db, clock, second.deviceId)).toBe(true);
    expect((await register(second.token, "b")).status).toBe(401);
    clock.setWallMs(outbox().find((row) => row.id === pending.id)!.retryAt);
    await until(() => expect(outbox().find((row) => row.id === pending.id)?.status).toBe("sent"));
    expect(requests).toHaveLength(3);
  } finally {
    await router.stop();
  }
});
