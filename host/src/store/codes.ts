import { createHash, randomBytes } from "node:crypto";
import { and, gt, isNull, lt, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const CODE_MAX_FAILURES = 5;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function normalizeCode(code: string): string | undefined {
  if (code.length > 64) {
    return undefined;
  }
  const normalized = code.replace(/-/g, "").toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalized) ? normalized : undefined;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function generateCode(exists: (hash: string) => boolean) {
  let raw: string;
  let codeHash: string;
  do {
    raw = [...randomBytes(8)].map((byte) => ALPHABET[byte & 31]).join("");
    codeHash = hashCode(raw);
  } while (exists(codeHash));
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, codeHash };
}

interface CodeColumns {
  usedAt: AnySQLiteColumn;
  expiresAt: AnySQLiteColumn;
  failures: AnySQLiteColumn;
  revokedAt?: AnySQLiteColumn;
}

export function liveCode(columns: CodeColumns, now: number) {
  return and(
    isNull(columns.usedAt), gt(columns.expiresAt, now), lt(columns.failures, CODE_MAX_FAILURES),
    columns.revokedAt ? isNull(columns.revokedAt) : undefined,
  );
}

export function failedCode(columns: CodeColumns) {
  return { failures: sql`${columns.failures} + 1` };
}
