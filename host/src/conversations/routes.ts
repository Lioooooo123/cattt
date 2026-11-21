import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import { ChatEvents } from "../chat-events/index.ts";
import { cancelTurn, getTurn, retryTurn } from "../store/turns.ts";
import {
  ConversationNotFoundError, getConversation, IdempotencyConflictError, InvalidChatRequestError,
  listConversations, NotPublisherError, readMessages, sendMessage,
} from "../store/conversations.ts";

export function conversationRoutes(ctx: HostContext, stream: (request: Request, turnId: string, cursor: string | null) => Response) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  const invalid = { error: { code: "invalid_request" } };
  const events = new ChatEvents(ctx);
  app.onError((error, c) => {
    if (error instanceof ConversationNotFoundError) {
      return c.json({ error: { code: "not_found" } }, 404);
    }
    if (error instanceof NotPublisherError) {
      return c.json({ error: { code: "not_publisher" } }, 409);
    }
    if (error instanceof IdempotencyConflictError) {
      return c.json({ error: { code: "idempotency_conflict" } }, 409);
    }
    if (error instanceof InvalidChatRequestError) {
      return c.json(invalid, 400);
    }
    throw error;
  });
  app.get("/conversations", auth, (c) => c.json({ conversations: listConversations(ctx.store.db, c.get("actor")) }));
  app.get("/conversations/:id", auth, (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    return id.success ? c.json(getConversation(ctx.store.db, c.get("actor"), id.data)) : c.json(invalid, 400);
  });
  app.get("/conversations/:id/messages", auth, (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json(invalid, 400);
    }
    getConversation(ctx.store.db, c.get("actor"), id.data);
    const query = z.object({
      before: z.string().optional(), after: z.string().optional(),
      limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
    }).strict().safeParse(c.req.query());
    return query.success ? c.json(readMessages(ctx.store.db, c.get("actor"), id.data, query.data)) : c.json(invalid, 400);
  });
  app.post("/conversations/:id/messages", auth, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json(invalid, 400);
    }
    getConversation(ctx.store.db, c.get("actor"), id.data);
    const body = z.object({
      client_message_id: z.string().min(1).max(100), text: z.string().trim().min(1).max(4000),
    }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(invalid, 400);
    }
    const result = events.write((db, append) => sendMessage(db, ctx.clock, c.get("actor"), id.data, {
      clientMessageId: body.data.client_message_id, text: body.data.text,
    }, append));
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.get("/conversations/:id/turns/:turnId", auth, (c) => {
    const ids = z.object({ id: z.uuid(), turnId: z.uuid() }).safeParse(c.req.param());
    return ids.success ? c.json(getTurn(ctx.store.db, c.get("actor"), ids.data.id, ids.data.turnId)) : c.json(invalid, 400);
  });
  app.get("/conversations/:id/turns/:turnId/stream", auth, (c) => {
    const ids = z.object({ id: z.uuid(), turnId: z.uuid() }).safeParse(c.req.param());
    if (!ids.success) {
      return c.json(invalid, 400);
    }
    getTurn(ctx.store.db, c.get("actor"), ids.data.id, ids.data.turnId);
    return stream(c.req.raw, ids.data.turnId, c.req.header("last-event-id") ?? c.req.query("last_event_id") ?? null);
  });
  app.post("/conversations/:id/turns/:turnId/cancel", auth, async (c) => {
    const ids = z.object({ id: z.uuid(), turnId: z.uuid() }).safeParse(c.req.param());
    if (!ids.success) {
      return c.json(invalid, 400);
    }
    getTurn(ctx.store.db, c.get("actor"), ids.data.id, ids.data.turnId);
    const raw = await c.req.text();
    let parsed: unknown;
    try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { parsed = null; }
    const body = z.object({ visible_length: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict().safeParse(parsed);
    if (!body.success) {
      return c.json(invalid, 400);
    }
    const turn = events.write((db, append) => cancelTurn(db, ctx.clock, c.get("actor"), ids.data.id, ids.data.turnId, body.data.visible_length, append));
    ctx.bus.publish("turn:wake", { turnId: turn.id });
    return c.json(turn);
  });
  app.post("/conversations/:id/messages/:messageId/reply", auth, async (c) => {
    const ids = z.object({ id: z.uuid(), messageId: z.uuid() }).safeParse(c.req.param());
    if (!ids.success) {
      return c.json(invalid, 400);
    }
    getConversation(ctx.store.db, c.get("actor"), ids.data.id);
    const body = z.object({ request_id: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(invalid, 400);
    }
    const result = events.write((db, append) => retryTurn(db, ctx.clock, c.get("actor"), ids.data.id, ids.data.messageId, body.data.request_id, append));
    return c.json(result.turn, result.created ? 201 : 200);
  });
  app.all("/conversations/*", auth, (c) => c.json({ error: { code: "not_found" } }, 404));
  return app;
}
