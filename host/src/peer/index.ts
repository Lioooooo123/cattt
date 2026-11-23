import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { parseHlc } from "../clock/index.ts";
import { CertificateError, initializePeerIdentity, validatePeerCertificates } from "../identity/peer-tls.ts";
import type { HostContext } from "../runtime/index.ts";
import { getHousehold } from "../store/identity.ts";
import {
  approvePeer, confirmPeer, getPeer, joinPeerHousehold, listPeers, peerForCertificate,
  PeerHouseholdConflict, preparePeerJoin, requirePristineHousehold, revokePeer, setPeerPullPaused,
} from "../store/peers.ts";
import type { PeerRecord } from "../store/peers.ts";
import { listenPeerHttps, requestPeerHttps } from "./https.ts";
import type { PeerRequestOptions } from "./https.ts";
import {
  DEFAULT_PEER_PROTOCOL, PEER_VERSION_HEADER, peerAccess, peerDescriptor, peerFingerprint,
  peerHelloReply, peerHelloRequest, peerHostId, peerOperations, PeerProtocolError, peerVersion,
} from "./protocol.ts";
import type { PeerActor, PeerDescriptor, PeerHandlers, PeerHello, PeerOperation, PeerProtocol } from "./protocol.ts";

export type { PeerActor, PeerHandlers, PeerOperation, PeerProtocol } from "./protocol.ts";
export type { PeerRequestOptions } from "./https.ts";

export interface PeerTransport {
  writablePeer(peerHostId: string): PeerActor | undefined;
  request(peerHostId: string, operation: PeerOperation, options?: PeerRequestOptions): Promise<Response>;
}

export interface PeerServiceAccess {
  transport: PeerTransport;
  protocol: PeerProtocol;
  fingerprint(): string;
  compatiblePeers(): PeerRecord[];
}

export type PeerStateChange =
  | { type: "paired"; hostId: string }
  | { type: "updated" | "revoked" | "identity_rotated" | "activated" };

export interface PeerServices {
  handlers: PeerHandlers;
  admin?: Hono;
  syncStatus?(peer: PeerRecord, paired: boolean, compatible: boolean): unknown;
  canRequest?(operation: PeerOperation, peer: PeerRecord): boolean;
  onChange?(change: PeerStateChange): void;
  stop?(): Promise<void>;
}

const approval = z.strictObject({ identity: peerDescriptor, confirmed_fingerprint: peerFingerprint });
const maxApprovalBytes = 24 * 1024;
const limitBody = (maxSize: number) => bodyLimit({
  maxSize, onError: () => errorResponse("payload_too_large", 413),
});

function errorResponse(code: string, status: number) {
  return Response.json({ error: { code } }, { status });
}

export async function startPeerService(ctx: HostContext, options: {
  port: number;
  hostname: string;
  advertisedHost: () => string;
  configure(access: PeerServiceAccess): PeerServices;
  protocol?: PeerProtocol;
  report(error: unknown): void;
}) {
  const { db } = ctx.store;
  const clock = ctx.clock;
  const protocol = options.protocol ?? DEFAULT_PEER_PROTOCOL;
  if (!peerVersion.safeParse(protocol.version).success
    || protocol.readOnlyVersions.some((version) => !peerVersion.safeParse(version).success)) {
    throw new RangeError("Peer 协议版本必须是正整数");
  }
  const identity = await initializePeerIdentity(ctx.config.dataDir, clock, ctx.hostId);
  let services: PeerServices | undefined;
  const app = new Hono<{ Bindings: { fingerprint: string } }>();
  app.use("*", async (c, next) => {
    if (ctx.config.accessPaused?.()) {
      // Maintenance is transient; peers still validate the negotiated wire version.
      return c.json({ error: { code: "maintenance" } }, 503, {
        [PEER_VERSION_HEADER]: String(protocol.version),
      });
    }
    await next();
    c.header(PEER_VERSION_HEADER, String(protocol.version));
  });
  app.notFound(() => errorResponse("not_found", 404));
  app.onError((error) => {
    options.report(error);
    return errorResponse("internal_error", 500);
  });
  const ownHello = (): PeerHello => ({
    host_id: ctx.hostId, household_id: ctx.householdId, protocol_version: protocol.version,
    fingerprint: identity.current().fingerprint,
  });

  const isConfirmed = (peer: PeerRecord) => peer.confirmedAt !== null
    && peer.confirmedLocalFingerprint === identity.current().fingerprint;
  const publicRecord = (peer: PeerRecord) => {
    const active = peer.revokedAt === null && isConfirmed(peer);
    const access = active ? peerAccess(protocol, peer.protocolVersion) ?? null : null;
    return {
      host_id: peer.hostId, household_id: peer.householdId, fingerprint: peer.fingerprint,
      address: { host: peer.addressHost, port: peer.addressPort }, protocol_version: peer.protocolVersion,
      status: peer.revokedAt !== null ? "revoked" : active ? "paired" : "approved",
      access,
      approved_at: peer.approvedAt, confirmed_at: active ? peer.confirmedAt : null, revoked_at: peer.revokedAt,
      sync: services?.syncStatus?.(peer, active, access !== null),
    };
  };

  app.post("/peer/hello", limitBody(4096), async (c) => {
    const parsed = peerHelloRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("invalid_request", 400);
    }
    const hello = parsed.data;
    const peer = peerForCertificate(db, ctx.householdId, c.env.fingerprint);
    if (!peer || hello.host_id !== peer.hostId || hello.fingerprint !== peer.fingerprint
      || hello.household_id !== ctx.householdId) {
      return errorResponse("peer_identity_mismatch", 403);
    }
    const access = peerAccess(protocol, hello.protocol_version);
    if (!access || (hello.join_from_household_id && access !== "read_write")) {
      return errorResponse("peer_protocol_unsupported", 409);
    }
    if (hello.join_from_household_id) {
      const household = getHousehold(db, ctx.householdId);
      if (peer.joinFromHouseholdId !== hello.join_from_household_id || household?.originHostId !== ctx.hostId) {
        return errorResponse("peer_join_not_approved", 403);
      }
      preparePeerJoin(db, clock, peer.hostId);
      return c.json({
        ...ownHello(),
        household: {
          id: household.id, name: household.name, origin_host_id: household.originHostId,
          hlc: household.hlc, rev: household.rev, created_at: household.createdAt, updated_at: household.updatedAt,
        },
      });
    }
    if (peer.joinFromHouseholdId !== null && peer.joinPreparedAt === null) {
      return errorResponse("peer_join_not_approved", 403);
    }
    confirmPeer(db, clock, peer, hello.protocol_version, identity.current().fingerprint);
    services?.onChange?.({ type: "paired", hostId: peer.hostId });
    return c.json(ownHello());
  });

  app.use(peerOperations.lease.path, limitBody(4096));
  app.use(peerOperations.memberSeats.path, limitBody(4096));
  for (const operation of Object.keys(peerOperations) as PeerOperation[]) {
    const route = peerOperations[operation];
    app.on(route.method, route.path, (c) => {
      const peer = peerForCertificate(db, ctx.householdId, c.env.fingerprint);
      if (!peer || !isConfirmed(peer)) {
        return errorResponse("peer_not_paired", 403);
      }
      const access = peerAccess(protocol, peer.protocolVersion);
      if (!access || c.req.header(PEER_VERSION_HEADER) !== String(peer.protocolVersion)) {
        return errorResponse("peer_protocol_unsupported", 409);
      }
      if (route.method === "POST" && access !== "read_write") {
        return errorResponse("peer_upgrade_required", 403);
      }
      if (operation === "blob" && !peerFingerprint.safeParse(c.req.param("sha256")).success) {
        return errorResponse("invalid_request", 400);
      }
      const handler = services?.handlers[operation];
      return handler ? handler(c.req.raw, {
        hostId: peer.hostId, householdId: peer.householdId, fingerprint: peer.fingerprint,
        protocolVersion: peer.protocolVersion, access,
      }) : errorResponse("not_found", 404);
    });
  }

  const currentPeers = () => listPeers(db, ctx.householdId);
  const listener = await listenPeerHttps({
    hostname: options.hostname, port: options.port, identity,
    trustedRoots: () => currentPeers().filter((peer) => peer.revokedAt === null).map((peer) => peer.caCertificate),
    isApproved: (fingerprint) => !!peerForCertificate(db, ctx.householdId, fingerprint),
    dispatch: (request, fingerprint) => app.fetch(request, { fingerprint }),
    report: options.report,
  });

  function verifiedApproval(input: z.infer<typeof approval>, householdId: string, joinFromHouseholdId: string | null) {
    const remote = input.identity;
    const validated = validatePeerCertificates(clock, remote.host_id, remote.certificate, remote.ca_certificate);
    if (remote.host_id === ctx.hostId || remote.fingerprint !== validated.fingerprint
      || input.confirmed_fingerprint !== validated.fingerprint || validated.fingerprint === identity.current().fingerprint) {
      throw new CertificateError("Peer 身份或管理员核对指纹不符");
    }
    return {
      hostId: remote.host_id, householdId, joinFromHouseholdId, fingerprint: validated.fingerprint,
      caCertificate: validated.caCertificate, protocolVersion: remote.protocol_version,
      addressHost: remote.address.host, addressPort: remote.address.port,
    };
  }

  async function exchangeHello(peer: ReturnType<typeof verifiedApproval>, previousHouseholdId?: string) {
    const local = identity.current();
    const response = await requestPeerHttps(local, peer, "POST", "/peer/hello", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...ownHello(), household_id: peer.householdId, join_from_household_id: previousHouseholdId,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Peer hello HTTP ${response.status}`);
    }
    const reply = peerHelloReply.parse(await response.json());
    if (reply.host_id !== peer.hostId || reply.household_id !== peer.householdId || reply.fingerprint !== peer.fingerprint
      || !peerAccess(protocol, reply.protocol_version) || local.fingerprint !== identity.current().fingerprint) {
      throw new Error("Peer hello 身份或协议不符");
    }
    return reply;
  }

  const admin = new Hono();
  admin.onError((error) => {
    if (error instanceof PeerHouseholdConflict) {
      return errorResponse("peer_household_conflict", 409);
    }
    if (error instanceof CertificateError) {
      return errorResponse("peer_certificate_invalid", 400);
    }
    throw error;
  });
  function descriptor() {
    const current = identity.current();
    return {
      ...ownHello(), ca_certificate: current.caCertificate, certificate: current.cert,
      address: { host: options.advertisedHost(), port: listener.port }, expires_at: current.expiresAt,
    };
  }
  // The descriptor exchanged by admins is a strict schema. Expiry is a separate metadata field.
  const descriptorResponse = () => {
    const { expires_at, ...value } = descriptor();
    return Response.json(value, { headers: { "x-cattt-peer-certificate-expires-at": String(expires_at) } });
  };
  admin.get("/peer-identity", descriptorResponse);
  admin.post("/peer-identity/rotate", async () => {
    await identity.rotate();
    services?.onChange?.({ type: "identity_rotated" });
    listener.reload(true);
    return descriptorResponse();
  });
  admin.get("/peers", (c) => c.json({ peers: currentPeers().map(publicRecord) }));
  admin.put("/peers/:id", limitBody(maxApprovalBytes), async (c) => {
    const parsed = approval.extend({ allow_join: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || c.req.param("id") !== parsed.data.identity.host_id) {
      return errorResponse("invalid_request", 400);
    }
    const input = parsed.data;
    const otherHousehold = input.identity.household_id !== ctx.householdId;
    if (otherHousehold && (!input.allow_join || getHousehold(db, ctx.householdId)?.originHostId !== ctx.hostId)) {
      return errorResponse("peer_household_conflict", 409);
    }
    const peer = verifiedApproval(input, ctx.householdId, otherHousehold ? input.identity.household_id : null);
    const saved = approvePeer(db, clock, peer);
    services?.onChange?.({ type: "updated" });
    listener.reload();
    return c.json({ peer: publicRecord(saved) });
  });
  admin.post("/peers/connect", limitBody(maxApprovalBytes), async (c) => {
    const parsed = approval.extend({ join_household: z.boolean().optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("invalid_request", 400);
    }
    const input = parsed.data;
    const localHousehold = ctx.householdId;
    const otherHousehold = input.identity.household_id !== localHousehold;
    const remote = verifiedApproval(input, input.identity.household_id, null);
    if (!peerAccess(protocol, remote.protocolVersion) || (otherHousehold && remote.protocolVersion !== protocol.version)) {
      return errorResponse("peer_protocol_unsupported", 409);
    }
    if (otherHousehold) {
      if (!input.join_household) {
        return errorResponse("peer_household_conflict", 409);
      }
      requirePristineHousehold(db, ctx.hostId, localHousehold);
      const seed = await exchangeHello(remote, localHousehold).then((reply) => {
        if (reply.protocol_version !== protocol.version || reply.household?.id !== remote.householdId
          || reply.household.origin_host_id !== remote.hostId) {
          throw new Error("Peer 家庭引导记录无效");
        }
        parseHlc(reply.household.hlc);
        return reply.household;
      }).catch(() => undefined);
      if (!seed) {
        return errorResponse("peer_connection_failed", 502);
      }
      joinPeerHousehold(db, clock, ctx.hostId, localHousehold, {
        id: seed.id, name: seed.name, originHostId: seed.origin_host_id, hlc: seed.hlc,
        rev: seed.rev, createdAt: seed.created_at, updatedAt: seed.updated_at, deletedAt: null,
      }, remote);
      ctx.householdId = remote.householdId;
    } else {
      approvePeer(db, clock, remote);
    }
    services?.onChange?.({ type: "updated" });
    listener.reload();
    const reply = await exchangeHello(remote).catch(() => undefined);
    const saved = getPeer(db, remote.hostId);
    const paired = reply && saved?.fingerprint === remote.fingerprint
      && confirmPeer(db, clock, saved, reply.protocol_version, identity.current().fingerprint);
    if (paired) {
      services?.onChange?.({ type: "paired", hostId: paired.hostId });
    }
    return paired ? c.json({ peer: publicRecord(paired) }) : errorResponse("peer_connection_failed", 502);
  });
  admin.put("/peers/:id/sync", limitBody(256), async (c) => {
    const id = peerHostId.safeParse(c.req.param("id"));
    const body = z.strictObject({ paused: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) {
      return errorResponse("invalid_request", 400);
    }
    const peer = setPeerPullPaused(db, ctx.householdId, id.data, body.data.paused);
    if (!peer) return errorResponse("peer_not_active", 404);
    services?.onChange?.({ type: "updated" });
    return c.json({ peer: publicRecord(peer) });
  });
  admin.delete("/peers/:id", (c) => {
    const id = peerHostId.safeParse(c.req.param("id"));
    if (!id.success) {
      return errorResponse("invalid_request", 400);
    }
    revokePeer(db, clock, ctx.householdId, id.data);
    services?.onChange?.({ type: "revoked" });
    listener.reload();
    return c.json({ ok: true });
  });

  const transport: PeerTransport = {
    writablePeer(peerHostId) {
      const peer = getPeer(db, peerHostId);
      if (peer?.householdId === ctx.householdId && peer.revokedAt === null && isConfirmed(peer)
        && peerAccess(protocol, peer.protocolVersion) === "read_write") {
        return {
          hostId: peer.hostId, householdId: peer.householdId, fingerprint: peer.fingerprint,
          protocolVersion: peer.protocolVersion, access: "read_write",
        };
      }
    },
    async request(peerHostId, operation, requestOptions = {}) {
      const peer = getPeer(db, peerHostId);
      if (!peer || peer.householdId !== ctx.householdId || peer.revokedAt !== null || !isConfirmed(peer)
        || services?.canRequest?.(operation, peer) === false) {
        throw new Error("Peer 尚未结对或已撤销");
      }
      const route = peerOperations[operation];
      const access = peerAccess(protocol, peer.protocolVersion);
      if (!access || (route.method === "POST" && access !== "read_write")) {
        throw new PeerProtocolError("Peer 协议不支持此操作，需要升级宿主");
      }
      const sha = operation === "blob" ? peerFingerprint.parse(requestOptions.sha256) : "";
      const headers = new Headers(requestOptions.headers);
      headers.set(PEER_VERSION_HEADER, String(protocol.version));
      const path = route.path.replace(":sha256", sha);
      const response = await requestPeerHttps(identity.current(), peer, route.method, path, { ...requestOptions, headers });
      if (response.headers.get(PEER_VERSION_HEADER) !== String(peer.protocolVersion)) {
        await response.body?.cancel();
        throw new PeerProtocolError("Peer 响应版本与上次握手不一致");
      }
      return response;
    },
  };
  const activate = () => services?.onChange?.({ type: "activated" });
  const stop = async () => {
    await Promise.all([services?.stop?.(), listener.stop()]);
  };
  try {
    services = options.configure({
      transport, protocol,
      fingerprint: () => identity.current().fingerprint,
      compatiblePeers: () => currentPeers().filter((peer) =>
        peer.revokedAt === null && isConfirmed(peer) && peerAccess(protocol, peer.protocolVersion) !== undefined),
    });
    if (services.admin) admin.route("/", services.admin);
    if (!ctx.config.accessPaused?.()) activate();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    admin, port: listener.port, transport, activate, stop,
  };
}
