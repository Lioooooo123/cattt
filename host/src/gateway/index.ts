import type { Component, HostContext } from "../runtime/index.ts";

export class Gateway implements Component {
  readonly name = "gateway";
  private server: ReturnType<typeof Bun.serve> | undefined;

  get port(): number | undefined {
    return this.server?.port;
  }

  start(ctx: HostContext): void {
    this.server = Bun.serve({
      hostname: ctx.config.hostname ?? "127.0.0.1",
      port: ctx.config.port ?? 8788,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/v2/healthz") {
          return Response.json({ ok: true, hostId: ctx.hostId, protocolVersion: 1 });
        }
        return Response.json({ error: "未找到接口" }, { status: 404 });
      },
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.stop(true);
  }
}
