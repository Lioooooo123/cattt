import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import { listMailbox, MailboxError, markLetterRead } from "../store/mailbox.ts";

const query = z.strictObject({
  after: z.uuidv7().optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),
});

export function mailboxRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  app.get("/mailbox", auth, (c) => {
    const parsed = query.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_request" } }, 400);
    }
    try {
      return c.json(listMailbox(ctx.store.db, c.get("actor"), { ...parsed.data, limit: parsed.data.limit ?? 50 }));
    } catch (error) {
      if (error instanceof MailboxError) {
        return c.json({ error: { code: error.code } }, error.status);
      }
      throw error;
    }
  });
  app.post("/mailbox/:id/read", auth, (c) => {
    const id = z.uuidv7().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: { code: "invalid_request" } }, 400);
    }
    try {
      const letter = markLetterRead(ctx.store.db, ctx.clock, c.get("actor"), id.data);
      return c.json({ letter });
    } catch (error) {
      if (error instanceof MailboxError) {
        return c.json({ error: { code: error.code } }, error.status);
      }
      throw error;
    }
  });
  return app;
}
