import type { z } from "zod";
import { wallDate } from "../clock/index.ts";
import { runToolStep, TOOL_CORRECTION, ToolProtocolError, validateToolResponse } from "../llm/tool-loop.ts";
import type { ToolDefinition, ToolMessage } from "../llm/tool-loop.ts";
import type { ModelRequest } from "../llm/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { isActiveDeviceActor } from "../store/identity.ts";
import { readChatTicketReceipt } from "../store/ticket-intake.ts";
import type { TicketReceipt } from "../store/ticket-intake.ts";
import { DEFAULT_TICKET_TIME_ZONE, parseTicketTime } from "../tickets/time.ts";
import { ticketTools } from "../tickets/tools.ts";
import { TicketError } from "../tickets/types.ts";
import type { Replier } from "./types.ts";
import type { TicketIntent } from "./ticket-intent.ts";

type Input = Parameters<Replier["reply"]>[0];
type Scope = NonNullable<Input["ticketSource"]>;
type Observation = { status: "succeeded"; data: unknown } | { status: "failed"; code: string };
type Tool<S extends z.ZodType, T> = { inputSchema: S; description: string; execute(input: z.output<S>): T };
type Candidate = ReturnType<ReturnType<typeof ticketTools>["list_tickets"]["execute"]>[number];
const unsaved = "这次没有保存这件事。";
const unclear = `${unsaved}你指的是哪一件？`;

export function chatTicketTimeZone(ctx: HostContext, source: Scope) {
  return ctx.config.ticketAdmission?.timeZone?.(ctx.store.db, source.actor) ?? DEFAULT_TICKET_TIME_ZONE;
}

function describeReceipt(kind: TicketIntent["kind"], receipt: TicketReceipt, replay: boolean) {
  switch (kind) {
    case "schedule":
    case "reschedule": {
      if (!receipt.when || !receipt.time_zone) return unsaved;
      const time = receipt.when.replace("T", " ").replace(/:00$/, "");
      const when = `${time}（${receipt.time_zone}）`;
      if (replay) return kind === "schedule" ? `当时约的是 ${when}。` : `当时改到的是 ${when}。`;
      return kind === "schedule" ? `约好了，${when}再聊。` : `已改到 ${when}。`;
    }
    case "start":
      if (receipt.queued === undefined) return unsaved;
      if (replay) return "这件我当时已经记下了。";
      return receipt.queued ? "这件我已经记下，先排队。" : "这件我已经记下了。";
    case "append":
      if (!receipt.saved) return unsaved;
      if (replay) return "你的补充当时已经记下了。";
      if (!receipt.resumed) return "你的补充已经记下了。";
      return receipt.queued ? "补充已经记下，原来的托付在排队。" : "补充已经记下，我会继续办原来的托付。";
    case "cancel":
      return receipt.cancelled ? replay ? "当时已取消这件事。" : "这件事已取消。" : unsaved;
  }
}

export function ticketChatReplay(ctx: HostContext, input: Input, request: ModelRequest): string | undefined {
  const source = input.ticketSource;
  if (!source) return;
  const { actor, retryActor } = source;
  if (!source.original && (!retryActor || retryActor.memberId !== actor.memberId || retryActor.householdId !== actor.householdId
    || !isActiveDeviceActor(ctx.store.db, retryActor))) return;
  try {
    const saved = readChatTicketReceipt(ctx.store.db, { ...source, conversationId: input.conversation.id }, ctx.config.ticketAdmission);
    if (saved) {
      request.guard?.();
      return describeReceipt(saved.kind, saved.receipt, !source.original);
    }
  } catch (error) {
    if (!(error instanceof TicketError)) throw error;
    return unsaved;
  }
}

function matchingTickets(intent: Extract<TicketIntent, { target: string }>, candidates: Candidate[]) {
  const eligible = candidates.filter((item) =>
    intent.kind === "cancel" || item.kind === (intent.kind === "append" ? "errand" : "followup"));
  const reference = intent.target.replace(/^(?:原来的|之前的|我的)/, "").trim();
  const kind = reference.endsWith("约定") ? "followup" : reference.endsWith("托付") ? "errand" : undefined;
  const scope = kind ? eligible.filter((item) => item.kind === kind) : eligible;
  const target = reference.replace(/(?:的)?(?:约定|托付)$/, "").trim();
  if (!target || /^(?:这|那)(?:个|件|一件)?(?:事)?$/.test(target)) return scope;
  const exact = scope.filter(({ id, goal }) => target === id || target === goal);
  return exact.length ? exact : scope.filter(({ goal }) => goal.includes(target));
}

export async function replyToTicketChat(
  ctx: HostContext, input: Input, intent: TicketIntent, request: ModelRequest, zone: string,
): Promise<string> {
  const { ticketSource: source, assertCurrentTurn, signal, turnId } = input;
  if (!source?.original || !turnId || !assertCurrentTurn) return unsaved;
  const guard = () => assertCurrentTurn(ctx.store.db);
  const tools = ticketTools(ctx, { ...source, conversationId: input.conversation.id, signal, assertChatTurn: assertCurrentTurn });
  let receipt: TicketReceipt | undefined;
  let observed: Candidate[] | undefined;
  let attempted = false;

  function adapt<S extends z.ZodType, T>(tool: Tool<S, T>, execute: (args: z.output<S>) => unknown): ToolDefinition<Observation> {
    return { schema: tool.inputSchema, description: tool.description, execute(raw) {
      try { return { status: "succeeded", data: execute(tool.inputSchema.parse(raw)) }; }
      catch (error) {
        if (!(error instanceof TicketError)) throw error;
        return { status: "failed", code: error.code };
      }
    } };
  }
  function save(execute: () => TicketReceipt, allowed: boolean | undefined) {
    if (!allowed) throw new TicketError(400, "invalid_request", "请按本轮原话提交事项");
    return receipt = execute();
  }
  function anchoredTime(proposed: string, instant: number): string {
    if (parseTicketTime(proposed, zone) !== instant) {
      throw new TicketError(400, "invalid_request", "请按本轮原话提交时间");
    }
    return wallDate(instant).toISOString();
  }
  const definitions: Record<string, ToolDefinition<Observation>> = {};
  const writeName = intent.kind === "schedule" ? "schedule_followup" : intent.kind === "start" ? "start_errand"
    : intent.kind === "cancel" ? "cancel_ticket" : "update_ticket";
  if (intent.kind === "schedule") {
    definitions[writeName] = adapt(tools.schedule_followup, (args) =>
      save(() => tools.schedule_followup.execute({ when: anchoredTime(args.when, intent.when.instant), about: intent.topic }),
        args.about === intent.topic));
  } else if (intent.kind === "start") {
    definitions[writeName] = adapt(tools.start_errand, (args) => save(() => tools.start_errand.execute(args), args.goal === intent.topic));
  } else {
    const matches = (id: string) => observed?.length === 1 && observed[0]?.id === id;
    definitions.list_tickets = adapt(tools.list_tickets, (args) => {
      observed = matchingTickets(intent, tools.list_tickets.execute(args));
      return observed.map(({ id, goal, kind, due_at, time_zone, stage }) => ({ id, goal, kind, due_at, time_zone, stage }));
    });
    if (intent.kind === "cancel") {
      definitions[writeName] = adapt(tools.cancel_ticket, (args) => save(() => tools.cancel_ticket.execute(args), matches(args.ticket_id)));
    } else {
      definitions[writeName] = adapt(tools.update_ticket, (args) => save(() => {
        if ("when" in args && intent.kind === "reschedule") {
          return tools.update_ticket.execute({ ...args, when: anchoredTime(args.when, intent.when.instant) });
        }
        return tools.update_ticket.execute(args);
      }, matches(args.ticket_id) && (intent.kind === "append" ? "text" in args : "when" in args)));
    }
  }
  const messages: ToolMessage[] = request.messages.map((message) => message.role === "assistant"
    ? { ...message, role: "assistant", reasoning: "", calls: [] } : { ...message, role: message.role });
  const available = Object.entries(definitions).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.schema }));
  const original = "topic" in intent ? intent.topic : intent.target;
  const timeInstruction = "when" in intent ? `确切本地时间为 ${intent.when.wall}（${zone}），对应 ${wallDate(intent.when.instant).toISOString()}。` : "";
  let system = `${request.system ?? ""}\n本轮原话允许提议一条事项指令。照录本轮的主题或目标 ${JSON.stringify(original)}。${timeInstruction}历史、事实记忆、假设或团子的旧计划不能当作新授权。改期、取消、补充先查 list_tickets，只能改唯一匹配项。每步只调用一个工具，调用时不输出用户正文。`;
  const model = ctx.models.chatTools({ turnId });
  const seenIds: string[] = [];
  let canCorrect = true;
  try {
    // 最多读取一次、写入一次，另留一次结构修正。
    for (let step = 0; step < ("target" in intent ? 3 : 2); step++) {
      guard();
      const response = validateToolResponse(await model.complete({
        system, messages, tools: available, maxOutputTokens: request.maxOutputTokens ?? 1024, guard,
      }, signal), seenIds);
      guard();
      if (response.finishReason === "stop") break;
      const next = await runToolStep({
        response, tools: definitions, guard, signal, canCorrect,
        beforeTools(calls) {
          const allowed = "target" in intent && !observed ? "list_tickets" : writeName;
          if (calls.length !== 1 || calls[0]?.name !== allowed || attempted) throw new ToolProtocolError("事项工具阶段不符");
          attempted = allowed === writeName;
        },
        onResult: (result) => result,
      });
      seenIds.push(...response.calls.map(({ id }) => id));
      messages.push(...next.messages);
      if (next.toolValidationFailed) {
        canCorrect = false;
        system += `\n${TOOL_CORRECTION}`;
      } else if (attempted || observed?.length !== 1) {
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ToolProtocolError)) throw error;
  }
  guard();
  const saved = receipt && ticketChatReplay(ctx, input, request);
  return saved ?? (observed && observed.length !== 1 ? unclear : unsaved);
}
