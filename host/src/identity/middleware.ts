import { createMiddleware } from "hono/factory";
import type { HostContext } from "../runtime/index.ts";
import { resolveDeviceToken } from "../store/identity.ts";
import type { Actor } from "./index.ts";

export type IdentityEnv = { Variables: { actor: Actor } };

export function requireActor(ctx: HostContext) {
  return createMiddleware<IdentityEnv>(async (c, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(c.req.header("authorization") ?? "");
    const actor = match ? resolveDeviceToken(ctx.store.db, ctx.clock, match[1]!) : undefined;
    if (!actor) {
      return c.json({ error: { code: "unauthorized" } }, 401);
    }
    c.set("actor", actor);
    await next();
  });
}
