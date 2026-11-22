import { z } from "zod";
import type { PeerActor, PeerTransport } from "../peer/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { DEFAULT_MAX_MEMBERS } from "../runtime/config.ts";
import { getHousehold, MemberLimitError } from "../store/identity.ts";
import {
  confirmJoinedMemberSeat, creatorSeatInspections, inspectJoinedMemberSeats,
  MemberSeatAuthorityPendingError, MemberSeatUnavailableError, recordCreatorSeatInspection, reserveJoinedMemberSeat,
} from "../store/member-seats.ts";
import { AccessDeniedError } from "./access.ts";

const batchSize = 64;
const id = z.uuidv7();
const requestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("reserve"), member_id: id }),
  z.strictObject({ op: z.literal("confirm"), member_id: id }),
  z.strictObject({ op: z.literal("inspect"), legacy: z.boolean(), member_ids: z.array(id).max(batchSize) }),
]);
const inspected = z.strictObject({ retired: z.array(id).max(batchSize), legacyMemberIds: z.array(id) });
const ok = z.strictObject({ ok: z.literal(true) });
const wireError = z.object({ error: z.object({ code: z.string() }) });

type AccessTransport = () => PeerTransport | undefined;

function responseError(code: string, status: number) {
  return Response.json({ error: { code } }, { status });
}

async function requestSeat(ctx: HostContext, access: AccessTransport, peerHostId: string, input: z.infer<typeof requestSchema>) {
  const transport = access();
  const peer = transport?.writablePeer(peerHostId);
  if (!transport || peer?.householdId !== ctx.householdId) throw new MemberSeatAuthorityPendingError();
  let response: Response;
  let data: unknown;
  try {
    response = await transport.request(peerHostId, "memberSeats", {
      headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      signal: AbortSignal.timeout(input.op === "reserve" ? 8_000 : 2_000),
    });
    data = await response.json();
  } catch {
    throw new MemberSeatAuthorityPendingError();
  }
  if (access()?.writablePeer(peerHostId)?.fingerprint !== peer.fingerprint) throw new MemberSeatAuthorityPendingError();
  if (!response.ok) {
    const error = wireError.safeParse(data);
    switch (error.data?.error.code) {
      case "member_limit": throw new MemberLimitError(ctx.config.maxMembers ?? DEFAULT_MAX_MEMBERS);
      case "member_seat_invalid": throw new MemberSeatUnavailableError();
      default: throw new MemberSeatAuthorityPendingError();
    }
  }
  return data;
}

export async function askCreatorForSeat(
  ctx: HostContext, access: AccessTransport, operation: "reserve" | "confirm", memberId: string,
) {
  const creator = getHousehold(ctx.store.db, ctx.householdId)?.originHostId;
  if (!creator || creator === ctx.hostId) throw new AccessDeniedError();
  const data = await requestSeat(ctx, access, creator, { op: operation, member_id: memberId });
  if (!ok.safeParse(data).success) throw new MemberSeatAuthorityPendingError();
}

export async function refreshCreatorSeats(ctx: HostContext, access: AccessTransport) {
  const { householdId, store, clock } = ctx;
  const inspections = creatorSeatInspections(store.db, clock, householdId);
  // An unavailable peer leaves its grants allocated and its upgrade fence closed.
  await Promise.all([...inspections].map(async ([peerHostId, { legacy, memberIds }]) => {
    for (let offset = 0; offset < memberIds.length || offset === 0; offset += batchSize) {
      const batch = memberIds.slice(offset, offset + batchSize);
      const includeLegacy = legacy && offset === 0;
      let data: unknown;
      try {
        data = await requestSeat(ctx, access, peerHostId, { op: "inspect", legacy: includeLegacy, member_ids: batch });
      } catch (error) {
        if (error instanceof MemberSeatAuthorityPendingError) return;
        throw error;
      }
      const parsed = inspected.safeParse(data);
      if (!parsed.success || parsed.data.retired.some((memberId) => !batch.includes(memberId))) return;
      recordCreatorSeatInspection(store.db, clock, { householdId, peerHostId }, {
        retired: parsed.data.retired, legacyMemberIds: includeLegacy ? parsed.data.legacyMemberIds : undefined,
      });
    }
  }));
}

export function memberSeatPeerHandler(ctx: HostContext, access: AccessTransport) {
  return async (request: Request, actor: PeerActor) => {
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return responseError("invalid_request", 400);
    const input = parsed.data;
    const { householdId, hostId, store, clock } = ctx;
    try {
      const creator = getHousehold(store.db, householdId)?.originHostId;
      const currentlyPaired = () => access()?.writablePeer(actor.hostId)?.fingerprint === actor.fingerprint;
      if (actor.access !== "read_write" || actor.householdId !== householdId || !creator || !currentlyPaired()) {
        throw new AccessDeniedError();
      }
      if (input.op === "inspect") {
        return Response.json(inspectJoinedMemberSeats(store.db, clock, householdId, {
          creatorHostId: actor.hostId, memberIds: input.member_ids, legacy: input.legacy,
        }));
      }
      if (creator !== hostId || actor.hostId === creator) throw new AccessDeniedError();
      const seat = { householdId, peerHostId: actor.hostId, memberId: input.member_id };
      const maxMembers = ctx.config.maxMembers ?? DEFAULT_MAX_MEMBERS;
      if (input.op === "reserve") {
        await refreshCreatorSeats(ctx, access);
        if (!currentlyPaired()) throw new AccessDeniedError();
        reserveJoinedMemberSeat(store.db, clock, seat, maxMembers);
      } else {
        confirmJoinedMemberSeat(store.db, clock, seat, maxMembers);
      }
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof AccessDeniedError) return responseError("forbidden", 403);
      if (error instanceof MemberLimitError) return responseError("member_limit", 409);
      if (error instanceof MemberSeatUnavailableError) return responseError("member_seat_invalid", 409);
      if (error instanceof MemberSeatAuthorityPendingError) return responseError("member_seat_authority_pending", 503);
      throw error;
    }
  };
}
