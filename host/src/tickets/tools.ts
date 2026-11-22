import { z } from "zod";
import type { Actor } from "../identity/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { listActorTickets } from "../store/tickets.ts";
import { dispatchTicketCommand } from "./index.ts";
import { errandFields, scheduleFields } from "./types.ts";
import type { SourceReference, TicketCommand, TicketCommandContext } from "./types.ts";

type ToolContext = SourceReference & { actor: Actor; conversationId: string; signal?: AbortSignal; assertChatTurn?: TicketCommandContext["assertChatTurn"] };

export function ticketTools(ctx: HostContext, input: ToolContext) {
  const submit = (command: TicketCommand) => {
    input.signal?.throwIfAborted();
    return dispatchTicketCommand(ctx, {
      actor: input.actor, conversationId: input.conversationId,
      assertChatTurn: input.assertChatTurn,
      origin: { source: "chat", messageId: input.messageId, revision: input.revision },
    }, command);
  };
  const schedule = scheduleFields;
  const errand = errandFields;
  const update = z.union([
    scheduleFields.omit({ about: true }).extend({ ticket_id: z.uuid() }),
    z.strictObject({ ticket_id: z.uuid(), text: z.string() }),
  ]);
  const cancel = z.strictObject({ ticket_id: z.uuid() });
  const list = z.strictObject({});
  return {
    schedule_followup: {
      description: "用户明确约好之后再聊时登记约定。先问清具体日期、时间和主题。",
      inputSchema: schedule,
      execute: (args: z.input<typeof schedule>) => submit({ kind: "schedule", ...schedule.parse(args) }),
    },
    start_errand: {
      description: "用户明确托付后登记事项。只有保存成功才确认，排队时告诉用户团子先记下了。",
      inputSchema: errand,
      execute: (args: z.input<typeof errand>) => submit({ kind: "start", ...errand.parse(args) }),
    },
    list_tickets: {
      description: "读取这位成员在当前会话中的事项。改期、取消或继续原托付前先查找对应事项。",
      inputSchema: list,
      execute: (args: z.input<typeof list>) => {
        input.signal?.throwIfAborted();
        list.parse(args);
        return listActorTickets(ctx.store.db, input.actor, "actionable", input.conversationId);
      },
    },
    update_ticket: {
      description: "用户明确改期时传具体时间。补充或继续原托付时传 text，保存以当前用户原话为准。",
      inputSchema: update,
      execute: (args: z.input<typeof update>) => {
        const { ticket_id: ticketId, ...change } = update.parse(args);
        return submit("text" in change ? { kind: "append", ticketId, text: change.text }
          : { kind: "reschedule", ticketId, when: change.when });
      },
    },
    cancel_ticket: {
      description: "用户明确撤回时取消已有事项。指代不清时先问。",
      inputSchema: cancel,
      execute: (args: z.input<typeof cancel>) => submit({ kind: "cancel", ticketId: cancel.parse(args).ticket_id }),
    },
  };
}
