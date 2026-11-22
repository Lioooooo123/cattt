import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import { ProactiveNotHomeError, readProactivePermission, setProactivePermission } from "../store/proactive-permission.ts";

const input = z.strictObject({
  allow_proactive: z.boolean(),
  time_zone: z.string().max(100).refine((value) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_+/-]*$/.test(value)) { return false; }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }).optional(),
});

function dto(permission: ReturnType<typeof readProactivePermission>) {
  return { allow_proactive: permission.allowed, revision: permission.revision, time_zone: permission.timeZone };
}

export function proactiveRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  app.get("/me/proactive", auth, (c) => c.json(dto(readProactivePermission(ctx.store.db, c.get("actor").memberId))));
  app.patch("/me/proactive", auth, async (c) => {
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) { return c.json({ error: { code: "invalid_request" } }, 400); }
    try {
      return c.json(dto(setProactivePermission(ctx.store.db, c.get("actor"),
        parsed.data.allow_proactive, parsed.data.time_zone)));
    } catch (error) {
      if (error instanceof ProactiveNotHomeError) {
        return c.json({ error: { code: "not_publisher" } }, 409);
      }
      throw error;
    }
  });
  return app;
}
