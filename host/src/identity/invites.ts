import { Hono } from "hono";
import { z } from "zod";
import type { HostContext } from "../runtime/index.ts";
import { normalizeCode } from "../store/codes.ts";
import { MemberLimitError, removeMember } from "../store/identity.ts";
import { acceptMemberInvite, bootstrapMember, issueMemberInvite, MemberBootstrapError, revokeMemberInvite } from "../store/invites.ts";
import { AccessDeniedError } from "./access.ts";
import { requireActor } from "./middleware.ts";
import type { IdentityEnv } from "./middleware.ts";
import type { LanIdentity } from "./tls.ts";
import { memberRecord } from "./dto.ts";

const name = z.string().trim().min(1).max(100);
const badRequest = { error: { code: "invalid_request" } };

export function memberInviteRoutes(
  ctx: HostContext,
  identity: LanIdentity,
  lanStatus: () => { port: number },
  admin = false,
) {
  const app = new Hono<IdentityEnv>();
  app.onError((error, c) => {
    if (error instanceof MemberLimitError) {
      return c.json({ error: { code: "member_limit" } }, 409);
    }
    if (error instanceof MemberBootstrapError) {
      return c.json({ error: { code: "members_already_initialized" } }, 409);
    }
    if (error instanceof AccessDeniedError) {
      return c.json({ error: { code: "forbidden" } }, 403);
    }
    if (error instanceof TypeError) {
      return c.json(badRequest, 400);
    }
    throw error;
  });
  if (!admin) {
    app.post("/invites/accept", async (c) => {
      const parsed = z.object({
        code: z.string().refine((code) => normalizeCode(code) !== undefined),
        display_name: name, device_name: name,
      }).strict().safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(badRequest, 400);
      }
      const result = acceptMemberInvite(ctx.store.db, ctx.clock, {
        code: parsed.data.code, displayName: parsed.data.display_name,
        deviceName: parsed.data.device_name, maxMembers: ctx.config.maxMembers,
      });
      return result ? c.json({
        member: memberRecord(result.member), device_id: result.deviceId, device_token: result.token, household: result.household,
      }) : c.json({ error: { code: "invite_code_invalid" } }, 401);
    });
    app.use("/invites", requireActor(ctx));
    app.use("/invites/:id", requireActor(ctx));
  } else {
    app.post("/members", async (c) => {
      const parsed = z.object({ display_name: name }).strict().safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(badRequest, 400);
      }
      return c.json({ member: memberRecord(bootstrapMember(ctx.store.db, ctx.clock, {
        householdId: ctx.householdId, displayName: parsed.data.display_name, maxMembers: ctx.config.maxMembers,
      })) });
    });
    app.delete("/members/:id", (c) => {
      const parsed = z.uuid().safeParse(c.req.param("id"));
      if (!parsed.success) {
        return c.json(badRequest, 400);
      }
      removeMember(ctx.store.db, ctx.clock, ctx.householdId, parsed.data);
      return c.json({ ok: true });
    });
  }
  app.post("/invites", async (c) => {
    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json(badRequest, 400);
      }
    }
    const parsed = z.object({ display_name: name.optional() }).strict().safeParse(body);
    if (!parsed.success) {
      return c.json(badRequest, 400);
    }
    const invite = issueMemberInvite(ctx.store.db, ctx.clock, {
      householdId: admin ? ctx.householdId : c.get("actor").householdId,
      invitedByMemberId: admin ? undefined : c.get("actor").memberId,
      displayName: parsed.data.display_name, maxMembers: ctx.config.maxMembers,
    });
    const params = new URLSearchParams({
      v: "2", h: identity.hosts().join(","), p: String(lanStatus().port),
      c: invite.code.replace(/-/g, ""), fp: identity.fingerprint,
    });
    return c.json({
      invite_id: invite.inviteId, code: invite.code, expires_at: invite.expiresAt,
      invite_url: `maomao://invite?${params}`,
    });
  });
  app.delete("/invites/:id", (c) => {
    const parsed = z.uuid().safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json(badRequest, 400);
    }
    revokeMemberInvite(ctx.store.db, ctx.clock, {
      inviteId: parsed.data, householdId: admin ? ctx.householdId : c.get("actor").householdId,
      inviterMemberId: admin ? undefined : c.get("actor").memberId,
    });
    return c.json({ ok: true });
  });
  return app;
}
