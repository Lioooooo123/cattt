import { Hono } from "hono";
import type { Component, HostContext } from "../runtime/index.ts";
import { streamTurn } from "../turns/stream.ts";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import { getHousehold, getMember, listMembers } from "../store/identity.ts";
import { hostAdminRoutes, phonePairingRoutes } from "../identity/pairing.ts";
import { initializeLan } from "../identity/tls.ts";
import type { LanTlsOptions } from "../identity/tls.ts";
import { DEFAULT_LAN_HTTPS_PORT } from "../runtime/config.ts";
import { memberInviteRoutes } from "../identity/invites.ts";
import { conversationRoutes } from "../conversations/routes.ts";
import { actorDto, memberProfile } from "../identity/dto.ts";

interface GatewayOptions {
  heartbeatIntervalMs?: number;
  lanPort?: number;
  tlsRefreshIntervalMs?: number;
  tls?: LanTlsOptions;
}

export class Gateway implements Component {
  readonly name = "gateway";
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly streams = new Set<AbortController>();
  private readonly heartbeatIntervalMs: number;
  private lanServer: ReturnType<typeof Bun.serve> | undefined;
  private readonly draining = new Set<ReturnType<typeof Bun.serve>>();
  private stopping = false;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(private readonly options: GatewayOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) {
      throw new RangeError("心跳间隔必须是正整数毫秒");
    }
    if (options.tlsRefreshIntervalMs !== undefined
      && (!Number.isSafeInteger(options.tlsRefreshIntervalMs) || options.tlsRefreshIntervalMs < 1)) {
      throw new RangeError("证书检查间隔必须是正整数毫秒");
    }
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  get lanPort(): number | undefined {
    return this.lanServer?.port;
  }

  async start(ctx: HostContext): Promise<void> {
    this.stopping = false;
    const hostname = ctx.config.hostname ?? "127.0.0.1";
    if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) {
      throw new Error("HTTP 管理监听必须使用回环地址");
    }
    const lanPort = this.options.lanPort ?? ctx.config.lanHttpsPort ?? DEFAULT_LAN_HTTPS_PORT;
    if (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535) {
      throw new RangeError("局域网 HTTPS 端口必须是 0 至 65535 的整数");
    }
    const identity = await initializeLan(ctx.config.dataDir, ctx.clock, this.options.tls);
    const app = new Hono<IdentityEnv>();
    const internalError = (error: Error) => {
      try {
        Promise.resolve(ctx.config.onError ? ctx.config.onError(error, "gateway:http") : console.error("接口处理失败", error)).catch(() => {});
      } catch {}
      return Response.json({ error: { code: "internal_error" } }, { status: 500 });
    };
    app.onError(internalError);
    const lanStatus = () => ({ enabled: this.lanPort !== undefined, port: this.lanPort ?? 0 });
    const auth = requireActor(ctx);
    app.route("/v2", phonePairingRoutes(ctx));
    app.route("/v2", memberInviteRoutes(ctx, identity, lanStatus));
    app.route("/v2", conversationRoutes(ctx, (request, turnId, cursor) => this.stream(request, ctx, turnId, cursor)));
    app.get("/v2/healthz", (c) => c.json({ ok: true, host_id: ctx.hostId, protocol_version: 1 }));
    app.get("/v2/me", auth, (c) => {
      const actor = c.get("actor");
      const member = getMember(ctx.store.db, actor.memberId);
      const household = getHousehold(ctx.store.db, actor.householdId);
      if (!member || !household) {
        return c.json({ error: { code: "unauthorized" } }, 401);
      }
      return c.json({ actor: actorDto(actor), member: memberProfile(member), household: { id: household.id, name: household.name } });
    });
    app.get("/v2/members", auth, (c) => {
      return c.json({ members: listMembers(ctx.store.db, c.get("actor").householdId).map(memberProfile) });
    });
    app.notFound((c) => c.json({ error: { code: "not_found", message: "未找到接口" } }, 404));
    const loopback = new Hono<IdentityEnv>();
    loopback.onError(internalError);
    loopback.route("/", app);
    loopback.route("/host", hostAdminRoutes(ctx, identity, lanStatus));
    loopback.notFound((c) => c.json({ error: { code: "not_found", message: "未找到接口" } }, 404));
    const lanEnabled = this.options.lanPort !== undefined || lanPort !== 0;
    const bindLan = (port: number) => Bun.serve({
      hostname: "0.0.0.0", port, idleTimeout: 0, tls: identity.serverOptions(), fetch: app.fetch,
    });
    const report = (error: unknown) => {
      try {
        const result = ctx.config.onError
          ? ctx.config.onError(error, "gateway:tls") : console.error("更新局域网证书失败", error);
        Promise.resolve(result).catch(() => {});
      } catch {}
    };
    try {
      this.server = Bun.serve({ hostname, port: ctx.config.port ?? 8788, idleTimeout: 0, fetch: loopback.fetch });
      if (lanEnabled) {
        this.lanServer = bindLan(lanPort);
      }
      const boundPort = this.lanPort ?? lanPort;
      let needsReload = false;
      this.refreshTimer = setInterval(() => {
        if (this.refreshing) {
          return;
        }
        this.refreshing = (async () => {
          needsReload = await identity.refresh() || needsReload;
          if (!needsReload || !lanEnabled || this.stopping) {
            return;
          }
          const old = this.lanServer;
          this.lanServer = undefined;
          if (old) {
            this.draining.add(old);
            void old.stop(false).catch(report).finally(() => this.draining.delete(old));
          }
          for (let attempt = 0; attempt < 4 && !this.stopping; attempt += 1) {
            try {
              this.lanServer = bindLan(boundPort);
              needsReload = false;
              break;
            } catch (error) {
              report(error);
              if (attempt < 3) {
                await Bun.sleep(25);
              }
            }
          }
        })().catch(report).finally(() => { this.refreshing = undefined; });
      }, this.options.tlsRefreshIntervalMs ?? 60_000);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    await this.refreshing;
    const server = this.server;
    const lanServer = this.lanServer;
    this.server = undefined;
    this.lanServer = undefined;
    for (const stream of this.streams) {
      stream.abort();
    }
    await Promise.all([server, lanServer, ...this.draining].map((listener) => listener?.stop(true)));
    this.draining.clear();
  }

  private stream(request: Request, ctx: HostContext, streamId: string, cursor: string | null): Response {
    const abort = new AbortController();
    const iterator = streamTurn(ctx, streamId, cursor, abort.signal);
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
