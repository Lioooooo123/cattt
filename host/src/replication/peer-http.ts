import { z } from "zod";
import { PeerProtocolError } from "../peer/protocol.ts";
import type { PeerTransport } from "../peer/index.ts";
import { getNativeReplicationSource, MAX_CHANGE_PAGE } from "../store/replication.ts";
import type { HostContext } from "../runtime/index.ts";
import { PeerSyncTransportError } from "./peer-pull.ts";
import { createPeerSyncService } from "./peer-service.ts";
import { PEER_SYNC_PROTOCOL_VERSION } from "./peer-types.ts";
import type { PeerChanges, PeerSyncReply, PeerSyncTransport, SnapshotManifest, SnapshotPage } from "./peer-types.ts";
import { ReplicationError, replicationCursorSchema, replicationErrorCodeSchema } from "./types.ts";

const decimal = z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.int().nonnegative());
const limit = decimal.pipe(z.int().min(1).max(MAX_CHANGE_PAGE));
const version = String(PEER_SYNC_PROTOCOL_VERSION);
const base = { protocol_version: z.literal(version) };
const querySchema = z.discriminatedUnion("op", [
  z.strictObject({ ...base, op: z.literal("snapshot") }),
  z.strictObject({ ...base, op: z.literal("snapshot_page"), snapshot_id: z.uuidv4(), offset: decimal, limit }),
  z.strictObject({ ...base, op: z.literal("changes"), limit, cursor: z.string().max(512).transform((input, ctx) => {
    try { return JSON.parse(input) as unknown; } catch {
      ctx.addIssue({ code: "custom", message: "复制游标不是有效 JSON" });
      return z.NEVER;
    }
  }).pipe(replicationCursorSchema.nullable()) }),
]);

function rejected(code: string, status: number) {
  return Response.json({ error: { code } }, { status });
}

export function typedChangesHandler(ctx: HostContext) {
  const db = ctx.store.db;
  const service = createPeerSyncService(db, ctx.hostId);
  return (request: Request, actor: { householdId: string }): Response => {
    const params = new URL(request.url).searchParams;
    if (params.size !== new Set(params.keys()).size) {
      return rejected("invalid_request", 400);
    }
    const requestedVersion = params.get("protocol_version");
    if (requestedVersion !== null && requestedVersion !== version) {
      return rejected("unsupported_protocol", 409);
    }
    const parsed = querySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) {
      return rejected("invalid_request", 400);
    }
    try {
      const source = getNativeReplicationSource(db, ctx.hostId);
      if (source.householdId !== actor.householdId) {
        return rejected("source_mismatch", 403);
      }
      const query = parsed.data;
      switch (query.op) {
        case "snapshot":
          return Response.json(service.openSnapshot());
        case "snapshot_page":
          return Response.json(service.readSnapshotPage({
            snapshotId: query.snapshot_id, offset: query.offset, limit: query.limit,
          }));
        case "changes":
          return Response.json(service.readChanges({ cursor: query.cursor, limit: query.limit }));
      }
    } catch (error) {
      if (!(error instanceof ReplicationError)) throw error;
      if (error.code === "snapshot_too_large") return rejected(error.code, 413);
      if (error.code === "source_mismatch") return rejected(error.code, 403);
      if (error.code === "invalid_snapshot" || error.code === "invalid_cursor" || error.code === "invalid_page") {
        return rejected(error.code, 400);
      }
      return rejected(error.code, 409);
    }
  };
}

const wireError = z.object({ error: z.object({ code: z.string() }) });

export function typedPeerTransport(transport: PeerTransport, hostId: string): PeerSyncTransport {
  async function read<T>(query: Record<string, string>, signal: AbortSignal): Promise<PeerSyncReply<T>> {
    let response: Response;
    try {
      response = await transport.request(hostId, "typedChanges", {
        query: { ...query, protocol_version: version }, signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PeerProtocolError) {
        throw new ReplicationError("unsupported_protocol", error.message);
      }
      throw new PeerSyncTransportError("无法连接复制来源宿主");
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new PeerSyncTransportError(`复制来源暂时不可用（HTTP ${response.status}）`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof SyntaxError)) {
        throw new PeerSyncTransportError("读取复制响应时中断");
      }
      if (response.status === 404) {
        throw new ReplicationError("unsupported_protocol", "对端未提供类型化复制接口");
      }
      throw new ReplicationError(query.op === "changes" ? "invalid_page" : "invalid_snapshot", "复制响应不是有效 JSON");
    }
    if (!response.ok) {
      const parsed = wireError.safeParse(body);
      const code = parsed.success ? parsed.data.error.code : undefined;
      if (response.status === 404 || code === "peer_protocol_unsupported" || code === "peer_upgrade_required") {
        throw new ReplicationError("unsupported_protocol", "对端不支持当前复制协议");
      }
      const replicationCode = replicationErrorCodeSchema.safeParse(code);
      if (replicationCode.success) {
        throw new ReplicationError(replicationCode.data, `复制来源拒绝请求（HTTP ${response.status}）`);
      }
      throw new PeerSyncTransportError(`复制来源未接受请求（HTTP ${response.status}）`);
    }
    // R6.3 validates the envelope, source, and every page before writing.
    return body as PeerSyncReply<T>;
  }
  return {
    openSnapshot: (signal) => read<SnapshotManifest>({ op: "snapshot" }, signal),
    readSnapshotPage: ({ snapshotId, offset, limit }, signal) => read<SnapshotPage>({
      op: "snapshot_page", snapshot_id: snapshotId, offset: String(offset), limit: String(limit),
    }, signal),
    readChanges: ({ cursor, limit }, signal) => read<PeerChanges>({
      op: "changes", cursor: JSON.stringify(cursor), limit: String(limit),
    }, signal),
  };
}
