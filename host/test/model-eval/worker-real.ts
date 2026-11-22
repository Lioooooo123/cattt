import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/clock/index.ts";
import { JobRunner } from "../../src/jobs/index.ts";
import { isConfigured, modelConfigFromEnv, slotSpec } from "../../src/llm/config.ts";
import { startHost } from "../../src/runtime/index.ts";
import { listConversations, sendMessage } from "../../src/store/conversations.ts";
import { resolveDeviceToken } from "../../src/store/identity.ts";
import { readKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { modelCalls, runSteps } from "../../src/store/schema/index.ts";
import { listWorkerReports } from "../../src/store/ticket-worker.ts";
import { registerTicketWorkers } from "../../src/ticket-workers/index.ts";
import { dispatchTicketCommand } from "../../src/tickets/index.ts";
import { issueTestDevice } from "../identity-fixture.ts";

const config = modelConfigFromEnv(process.env);
const spec = slotSpec(config, "worker");
if (!isConfigured(spec) || !["openai-compatible", "deepseek"].includes(spec.provider)) {
  throw new Error("需要配置真实 WORKER_PROVIDER、模型名和对应服务凭证");
}

const instant = Date.parse("2026-11-22T03:42:00Z");
const text = "请先用 get_time 读取事项时区的日期及时间，然后用 report 的 ready 状态给我结果，结果包含 YYYY-MM-DD 和 HH:mm，照抄工具给出的年月日和时分。";
let passed = true;
for (let iteration = 1; iteration <= 3; iteration++) {
  const directory = mkdtempSync(join(tmpdir(), "cattt-worker-real-"));
  const jobs = new JobRunner();
  registerTicketWorkers(jobs);
  try {
    const clock = new ManualClock("worker-real-eval", instant);
    const host = await startHost({ dataDir: directory, clock, model: config, ticketAdmission: { readKnowledgeSource } }, [jobs]);
    try {
      const device = issueTestDevice(host, "评测成员");
      const actor = resolveDeviceToken(host.store.db, clock, device.token)!;
      const conversationId = listConversations(host.store.db, actor).find(({ kind }) => kind === "direct")!.id;
      const source = sendMessage(host.store.db, clock, actor, conversationId, {
        clientMessageId: crypto.randomUUID(), text,
      }).body.message;
      const ticket = dispatchTicketCommand(host, {
        actor, conversationId, origin: { source: "chat", messageId: source.id, revision: 1 },
      }, { kind: "start", goal: "查事项时区的日期和时分" });
      const deadline = performance.now() + 80_000;
      let report = listWorkerReports(host.store.db, host.hostId)[0];
      while (!report && performance.now() < deadline) {
        await Bun.sleep(50);
        report = listWorkerReports(host.store.db, host.hostId)[0];
      }
      const steps = host.store.db.select().from(runSteps).all();
      const names = steps.at(-1)?.history.flatMap((message) => message.role === "tool"
        ? message.observations.filter(({ summaryAllowed }) => summaryAllowed).map(({ name }) => name) : []) ?? [];
      const calls = host.store.db.select().from(modelCalls).where(eq(modelCalls.slot, "worker")).all();
      const status = report?.result.status;
      const result = report?.result.status === "ready" ? report.result.result : "";
      const okay = !!report && report.ticketId === ticket.ticket_id && status === "ready"
        && result.includes("2026-11-22") && result.includes("11:42") && names.includes("get_time")
        && calls.filter(({ status }) => status === "completed").length >= 2 && calls.every(({ model }) => model === spec.model);
      console.log(JSON.stringify({
        iteration, provider: spec.provider, model: spec.model, okay, status: status ?? "timeout", result,
        steps: steps.length, toolNames: names, calls: calls.map(({ status, outputTokens }) => ({ status, outputTokens })),
      }));
      passed &&= okay;
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (!passed) { process.exitCode = 1; }
