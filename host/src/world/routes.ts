import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { PeerTransport } from "../peer/index.ts";
import { PublicationLeaseError } from "../publication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { readPublicationRoute } from "../store/publication.ts";
import {
  acknowledgeWorldAction, pollWorld, putWorldProfile, putWorldState, readWorldAction, registerWorldSession, requestWorldAction, worldView,
} from "../store/world.ts";
import { WorldError, WORLD_PROTOCOL_VERSION } from "./protocol.ts";
import { ackRequest, actionRequest, profileRequest, sessionQuery, stateRequest } from "./wire.ts";
import { worldPresence } from "./presence.ts";

const registration = z.strictObject({ protocol_version: z.literal(WORLD_PROTOCOL_VERSION) });
const actionId = z.uuidv7();

export function worldRoutes(ctx: HostContext, transport: () => PeerTransport | undefined, stopped: AbortSignal) {
  const app = new Hono<IdentityEnv>();
  const combinedPresence = worldPresence(ctx, transport, stopped);
  const errorFields = (error: unknown, householdId: string) => {
    if (error instanceof WorldError) return { code: error.code };
    if (error instanceof PublicationLeaseError) {
      const route = readPublicationRoute(ctx.store.db, householdId, ctx.publication);
      return { code: error.code, publisher_host_id: route.current?.holderHostId ?? null };
    }
    return { code: "world_unavailable" };
  };

  app.use("*", requireActor(ctx));
  app.use("*", bodyLimit({
    maxSize: 24_000, onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
  }));
  app.onError((error, c) => {
    if (error instanceof WorldError || error instanceof PublicationLeaseError) {
      return c.json({ error: errorFields(error, c.get("actor").householdId) }, error instanceof WorldError ? error.httpStatus : 409);
    }
    throw error;
  });
  app.post("/sessions", async (c) => {
    const body = registration.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "unsupported_protocol" } }, 400);
    const actor = c.get("actor");
    const result = registerWorldSession(ctx, actor);
    return c.json({ ...result, presence: await combinedPresence(result.presence, actor.householdId) });
  });
  app.get("/state", async (c) => {
    const actor = c.get("actor");
    const view = worldView(ctx, actor);
    return c.json({ ...view, presence: await combinedPresence(view.presence, actor.householdId) });
  });
  app.put("/state", async (c) => {
    const body = stateRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "bad_request" } }, 400);
    const actor = c.get("actor");
    const view = putWorldState(ctx, actor, body.data);
    return c.json({ ...view, presence: await combinedPresence(view.presence, actor.householdId) });
  });
  app.put("/profile", async (c) => {
    const body = profileRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "bad_request" } }, 400);
    const actor = c.get("actor");
    const { base_revision, ...profile } = body.data;
    const view = putWorldProfile(ctx, actor, base_revision, profile);
    return c.json({ ...view, presence: await combinedPresence(view.presence, actor.householdId) });
  });
  app.post("/actions", async (c) => {
    const body = actionRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: "bad_request" } }, 400);
    return c.json(requestWorldAction(ctx, c.get("actor"), body.data));
  });
  app.get("/actions/:id", (c) => {
    const id = actionId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: { code: "bad_request" } }, 400);
    return c.json(readWorldAction(ctx, c.get("actor"), id.data));
  });
  app.post("/actions/:id/ack", async (c) => {
    const id = actionId.safeParse(c.req.param("id"));
    const body = ackRequest.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: { code: "bad_request" } }, 400);
    return c.json(acknowledgeWorldAction(ctx, c.get("actor"), id.data, body.data));
  });
  app.get("/events", (c) => {
    const input = sessionQuery.safeParse(c.req.query());
    if (!input.success) return c.json({ error: { code: "bad_request" } }, 400);
    const actor = c.get("actor");
    const initial = pollWorld(ctx, actor, input.data);
    return streamSSE(c, async (stream) => {
      let page = initial;
      let previousWorld = "";
      let previousPresence = "";
      let previousStatuses = new Map<string, string>();
      const sent = new Set<string>();
      try {
        while (!stream.aborted && !stopped.aborted) {
          const { presence: local, server_time, ...view } = page.view;
          const world = JSON.stringify(view);
          if (world !== previousWorld) {
            await stream.writeSSE({ event: "world_state", data: JSON.stringify({ ...view, server_time }) });
            previousWorld = world;
          }
          const presence = JSON.stringify({ presence: await combinedPresence(local, actor.householdId) });
          if (presence !== previousPresence) {
            await stream.writeSSE({ event: "presence", data: presence });
            previousPresence = presence;
          }
          for (const action of page.requested) {
            if (!sent.has(action.id)) {
              await stream.writeSSE({ event: "action", id: action.id, data: JSON.stringify(action) });
              sent.add(action.id);
            }
          }
          const statuses = new Map<string, string>();
          for (const action of page.statuses) {
            const status = JSON.stringify(action);
            statuses.set(action.id, status);
            if (status !== previousStatuses.get(action.id)) {
              await stream.writeSSE({ event: "action_status", data: status });
            }
          }
          previousStatuses = statuses;
          // Only requests still pending can be resent. This also bounds this
          // connection's dedupe state over long idle periods.
          for (const id of sent) {
            if (!page.requested.some((action) => action.id === id)) sent.delete(id);
          }
          await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ server_time }) });
          await stream.sleep(500);
          if (!stream.aborted && !stopped.aborted) page = pollWorld(ctx, actor, input.data);
        }
      } catch (error) {
        if (!stream.aborted && !stopped.aborted) {
          if (!(error instanceof WorldError || error instanceof PublicationLeaseError)) {
            await ctx.config.onError?.(error, "gateway:world");
          }
          await stream.writeSSE({ event: "world_error", data: JSON.stringify(errorFields(error, actor.householdId)) });
        }
      }
    });
  });
  return app;
}
