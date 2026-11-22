import { z } from "zod";
import type { JobRunner } from "../jobs/index.ts";
import { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import type { PeerTransport } from "../peer/index.ts";
import { typedPeerTransport } from "../replication/peer-http.ts";
import { replySchema } from "../replication/peer-types.ts";
import type { ReplicationCursor } from "../replication/types.ts";
import type { HostContext } from "../runtime/index.ts";
import { changePageSchema } from "../store/replication.ts";
import {
  admitRelayPublication, publishRelay, readRelayCursor, readRelayGrant, relayDue, relayKey, reviewRelayMandate,
} from "../store/relay.ts";
import type { RemoteRelayProof } from "../store/relay.ts";

const relayPayload = z.strictObject({
  grant_id: z.uuidv7(),
  source_generation: z.uuidv4(),
  source_seq: z.int().positive(),
});

const changesReply = replySchema(z.strictObject({
  status: z.literal("changes"),
  page: changePageSchema,
}));

export class RelayService {
  readonly peer: PeerBehaviorChannel;

  constructor(private readonly transport: () => PeerTransport | undefined, jobs: JobRunner, channel?: PeerBehaviorChannel) {
    this.peer = channel ?? new PeerBehaviorChannel(transport);
    if (!channel) this.peer.registerDelivery(jobs);
    this.peer.register("relay", {
      payload: relayPayload,
      inspect(db, { direction, envelope, sourceHostId, payload }) {
        const { source } = envelope;
        if (source.kind !== "message" || envelope.idempotency_key !== relayKey(source.id)) {
          return "rejected";
        }
        // The durable grant and its source-log watermark both have to exist.
        const grant = readRelayGrant(db, payload.grant_id);
        const cursor = direction === "outbound"
          ? readRelayCursor(db, sourceHostId, sourceHostId) : readRelayCursor(db, envelope.target_host_id, sourceHostId);
        if (!grant) {
          return cursor?.generation === payload.source_generation && cursor.seq >= payload.source_seq ? "rejected" : "waiting";
        }
        if (grant.originHostId !== sourceHostId || grant.householdId !== envelope.household_id
          || grant.targetHostId !== envelope.target_host_id || grant.sourceMessageId !== source.id || grant.sourceRevision !== source.rev
          || grant.sourceGeneration !== payload.source_generation || grant.sourceSeq !== payload.source_seq) {
          return "rejected";
        }
        if (!cursor || cursor.seq < grant.sourceSeq && cursor.generation === grant.sourceGeneration) {
          return "waiting";
        }
        if (cursor.generation !== grant.sourceGeneration) {
          return "rejected";
        }
        const reviewed = reviewRelayMandate(db, grant);
        return !("reason" in reviewed) && reviewed.urgent === grant.urgent ? "ready" : "rejected";
      },
      admit: (tx, clock, { envelope, payload }) =>
        admitRelayPublication(tx, clock, payload.grant_id, envelope.target_host_id),
    });
  }

  async publishPending(ctx: HostContext, signal: AbortSignal): Promise<void> {
    const verified = new Map<string, RemoteRelayProof | null>();
    for (const { id } of relayDue(ctx)) {
      signal.throwIfAborted();
      const pending = publishRelay(ctx, id);
      if (!pending) {
        continue;
      }
      const key = JSON.stringify(pending.cursor);
      if (!verified.has(key)) {
        verified.set(key, await this.verifyRemote(ctx, pending.cursor, signal));
      }
      signal.throwIfAborted();
      publishRelay(ctx, id, verified.get(key) ?? null);
    }
  }

  private async verifyRemote(
    ctx: HostContext, cursor: ReplicationCursor, signal: AbortSignal,
  ): Promise<RemoteRelayProof | null> {
    const transport = this.transport();
    const peer = transport?.writablePeer(cursor.sourceHostId);
    if (!transport || peer?.householdId !== ctx.householdId) {
      return null;
    }
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
    const remote = await typedPeerTransport(transport, cursor.sourceHostId).readChanges({ cursor, limit: 1 }, timeout)
      .catch(() => null);
    const parsed = changesReply.safeParse(remote);
    if (!parsed.success) {
      return null;
    }
    const { source, data: { page } } = parsed.data;
    const same = (value: ReplicationCursor) => value.sourceHostId === cursor.sourceHostId
      && value.generation === cursor.generation && value.seq === cursor.seq;
    if (source.householdId !== ctx.householdId || source.sourceHostId !== cursor.sourceHostId
      || source.generation !== cursor.generation || !same(page.from) || !same(page.next)
      || page.hasMore || page.changes.length) {
      return null;
    }
    return {
      cursor,
      isStillPaired: () => {
        const current = transport.writablePeer(cursor.sourceHostId);
        return current?.fingerprint === peer.fingerprint && current.protocolVersion === peer.protocolVersion
          && current.householdId === peer.householdId;
      },
    };
  }
}
