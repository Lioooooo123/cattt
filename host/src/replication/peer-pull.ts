import { z } from "zod";
import type { StoreDb } from "../store/index.ts";
import { applyReplicaSnapshot } from "../store/replication-snapshot.ts";
import { applyChangePage, changePageSchema, getPeerCursor, MAX_CHANGE_PAGE } from "../store/replication.ts";
import {
  PEER_SYNC_PROTOCOL_VERSION, replySchema, snapshotManifestSchema, snapshotRecordSchema,
} from "./peer-types.ts";
import type { PeerSyncIdentity, PeerSyncTransport } from "./peer-types.ts";
import { ReplicationError, replicationCursorSchema } from "./types.ts";
import type { ApplyPageResult, ReplicationCursor, ReplicationErrorCode, ReplicationSource } from "./types.ts";

export class PeerSyncTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerSyncTransportError";
  }
}

class RetryExhausted extends Error {
  constructor(cause: PeerSyncTransportError) {
    super("复制传输重试次数已用尽", { cause });
  }
}

export interface PeerPullOptions {
  pageSize?: number;
  maxChangePages?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

export type PeerPullResult =
  | { status: "caught_up" | "more"; cursor: ReplicationCursor; applied: number }
  | Extract<ApplyPageResult, { status: "waiting" }>
  | {
    status: "stopped";
    cursor: ReplicationCursor | null;
    reason: "aborted" | "retry_exhausted" | "replication_error" | "failure";
    code?: ReplicationErrorCode;
    message?: string;
  };

const manifestReplySchema = replySchema(snapshotManifestSchema);
const snapshotPageReplySchema = replySchema(z.strictObject({
  snapshotId: z.uuidv4(),
  offset: z.int().nonnegative(),
  records: z.array(snapshotRecordSchema).max(MAX_CHANGE_PAGE),
}));
const changesReplySchema = replySchema(z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("changes"), page: changePageSchema }),
  z.strictObject({ status: z.literal("reset_required"), head: replicationCursorSchema }),
]));

function boundedInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`复制参数无效：${name}`);
  }
  return value;
}

function sameStream(a: ReplicationCursor | ReplicationSource, b: ReplicationCursor | ReplicationSource) {
  return a.sourceHostId === b.sourceHostId && a.generation === b.generation;
}

function verifyCursor(cursor: ReplicationCursor, source: ReplicationSource) {
  if (cursor.sourceHostId !== source.sourceHostId) {
    throw new ReplicationError("source_mismatch", "复制游标属于另一来源宿主");
  }
  if (cursor.generation !== source.generation) {
    throw new ReplicationError("reset_required", "复制响应的游标世代已变化");
  }
}

async function attempt<T>(
  pullSignal: AbortSignal, timeoutMs: number, send: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  pullSignal.throwIfAborted();
  const deadline = new AbortController();
  const signal = AbortSignal.any([pullSignal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new PeerSyncTransportError("复制请求超时")), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return send(signal);
    }), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function createPeerPullClient(
  db: Pick<StoreDb, "select" | "transaction">, peer: PeerSyncIdentity,
  transport: PeerSyncTransport, options: PeerPullOptions = {},
) {
  const pageSize = boundedInteger(options.pageSize ?? 100, MAX_CHANGE_PAGE, "pageSize");
  const maxChangePages = boundedInteger(options.maxChangePages ?? 32, 100, "maxChangePages");
  const maxAttempts = boundedInteger(options.maxAttempts ?? 3, 5, "maxAttempts");
  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? 10_000, 60_000, "requestTimeoutMs");

  function parseReply<T extends { source: ReplicationSource }>(
    schema: z.ZodType<T>, wire: unknown, code: "invalid_page" | "invalid_snapshot",
  ): T {
    if (wire && typeof wire === "object" && "protocol_version" in wire
      && wire.protocol_version !== PEER_SYNC_PROTOCOL_VERSION) {
      throw new ReplicationError("unsupported_protocol", "不支持的快照或增量协议版本");
    }
    const parsed = schema.safeParse(wire);
    if (!parsed.success) {
      throw new ReplicationError(code, "快照或增量响应格式无效");
    }
    const { sourceHostId, householdId } = parsed.data.source;
    if (sourceHostId !== peer.sourceHostId || householdId !== peer.householdId) {
      throw new ReplicationError("source_mismatch", "响应的来源或家庭与已认证对端不匹配");
    }
    return parsed.data;
  }

  async function request<T>(signal: AbortSignal, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let remaining = maxAttempts; ; remaining--) {
      try {
        const result = await attempt(signal, requestTimeoutMs, send);
        signal.throwIfAborted();
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof PeerSyncTransportError)) {
          throw error;
        }
        if (remaining === 1) {
          throw new RetryExhausted(error);
        }
      }
    }
  }

  async function readChanges(cursor: ReplicationCursor, signal: AbortSignal) {
    const response = parseReply(changesReplySchema, await request(signal, (attemptSignal) =>
      transport.readChanges({ cursor, limit: pageSize }, attemptSignal)), "invalid_page");
    const { source, data } = response;
    if (data.status === "reset_required") {
      verifyCursor(data.head, source);
    } else {
      const { from, next, changes } = data.page;
      verifyCursor(from, source);
      verifyCursor(next, source);
      if (!sameStream(cursor, from) || from.seq !== cursor.seq || changes.length > pageSize) {
        throw new ReplicationError("invalid_page", "增量页与所请求的游标或页大小不符");
      }
    }
    return response;
  }

  async function readSnapshot(signal: AbortSignal) {
    const opened = parseReply(manifestReplySchema, await request(signal, (attemptSignal) =>
      transport.openSnapshot(attemptSignal)), "invalid_snapshot");
    const { source, data: manifest } = opened;
    const { snapshotId, recordCount, watermark } = manifest;
    verifyCursor(watermark, source);
    const records: z.infer<typeof snapshotRecordSchema>[] = [];
    for (let offset = 0; offset < recordCount; offset += pageSize) {
      const page = parseReply(snapshotPageReplySchema, await request(signal, (attemptSignal) =>
        transport.readSnapshotPage({ snapshotId, offset, limit: pageSize }, attemptSignal)), "invalid_snapshot");
      if (!sameStream(page.source, source)) {
        throw new ReplicationError("reset_required", "快照分页期间来源世代已变化");
      }
      if (page.data.snapshotId !== snapshotId || page.data.offset !== offset
        || page.data.records.length !== Math.min(pageSize, recordCount - offset)) {
        throw new ReplicationError("invalid_snapshot", "快照页截断、重复或与清单不匹配");
      }
      records.push(...page.data.records);
    }
    return { source, manifest, records };
  }

  return {
    async pull(signal = new AbortController().signal): Promise<PeerPullResult> {
      let cursor: ReplicationCursor | null = null;
      try {
        const before = getPeerCursor(db, peer.sourceHostId);
        cursor = before;
        signal.throwIfAborted();
        let applied = 0;
        let response = before ? await readChanges(before, signal) : null;
        if (!response || response.data.status === "reset_required") {
          const { source, manifest, records } = await readSnapshot(signal);
          // Reconfirm the serving generation and the log boundary after all
          // pages arrive. The first incremental page can be used immediately.
          response = await readChanges(manifest.watermark, signal);
          if (response.data.status === "reset_required" || !sameStream(source, response.source)) {
            throw new ReplicationError("reset_required", "快照完成前来源已换世代或增量需重置");
          }
          signal.throwIfAborted();
          const installed = applyReplicaSnapshot(db, response.source, before, manifest, records);
          if (installed.status === "waiting") {
            return installed;
          }
          cursor = installed.cursor;
          applied += installed.applied;
        }
        for (let pageNumber = 1; ; pageNumber++) {
          if (response.data.status === "reset_required") {
            throw new ReplicationError("reset_required", "拉取增量期间来源需要重置");
          }
          signal.throwIfAborted();
          const result = applyChangePage(db, response.source, response.data.page);
          if (result.status === "waiting") {
            return result;
          }
          cursor = result.cursor;
          applied += result.applied;
          if (!response.data.page.hasMore) {
            return { status: "caught_up", cursor, applied };
          }
          if (pageNumber === maxChangePages) {
            return { status: "more", cursor, applied };
          }
          response = await readChanges(cursor, signal);
        }
      } catch (error) {
        if (signal.aborted) {
          return { status: "stopped", cursor, reason: "aborted" };
        }
        if (error instanceof RetryExhausted) {
          return { status: "stopped", cursor, reason: "retry_exhausted", message: error.message };
        }
        if (error instanceof ReplicationError) {
          return { status: "stopped", cursor, reason: "replication_error", code: error.code, message: error.message };
        }
        return { status: "stopped", cursor, reason: "failure", message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
