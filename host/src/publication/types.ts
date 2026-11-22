import { z } from "zod";

export const PUBLICATION_WIRE_VERSION = 1;
export const PUBLICATION_PEER_VERSION = 2;
export const LEASE_MS = 30_000;
export const RENEW_AFTER_MS = 10_000;
export const RETRY_MS = 2_000;
export const REQUEST_TIMEOUT_MS = 3_000;
export const CLOCK_DIVERGENCE_MS = 2_000;

const hostId = z.uuidv7();
const grantId = z.uuid();
const requestId = z.uuidv4();
const epoch = z.int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const historyDigest = z.string().regex(/^[0-9a-f]{64}$/);

export const transferRequestSchema = z.strictObject({
  request_id: requestId,
  expected_epoch: epoch,
});

export const handoffReceiptSchema = z.strictObject({
  request_id: requestId,
  household_id: hostId,
  epoch: epoch.min(2),
  holder_host_id: hostId,
  previous_holder_host_id: hostId,
  previous_grant_id: grantId,
  history_digest: historyDigest,
});
export type HandoffReceipt = z.infer<typeof handoffReceiptSchema>;

export const renewalRequestSchema = z.strictObject({
  household_id: hostId,
  epoch,
  grant_id: grantId,
  sequence: z.int().positive(),
  request_id: requestId,
});
export type RenewalRequest = z.infer<typeof renewalRequestSchema>;

export const renewalReceiptSchema = renewalRequestSchema.extend({
  holder_host_id: hostId,
  ttl_ms: z.literal(LEASE_MS),
});

export const publicationRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    protocol_version: z.literal(PUBLICATION_WIRE_VERSION),
    operation: z.literal("renew"),
    renewal: renewalRequestSchema,
  }),
  z.strictObject({
    protocol_version: z.literal(PUBLICATION_WIRE_VERSION),
    operation: z.literal("accept"),
    receipt: handoffReceiptSchema,
  }),
]);

export interface PublicationFence {
  epoch: number;
  grantId: string;
}

export interface PublicationProof extends PublicationFence {
  householdId: string;
  holderHostId: string;
}

export type PublicationErrorCode =
  | "publication_lease_pending"
  | "not_publisher"
  | "publication_history_pending"
  | "publication_epoch_conflict"
  | "publication_peer_ineligible"
  | "publication_request_conflict";

export class PublicationLeaseError extends Error {
  constructor(public readonly code: PublicationErrorCode) {
    super(code);
    this.name = "PublicationLeaseError";
  }
}
