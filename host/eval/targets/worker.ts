import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../../src/clock/index.ts";
import { JobRunner } from "../../src/jobs/index.ts";
import { modelConfigFromEnv } from "../../src/llm/config.ts";
import type { ToolModel } from "../../src/llm/tool-loop.ts";
import { startHost } from "../../src/runtime/index.ts";
import { listConversations, sendMessage } from "../../src/store/conversations.ts";
import { createMember } from "../../src/store/identity.ts";
import type { Actor } from "../../src/identity/index.ts";
import { readKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { runSteps } from "../../src/store/schema/index.ts";
import { listWorkerReports } from "../../src/store/ticket-worker.ts";
import { registerTicketWorkers } from "../../src/ticket-workers/index.ts";
import { dispatchTicketCommand } from "../../src/tickets/index.ts";
import type { EvalCase, EvalMode } from "../schema.ts";
import { traceToolModel } from "../trace.ts";
import type { ModelCallTrace, WorkerStepTrace } from "../trace.ts";

export async function runWorker(item: EvalCase, mode: EvalMode, trace: ModelCallTrace[], steps: WorkerStepTrace[]) {
  if (item.setup.memories.length || item.setup.boundaries.length || item.setup.prior_messages.length || item.setup.conversation.kind !== "direct") {
    throw new Error("worker 本阶段仅支持无额外记忆/边界/历史的单聊托付");
  }
  const directory = await mkdtemp(join(tmpdir(), "cattt-eval-worker-"));
  try {
    const jobs = new JobRunner();
    const config = modelConfigFromEnv(mode === "scripted" ? { MODEL_PROVIDER: "mock", MOCK_DELAY_MS: "0" } : process.env);
    const host = await startHost({ dataDir: directory, clock: new ManualClock("eval-worker", Date.parse("2026-11-22T03:42:00Z")),
      model: config, ticketAdmission: { readKnowledgeSource, timeZone: () => "Asia/Shanghai" } }, []);
    try {
      let position = 0;
      const scripted: ToolModel = { async complete(_request, signal) {
        signal.throwIfAborted();
        const step = item.scripted_steps?.[position++];
        if (!step) throw new Error("缺少 scripted_steps 工具步骤");
        return { finishReason: "tool-calls", text: "", reasoning: "", outputTokens: 32,
          calls: step.calls.map((call) => ({ ...call, id: crypto.randomUUID() })) };
      } };
      const spec = host.models.slot("worker");
      const provider = mode === "scripted" ? "mock" : spec.provider;
      const model = mode === "scripted" ? "eval-scripted-worker" : spec.model ?? "unknown";
      const modelClient = traceToolModel(mode === "scripted" ? scripted : host.models.worker(), trace, provider, model);
      registerTicketWorkers(jobs, { model: modelClient });
      const actors = new Map(item.setup.members.map(({ id, name }) => [id, {
        memberId: createMember(host.store.db, host.clock, { householdId: host.householdId, homeHostId: host.hostId, displayName: name }),
        householdId: host.householdId, hostId: host.hostId, deviceId: "eval",
      } satisfies Actor]));
      const actor = actors.get(item.input.sender)!;
      const conversationId = listConversations(host.store.db, actor).find((row) => row.kind === "direct")!.id;
      const source = sendMessage(host.store.db, host.clock, actor, conversationId, { clientMessageId: crypto.randomUUID(), text: item.input.text }).body.message;
      const ticket = dispatchTicketCommand(host, { actor, conversationId, origin: { source: "chat", messageId: source.id, revision: 1 } }, { kind: "start", goal: item.description });
      jobs.start(host);
      try {
        const deadline = performance.now() + 120_000;
        for (;;) {
          const report = listWorkerReports(host.store.db, host.hostId).find((row) => row.ticketId === ticket.ticket_id);
          if (report) {
            return { provider, model, report: report.result };
          }
          if (performance.now() > deadline) throw new Error("worker 等待报告超时");
          await Bun.sleep(20);
        }
      } finally {
        await jobs.stop();
        steps.push(...host.store.db.select().from(runSteps).all().sort((a, b) => a.step - b.step).map(({ step, history }) => ({ step, history })));
      }
    } finally { await host.stop(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
