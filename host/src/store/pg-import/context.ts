import { encodeHlc, ManualClock } from "../../clock/index.ts";
import { ImportError } from "../../import-pg/snapshot.ts";
import type { LegacyRow, PgSnapshot, SourceTable } from "../../import-pg/snapshot.ts";
import { mappedId } from "../../import-pg/values.ts";
import type { ReplicationTx } from "../replication-adapter.ts";
import { ImportAudit } from "./audit.ts";

export type Data = LegacyRow["data"];
export const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export const dictionary = (value: unknown): Data | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
export const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
export const integer = (value: unknown): number => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new ImportError("旧数据含目标无法表示的整数");
};
export function millis(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffffffff) {
    throw new ImportError("旧数据含目标无法表示的日期");
  }
  return time;
}
export const optionalMillis = (value: unknown) => value === null || value === undefined ? null : millis(value);
export const validZone = (name: string) => {
  try { new Intl.DateTimeFormat("en", { timeZone: name }); return true; } catch { return false; }
};

export function importContext(tx: ReplicationTx, snapshot: PgSnapshot) {
  const { userId, conversationId } = snapshot;
  const user = snapshot.tables.users.rows[0]!;
  const createdAt = millis(user.data.created_at);
  const id = (type: string, key: string, at = createdAt) => mappedId(userId, type, key, at);
  const hostId = id("host", userId);
  const householdId = id("household", userId);
  const memberId = id("member", userId);
  const conversation = snapshot.tables.conversations.rows[0];
  const directAt = conversation ? millis(conversation.data.created_at) : createdAt;
  const directId = id("direct", conversationId ?? userId, directAt);
  const groupId = id("group", userId);
  const scope = { householdId, conversationId: directId, publisherHostId: hostId, forMemberId: memberId };
  const timeZone = string(user.data.time_zone);
  if (!timeZone || !validZone(timeZone)) throw new ImportError("旧账号时区无效");

  const streams = new Map<string, ManualClock>();
  function business(type: string, key: string, createdAt: number, updatedAt = createdAt, rev = 1, idOverride?: string) {
    let clock = streams.get(type);
    if (!clock) {
      clock = new ManualClock(hostId);
      streams.set(type, clock);
    }
    clock.setWallMs(Math.max(createdAt, updatedAt));
    return { id: idOverride ?? id(type, key, createdAt), originHostId: hostId, hlc: encodeHlc(clock.hlc()),
      rev, createdAt, updatedAt, deletedAt: null };
  }

  const rows = (table: SourceTable) => snapshot.tables[table].rows;
  return { tx, user, snapshot, id, business, rows, hostId, householdId, memberId, directId, groupId, directAt, timeZone, scope,
    audit: new ImportAudit(tx, snapshot) };
}

export type ImportContext = ReturnType<typeof importContext>;
