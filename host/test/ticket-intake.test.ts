import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, inArray } from "drizzle-orm";
import { Gateway } from "../src/gateway/index.ts";
import { ManualClock } from "../src/clock/index.ts";
import { startHost } from "../src/runtime/index.ts";
import { issueTestDevice } from "./identity-fixture.ts";
import { listConversations, sendMessage } from "../src/store/conversations.ts";
import { resolveDeviceToken } from "../src/store/identity.ts";
import { businessRow } from "../src/store/business.ts";
import { conversations, messages } from "../src/store/schema/conversations.ts";
import { hosts, members } from "../src/store/schema/identity.ts";
import { decisions, runs, ticketInputs, tickets, triggers } from "../src/store/schema/tickets.ts";
import { jobs } from "../src/store/schema/index.ts";
import { dispatchTicketCommand } from "../src/tickets/index.ts";
import { ticketTools } from "../src/tickets/tools.ts";
import { admitQueuedErrands, getCurrentTicketExecution } from "../src/store/tickets.ts";
import type { TicketJob } from "../src/tickets/types.ts";

const clock = new ManualClock("intake", Date.parse("2026-11-22T03:00:00Z"));
const withdrawn = new Set<string>();
let dataDir: string;
let gateway: Gateway;
let host: Awaited<ReturnType<typeof startHost>>;
let a: ReturnType<typeof issueTestDevice>;
let b: ReturnType<typeof issueTestDevice>;

beforeEach(async () => {
  clock.setWallMs(Date.parse("2026-11-22T03:00:00Z"));
  withdrawn.clear();
  dataDir = mkdtempSync(join(tmpdir(), "cattt-ticket-intake-"));
  gateway = new Gateway();
  host = await startHost({
    dataDir, clock, port: 0, lanHttpsPort: 0,
    ticketAdmission: {
      readKnowledgeSource(db, source) {
        if (!withdrawn.has(source.sourceMessageId)) {
          return db.select().from(messages).where(eq(messages.id, source.sourceMessageId)).get();
        }
      },
      allowsTopic: (_db, input) => !input.text.includes("拒绝的主题"),
    },
  }, [gateway]);
  a = issueTestDevice(host, "小甲");
  b = issueTestDevice(host, "小乙");
});

afterEach(async () => {
  await host?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

function session(device = a, kind: "direct" | "group" = "direct") {
  const actor = resolveDeviceToken(host.store.db, clock, device.token)!;
  const conversationId = listConversations(host.store.db, actor).find((row) => row.kind === kind)!.id;
  return { actor, conversationId };
}

function said(text: string, s = session()) {
  const id = sendMessage(host.store.db, clock, s.actor, s.conversationId, {
    clientMessageId: crypto.randomUUID(), text,
  }).body.message.id;
  return { messageId: id, revision: 1 };
}

function request(path: string, options: { token?: string; method?: string; key?: string; body?: unknown } = {}) {
  const headers = new Headers({ authorization: `Bearer ${options.token ?? a.token}` });
  if (options.key) headers.set("Idempotency-Key", options.key);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${gateway.port}/v2/tickets${path}`, {
    method: options.method, headers, body: JSON.stringify(options.body),
  });
}

function command(text: string, s = session()) {
  return dispatchTicketCommand(host, { ...s, origin: { source: "chat", ...said(text, s) } }, { kind: "start", goal: text });
}

function jobRows() {
  return host.store.db.select().from(jobs).where(inArray(jobs.queue, ["followup", "errand"])).all();
}

function currentRun(ticketId: string) {
  return host.store.db.select().from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.generation)).get()!;
}

function failed(ticketId: string, stage: "failed" | "blocked" = "failed"): void {
  const db = host.store.db;
  const run = currentRun(ticketId);
  db.update(runs).set({ status: "ended", outputTokens: 8000 }).where(eq(runs.id, run.id)).run();
  db.update(tickets).set({ status: "ended", stage, endedReason: stage }).where(eq(tickets.id, ticketId)).run();
}

test("前台、HTTP 和 SQLite 共用事项入口；重放收据及换正文冲突", async () => {
  const s = session();
  const origin = said("请帮我想几个徒步地点", s);
  const make = ticketTools(host, { ...s, ...origin });
  const ticket = await make.start_errand.execute({ goal: "想几个徒步地点" });
  expect(await make.start_errand.execute({ goal: "想几个徒步地点" })).toEqual(ticket);
  const input = said("找可以带狗的路线", s);
  const add = ticketTools(host, { ...s, ...input });
  await add.update_ticket.execute({ ticket_id: ticket.ticket_id, text: "模型改写一" });
  await add.update_ticket.execute({ ticket_id: ticket.ticket_id, text: "模型改写二" });
  const patch = (text: string) => request(`/${ticket.ticket_id}`, {
    method: "PATCH", key: "add-1", body: { text },
  });
  const [first, replay] = await Promise.all([patch("周六出发"), patch("周六出发")]);
  expect(first.status).toBe(200);
  expect(await replay.json()).toEqual(await first.json());
  expect((await patch("周日出发")).status).toBe(409);
  const db = host.store.db;
  expect(db.select().from(ticketInputs).all().map((row) => row.text)).toEqual(["找可以带狗的路线", "周六出发"]);
  expect(db.select().from(triggers).all()).toHaveLength(3);
  expect(db.select().from(decisions).all()).toHaveLength(3);
  expect(jobRows().filter((row) => row.status === "queued")).toHaveLength(1);
});

test("HTTP 按 Actor 隔离单聊和群聊事项，并拒绝另一宿主写入", async () => {
  const privateTicket = command("甲的单聊事项");
  const groupTicket = command("甲的群聊事项", session(a, "group"));
  const bob = command("乙的事项", session(b));
  const list = await request("", { token: b.token });
  expect((await list.json()).tickets.map((row: { id: string }) => row.id)).toEqual([bob.ticket_id]);
  for (const id of [privateTicket.ticket_id, groupTicket.ticket_id]) {
    expect((await request(`/${id}`, { token: b.token })).status).toBe(404);
    expect((await request(`/${id}`, { token: b.token, method: "PATCH", body: { text: "越权" } })).status).toBe(404);
    expect((await request(`/${id}/cancel`, { token: b.token, method: "POST" })).status).toBe(404);
  }
  expect((await request("", { token: "invalid" })).status).toBe(401);
  const db = host.store.db;
  const other = db.insert(hosts).values({
    ...businessRow(clock, host.hostId), householdId: host.householdId, displayName: "另一台 Mac",
  }).returning().get()!;
  db.update(members).set({ homeHostId: other.id }).where(eq(members.id, a.memberId)).run();
  db.update(conversations).set({ publisherHostId: other.id }).where(eq(conversations.id, session(a, "group").conversationId)).run();
  for (const id of [privateTicket.ticket_id, groupTicket.ticket_id]) {
    const write = await request(`/${id}/cancel`, { method: "POST" });
    expect(write.status).toBe(409);
    expect((await write.json()).error.code).toBe("not_publisher");
  }
  expect(db.select().from(triggers).all()).toHaveLength(3);
});

test("取消后重放补充返回原收据，旧作业失效", async () => {
  const ticket = command("找徒步路线");
  const path = `/${ticket.ticket_id}`;
  const append = () => request(path, { method: "PATCH", key: "append", body: { text: "周六" } });
  const original = await (await append()).json();
  const queued = jobRows().find((row) => row.status === "queued")!;
  expect(getCurrentTicketExecution(host.store.db, JSON.parse(queued.payload))).toBeDefined();
  const cancel = () => request(`${path}/cancel`, { method: "POST", key: "cancel" });
  const cancelled = await (await cancel()).json();
  expect(await (await cancel()).json()).toEqual(cancelled);
  expect(await (await append()).json()).toEqual(original);
  expect((await (await request(path)).json()).ticket.stage).toBe("cancelled");
  expect(getCurrentTicketExecution(host.store.db, JSON.parse(queued.payload))).toBeUndefined();
  expect(jobRows().filter((row) => row.status === "queued")).toHaveLength(0);
});

test("失败和受阻托付续办保留旧代次和预算，独立新代次可以执行", async () => {
  const ticket = command("想一个周末计划");
  const path = `/${ticket.ticket_id}`;
  const old: TicketJob = JSON.parse(jobRows()[0]!.payload);
  for (const [i, terminal] of ["failed", "blocked"].entries()) {
    failed(ticket.ticket_id, terminal as "failed" | "blocked");
    const resume = () => request(path, { method: "PATCH", key: `resume-${i}`, body: { text: "请继续这件事" } });
    const receipt = await (await resume()).json();
    expect(receipt).toMatchObject({ resumed: true, queued: false });
    expect(await (await resume()).json()).toEqual(receipt);
    expect(currentRun(ticket.ticket_id)).toMatchObject({ generation: i + 1, outputTokens: 0, elapsedMs: 0 });
  }
  expect(getCurrentTicketExecution(host.store.db, old)).toBeUndefined();
  const active: TicketJob = JSON.parse(jobRows().find((row) => row.status === "queued")!.payload);
  expect(getCurrentTicketExecution(host.store.db, active)?.run?.generation).toBe(2);
  expect(host.store.db.select().from(runs).all().map((row) => row.outputTokens)).toEqual([8000, 8000, 0]);
});

test("准入限制同时在办与日名额，排队仅在有余量时开工", () => {
  const first = command("想第一件");
  command("想第二件");
  const queued = command("想第三件");
  expect(queued).toMatchObject({ queued: true });
  expect(currentRun(queued.ticket_id).localDay).toBeNull();
  expect(admitQueuedErrands(host.store.db, clock)).toBe(false);
  failed(first.ticket_id);
  expect(admitQueuedErrands(host.store.db, clock)).toBe(true);
  expect(currentRun(queued.ticket_id).localDay).toBe("2026-11-22");
  const next = command("想第四件");
  expect(next).toMatchObject({ queued: true });
});

test("失败续办计入五次日额度，跨日扫描只登记最新代次", async () => {
  const ticket = command("想下个月的计划");
  const path = `/${ticket.ticket_id}`;
  for (let i = 1; i <= 5; i += 1) {
    failed(ticket.ticket_id);
    const result = await request(path, { method: "PATCH", key: `add-${i}`, body: { text: "再想想" } });
    expect(await result.json()).toMatchObject({ resumed: true, queued: i === 5 });
  }
  expect(admitQueuedErrands(host.store.db, clock)).toBe(false);
  clock.advance(24 * 60 * 60 * 1000);
  expect(admitQueuedErrands(host.store.db, clock)).toBe(true);
  expect(currentRun(ticket.ticket_id)).toMatchObject({ generation: 5, localDay: "2026-11-23" });
});

test("默认资格拒绝他人原话及修订失效，许可复核覆盖收据和全部历史补充", async () => {
  const s = session(a, "group");
  const foreign = said("乙想托付", session(b, "group"));
  const submit = (origin: ReturnType<typeof said>, goal: string) => dispatchTicketCommand(host, {
    ...s, origin: { source: "chat", ...origin },
  }, { kind: "start", goal });
  expect(() => submit(foreign, "借用乙的原话")).toThrow();
  const source = said("请帮我想个计划", s);
  expect(() => submit(source, "拒绝的主题")).toThrow();
  expect(() => submit({ ...source, revision: 2 }, "想个计划")).toThrow();
  const ticket = submit(source, "想个计划");
  const supplement = said("考虑乘地铁", s);
  await ticketTools(host, { ...s, ...supplement }).update_ticket.execute({ ticket_id: ticket.ticket_id, text: "补充" });
  failed(ticket.ticket_id);
  withdrawn.add(supplement.messageId);
  const response = await request(`/${ticket.ticket_id}`, { method: "PATCH", body: { text: "请继续" } });
  expect(response.status).toBe(409);
  expect(currentRun(ticket.ticket_id).generation).toBe(0);
  expect(host.store.db.select().from(ticketInputs).all()).toHaveLength(1);
  withdrawn.add(source.messageId);
  expect(() => submit(source, "想个计划")).toThrow();
});

test("改期替换未执行约定作业，失败事务回滚内容、Job、证明与收据", async () => {
  const s = session();
  const source = said("想约明天聊", s);
  const make = () => request("", {
    method: "POST", key: "schedule",
    body: {
      kind: "schedule", conversation_id: s.conversationId, source_message_id: source.messageId,
      source_revision: source.revision, about: "聊旅行", when: "2026-11-23T10:00",
    },
  });
  host.store.raw.exec("CREATE TRIGGER reject_ticket_decision BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  expect((await make()).status).toBe(500);
  expect(jobRows()).toBeEmpty();
  for (const table of [tickets, triggers, decisions, ticketInputs]) {
    expect(host.store.db.select().from(table).all()).toBeEmpty();
  }
  host.store.raw.exec("DROP TRIGGER reject_ticket_decision");
  const response = await make();
  expect(response.status).toBe(201);
  const receipt = await response.json();
  const old = jobRows()[0]!;
  expect(old.runAt).toBe(Date.parse("2026-11-23T02:00:00Z"));
  const path = `/${receipt.ticket_id}`;
  const reschedule = await request(path, { method: "PATCH", key: "date", body: { when: "2026-11-24T10:00" } });
  expect(reschedule.status).toBe(200);
  expect(getCurrentTicketExecution(host.store.db, JSON.parse(old.payload))).toBeUndefined();
  expect(jobRows().filter((row) => row.status === "queued").map((row) => row.runAt)).toEqual([Date.parse("2026-11-24T02:00:00Z")]);
  clock.advance(7 * 24 * 60 * 60 * 1000);
  expect(await (await make()).json()).toEqual(receipt);
});
