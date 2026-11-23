import { soulRoutes } from "../soul/routes.ts";
import { worldRoutes } from "../world/routes.ts";
import { backupStatus, createBackup } from "../backup/index.ts";
import { phoneSyncGeneration } from "../store/backup.ts";
import { join } from "node:path";
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
import { pushRoutes } from "../push/routes.ts";
import { proactiveRoutes } from "../inference/routes.ts";
import { mailboxRoutes } from "../router/mailbox-routes.ts";
import { ticketRoutes } from "../tickets/routes.ts";
import { conversationRoutes } from "../conversations/routes.ts";
import { BlobStorage } from "../files/blobs.ts";
import { fileRoutes } from "../files/routes.ts";
import { memberChangesRoutes } from "../member-changes/routes.ts";
import { memberResourceRoutes } from "../member-resources/routes.ts";
import type { GroupSends } from "../group-sends/index.ts";
import { actorDto, memberProfile } from "../identity/dto.ts";
import { startHostPeer } from "../runtime/peer.ts";
import { relayRoutes } from "../relay/routes.ts";
import type { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import type { PeerProtocol } from "../peer/index.ts";
import { isPeerAddress } from "../peer/protocol.ts";

export interface GatewayOptions {
  groupSends?: GroupSends;
  peerBehavior?: PeerBehaviorChannel;
  heartbeatIntervalMs?: number;
  lanPort?: number;
  peerPort?: number;
  peerHostname?: string;
  peerHandlers?: Parameters<typeof startHostPeer>[1]["handlers"];
  peerProtocol?: PeerProtocol;
  tlsRefreshIntervalMs?: number;
  tls?: LanTlsOptions;
}

export class Gateway implements Component {
  readonly name = "gateway";
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly streams = new Set<AbortController>();
  private readonly heartbeatIntervalMs: number;
  private peerService: Awaited<ReturnType<typeof startHostPeer>> | undefined;
  private lanServer: ReturnType<typeof Bun.serve> | undefined;
  private readonly draining = new Set<ReturnType<typeof Bun.serve>>();
  private fileShutdown: AbortController | undefined;
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

  attachBehavior(channel: PeerBehaviorChannel, groupSends: GroupSends): void {
    this.options.peerBehavior = channel;
    this.options.groupSends = groupSends;
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  get lanPort(): number | undefined {
    return this.lanServer?.port;
  }

  get peerPort(): number | undefined {
    return this.peerService?.port;
  }

  get peerTransport() {
    return this.peerService?.transport;
  }

  activatePeer(): void { this.peerService?.activate(); }

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
    const generation = () => phoneSyncGeneration(ctx.store.db, ctx.hostId);
    const maintenance = () => ctx.config.accessPaused?.() ?? false;
    const unavailable = () => Response.json({ error: { code: "maintenance" } }, { status: 503 });
    app.use("/v2/*", async (c, next) => {
      if (c.req.path === "/v2/healthz") return next();
      if (maintenance()) return unavailable();
      const current = generation();
      c.header("X-Cattt-Sync-Generation", current);
      const given = c.req.header("X-Cattt-Sync-Generation");
      // The member changes feed owns its cursor-reset envelope.
      const ownsCursorReset = c.req.path === "/v2/sync-generation" || c.req.path === "/v2/changes";
      if (given !== undefined && given !== current && !ownsCursorReset) {
        return c.json({ error: { code: "reset_required" }, generation: current }, 409);
      }
      await next();
    });
    app.get("/v2/sync-generation", auth, (c) => c.json({ generation: generation() }));
    app.route("/v2", phonePairingRoutes(ctx));
    const peerTransport = () => this.peerTransport;
    app.route("/v2", memberInviteRoutes(ctx, identity, lanStatus, false, peerTransport));
    app.route("/v2", memberResourceRoutes(ctx, this.options.peerBehavior));
    app.route("/v2", soulRoutes(ctx));
    app.route("/v2", conversationRoutes(ctx, (request, turnId, cursor) => this.stream(request, ctx, turnId, cursor), this.options.groupSends));
    const blobs = new BlobStorage(join(ctx.config.dataDir, "blobs"));
    this.fileShutdown = new AbortController();
    app.route("/v2", memberChangesRoutes(ctx, blobs));
    app.route("/v2/world", worldRoutes(ctx, () => this.peerTransport, this.fileShutdown.signal));
    app.route("/v2/files", fileRoutes(ctx, this.fileShutdown.signal, blobs));
    app.route("/v2", ticketRoutes(ctx));
    app.route("/v2", mailboxRoutes(ctx));
    app.route("/v2", proactiveRoutes(ctx));
    app.route("/v2", pushRoutes(ctx));
    if (ctx.config.relay) app.route("/v2", relayRoutes(ctx, ctx.config.relay.peer));
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
      const peerPort = this.options.peerPort ?? ctx.config.peerHttpsPort ?? 0;
      if (this.options.peerPort !== undefined || peerPort !== 0) {
        if (!Number.isInteger(peerPort) || peerPort < 0 || peerPort > 65535) {
          throw new RangeError("Peer HTTPS 端口必须是 0 至 65535 的整数");
        }
        const peerHostname = this.options.peerHostname ?? "0.0.0.0";
        this.peerService = await startHostPeer(ctx, {
          port: peerPort, hostname: peerHostname, storage: blobs,
          advertisedHost: () => [peerHostname, ...identity.hosts()].find(isPeerAddress) ?? "localhost",
          handlers: this.options.peerBehavior ? {
            ...this.options.peerHandlers,
            inbox: (request, actor) => this.options.peerBehavior!.receive(ctx, request, actor),
          } : this.options.peerHandlers,
          protocol: this.options.peerProtocol,
          report: (error) => {
            try {
              Promise.resolve(ctx.config.onError
                ? ctx.config.onError(error, "gateway:peer") : console.error("Peer HTTPS 错误", error)).catch(() => {});
            } catch {}
          },
        });
      }
      loopback.route("/host", hostAdminRoutes(ctx, identity, lanStatus, this.peerService?.admin, {
        maintenance, generation, peerPort: () => this.peerPort,
        list: () => backupStatus(ctx.config.dataDir),
        create: async () => {
          await this.refreshing;
          if (maintenance()) throw new Error("维护期间无法创建在线备份");
          return createBackup(ctx.config.dataDir, ctx.store, "manual", ctx.clock);
        },
      }, peerTransport));
      this.server = Bun.serve({ hostname, port: ctx.config.port ?? 8788, idleTimeout: 0,
        fetch: (request) => {
          const pathname = new URL(request.url).pathname;
          if (maintenance() && pathname !== "/v2/healthz" && pathname !== "/host/status") return unavailable();
          return loopback.fetch(request);
        },
      });
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
    this.fileShutdown?.abort();
    this.fileShutdown = undefined;
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
    const peer = this.peerService;
    this.peerService = undefined;
    await Promise.all([server?.stop(true), lanServer?.stop(true), peer?.stop(),
      ...Array.from(this.draining, (listener) => listener.stop(true))]);
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
