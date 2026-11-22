import { createHash } from "node:crypto";
import { z } from "zod";
import { peerFingerprint, peerHostId, peerVersion } from "../peer/protocol.ts";
import { businessFields } from "../replication/types.ts";

export const PEER_INBOX_VERSION = 1;
export const MAX_BEHAVIOR_BYTES = 16 * 1024;
export const MAX_RECEIPT_BYTES = 2 * 1024;

export const behaviorKind = z.enum(["group_speak", "relay", "memory_action"]);
export type PeerBehaviorKind = z.infer<typeof behaviorKind>;

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const sourceReference = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  id: peerHostId,
  rev: z.number().int().positive(),
});
// Preserve all JSON keys for the idempotency hash. The registered schema validates the fields.
const payload = z.custom<Record<string, unknown>>((value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0,
);

export const behaviorEnvelope = z.strictObject({
  inbox_version: peerVersion,
  household_id: peerHostId,
  target_host_id: peerHostId,
  idempotency_key: idempotencyKey,
  kind: behaviorKind,
  source: sourceReference,
  payload,
});
export type PeerBehaviorEnvelope = z.infer<typeof behaviorEnvelope>;

export interface PeerBehaviorDraft {
  targetHostId: string;
  idempotencyKey: string;
  kind: PeerBehaviorKind;
  source: z.infer<typeof sourceReference>;
  payload: Record<string, unknown>;
}

export const peerReceipt = z.strictObject({
  inbox_version: peerVersion,
  receipt_id: peerHostId,
  admission_id: peerHostId,
  household_id: peerHostId,
  source_host_id: peerHostId,
  target_host_id: peerHostId,
  idempotency_key: idempotencyKey,
  request_hash: peerFingerprint,
  accepted_at: z.number().int().nonnegative(),
  memory_write: z.strictObject({
    revision: z.int().positive(),
    hlc: businessFields.hlc,
  }).optional(),
});
export type PeerReceipt = z.infer<typeof peerReceipt>;

const behaviorErrors = {
  peer_invalid_request: 400,
  peer_target_or_actor_invalid: 403,
  peer_inbox_version_unsupported: 409,
  peer_idempotency_conflict: 409,
  peer_source_pending: 409,
  peer_publication_stale: 409,
  peer_payload_too_large: 413,
  peer_behavior_unsupported: 422,
  peer_behavior_rejected: 422,
  peer_memory_source_unavailable: 409,
  peer_memory_revision_conflict: 409,
} as const;
export type PeerInboxError = keyof typeof behaviorErrors;

export function inboxError(code: PeerInboxError): Response {
  return Response.json({ error: { code } }, { status: behaviorErrors[code] });
}

const terminalInboxError = z.strictObject({
  error: z.strictObject({ code: z.enum([
    "peer_invalid_request", "peer_idempotency_conflict", "peer_payload_too_large",
    "peer_behavior_unsupported", "peer_behavior_rejected", "peer_publication_stale",
    "peer_memory_source_unavailable", "peer_memory_revision_conflict",
  ]) }),
});

export function inboxRejection(status: number, body: unknown): PeerInboxError | undefined {
  const error = terminalInboxError.safeParse(body);
  if (error.success && status === behaviorErrors[error.data.error.code]) {
    return error.data.error.code;
  }
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) {
    throw new RangeError("Peer 行为 JSON 嵌套过深");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (typeof value !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Peer 行为负载必须为 JSON");
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`).join(",")}}`;
}

export function encodeEnvelope(envelope: PeerBehaviorEnvelope) {
  const body = canonicalJson(envelope);
  if (Buffer.byteLength(body, "utf8") > MAX_BEHAVIOR_BYTES) {
    throw new RangeError("Peer 行为负载过大");
  }
  const requestHash = createHash("sha256").update(body).digest("hex");
  return { body, requestHash };
}

export class PeerBodyTooLarge extends Error {}

export async function readPeerJson(input: Request | Response, maxBytes: number): Promise<unknown> {
  const reader = input.body?.getReader();
  if (!reader) {
    throw new Error("Peer JSON 正文缺失");
  }
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  let ended = false;
  try {
    if (Number(input.headers.get("content-length")) > maxBytes) {
      throw new PeerBodyTooLarge();
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        break;
      }
      if (length + chunk.value.length > maxBytes) {
        throw new PeerBodyTooLarge();
      }
      bytes.set(chunk.value, length);
      length += chunk.value.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    if (!ended) {
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

export function matchesPeerReceipt(
  receipt: PeerReceipt,
  envelope: PeerBehaviorEnvelope,
  sourceHostId: string,
  requestHash: string,
): boolean {
  return receipt.inbox_version === envelope.inbox_version
    && receipt.household_id === envelope.household_id
    && receipt.source_host_id === sourceHostId
    && receipt.target_host_id === envelope.target_host_id
    && receipt.idempotency_key === envelope.idempotency_key
    && receipt.request_hash === requestHash;
}
