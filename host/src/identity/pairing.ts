import { pendingPublicationTransfer, readPublicationRoute } from "../store/publication.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { HostContext } from "../runtime/index.ts";
import { listMembers, revokeDevice } from "../store/identity.ts";
import { issuePairingCode, listPairedDevices, normalizePairingCode, redeemPairingCode, revokeLocalDevice } from "../store/pairing.ts";
import { requireActor } from "./middleware.ts";
import type { IdentityEnv } from "./middleware.ts";
import type { LanIdentity } from "./tls.ts";
import { memberInviteRoutes } from "./invites.ts";
import type { PeerTransport } from "../peer/index.ts";
import { memberProfile } from "./dto.ts";

const badRequest = { error: { code: "invalid_request" } };

export function phonePairingRoutes(ctx: HostContext) {
  const app = new Hono<IdentityEnv>();
  app.post("/pair", async (c) => {
    const parsed = z.object({
      code: z.string().refine((code) => normalizePairingCode(code) !== undefined),
      device_name: z.string().trim().min(1).max(100),
    }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(badRequest, 400);
    }
    const result = redeemPairingCode(ctx.store.db, ctx.clock, {
      code: parsed.data.code, deviceName: parsed.data.device_name,
    });
    return result ? c.json({
      device_id: result.deviceId, device_token: result.token, member: memberProfile(result.member), household: result.household,
    }) : c.json({ error: { code: "pairing_code_invalid" } }, 401);
  });
  app.post("/device/unpair", requireActor(ctx), (c) => {
    revokeDevice(ctx.store.db, ctx.clock, c.get("actor").deviceId);
    return c.json({ ok: true });
  });
  return app;
}

export function hostAdminRoutes(
  ctx: HostContext,
  identity: LanIdentity,
  lanStatus: () => { enabled: boolean; port: number },
  peerAdmin?: Hono,
  recovery?: {
    maintenance(): boolean;
    generation(): string;
    peerPort(): number | undefined;
    list(): unknown;
    create(): Promise<{ id: string }>;
  },
  peerTransport?: () => PeerTransport | undefined,
) {
  const app = new Hono();
  const expected = createHash("sha256").update(identity.adminToken).digest();
  app.use("*", async (c, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(c.req.header("authorization") ?? "");
    const given = createHash("sha256").update(match?.[1] ?? "").digest();
    if (!match || !timingSafeEqual(given, expected)) {
      return c.json({ error: { code: "unauthorized" } }, 401);
    }
    await next();
  });
  const lan = () => ({ ...lanStatus(), hosts: identity.hosts() });
  app.route("/", memberInviteRoutes(ctx, identity, lanStatus, true, peerTransport));
  if (peerAdmin) {
    app.route("/", peerAdmin);
  }
  app.post("/pairing-codes", async (c) => {
    const parsed = z.object({ member_id: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(badRequest, 400);
    }
    try {
      const { code, expiresAt } = issuePairingCode(ctx.store.db, ctx.clock, parsed.data.member_id);
      const { port, hosts } = lan();
      const params = new URLSearchParams({
        v: "2", h: hosts.join(","), p: String(port), c: code.replace(/-/g, ""), fp: identity.fingerprint,
      });
      return c.json({
        code, expires_at: expiresAt, pair_url: `maomao://pair?${params}`, hosts, port,
        ca_fingerprint: identity.fingerprint, ca_fingerprint_short: identity.fingerprintShort,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return c.json(badRequest, 400);
      }
      throw error;
    }
  });
  app.get("/devices", (c) => c.json({ devices: listPairedDevices(ctx.store.db) }));
  app.delete("/devices/:id", (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json(badRequest, 400);
    }
    revokeLocalDevice(ctx.store.db, ctx.clock, id.data);
    return c.json({ ok: true });
  });
  app.get("/publication-lease", (c) => {
    const { current, status } = readPublicationRoute(ctx.store.db, ctx.householdId, ctx.publication);
    return c.json({
      epoch: current?.epoch ?? null, holder_host_id: current?.holderHostId ?? null, status,
      pending_transfer: pendingPublicationTransfer(ctx.store.db, ctx.householdId, ctx.hostId),
    });
  });
  if (recovery) {
    app.get("/backups", (c) => c.json(recovery.list()));
    app.post("/backups", async (c) => {
      try { return c.json(await recovery.create(), 201); }
      catch { return c.json({ error: { code: "backup_failed" } }, 500); }
    });
  }
  app.get("/status", (c) => {
    const members = listMembers(ctx.store.db, ctx.householdId);
    return c.json({
      ...(recovery ? { maintenance: recovery.maintenance(), sync_generation: recovery.generation(),
        peer_https_port: recovery.peerPort() ?? 0 } : {}),
      host_id: ctx.hostId,
      household_id: ctx.householdId,
      has_members: members.length > 0,
      local_members: members.filter((member) => member.homeHostId === ctx.hostId).map(memberProfile),
      lan: lan(), ca_fingerprint: identity.fingerprint, ca_fingerprint_short: identity.fingerprintShort,
      devices: listPairedDevices(ctx.store.db),
    });
  });
  return app;
}
