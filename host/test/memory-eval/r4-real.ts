import { eq } from "drizzle-orm";
import { PublicationWindow } from "../../src/publication/window.ts";
import { EventBus } from "../../src/bus/index.ts";
import { assembleChatRequest } from "../../src/context/chat.ts";
import type { Message } from "../../src/conversations/types.ts";
import { JobRunner } from "../../src/jobs/index.ts";
import { modelConfigFromEnv } from "../../src/llm/config.ts";
import { createChatModel, createExtractModel } from "../../src/llm/index.ts";
import type { ModelClient, ModelRequest } from "../../src/llm/types.ts";
import { registerMemoryExtraction } from "../../src/memory/jobs.ts";
import type { HostEvents } from "../../src/runtime/index.ts";
import { HostModelRuntime } from "../../src/runtime/model.ts";
import { getConversation } from "../../src/store/conversations.ts";
import { saveMemory } from "../../src/store/knowledge.ts";
import { withdrawKnowledgeSource } from "../../src/store/knowledge-source.ts";
import { MEMORY_EXTRACTION_QUEUE } from "../../src/store/memory-extraction.ts";
import { jobs } from "../../src/store/schema/index.ts";
import { ChatReplier } from "../../src/turns/chat-replier.ts";
import { observeContext, setupContextFixture } from "./context-fixture.ts";
import { controlledCandidates } from "./controlled-context-input.ts";
import { contextInput, timelines } from "./corpus.ts";
import type { ContextProbe, MemberId, Timeline } from "./corpus.ts";
import { runExtractionProbe } from "./extraction-probe.ts";
import { scoreContext, summarize } from "./score.ts";

const url = new URL(process.env.OPENAI_COMPAT_BASE_URL ?? "http://127.0.0.1:11434/v1");
if (!["http:", "https:"].includes(url.protocol)
  || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  || url.username || url.password || url.search || url.hash) {
  throw new Error("评测仅使用无凭证的本机 OpenAI 兼容服务");
}
const { EXTRACT_MODEL, CHAT_MODEL } = process.env;
if (!EXTRACT_MODEL?.trim() || !CHAT_MODEL?.trim()) {
  throw new Error("请设置 EXTRACT_MODEL 和 CHAT_MODEL 为本机已运行的模型 ID");
}
const config = modelConfigFromEnv({
  MODEL_PROVIDER: "openai-compatible", EXTRACT_MODEL, CHAT_MODEL, OPENAI_COMPAT_BASE_URL: url.href,
  OPENAI_COMPAT_THINKING_PARAM: process.env.OPENAI_COMPAT_THINKING_PARAM ?? "none",
});
const extract = createExtractModel(config);
const chat = createChatModel(config);
await fetch(`${url.href.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(3000) }).then(async (response) => {
  await response.body?.cancel();
  if (!response.ok) { throw new Error(`本机模型服务 /models 返回 ${response.status}`); }
});
const code = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
const dirty = Bun.spawnSync(["git", "status", "--porcelain"]).stdout.length > 0;
console.log(JSON.stringify({
  mode: "loopback-real", code, dirty, extract: extract.modelId, chat: chat.modelId,
  temperature: 0, thinking: config.OPENAI_COMPAT_THINKING_PARAM, runs: 3,
}));

function traced(client: ModelClient, report: (raw: string) => void): ModelClient {
  return {
    ...client,
    async *stream(request, signal) {
      const bounded = AbortSignal.timeout(60_000);
      const signals = signal ? AbortSignal.any([signal, bounded]) : bounded;
      let raw = "";
      try {
        for await (const event of client.stream(request, signals)) {
          if (event.type === "text-delta") { raw += event.delta; }
          yield event;
        }
      } finally {
        report(raw);
      }
    },
  };
}

async function replay(timeline: Timeline, probe: ContextProbe, run: number) {
  const seed = setupContextFixture();
  const { db, store, clock, hostId, householdId, actors } = seed;
  const label = timeline.id + "/" + probe.query.id;
  const bus = new EventBus<HostEvents>((error) => console.error("评测唤醒失败", error));
  const core = { store, clock, hostId, householdId, bus, publication: new PublicationWindow(clock), config: { dataDir: ":memory:", model: config } };
  const models = new HostModelRuntime(core);
  const runner = new JobRunner();
  let eventLabel = "";
  registerMemoryExtraction(runner, {
    model: traced(models.text("memory_extract"), (raw) => console.log(JSON.stringify({ run, probe: label, event: eventLabel, stage: "replay-extract", raw }))),
  });
  const capacity = timeline.id.endsWith("-budget") ? controlledCandidates[timeline.id]! : undefined;
  if (!capacity) { runner.start({ ...core, models }); }
  try {
    const { events, query } = contextInput(timeline, probe);
    const ledger = new Map<string, Message>();
    for (const event of events) {
      eventLabel = event.id;
      if (event.kind === "withdraw") {
        const id = ledger.get(event.messageId)!.id;
        if (!withdrawKnowledgeSource(db, clock, actors[event.author], id, 1)) {
          throw new Error("无法撤回评测来源");
        }
        continue;
      }
      const message = seed.append(event);
      ledger.set(event.id, message);
      if (message.author.kind === "cat") { continue; }
      if (capacity) {
        for (const [, subject, predicate, value] of capacity.filter(([id]) => id === event.id)) {
          const saved = saveMemory(db, clock, {
            ...seed.source(message), subjectMemberId: subject === "pair" ? null : actors[subject].memberId,
            fingerprint: predicate, predicate, value,
          });
          if (!saved) { throw new Error("无法写入容量竞争候选"); }
        }
      } else {
        bus.publish("jobs:wake", { queue: MEMORY_EXTRACTION_QUEUE });
        const deadline = Date.now() + 190_000;
        for (;;) {
          const job = db.select().from(jobs).where(eq(jobs.dedupeKey, message.id + ":1")).get();
          if (job?.status === "done") { break; }
          if (!job || job.status === "dead" || Date.now() >= deadline) {
            throw new Error("评测抽取作业失败：" + (job?.lastError ?? job?.status ?? "missing"));
          }
          if (job.status === "queued" && job.runAt > clock.wallMs()) { clock.advance(job.runAt - clock.wallMs()); }
          await Bun.sleep(25);
        }
      }
    }
    // Stop extraction before adding the question. Seeded capacity jobs are never dispatched.
    await runner.stop();
    if (query.author === "cat") { throw new Error("评测查询需要成员作者"); }
    const trigger = seed.append(query);
    const conversation = getConversation(db, actors[query.author], trigger.conversation_id);
    let outgoing: ModelRequest | undefined;
    const replier = new ChatReplier(() => ({ client: models.text("chat"), summarize: models.summary("chat") }), (input) => {
      outgoing = { ...assembleChatRequest(db, input), extraBody: { temperature: 0 } };
      return outgoing;
    });
    let reply = "";
    for await (const text of replier.reply({ conversation, trigger, history: [], signal: AbortSignal.timeout(60_000) })) {
      reply += text;
    }
    const observation = observeContext(outgoing!.system!, new Map<string, MemberId>([
      [actors.a.memberId, "a"], [actors.b.memberId, "b"],
    ]), new Map([...ledger].map(([id, row]) => [row.id, id])));
    const score = scoreContext(timeline, probe, observation);
    console.log(JSON.stringify({ run, stage: "context", ...score, query: query.text, observation, reply }));
    return score;
  } finally {
    await runner.stop();
    store.close();
  }
}

let passed = true;
for (let run = 1; run <= 3; run += 1) {
  const extraction = [];
  const context = [];
  for (const timeline of timelines) {
    for (const probe of timeline.extraction) {
      const label = timeline.id + "/" + probe.messageId;
      let raw = "";
      try {
        const result = await runExtractionProbe(timeline, probe, traced(extract, (text) => { raw = text; }));
        extraction.push(result.score);
        console.log(JSON.stringify({ run, stage: "extraction", raw, ...result.score, status: result.status }));
      } catch (error) {
        console.log(JSON.stringify({ run, stage: "extraction", probe: label, raw, error: String(error) }));
      }
    }
    for (const probe of timeline.context) {
      try {
        context.push(await replay(timeline, probe, run));
      } catch (error) {
        console.log(JSON.stringify({ run, stage: "context", probe: timeline.id + "/" + probe.query.id, error: String(error) }));
      }
    }
  }
  const extractionSummary = summarize(extraction);
  const contextSummary = summarize(context);
  const structuredPass = extractionSummary.probes === 16 && extractionSummary.passed
    && contextSummary.probes === 15 && contextSummary.passed;
  passed &&= structuredPass;
  console.log(JSON.stringify({
    run, extraction: extractionSummary, context: contextSummary, structuredPass,
    replySemantics: "需要人工按验收报告标注",
  }));
}
process.exitCode = passed ? 0 : 1;
