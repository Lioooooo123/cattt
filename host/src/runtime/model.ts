import { createSlotModel } from "../llm/index.ts";
import { isConfigured, modelConfigFromEnv, slotSpec } from "../llm/config.ts";
import type { ModelConfig, SlotName, SlotSpec } from "../llm/config.ts";
import { ModelAuthError } from "../llm/errors.ts";
import { createMockModel } from "../llm/mock.ts";
import { INPUT_BUDGET, toolDefinitions } from "../llm/tool-loop.ts";
import type { ToolModel, ToolRequest } from "../llm/tool-loop.ts";
import type { ModelClient, ModelUsage } from "../llm/types.ts";
import type { SummarizeToolHistory } from "../llm/tool-history-summary.ts";
import { reserveModelCall, settleModelCall } from "../store/model-budget.ts";
import type { HostContext } from "./index.ts";
import { ModelAdmission } from "./model-admission.ts";

const purposeSlots = {
  chat: "chat", route: "router",
  memory_extract: "extract", memory_extract_chat: "extract", memory_recall: "extract",
  boundary_summarize: "extract", diary_read: "extract", cat_diary: "extract",
} as const satisfies Record<string, SlotName>;

type TextPurpose = keyof typeof purposeSlots;
type Purpose = TextPurpose | "errand" | "context_summary";
type Reference = { turnId?: string; jobId?: string };
type Slot = { spec: SlotSpec; client: ModelClient & ToolModel; admission: ModelAdmission };

export class ModelBudgetExceeded extends Error {
  constructor() { super("model_daily_budget"); this.name = "ModelBudgetExceeded"; }
}

export class HostModelRuntime {
  private readonly config: ModelConfig;
  private readonly slots = new Map<SlotName, Slot>();

  constructor(private readonly ctx: Pick<HostContext, "config" | "hostId" | "store" | "clock">) {
    this.config = ctx.config.model ?? modelConfigFromEnv({});
    const resources = new Map<string, ModelAdmission>();
    for (const name of ["chat", "router", "worker", "extract"] as const) {
      const spec = slotSpec(this.config, name);
      const { provider, baseURL } = spec;
      const resource = baseURL ? `${provider}:${baseURL}` : provider;
      const limit = provider === "openai-compatible" ? this.config.MODEL_LOCAL_CONCURRENCY
        : provider === "deepseek" ? this.config.MODEL_CLOUD_CONCURRENCY : this.config.MODEL_MOCK_CONCURRENCY;
      const admission = resources.get(resource) ?? new ModelAdmission(limit);
      resources.set(resource, admission);
      this.slots.set(name, { spec, client: createSlotModel(this.config, name, spec), admission });
    }
  }

  slot(name: SlotName) {
    const { provider, model, thinking, baseURL } = this.resolve(name).spec;
    return { provider, model, thinking, baseURL };
  }

  text(purpose: TextPurpose, options: Reference & { slot?: SlotName } = {}): ModelClient {
    const name = purposeSlots[purpose];
    if (!Object.hasOwn(purposeSlots, purpose) || !name || options.slot !== undefined && options.slot !== name) {
      throw new Error("模型用途与槽位不匹配");
    }
    const slot = this.resolve(name);
    const client = purpose === "cat_diary" && slot.spec.provider === "mock"
      ? createMockModel(this.config.MOCK_DELAY_MS, false, "cat_diary")
      : slot.client;
    const runtime = this;
    return {
      provider: client.provider, modelId: client.modelId,
      async *stream({ guard, ...request }, signal) {
        const signals = [request.signal, signal].filter((item): item is AbortSignal => !!item);
        const combined = signals.length ? AbortSignal.any(signals) : undefined;
        const maxOutputTokens = request.maxOutputTokens ?? 2048;
        const settle = await runtime.begin(name, purpose, [request.system, request.messages, request.extraBody],
          maxOutputTokens, options, guard, combined);
        let status: "completed" | "failed" = "failed";
        let usage: ModelUsage | undefined;
        try {
          for await (const event of client.stream({
            ...request, maxOutputTokens, ...(purpose === "cat_diary" && { guard }),
          }, combined)) {
            if (event.type === "finish") {
              usage = event.usage;
              status = event.finishReason === "stop" || event.finishReason === "length" ? "completed" : "failed";
            }
            yield event;
          }
        } catch (error) {
          status = "failed";
          throw error;
        } finally {
          settle(status, usage);
        }
      },
    };
  }

  chatTools(reference: Reference): ToolModel {
    return { complete: (request, signal) => this.complete("chat", "chat", request, reference, signal) };
  }

  worker(reference: Reference = {}): ToolModel {
    return { complete: (request, signal) => this.complete("worker", "errand", request, reference, signal) };
  }

  summary(name: "chat" | "worker", reference: Reference = {}): SummarizeToolHistory | undefined {
    if (name !== "chat" && name !== "worker") { throw new Error("摘要用途与槽位不匹配"); }
    if (this.resolve(name).spec.provider === "mock") { return; }
    return async ({ system, jsonLines, maxOutputTokens, signal, guard }) => {
      const result = await this.complete(name, "context_summary", {
        system, messages: [{ role: "user", content: jsonLines }], tools: [], maxOutputTokens, guard,
      }, reference, signal);
      const valid = result.finishReason === "stop" && !result.calls.length;
      return { text: valid ? result.text : "", outputTokens: result.outputTokens };
    };
  }

  private resolve(name: SlotName): Slot {
    const slot = this.slots.get(name);
    if (!slot) { throw new Error("未知模型槽位"); }
    return slot;
  }

  private async complete(
    name: "chat" | "worker", purpose: "chat" | "errand" | "context_summary", { guard, ...request }: ToolRequest,
    reference: Reference, signal: AbortSignal,
  ) {
    const settle = await this.begin(name, purpose, [request.system, toolDefinitions(request.tools), request.messages],
      request.maxOutputTokens, reference, guard, signal);
    let usage: ModelUsage | undefined;
    let status: "completed" | "failed" = "failed";
    try {
      const response = await this.resolve(name).client.complete(request, signal);
      usage = response.usage;
      if (response.finishReason === "stop" && response.calls.length === 0
        || purpose !== "context_summary" && response.finishReason === "tool-calls" && response.calls.length > 0) {
        status = "completed";
      }
      return response;
    } finally {
      settle(status, usage);
    }
  }

  private async begin(
    name: SlotName, purpose: Purpose, input: unknown, outputLimit: number, { turnId, jobId }: Reference,
    guard?: () => void, signal?: AbortSignal,
  ) {
    const { ctx, config } = this;
    const { spec, admission } = this.resolve(name);
    if (!isConfigured(spec)) { throw new ModelAuthError(); }
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (bytes > INPUT_BUDGET || !Number.isSafeInteger(outputLimit) || outputLimit < 1 || outputLimit > 8000) {
      throw new Error("model_input_budget: 模型请求超出限制");
    }
    const foreground = name === "chat" || purpose === "memory_recall" || purpose === "memory_extract_chat";
    const release = await admission.acquire(foreground, signal);
    try {
      signal?.throwIfAborted();
      guard?.();
      const id = reserveModelCall(ctx.store.db, ctx.clock, {
        hostId: ctx.hostId, slot: name, purpose, provider: spec.provider, model: spec.model!,
        reservedTokens: bytes + outputLimit, turnId, jobId,
      }, { calls: config.MODEL_DAILY_CALL_LIMIT, tokens: config.MODEL_DAILY_TOKEN_LIMIT });
      if (!id) { throw new ModelBudgetExceeded(); }
      const started = performance.now();
      return (status: "completed" | "failed", usage?: ModelUsage) => {
        try { settleModelCall(ctx.store.db, id, status, Math.floor(performance.now() - started), usage); }
        finally { release(); }
      };
    } catch (error) {
      release();
      throw error;
    }
  }
}
