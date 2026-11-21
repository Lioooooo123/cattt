import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import {
  ConversationNotFoundError, getConversation, IdempotencyConflictError, InvalidChatRequestError,
  listConversations, NotPublisherError, readMessages, sendMessage,
} from "../store/conversations.ts";

export function conversationRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  const invalid = { error: { code: "invalid_request" } };
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
    const result = sendMessage(ctx.store.db, ctx.clock, c.get("actor"), id.data, {
      clientMessageId: body.data.client_message_id, text: body.data.text,
    });
    return c.json(result.body, result.created ? 201 : 200);
  });
  app.all("/conversations/*", auth, (c) => c.json({ error: { code: "not_found" } }, 404));
  return app;
}
