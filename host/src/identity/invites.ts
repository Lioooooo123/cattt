import { Hono } from "hono";
import { z } from "zod";
import type { HostContext } from "../runtime/index.ts";
import type { PeerTransport } from "../peer/index.ts";
import { normalizeCode } from "../store/codes.ts";
import { getHousehold, listMembers, MemberLimitError, removeMember } from "../store/identity.ts";
import {
  acceptMemberInvite, bootstrapMember, issueMemberInvite, listOpenMemberInvites, memberInviteAdmission,
  MemberBootstrapError, MemberSyncPendingError, prepareJoinedMemberInvite, revokeMemberInvite,
} from "../store/invites.ts";
import { MemberSeatAuthorityPendingError, MemberSeatUnavailableError } from "../store/member-seats.ts";
import { AccessDeniedError } from "./access.ts";
import { requireActor } from "./middleware.ts";
import type { IdentityEnv } from "./middleware.ts";
import type { LanIdentity } from "./tls.ts";
import { memberProfile, memberRecord } from "./dto.ts";
import { askCreatorForSeat, refreshCreatorSeats } from "./member-seats.ts";

const name = z.string().trim().min(1).max(100);
const badRequest = { error: { code: "invalid_request" } };

export function memberInviteRoutes(
  ctx: HostContext,
  identity: LanIdentity,
  lanStatus: () => { port: number },
  admin = false,
  peerTransport: () => PeerTransport | undefined = () => undefined,
) {
  const app = new Hono<IdentityEnv>();
  app.onError((error, c) => {
    if (error instanceof MemberLimitError) {
      return c.json({ error: { code: "member_limit" } }, 409);
    }
    if (error instanceof MemberBootstrapError) {
      return c.json({ error: { code: "members_already_initialized" } }, 409);
    }
    if (error instanceof MemberSyncPendingError) {
      return c.json({ error: { code: "peer_sync_pending" } }, 409);
    }
    if (error instanceof MemberSeatAuthorityPendingError) {
      return c.json({ error: { code: "member_seat_authority_pending" } }, 503);
    }
    if (error instanceof MemberSeatUnavailableError) {
      return c.json({ error: { code: "invite_code_invalid" } }, 401);
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
      const admission = memberInviteAdmission(ctx.store.db, ctx.clock, parsed.data.code);
      const confirmedSeat = admission?.seat;
      if (confirmedSeat) {
        try {
          await askCreatorForSeat(ctx, peerTransport, "confirm", confirmedSeat.memberId);
        } catch (error) {
          if (error instanceof MemberSeatUnavailableError) revokeMemberInvite(ctx.store.db, ctx.clock, {
            householdId: ctx.householdId, inviteId: confirmedSeat.inviteId,
          });
          throw error;
        }
      } else if (admission?.localAuthority) {
        await refreshCreatorSeats(ctx, peerTransport);
      }
      const result = acceptMemberInvite(ctx.store.db, ctx.clock, {
        code: parsed.data.code, displayName: parsed.data.display_name,
        deviceName: parsed.data.device_name, maxMembers: ctx.config.maxMembers, confirmedSeat,
      });
      return result ? c.json({
        member: memberRecord(result.member), device_id: result.deviceId, device_token: result.token, household: result.household,
      }) : c.json({ error: { code: "invite_code_invalid" } }, 401);
    });
    app.use("/invites", requireActor(ctx));
    app.use("/invites/:id", requireActor(ctx));
  } else {
    app.get("/members", (c) => {
      const household = getHousehold(ctx.store.db, ctx.householdId);
      if (!household) return c.json({ error: { code: "not_found" } }, 404);
      return c.json({
        host_id: ctx.hostId,
        household: { id: household.id, name: household.name, origin_host_id: household.originHostId },
        members: listMembers(ctx.store.db, household.id).map(memberProfile),
        max_members: ctx.config.maxMembers,
      });
    });
    app.get("/invites", (c) => c.json({
      invites: listOpenMemberInvites(ctx.store.db, ctx.clock, ctx.householdId),
    }));
    app.post("/members", async (c) => {
      const parsed = z.object({ display_name: name }).strict().safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(badRequest, 400);
      }
      if (getHousehold(ctx.store.db, ctx.householdId)?.originHostId === ctx.hostId
        && listMembers(ctx.store.db, ctx.householdId).length === 0) await refreshCreatorSeats(ctx, peerTransport);
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
    const input = {
      householdId: admin ? ctx.householdId : c.get("actor").householdId,
      invitedByMemberId: admin ? undefined : c.get("actor").memberId,
      displayName: parsed.data.display_name, maxMembers: ctx.config.maxMembers,
    };
    const localAuthority = getHousehold(ctx.store.db, input.householdId)?.originHostId === ctx.hostId;
    if (localAuthority) await refreshCreatorSeats(ctx, peerTransport);
    const invite = localAuthority ? issueMemberInvite(ctx.store.db, ctx.clock, input)
      : prepareJoinedMemberInvite(ctx.store.db, ctx.clock, input);
    if (invite.seatMemberId) {
      try {
        await askCreatorForSeat(ctx, peerTransport, "reserve", invite.seatMemberId);
      } catch (error) {
        revokeMemberInvite(ctx.store.db, ctx.clock, { householdId: input.householdId, inviteId: invite.inviteId });
        throw error;
      }
    }
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
