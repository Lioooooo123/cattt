import { Hono } from "hono";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import { PEER_DELIVERY_QUEUE } from "../peer-behavior/index.ts";
import type { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { withdrawKnowledgeSource } from "../store/knowledge-source.ts";
import { RelayError, requestRelay } from "../store/relay.ts";

const sourceRevision = z.int().positive();
const request = z.strictObject({ source_message_id: z.uuidv7(), source_revision: sourceRevision });
const withdrawal = z.strictObject({ source_revision: sourceRevision });

export function relayRoutes(ctx: HostContext, peer: PeerBehaviorChannel) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  app.post("/relays", auth, async (c) => {
    const parsed = request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_request" } }, 400);
    }
    try {
      const result = requestRelay(ctx, peer, c.get("actor"), {
        sourceMessageId: parsed.data.source_message_id, sourceRevision: parsed.data.source_revision,
      });
      if (result.state === "queued") {
        ctx.bus.publish("jobs:wake", { queue: PEER_DELIVERY_QUEUE });
      } else if (result.state === "pending") {
        ctx.bus.publish("relay:wake", { id: result.id });
      }
      return c.json(result);
    } catch (error) {
      if (error instanceof RelayError) {
        return c.json({ error: { code: error.code } }, error.status);
      }
      throw error;
    }
  });
  app.post("/relays/sources/:id/withdraw", auth, async (c) => {
    const id = z.uuidv7().safeParse(c.req.param("id"));
    const parsed = withdrawal.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !parsed.success) {
      return c.json({ error: { code: "invalid_request" } }, 400);
    }
    const result = withdrawKnowledgeSource(
      ctx.store.db, ctx.clock, c.get("actor"), id.data, parsed.data.source_revision,
    );
    if (!result) {
      return c.json({ error: { code: "relay_source_not_found" } }, 404);
    }
    return c.json({ source_message_id: result.sourceMessageId, withdrawn: true });
  });
  return app;
}
