import { Hono } from "hono";
import { z } from "zod";
import { requireActor, type IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import { deletePushDevice, enrollPushDevice } from "../store/device-push.ts";
import { resolvePublicationPush } from "../store/publication-push.ts";

const enrollment = z.strictObject({
  token: z.string().regex(/^(?:[a-fA-F0-9]{2}){16,256}$/).transform((token) => token.toLowerCase()),
  environment: z.enum(["sandbox", "production"]),
  topic: z.string(),
});

export function pushRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  app.put("/device/push", auth, async (c) => {
    const apns = ctx.config.apns;
    if (!apns) return c.json({ error: { code: "push_disabled" } }, 503);
    const input = enrollment.safeParse(await c.req.json().catch(() => null));
    if (!input.success || input.data.topic !== apns.topic) return c.json({ error: { code: "invalid_request" } }, 400);
    const result = enrollPushDevice(ctx, c.get("actor"), input.data);
    if (result === "forbidden") return c.json({ error: { code: "permission_denied" } }, 403);
    if (result === "conflict") return c.json({ error: { code: "push_token_bound" } }, 409);
    return c.body(null, 204);
  });
  app.delete("/device/push", auth, (c) => deletePushDevice(ctx, c.get("actor"))
    ? c.body(null, 204) : c.json({ error: { code: "permission_denied" } }, 403));
  app.get("/notifications/:id", auth, (c) => {
    const id = z.uuidv7().safeParse(c.req.param("id"));
    const intent = id.success && resolvePublicationPush(ctx, c.get("actor"), id.data);
    if (!intent) return c.json({ error: { code: "not_found" } }, 404);
    const { destination } = intent;
    return c.json(destination.route === "chat"
      ? { route: "chat", conversation_id: intent.conversationId, message_id: destination.messageId }
      : { route: "mailbox", letter_id: destination.letterId });
  });
  return app;
}
