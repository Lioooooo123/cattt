import { Hono } from "hono";
import type { Component, HostContext } from "../runtime/index.ts";
import { ChatEvents } from "../chat-events/index.ts";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import { getHousehold, getMember, listMembers } from "../store/identity.ts";

function memberProfile(member: NonNullable<ReturnType<typeof getMember>>) {
  const { id, householdId, displayName, homeHostId } = member;
  return { id, householdId, displayName, homeHostId };
}

export class Gateway implements Component {
  readonly name = "gateway";
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly streams = new Set<AbortController>();
  private readonly heartbeatIntervalMs: number;

  constructor(options: { heartbeatIntervalMs?: number } = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) {
      throw new RangeError("心跳间隔必须是正整数毫秒");
    }
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  start(ctx: HostContext): void {
    const events = new ChatEvents(ctx);
    const app = new Hono<IdentityEnv>();
    const auth = requireActor(ctx);
    app.get("/v2/healthz", (c) => c.json({ ok: true, hostId: ctx.hostId, protocolVersion: 1 }));
    app.get("/v2/me", auth, (c) => {
      const actor = c.get("actor");
      const member = getMember(ctx.store.db, actor.memberId);
      const household = getHousehold(ctx.store.db, actor.householdId);
      if (!member || !household) {
        return c.json({ error: { code: "unauthorized" } }, 401);
      }
      return c.json({ actor, member: memberProfile(member), household: { id: household.id, name: household.name } });
    });
    app.get("/v2/members", auth, (c) => {
      return c.json({ members: listMembers(ctx.store.db, c.get("actor").householdId).map(memberProfile) });
    });
    app.get("/v2/streams/:streamId/events", auth, (c) => {
      let streamId: string;
      try {
        streamId = decodeURIComponent(new URL(c.req.url).pathname.split("/")[3]!);
      } catch {
        return c.json({ error: "事件流标识无效" }, 400);
      }
      return this.stream(c.req.raw, events, streamId,
        c.req.header("last-event-id") ?? c.req.query("cursor") ?? null);
    });
    app.notFound((c) => c.json({ error: "未找到接口" }, 404));
    this.server = Bun.serve({
      hostname: ctx.config.hostname ?? "127.0.0.1",
      port: ctx.config.port ?? 8788,
      idleTimeout: 0,
      fetch: app.fetch,
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const stream of this.streams) {
      stream.abort();
    }
    await server?.stop(true);
  }

  private stream(request: Request, events: ChatEvents, streamId: string, cursor: string | null): Response {
    const abort = new AbortController();
    const subscription = events.subscribe(streamId, cursor, abort.signal);
    if (subscription.status === "unknown") {
      return Response.json({ error: "事件游标未知或已过期", reason: "cursor_unknown" }, { status: 410 });
    }
    const iterator = subscription.events;
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let onAbort: () => void;
    const cleanup = () => {
      clearInterval(heartbeat);
      request.signal.removeEventListener("abort", onAbort);
      abort.signal.removeEventListener("abort", onAbort);
      this.streams.delete(abort);
      abort.abort();
      void iterator.return("aborted").catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        onAbort = () => {
          if (!closed) {
            closed = true;
            cleanup();
            controller.close();
          }
        };
        this.streams.add(abort);
        request.signal.addEventListener("abort", onAbort, { once: true });
        abort.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        controller.enqueue(encoder.encode(": connected\n\n"));
        heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        }, this.heartbeatIntervalMs);
      },
      pull: async (controller) => {
        try {
          const next = await iterator.next();
          if (closed) {
            return;
          }
          if (next.done) {
            closed = true;
            cleanup();
            controller.close();
          } else {
            const event = next.value;
            controller.enqueue(encoder.encode(
              `id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.data)}\n\n`,
            ));
          }
        } catch (error) {
          if (!closed) {
            closed = true;
            cleanup();
            controller.error(error);
          }
        }
      },
      cancel: () => {
        closed = true;
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }
}
