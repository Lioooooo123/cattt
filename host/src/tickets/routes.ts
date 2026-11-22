import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import { listActorTickets, readActorTicket, ticketView } from "../store/tickets.ts";
import { dispatchTicketCommand } from "./index.ts";
import { errandFields, patchTicketFields, scheduleFields, TicketError, ticketStatuses } from "./types.ts";

const proof = { conversation_id: z.uuid(), source_message_id: z.uuid(), source_revision: z.number().int().positive() };
const createFields = z.discriminatedUnion("kind", [
  scheduleFields.extend({ ...proof, kind: z.literal("schedule") }),
  errandFields.extend({ ...proof, kind: z.literal("start") }),
]);

export function ticketRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  const invalid = { error: { code: "invalid_request" } };
  app.onError((error, c) => {
    if (error instanceof TicketError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    throw error;
  });
  app.get("/tickets", auth, (c) => {
    const query = z.strictObject({
      status: z.enum(ticketStatuses).optional(), conversation_id: z.uuid().optional(),
    }).safeParse(c.req.query());
    if (!query.success) {
      return c.json(invalid, 400);
    }
    return c.json({ tickets: listActorTickets(ctx.store.db, c.get("actor"), query.data.status, query.data.conversation_id) });
  });
  app.get("/tickets/:id", auth, (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json(invalid, 400);
    }
    const ticket = ctx.store.db.transaction((tx) => readActorTicket(tx, c.get("actor"), id.data));
    return c.json({ ticket: ticketView(ticket) });
  });
  app.post("/tickets", auth, async (c) => {
    const body = createFields.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(invalid, 400);
    }
    const { conversation_id, source_message_id, source_revision, ...command } = body.data;
    return c.json(dispatchTicketCommand(ctx, {
      actor: c.get("actor"), conversationId: conversation_id,
      origin: {
        source: "app", requestId: c.req.header("Idempotency-Key"),
        proof: { messageId: source_message_id, revision: source_revision },
      },
    }, command), 201);
  });
  app.patch("/tickets/:id", auth, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const body = patchTicketFields.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return c.json(invalid, 400);
    }
    return c.json(dispatchTicketCommand(ctx, {
      actor: c.get("actor"), origin: { source: "app", requestId: c.req.header("Idempotency-Key") },
    }, "text" in body.data
      ? { kind: "append", ticketId: id.data, text: body.data.text }
      : { kind: "reschedule", ticketId: id.data, when: body.data.when }));
  });
  app.post("/tickets/:id/cancel", auth, (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json(invalid, 400);
    }
    return c.json(dispatchTicketCommand(ctx, {
      actor: c.get("actor"), origin: { source: "app", requestId: c.req.header("Idempotency-Key") },
    }, { kind: "cancel", ticketId: id.data }));
  });
  return app;
}
