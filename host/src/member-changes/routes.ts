import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { BlobStorage } from "../files/blobs.ts";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import type { HostContext } from "../runtime/index.ts";
import { getHostMeta, setHostMeta } from "../store/host-meta.ts";
import { getHouseholdMember, isActiveDeviceActor } from "../store/identity.ts";
import { writeTransaction } from "../store/index.ts";
import { memberProjectionKey, readMemberChangeIndex, reconcileMemberChangeIndex } from "../store/member-changes.ts";
import { getReplicationHead } from "../store/replication.ts";
import type { MemberChange, MemberChangePage, MemberProjection } from "./contract.ts";
import { memberCursorCodec, memberCursorFormat } from "./cursor.ts";
import type { MemberChangePosition } from "./cursor.ts";
import { isMemberChangeKind, memberProjectionReaders } from "./projections.ts";

const querySchema = z.object({
  cursor: z.string().regex(memberCursorFormat).optional(),
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.int().max(100)).default(50),
}).strict();

const keyName = "member_changes_cursor_key";

export function memberChangesRoutes(ctx: HostContext, storage: BlobStorage) {
  const app = new Hono<IdentityEnv>();
  const readers = memberProjectionReaders(storage);
  app.use("/changes", async (c, next) => {
    c.header("cache-control", "private, no-store");
    await next();
  });
  app.get("/changes", requireActor(ctx), (c) => {
    const params = new URL(c.req.url).searchParams;
    const fields = Object.fromEntries(params);
    const query = querySchema.safeParse(fields);
    if (!query.success || params.size !== Object.keys(fields).length) {
      return c.json({ error: { code: "invalid_request" } }, 400);
    }

    const actor = c.get("actor");
    const { cursor, limit } = query.data;
    return writeTransaction(ctx.store, (db) => {
      const member = getHouseholdMember(db, actor.householdId, actor.memberId);
      if (!member || !isActiveDeviceActor(db, actor)) {
        return c.json({ error: { code: "unauthorized" } }, 401);
      }
      if (member.homeHostId !== actor.hostId) {
        return c.json({ error: { code: "wrong_home_host", writer_host_id: member.homeHostId } }, 409);
      }

      const { generation } = getReplicationHead(db, actor.hostId);
      const { householdId, memberId, hostId } = actor;
      const scope = { householdId, memberId, hostId, generation };
      const reset = () => c.json({ reset: true, generation, error: { code: "cursor_reset_required" } }, 409);
      let key = getHostMeta(db, keyName);
      if (!key) {
        if (cursor) {
          return reset();
        }
        key = randomBytes(32).toString("base64url");
        setHostMeta(db, keyName, key);
      }
      const codec = memberCursorCodec(Buffer.from(key, "base64url"), scope);
      const position = cursor ? codec.open(cursor) : undefined;
      if (cursor && !position) {
        return reset();
      }

      const current = new Map<string, {
        kind: MemberProjection["kind"];
        resourceId: string;
        fingerprint: string;
        dto: MemberProjection;
      }>();
      for (const read of readers) {
        for (const dto of read(db, actor)) {
          const entry = {
            kind: dto.kind,
            resourceId: dto.value.id,
            fingerprint: createHash("sha256").update(JSON.stringify(dto.value)).digest("hex"),
            dto,
          };
          const resourceKey = memberProjectionKey(entry);
          if (current.has(resourceKey)) {
            throw new Error("成员同步投影存在重复资源");
          }
          current.set(resourceKey, entry);
        }
      }
      const { head, previousHead } = reconcileMemberChangeIndex(db, scope, current);
      if (position && (position.through ?? position.after) > previousHead) {
        return reset();
      }
      const after = position?.after ?? 0;
      const through = position?.through ?? head;
      const opening = position?.opening ?? true;
      const rows = readMemberChangeIndex(db, scope, { after, through, opening, limit: limit + 1 });
      const moreInRange = rows.length > limit;
      const changes: MemberChange[] = rows.slice(0, limit).map((row) => {
        const { kind, sequence, resourceId: id } = row;
        const projection = current.get(memberProjectionKey(row));
        if (projection) {
          return { ...projection.dto, op: "upsert", id, sequence };
        }
        if (row.fingerprint !== null || !isMemberChangeKind(kind)) {
          throw new Error("成员同步投影索引与当前视图不一致");
        }
        return { kind, op: "delete", id, sequence };
      });
      const next: MemberChangePosition = moreInRange
        ? { after: changes.at(-1)!.sequence, through, opening }
        : { after: through, through: null, opening: false };
      const unchanged = position?.through === null && position.after === next.after && next.through === null;
      const page: MemberChangePage = {
        generation, reset: false, changes, has_more: moreInRange || through < head,
        next: unchanged && cursor ? cursor : codec.seal(next),
      };
      return c.json(page);
    });
  });
  return app;
}
