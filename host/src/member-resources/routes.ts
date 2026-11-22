import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Actor } from "../identity/index.ts";
import { requireActor } from "../identity/middleware.ts";
import type { IdentityEnv } from "../identity/middleware.ts";
import { PEER_DELIVERY_QUEUE } from "../peer-behavior/index.ts";
import type { PeerBehaviorChannel } from "../peer-behavior/index.ts";
import type { HostContext } from "../runtime/index.ts";
import { getOwnedConversationMessage } from "../store/conversations.ts";
import {
  createDiaryEntry, getSharedDiaryEntry, listSharedDiaryEntries, matchesDiaryLocalDay,
  reviseDiaryEntry, setDiaryCatAllowed, withdrawDiaryEntry,
} from "../store/diary.ts";
import type { StoreDb } from "../store/index.ts";
import {
  canManageMemory, createBoundary, forgetMemory, getBoundaryRecord, getMemoryRecord,
  listAvailableBoundaries, listAvailableMemories, reviseBoundary, reviseMemory, withdrawBoundary,
} from "../store/knowledge.ts";
import { readKnowledgeSource, withdrawKnowledgeSource } from "../store/knowledge-source.ts";
import { continueLegacyDiary, legacyDiaryAccount } from "../store/legacy-diary.ts";
import {
  commitMemberResource, getMemberResourceReceipt, MemberResourceError, requireMemberResourceActor,
} from "../store/member-resources.ts";
import type { MemberResourceDb } from "../store/member-resources.ts";
import { getPeerDelivery } from "../store/peer-behavior.ts";
import { projectMemoryAction, stageMemoryAction } from "./memory-actions.ts";
import { canViewMemory, projectBoundary, projectDiaryEntry, projectMemory } from "./projections.ts";

const requestId = z.uuid();
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const edit = z.object({ request_id: requestId, expected_revision: revision }).strict();
const memoryEdit = edit.extend({ value: z.string().trim().min(1).max(2000) });
const sourceRef = z.object({ conversation_id: z.uuid(), message_id: z.uuid(), revision }).strict();
const boundaryDescription = z.string().trim().min(1).max(2000);
const diaryText = z.string().max(20_000).refine((text) => text.trim().length > 0);
const diaryDate = {
  recorded_at: z.number().int(), local_day: z.iso.date(), time_zone: z.string().min(1).max(100),
};
const legacyDiaryWrite = z.strictObject({
  request_id: requestId, source_account_id: z.uuid(), client_id: z.string().min(1).max(100),
  cloud_id: z.uuid().optional(), revoke_cat_access: z.boolean().default(false),
  draft: z.strictObject({ ...diaryDate, text: diaryText, cat_allowed: z.boolean().default(false) }).optional(),
}).refine((body) => !body.cloud_id || !body.draft);
type SourceRef = z.infer<typeof sourceRef>;
type RouteContext = Context<IdentityEnv>;
type Reader = Pick<StoreDb, "select">;

function idParam(c: RouteContext, name = "id") {
  const id = z.uuid().safeParse(c.req.param(name));
  if (!id.success) {
    throw new MemberResourceError("invalid_request");
  }
  return id.data;
}

function found<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new MemberResourceError("not_found");
  }
  return row;
}

function checkRevision(actual: number, expected: number) {
  if (actual !== expected) {
    throw new MemberResourceError("revision_conflict");
  }
}

function messageUse(db: Reader, actor: Actor, conversationId: string, messageId: string) {
  const row = found(getOwnedConversationMessage(db, actor, conversationId, messageId));
  const source = {
    householdId: actor.householdId, sourceMemberId: actor.memberId,
    sourceMessageId: row.id, sourceRevision: row.rev,
  };
  const allowed = readKnowledgeSource(db, source) !== undefined;
  return {
    source, allowed,
    dto: { conversation_id: conversationId, message_id: messageId, revision: row.rev, allowed },
  };
}

function writableSource(db: Reader, actor: Actor, ref: SourceRef) {
  const current = messageUse(db, actor, ref.conversation_id, ref.message_id);
  checkRevision(current.source.sourceRevision, ref.revision);
  if (!current.allowed) {
    throw new MemberResourceError("source_unavailable");
  }
  return current.source;
}

function readMemory(db: Reader, actor: Actor, id: string, includeDeleted = false) {
  const filter = { householdId: actor.householdId, id };
  const row = includeDeleted ? getMemoryRecord(db, filter) : undefined;
  const current = row && row.deletedAt !== null ? row : listAvailableMemories(db, filter)[0];
  return found(current && canViewMemory(actor, current) ? current : undefined);
}

function readBoundary(db: Reader, actor: Actor, id: string, includeDeleted = false) {
  const filter = { householdId: actor.householdId, subjectMemberId: actor.memberId, id };
  const row = includeDeleted ? getBoundaryRecord(db, filter) : undefined;
  return found(row && row.deletedAt !== null ? row : listAvailableBoundaries(db, filter)[0]);
}

function ownedDiary(db: Reader, actor: Actor, id: string, expected: number) {
  const row = getSharedDiaryEntry(db, actor.householdId, id);
  checkRevision(found(row?.ownerMemberId === actor.memberId ? row : undefined).rev, expected);
}

export function memberResourceRoutes(ctx: HostContext, peer?: PeerBehaviorChannel) {
  const app = new Hono<IdentityEnv>();
  const auth = requireActor(ctx);
  const { db } = ctx.store;
  const { clock } = ctx;
  app.onError((error, c) => {
    if (error instanceof MemberResourceError) {
      return c.json({ error: {
        code: error.code, ...(error.writerHostId ? { writer_host_id: error.writerHostId } : {}),
      } }, error.status);
    }
    throw error;
  });

  const write = <Input extends { request_id: string }, Output>(
    schema: z.ZodType<Input>,
    key: string,
    change: (tx: MemberResourceDb, actor: Actor, c: RouteContext, body: Input) => string,
    project: (tx: Reader, actor: Actor, c: RouteContext, id: string) => Output,
    status: 200 | 201 = 200,
  ) => async (c: RouteContext) => {
    const body = schema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      throw new MemberResourceError("invalid_request");
    }
    const actor = c.get("actor");
    const result = commitMemberResource(
      db, actor, body.data.request_id, `${c.req.method} ${c.req.path}`, body.data,
      (tx) => change(tx, actor, c, body.data), (tx, id) => project(tx, actor, c, id),
    );
    return c.json({ [key]: result.value }, result.replayed ? 200 : status);
  };

  const memoryProjection = (tx: Reader, actor: Actor, _c: RouteContext, id: string) =>
    found(projectMemory(tx, actor, readMemory(tx, actor, id, true)));
  app.get("/memories", auth, (c) => {
    const actor = c.get("actor");
    return c.json({ memories: db.transaction((tx) => listAvailableMemories(tx, { householdId: actor.householdId })
      .flatMap((row) => projectMemory(tx, actor, row) ?? [])) });
  });
  app.get("/memories/:id", auth, (c) => {
    const actor = c.get("actor");
    const id = idParam(c);
    return c.json({ memory: db.transaction((tx) => projectMemory(tx, actor, readMemory(tx, actor, id))) });
  });
  const actionResponse = (c: RouteContext, action: ReturnType<typeof projectMemoryAction>) =>
    c.json({ action }, action.status === "applied" || action.status === "rejected" ? 200 : 202);
  app.get("/memories/:id/requests/:requestId", auth, (c) => {
    const actor = c.get("actor");
    const memoryId = idParam(c);
    const key = idParam(c, "requestId");
    const action = db.transaction((tx) => {
      requireMemberResourceActor(tx, actor);
      const receipt = found(getMemberResourceReceipt(tx, actor.memberId, key));
      return projectMemoryAction(tx, actor, found(getPeerDelivery(tx, receipt.resourceId)), memoryId, key);
    });
    return actionResponse(c, action);
  });
  type MemoryEdit = { request_id: string; expected_revision: number; value?: string };
  const changeMemory = (schema: z.ZodType<MemoryEdit>) => async (c: RouteContext) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new MemberResourceError("invalid_request");
    const body = parsed.data;
    const actor = c.get("actor");
    const memoryId = idParam(c);
    const { value } = body;
    const result = commitMemberResource(
      db, actor, body.request_id, `${c.req.method} ${c.req.path}`, body,
      (tx) => {
        const row = readMemory(tx, actor, memoryId);
        if (!canManageMemory(actor, row)) throw new MemberResourceError("not_found");
        checkRevision(row.rev, body.expected_revision);
        if (row.originHostId !== actor.hostId) {
          return stageMemoryAction(ctx, tx, peer, actor, row, body.request_id, value);
        }
        return found(value === undefined
          ? forgetMemory(tx, clock, actor, row.id, body.expected_revision)
          : reviseMemory(tx, clock, actor, row.id, body.expected_revision, value)).id;
      },
      (tx, id) => {
        if (id === memoryId) return { memory: memoryProjection(tx, actor, c, id) };
        return { action: projectMemoryAction(tx, actor, found(getPeerDelivery(tx, id)), memoryId, body.request_id) };
      },
    );
    if (result.value.action) {
      if (!result.replayed) ctx.bus.publish("jobs:wake", { queue: PEER_DELIVERY_QUEUE });
      return actionResponse(c, result.value.action);
    }
    return c.json({ memory: result.value.memory }, 200);
  };
  app.patch("/memories/:id", auth, changeMemory(memoryEdit));
  app.delete("/memories/:id", auth, changeMemory(edit));

  const boundaryProjection = (tx: Reader, actor: Actor, _c: RouteContext, id: string) =>
    found(projectBoundary(tx, actor, readBoundary(tx, actor, id, true)));
  app.get("/boundaries", auth, (c) => {
    const actor = c.get("actor");
    return c.json({ boundaries: db.transaction((tx) => listAvailableBoundaries(tx, {
      householdId: actor.householdId, subjectMemberId: actor.memberId,
    }).flatMap((row) => projectBoundary(tx, actor, row) ?? [])) });
  });
  app.get("/boundaries/:id", auth, (c) => {
    const actor = c.get("actor");
    const id = idParam(c);
    return c.json({ boundary: db.transaction((tx) => projectBoundary(tx, actor, readBoundary(tx, actor, id))) });
  });
  app.post("/boundaries", auth, write(
    z.object({ request_id: requestId, source: sourceRef, description: boundaryDescription }).strict(), "boundary",
    (tx, actor, _c, body) => {
      const source = writableSource(tx, actor, body.source);
      const scope = { ...source, subjectMemberId: actor.memberId };
      if (getBoundaryRecord(tx, scope)) {
        throw new MemberResourceError("revision_conflict");
      }
      return found(createBoundary(tx, clock, { ...scope, description: body.description })).id;
    }, boundaryProjection, 201,
  ));
  app.patch("/boundaries/:id", auth, write(edit.extend({ description: boundaryDescription }), "boundary",
    (tx, actor, c, body) => {
      const row = readBoundary(tx, actor, idParam(c));
      checkRevision(row.rev, body.expected_revision);
      return found(reviseBoundary(tx, clock, actor, row.id, body.expected_revision, body.description)).id;
    }, boundaryProjection));
  app.delete("/boundaries/:id", auth, write(edit, "boundary",
    (tx, actor, c, body) => {
      const row = readBoundary(tx, actor, idParam(c));
      checkRevision(row.rev, body.expected_revision);
      return found(withdrawBoundary(tx, clock, actor, row.id, body.expected_revision)).id;
    }, boundaryProjection));

  app.get("/conversations/:conversationId/messages/:messageId/usage", auth, (c) => {
    const conversationId = idParam(c, "conversationId");
    const messageId = idParam(c, "messageId");
    return c.json({ source: db.transaction((tx) => messageUse(tx, c.get("actor"), conversationId, messageId).dto) });
  });
  app.post("/conversations/:conversationId/messages/:messageId/withdraw", auth, write(edit, "source",
    (tx, actor, c, body) => {
      const current = messageUse(tx, actor, idParam(c, "conversationId"), idParam(c, "messageId"));
      checkRevision(current.source.sourceRevision, body.expected_revision);
      return found(withdrawKnowledgeSource(tx, clock, actor, current.source.sourceMessageId,
        body.expected_revision)).sourceMessageId;
    },
    (tx, actor, c, id) => messageUse(tx, actor, idParam(c, "conversationId"), id).dto,
  ));

  const diaryProjection = (tx: Reader, actor: Actor, _c: RouteContext, id: string) =>
    found(projectDiaryEntry(tx, actor, found(getSharedDiaryEntry(tx, actor.householdId, id, true))));
  app.get("/diary/legacy", auth, (c) => {
    c.header("cache-control", "private, no-store");
    const actor = c.get("actor");
    return c.json(db.transaction((tx) => {
      requireMemberResourceActor(tx, actor);
      return { source_account_id: legacyDiaryAccount(tx, actor) ?? null };
    }));
  });
  app.put("/diary/legacy", auth, write(legacyDiaryWrite, "entry", (tx, actor, _c, body) => {
    const draft = body.draft && {
      text: body.draft.text, recordedAt: body.draft.recorded_at, localDay: body.draft.local_day,
      timeZone: body.draft.time_zone, catAllowed: body.draft.cat_allowed,
    };
    if (draft && !matchesDiaryLocalDay(draft)) throw new MemberResourceError("invalid_request");
    return continueLegacyDiary(tx, clock, actor, {
      accountId: body.source_account_id, clientId: body.client_id, cloudId: body.cloud_id,
      revokeCatAccess: body.revoke_cat_access, draft,
    });
  }, diaryProjection));
  app.get("/diary", auth, (c) => {
    const actor = c.get("actor");
    return c.json({ entries: db.transaction((tx) => listSharedDiaryEntries(tx, actor.householdId)
      .flatMap((row) => projectDiaryEntry(tx, actor, row) ?? [])) });
  });
  app.get("/diary/:id", auth, (c) => {
    const actor = c.get("actor");
    const id = idParam(c);
    return c.json({ entry: db.transaction((tx) => projectDiaryEntry(tx, actor,
      found(getSharedDiaryEntry(tx, actor.householdId, id)))) });
  });
  app.post("/diary", auth, write(z.object({
    request_id: requestId, text: diaryText, ...diaryDate,
    cat_allowed: z.boolean().default(false), source: sourceRef.optional(),
  }).strict(), "entry", (tx, actor, _c, body) => {
    const date = { recordedAt: body.recorded_at, localDay: body.local_day, timeZone: body.time_zone };
    if (!matchesDiaryLocalDay(date)) {
      throw new MemberResourceError("invalid_request");
    }
    const source = body.source ? writableSource(tx, actor, body.source) : undefined;
    return createDiaryEntry(tx, clock, actor, { ...date, source, text: body.text, catAllowed: body.cat_allowed }).id;
  }, diaryProjection, 201));
  app.patch("/diary/:id", auth, write(edit.extend({ text: diaryText }), "entry", (tx, actor, c, body) => {
    const id = idParam(c);
    ownedDiary(tx, actor, id, body.expected_revision);
    return found(reviseDiaryEntry(tx, clock, actor, id, body.expected_revision, body.text)).id;
  }, diaryProjection));
  app.patch("/diary/:id/cat-allowed", auth, write(edit.extend({ cat_allowed: z.boolean() }), "entry", (tx, actor, c, body) => {
    const id = idParam(c);
    ownedDiary(tx, actor, id, body.expected_revision);
    const row = setDiaryCatAllowed(tx, clock, actor, id, body.expected_revision, body.cat_allowed);
    if (!row) {
      throw new MemberResourceError("source_unavailable");
    }
    return row.id;
  }, diaryProjection));
  app.delete("/diary/:id", auth, write(edit, "entry", (tx, actor, c, body) => {
    const id = idParam(c);
    ownedDiary(tx, actor, id, body.expected_revision);
    return found(withdrawDiaryEntry(tx, clock, actor, id, body.expected_revision)).id;
  }, diaryProjection));

  return app;
}
