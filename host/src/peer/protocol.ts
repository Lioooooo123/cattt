import { isIPv4 } from "node:net";
import { z } from "zod";

export const PEER_VERSION_HEADER = "x-cattt-peer-version";
export const DEFAULT_PEER_PROTOCOL: PeerProtocol = { version: 9, readOnlyVersions: [] };

export interface PeerProtocol {
  readonly version: number;
  readonly readOnlyVersions: readonly number[];
}

export type PeerAccess = "read_write" | "read_only";

export class PeerProtocolError extends Error {}

export function peerAccess(protocol: PeerProtocol, remote: number): PeerAccess | undefined {
  if (protocol.version === remote) {
    return "read_write";
  }
  return protocol.readOnlyVersions.includes(remote) ? "read_only" : undefined;
}

export interface PeerActor {
  readonly hostId: string;
  readonly householdId: string;
  readonly fingerprint: string;
  readonly protocolVersion: number;
  readonly access: PeerAccess;
}

export type PeerHandlers = Partial<Record<PeerOperation, PeerHandler>>;
type PeerHandler = (request: Request, actor: PeerActor) => Response | Promise<Response>;

export const peerOperations = {
  changes: { method: "GET", path: "/peer/changes" },
  worldPresence: { method: "GET", path: "/peer/world-presence" },
  typedChanges: { method: "GET", path: "/peer/changes/typed" },
  blob: { method: "GET", path: "/peer/blobs/:sha256" },
  inbox: { method: "POST", path: "/peer/inbox" },
  lease: { method: "POST", path: "/peer/lease" },
  memberSeats: { method: "POST", path: "/peer/member-seats" },
} as const;
export type PeerOperation = keyof typeof peerOperations;

export const peerHostId = z.uuidv7();
export const peerFingerprint = z.string().regex(/^[0-9a-f]{64}$/);
export const peerVersion = z.number().int().positive();
const pem = z.string().min(1).max(8192);

export function isPeerAddress(host: string): boolean {
  if (host === "localhost" || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(host)) {
    return host.length <= 253;
  }
  if (!isIPv4(host)) {
    return false;
  }
  const [first, second] = host.split(".").map(Number);
  return first === 10 || first === 127 || (first === 192 && second === 168)
    || (first === 169 && second === 254) || (first === 172 && second! >= 16 && second! <= 31);
}

export const peerDescriptor = z.strictObject({
  host_id: peerHostId,
  household_id: peerHostId,
  protocol_version: peerVersion,
  fingerprint: peerFingerprint,
  ca_certificate: pem,
  certificate: pem,
  address: z.strictObject({
    host: z.string().refine(isPeerAddress),
    port: z.number().int().min(1).max(65535),
  }),
});
export type PeerDescriptor = z.infer<typeof peerDescriptor>;

export const peerHello = peerDescriptor.pick({
  host_id: true, household_id: true, protocol_version: true, fingerprint: true,
});
export type PeerHello = z.infer<typeof peerHello>;
export const peerHelloRequest = peerHello.extend({ join_from_household_id: peerHostId.optional() });

export const householdSeed = z.strictObject({
  id: peerHostId,
  name: z.string().min(1).max(255).refine((name) => name.trim().length > 0),
  origin_host_id: peerHostId,
  hlc: z.string().min(1).max(256),
  rev: z.number().int().positive(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});
export type HouseholdSeed = z.infer<typeof householdSeed>;
export const peerHelloReply = peerHello.extend({ household: householdSeed.optional() });
