import { z } from "zod";
import type { HostContext } from "../runtime/index.ts";
import { receiveTicketCommand } from "../store/ticket-intake.ts";
import { admitQueuedErrands } from "../store/tickets.ts";
import { TicketError, ticketCommandSchema } from "./types.ts";
import type { TicketCommand, TicketCommandContext } from "./types.ts";

const requestKey = /^[\x21-\x7e]{1,128}$/;
const sourceReference = z.object({ messageId: z.uuid(), revision: z.number().int().positive() });

/** HTTP 和前台工具都经这里提交，作业唤醒在事务提交之后发出。 */
export function dispatchTicketCommand(ctx: HostContext, input: TicketCommandContext, command: TicketCommand) {
  const parsed = ticketCommandSchema.safeParse(command);
  const origin = input.origin;
  const source = origin.source === "chat" ? origin : origin.proof;
  if (!parsed.success || (source && !sourceReference.safeParse(source).success)
    || (origin.source === "app" && origin.requestId !== undefined && !requestKey.test(origin.requestId))) {
    throw new TicketError(400, "invalid_request", "事项指令格式无效");
  }
  const result = receiveTicketCommand(ctx.store.db, ctx.clock, input, parsed.data, ctx.config.ticketAdmission, ctx.config.groupPublicationAuthority, ctx.publication);
  if (result.queue) {
    ctx.bus.publish("jobs:wake", { queue: result.queue });
  }
  return result.receipt;
}

export function admitNextErrand(ctx: HostContext): boolean {
  const admitted = admitQueuedErrands(ctx.store.db, ctx.clock, ctx.config.ticketAdmission, ctx.config.groupPublicationAuthority, ctx.publication);
  if (admitted) {
    ctx.bus.publish("jobs:wake", { queue: "errand" });
  }
  return admitted;
}
