import { createHash } from "node:crypto";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, item]) => [key, sorted(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function textSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Legacy IDs are immutable. Timestamp bits describe creation, entropy comes
 * from the legacy scope/type/ID, and message order is carried separately. */
export function mappedId(scope: string, type: string, key: string, createdAt: number): string {
  const head = createdAt.toString(16).padStart(12, "0");
  const tail = sha256([scope, type, key]);
  const variant = (8 + (Number.parseInt(tail[3]!, 16) % 4)).toString(16);
  return `${head.slice(0, 8)}-${head.slice(8)}-7${tail.slice(0, 3)}-${variant}${tail.slice(4, 7)}-${tail.slice(7, 19)}`;
}
