import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import { PublicationLeaseError } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { confirmDiarySource, listCatDiaries, setDiaryTimeZone } from "../store/cat-diary.ts";
import { readPublicationRoute } from "../store/publication.ts";
import { projectSoul, SoulError, updateSoul } from "../store/soul.ts";
import { timeZoneSchema } from "./diary-date.ts";
import { confirmDiarySchema } from "./facts.ts";
import { editSoulSchema, withdrawSoulSchema } from "./rules.ts";

const timeZoneEdit = z.strictObject({ time_zone: timeZoneSchema, expected_version: z.int().nonnegative() });

export function soulRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  const { db } = ctx.store;
  app.onError((error, c) => {
    if (error instanceof SoulError) return c.json({ error: { code: error.code } }, error.status);
    if (error instanceof PublicationLeaseError) {
      const route = readPublicationRoute(db, c.get("actor").householdId, ctx.publication);
      return c.json({ error: { code: error.code, publisher_host_id: route.current?.holderHostId ?? null } }, 409);
    }
    throw error;
  });
  const noStore = async (c: Parameters<typeof auth>[0], next: () => Promise<void>) => {
    c.header("cache-control", "private, no-store");
    await next();
  };
  app.use("/soul", noStore);
  app.use("/cat-diary", noStore);
  app.get("/soul", auth, (c) => c.json({
    soul: db.transaction((tx) => projectSoul(tx, c.get("actor"), ctx.clock.wallMs())),
  }));
  app.post("/soul", auth, async (c) => {
    const parsed = editSoulSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "invalid_request" } }, 400);
    return c.json({ soul: updateSoul(ctx, c.get("actor"), parsed.data) });
  });
  app.post("/soul/withdraw", auth, async (c) => {
    const parsed = withdrawSoulSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "invalid_request" } }, 400);
    return c.json({ soul: updateSoul(ctx, c.get("actor"), parsed.data) });
  });
  app.get("/cat-diary", auth, (c) => c.json(db.transaction((tx) => listCatDiaries(tx, c.get("actor")))));
  app.post("/cat-diary/sources", auth, async (c) => {
    const parsed = confirmDiarySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "invalid_request" } }, 400);
    return c.json(confirmDiarySource(ctx, c.get("actor"), parsed.data));
  });
  app.put("/cat-diary/time-zone", auth, async (c) => {
    const parsed = timeZoneEdit.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: "invalid_request" } }, 400);
    return c.json({ calendar: setDiaryTimeZone(ctx, c.get("actor"), parsed.data.time_zone, parsed.data.expected_version) });
  });
  return app;
}
