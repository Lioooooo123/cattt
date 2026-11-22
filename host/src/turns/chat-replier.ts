import { assembleChatRequest } from "../context/chat.ts";
import type { ChatRequest } from "../context/chat.ts";
import { classifyModelError, ModelOutputError, ModelReplyError } from "../llm/errors.ts";
import { createChatHistoryFitter } from "../llm/tool-history-summary.ts";
import type { SummarizeToolHistory } from "../llm/tool-history-summary.ts";
import type { ModelClient } from "../llm/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { LeaseLostError } from "../store/leases.ts";
import { ConversationNotFoundError } from "../store/conversations.ts";
import { PublicationLeaseError } from "../publication/types.ts";
import { DevelopmentEchoReplier } from "./development-replier.ts";
import { chatTicketTimeZone, replyToTicketChat, ticketChatReplay } from "./ticket-chat.ts";
import { ticketChatIntent } from "./ticket-intent.ts";
import { replyToYardChat } from "./yard-chat.ts";
import { yardChatIntent } from "./yard-intent.ts";
import type { Replier } from "./types.ts";

// Retain the original prompt entry point for the R3 cold-window comparison.
export { buildChatPrompt } from "../context/chat.ts";

type Input = Parameters<Replier["reply"]>[0];
type ChatModels = { client: ModelClient; summarize?: SummarizeToolHistory };

export class ChatReplier implements Replier {
  constructor(
    private readonly models: ModelClient | ((input: Input) => ChatModels),
    private readonly buildRequest: (input: Input) => ChatRequest,
    private readonly ctx?: HostContext,
  ) {}

  async *reply(input: Input): AsyncIterable<string> {
    const { prepareSummarySources, factualReply, ...request } = this.buildRequest(input);
    const { client, summarize } = typeof this.models === "function" ? this.models(input) : { client: this.models };
    let buffered: string | undefined = "";
    let finished = false;
    try {
      const yard = this.ctx && yardChatIntent(input.trigger.text);
      const source = input.ticketSource;
      const zone = this.ctx && source ? chatTicketTimeZone(this.ctx, source) : undefined;
      const ticket = zone ? ticketChatIntent(input.trigger.text, input.trigger.created_at, zone) : undefined;
      if (this.ctx && source && (ticket || !source.original)) {
        const existing = ticketChatReplay(this.ctx, input, request);
        if (existing !== undefined) {
          yield existing;
          return;
        }
        if (ticket && !source.original) {
          yield "这次没有保存这件事。";
          return;
        }
      }
      const lookup = yard || ticket || client.provider === "mock" ? undefined : factualReply;
      if (lookup) {
        request.system += "\n\n" + lookup.instruction;
        request.maxOutputTokens = 256;
        request.extraBody = { ...request.extraBody, response_format: { type: "json_object" } };
      }
      request.messages = await createChatHistoryFitter(summarize, prepareSummarySources)(
        { ...request, signal: input.signal }, yard || ticket ? 8 * 1024 : 0,
      );
      if (yard && this.ctx) {
        yield await replyToYardChat(this.ctx, input, yard, request);
        return;
      }
      if (ticket && this.ctx && zone) {
        yield await replyToTicketChat(this.ctx, input, ticket, request, zone);
        return;
      }
      for await (const event of client.stream(request, input.signal)) {
        input.signal.throwIfAborted();
        if (event.type === "text-delta") {
          if (!lookup) { yield event.delta; }
          else if (buffered !== undefined) {
            buffered = buffered.length + event.delta.length <= 1024 ? buffered + event.delta : undefined;
          }
        }
        if (event.type === "finish") {
          if (event.finishReason !== "stop" && event.finishReason !== "length") { throw new ModelOutputError(); }
          if (event.finishReason === "length") { buffered = undefined; }
          finished = true;
        }
      }
      if (!finished) { throw new ModelOutputError(); }
      if (lookup) {
        request.guard?.();
        input.signal.throwIfAborted();
        yield lookup.render(buffered ?? "");
      }
    } catch (error) {
      if (input.signal.aborted) { throw input.signal.reason; }
      if (error instanceof ConversationNotFoundError || error instanceof PublicationLeaseError || error instanceof LeaseLostError) { throw error; }
      throw new ModelReplyError(classifyModelError(error).code);
    }
  }
}

export function configuredReplier(ctx: HostContext): Replier {
  if (!ctx.config.model || ctx.config.model.MODEL_PROVIDER === "echo") { return new DevelopmentEchoReplier(); }
  return new ChatReplier(({ turnId }) => ({
    client: ctx.models.text("chat", { turnId }), summarize: ctx.models.summary("chat", { turnId }),
  }), (input) => assembleChatRequest(ctx.store.db, input, () => ctx.clock.wallMs()), ctx);
}
