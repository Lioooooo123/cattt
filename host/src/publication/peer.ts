import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ChatEvents } from "../chat-events/index.ts";
import type { PeerTransport } from "../peer/index.ts";
import { peerHostId } from "../peer/protocol.ts";
import type { PeerActor } from "../peer/protocol.ts";
import type { HostContext } from "../runtime/index.ts";
import { getHousehold } from "../store/identity.ts";
import { ensureWorld, readWorld } from "../store/world-state.ts";
import { WorldError } from "../world/protocol.ts";
import { WORLD_PEER_VERSION } from "../world/presence.ts";
import {
  acceptPublicationTransfer, acknowledgePublicationTransfer, beginPublicationRenewal, issuePublicationRenewal,
  preparePublicationTransfer, publicationPeer, publicationPeerBinding, publicationProof, requireSharedPublisher,
} from "../store/publication.ts";
import {
  handoffReceiptSchema, PUBLICATION_WIRE_VERSION, PublicationLeaseError,
  publicationRequestSchema, renewalReceiptSchema, REQUEST_TIMEOUT_MS, RETRY_MS, transferRequestSchema,
} from "./types.ts";
import type { PublicationProof, RenewalRequest } from "./types.ts";
import type { LeaseStart } from "./window.ts";

const MAX_REQUEST_BYTES = 4096;

function errorResponse(code: string, status: number) {
  return Response.json({ error: { code } }, { status });
}

export function createPublicationPeer(
  ctx: HostContext, transport: PeerTransport, fingerprint: () => string, canUseProtocol: (version: number) => boolean,
  report: (error: unknown) => void,
) {
  const { db } = ctx.store;
  const window = ctx.publication;
  const lifetime = new AbortController();
  let inflight: Promise<void> | undefined;
  let pending: { request: RenewalRequest; binding: string; started: LeaseStart } | undefined;
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

  function localPeer() {
    const peer = publicationPeer(db, ctx.householdId);
    if (peer && peer.confirmedLocalFingerprint === fingerprint() && canUseProtocol(peer.protocolVersion)) return peer;
    return undefined;
  }

  function sameProof(left: PublicationProof, right?: PublicationProof) {
    return left.epoch === right?.epoch && left.grantId === right.grantId && left.holderHostId === right.holderHostId;
  }

  async function renew() {
    const proof = publicationProof(db, ctx.householdId);
    const peer = localPeer();
    if (!proof || proof.holderHostId !== ctx.hostId || !peer) {
      window.clear();
      pending = undefined;
      return;
    }
    const binding = publicationPeerBinding(peer);
    if (!window.renewalDue(proof, binding)) return;
    if (!pending || pending.binding !== binding || pending.request.epoch !== proof.epoch
      || pending.request.household_id !== proof.householdId || window.elapsed(pending.started) >= REQUEST_TIMEOUT_MS) {
      const started = window.start();
      const request = beginPublicationRenewal(db, proof, binding);
      if (!request) return;
      pending = { request, binding, started };
    }
    const attempt = pending;
    const request = attempt.request;
    try {
      const response = await transport.request(peer.hostId, "lease", {
        signal: signal(), headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: PUBLICATION_WIRE_VERSION, operation: "renew", renewal: request }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const receipt = renewalReceiptSchema.safeParse((await response.json())?.receipt);
      const latestPeer = localPeer();
      if (!receipt.success || receipt.data.holder_host_id !== ctx.hostId
        || receipt.data.household_id !== request.household_id || receipt.data.epoch !== request.epoch
        || receipt.data.grant_id !== request.grant_id || receipt.data.sequence !== request.sequence
        || receipt.data.request_id !== request.request_id || lifetime.signal.aborted
        || !sameProof(proof, publicationProof(db, ctx.householdId)) || !latestPeer
        || publicationPeerBinding(latestPeer) !== binding) return;
      window.install(proof, binding, attempt.started);
      pending = undefined;
    } catch {
      // Once the current window expires, lack of a receipt is a waiting state.
    }
  }

  function refresh() {
    if (!inflight && !lifetime.signal.aborted && !ctx.config.accessPaused?.()) {
      inflight = renew().catch(report).finally(() => { inflight = undefined; });
    }
  }

  async function receive(request: Request, actor: PeerActor) {
    try {
      const payload = publicationRequestSchema.safeParse(await request.json().catch(() => null));
      if (!payload.success) return errorResponse("invalid_request", 400);
      const body = payload.data;
      if (body.operation === "renew") {
        return Response.json({ receipt: issuePublicationRenewal(db, actor, fingerprint(), body.renewal) });
      }
      const receipt = acceptPublicationTransfer(db, actor, ctx.hostId, fingerprint(), body.receipt);
      refresh();
      return Response.json({ receipt });
    } catch (error) {
      if (error instanceof PublicationLeaseError) return errorResponse(error.code, 409);
      throw error;
    }
  }

  const admin = new Hono();
  admin.post("/peers/:id/lease", bodyLimit({
    maxSize: MAX_REQUEST_BYTES, onError: () => errorResponse("payload_too_large", 413),
  }), async (c) => {
    const parsed = transferRequestSchema.safeParse(await c.req.json().catch(() => null));
    const peerHost = peerHostId.safeParse(c.req.param("id"));
    if (!parsed.success || !peerHost.success) return errorResponse("invalid_request", 400);
    const { request_id, expected_epoch } = parsed.data;
    let prepared: ReturnType<typeof preparePublicationTransfer>;
    try {
      const peer = localPeer();
      if (!peer || peer.hostId !== peerHost.data) return errorResponse("publication_peer_ineligible", 409);
      prepared = new ChatEvents(ctx).write((tx, append) => preparePublicationTransfer(
        tx, ctx.clock, ctx.householdId, ctx.hostId, peerHost.data, fingerprint(), request_id, expected_epoch, append,
        (transfer, current) => {
          if (peer.protocolVersion >= WORLD_PEER_VERSION && getHousehold(transfer, ctx.householdId)?.originHostId === ctx.hostId
            && !readWorld(transfer, ctx.householdId)) {
            ensureWorld(transfer, ctx.clock, requireSharedPublisher(transfer, ctx.householdId, window, current));
          }
        },
      ));
    } catch (error) {
      if (error instanceof PublicationLeaseError) return errorResponse(error.code, 409);
      if (error instanceof WorldError) return errorResponse("publication_history_pending", 409);
      throw error;
    }
    const receipt = prepared.receipt;
    if (prepared.acknowledged) return c.json({ receipt });

    try {
      const response = await transport.request(peerHost.data, "lease", {
        signal: signal(), headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: PUBLICATION_WIRE_VERSION, operation: "accept", receipt }),
      });
      const body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status === 409 && (code === "publication_history_pending" || code === "publication_epoch_conflict"
          || code === "publication_request_conflict" || code === "publication_peer_ineligible")) {
          return errorResponse(code, 409);
        }
        return errorResponse("peer_connection_failed", 502);
      }
      const accepted = handoffReceiptSchema.parse(body?.receipt);
      if (JSON.stringify(accepted) !== JSON.stringify(receipt)) return errorResponse("peer_connection_failed", 502);
    } catch {
      return errorResponse("peer_connection_failed", 502);
    }
    acknowledgePublicationTransfer(db, receipt);
    return c.json({ receipt });
  });

  const timer = setInterval(refresh, RETRY_MS);
  refresh();
  return {
    admin, receive, refresh,
    async stop() {
      clearInterval(timer);
      lifetime.abort();
      window.clear();
      await inflight;
    },
  };
}
