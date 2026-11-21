import type { Component, HostContext } from "../runtime/index.ts";
import { ChatEvents } from "../chat-events/index.ts";

export class Gateway implements Component {
  readonly name = "gateway";
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly streams = new Set<AbortController>();

  get port(): number | undefined {
    return this.server?.port;
  }

  start(ctx: HostContext): void {
    const events = new ChatEvents(ctx);
    this.server = Bun.serve({
      hostname: ctx.config.hostname ?? "127.0.0.1",
      port: ctx.config.port ?? 8788,
      idleTimeout: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v2/healthz") {
          return Response.json({ ok: true, hostId: ctx.hostId, protocolVersion: 1 });
        }
        const match = /^\/v2\/streams\/([^/]+)\/events$/.exec(url.pathname);
        if (request.method === "GET" && match) {
          let streamId: string;
          try {
            streamId = decodeURIComponent(match[1]!);
          } catch {
            return Response.json({ error: "事件流标识无效" }, { status: 400 });
          }
          return this.stream(request, events, streamId,
            request.headers.get("last-event-id") ?? url.searchParams.get("cursor"));
        }
        return Response.json({ error: "未找到接口" }, { status: 404 });
      },
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
        }, 15_000);
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
