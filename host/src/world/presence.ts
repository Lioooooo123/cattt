import { z } from "zod";
import type { PeerTransport } from "../peer/index.ts";
import type { PeerActor } from "../peer/protocol.ts";
import type { HostContext } from "../runtime/index.ts";
import { getHouseholdMember } from "../store/identity.ts";
import { publicationPeer } from "../store/publication.ts";
import { localPresence } from "../store/world.ts";

export const WORLD_PEER_VERSION = 7;
const presenceRow = z.strictObject({ member_id: z.uuidv7() });
const payload = z.strictObject({ presence: z.array(presenceRow).max(32) });
type Presence = z.infer<typeof presenceRow>[];

export function peerWorldPresence(ctx: HostContext, actor: PeerActor) {
  if (actor.householdId !== ctx.householdId || actor.access !== "read_write" || actor.protocolVersion < WORLD_PEER_VERSION) {
    return Response.json({ error: { code: "peer_upgrade_required" } }, { status: 403 });
  }
  return Response.json({ presence: localPresence(ctx.store.db, actor.householdId, ctx.clock.wallMs()) });
}

/** Short-lived peer observations, kept outside SQLite and both data projections. */
export function worldPresence(ctx: HostContext, transport: () => PeerTransport | undefined, stopped: AbortSignal) {
  let cache: { binding: string; expires: number; request: Promise<Presence> } | undefined;

  async function pull(connection: PeerTransport, hostId: string) {
    try {
      const response = await connection.request(hostId, "worldPresence", {
        signal: AbortSignal.any([stopped, AbortSignal.timeout(700)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return [];
      }
      return payload.parse(await response.json()).presence;
    } catch {
      return [];
    }
  }

  return async (local: Presence, householdId: string): Promise<Presence> => {
    const peer = publicationPeer(ctx.store.db, householdId);
    const connection = transport();
    const actor = peer && connection?.writablePeer(peer.hostId);
    if (!connection || !actor || actor.protocolVersion < WORLD_PEER_VERSION || stopped.aborted) return local;
    const binding = JSON.stringify([actor.hostId, actor.fingerprint, peer.approvalId]);
    const now = performance.now();
    if (!cache || cache.binding !== binding || cache.expires <= now) {
      cache = { binding, expires: now + 1_500, request: pull(connection, actor.hostId) };
    }
    const remote = await cache.request;
    const latest = publicationPeer(ctx.store.db, householdId);
    const valid = !stopped.aborted && latest?.hostId === actor.hostId
      && latest.fingerprint === actor.fingerprint && latest.approvalId === peer.approvalId
      && !!connection.writablePeer(actor.hostId);
    const rows = valid ? [...local, ...remote] : local;
    return [...new Set(rows.map(({ member_id }) => member_id))].sort()
      .filter((id) => getHouseholdMember(ctx.store.db, householdId, id)).map((member_id) => ({ member_id }));
  };
}
