import { ImportError } from "../../import-pg/snapshot.ts";
import type { LegacyRow } from "../../import-pg/snapshot.ts";
import { DEFAULT_HOST_NAME, DEFAULT_HOUSEHOLD_NAME } from "../../runtime/config.ts";
import { setHostMeta } from "../host-meta.ts";
import { conversations, households, hosts, members, messages, participants, turns } from "../schema/index.ts";
import { importedMemoryRestrictions } from "../schema/pg-import.ts";
import { proactivePermissions } from "../schema/inference.ts";
import { checked } from "./audit.ts";
import { dictionary, integer, millis, nonEmpty, optionalMillis, string } from "./context.ts";
import type { ImportContext } from "./context.ts";

export function importIdentity(ctx: ImportContext) {
  const { tx, user, hostId, householdId, memberId, directId, groupId, directAt, business, timeZone, audit } = ctx;
  const createdAt = millis(user.data.created_at);
  const household = { ...business("household", user.key, createdAt), name: DEFAULT_HOUSEHOLD_NAME };
  const host = { ...business("host", user.key, createdAt), householdId, displayName: DEFAULT_HOST_NAME };
  const member = { ...business("member", user.key, createdAt), householdId, homeHostId: hostId, displayName: "Han" };
  setHostMeta(tx, "host_id", hostId);
  const identity = [
    checked("households", household, tx.insert(households).values(household).returning().get()),
    checked("hosts", host, tx.insert(hosts).values(host).returning().get()),
    checked("members", member, tx.insert(members).values(member).returning().get()),
  ];
  const cat = ctx.rows("cats")[0]?.data;
  // The current preferences table is local. Use the old timezone and consent
  // for future input only. No old inference watch enters the scheduler.
  const proactive = {
    memberId, timeZone, allowed: cat?.allow_proactive === true,
    revision: Math.max(1, cat ? integer(cat.proactive_revision) : 0),
  };
  identity.push(checked("proactive_permissions", proactive, tx.insert(proactivePermissions).values(proactive).returning().get()));
  if (cat?.learn_memories === false || cat?.use_memories === false) {
    const restriction = { ...business("memory-restrictions", user.key, createdAt), householdId, memberId,
      learningDisabled: cat.learn_memories === false, recallDisabled: cat.use_memories === false };

    identity.push(checked("imported_memory_restrictions", restriction,
      tx.insert(importedMemoryRestrictions).values(restriction).returning().get()));
  }
  audit.mapped("users", user, identity, ["name", "host_owner", "time_zone"]);

  for (const [kind, id, ownerMemberId, at] of [
    ["group", groupId, null, createdAt], ["direct", directId, memberId, directAt],
  ] as const) {
    const conv = { ...business(kind, id, at, at, 1, id), householdId, kind, ownerMemberId, publisherHostId: hostId };
    const participant = { ...business("participant", id, at), conversationId: id, memberId };
    const result = [
      checked("conversations", conv, tx.insert(conversations).values(conv).returning().get()),
      checked("participants", participant, tx.insert(participants).values(participant).returning().get()),
    ];
    const previous = ctx.rows("conversations")[0];
    if (kind === "direct" && previous) audit.mapped("conversations", previous, result, ["cat_id", "version"]);
  }
}

type NativeMessage = typeof messages.$inferSelect;
type MessageMap = Map<string, { legacy: LegacyRow; target: NativeMessage }>;

export function importConversation(ctx: ImportContext) {
  const { tx, audit, memberId, directId, business } = ctx;
  const messageMap: MessageMap = new Map();
  const turnsById = new Map(ctx.rows("turns").map((row) => [row.key, row]));
  const byReply = new Map<string, LegacyRow>();
  for (const turn of turnsById.values()) {
    const id = string(turn.data.cat_message_id);
    if (id) byReply.set(id, turn);
  }
  const ticketRows = new Map(ctx.rows("tickets").map((row) => [row.key, row]));
  for (const legacy of ctx.rows("messages")) {
    const row = legacy.data;
    const createdAt = millis(row.created_at);
    if ((row.role !== "user" && row.role !== "cat") || typeof row.text !== "string"
      || (row.status !== "done" && row.status !== "stopped")) {
      throw new ImportError("旧消息角色、状态或正文无法映射");
    }
    const authorMemberId = row.role === "user" ? memberId : null;
    const linkedTurn = turnsById.get(string(row.turn_id) ?? "") ?? byReply.get(legacy.key);
    const turn = linkedTurn?.data.cat_message_id === legacy.key ? linkedTurn : undefined;
    const ticket = ticketRows.get(string(row.ticket_id) ?? "");
    const mandate = dictionary(ticket?.data.mandate);
    const sourceId = turn?.data.user_message_id ?? (
      mandate?.source_message_id === ticket?.data.source_message_id ? ticket?.data.source_message_id : undefined
    );
    const source = messageMap.get(string(sourceId) ?? "");
    const replyTo = authorMemberId === null && source?.target.authorMemberId === memberId ? source : undefined;
    const rawId = string(row.client_message_id);
    const clientMessageId = authorMemberId && rawId && rawId.length <= 100 ? rawId : null;
    const target: NativeMessage = {
      ...business("message", legacy.key, createdAt),
      conversationId: directId, authorMemberId, text: row.text, modality: "text",
      status: row.status === "done" ? "complete" : "stopped",
      clientMessageId, replyToMessageId: replyTo?.target.id ?? null,
      historyContextBlocked: authorMemberId === null && row.context_allowed !== true,
      turnId: turn && replyTo ? ctx.id("turn", turn.key, millis(turn.data.created_at)) : null,
      publicationEpoch: null,
    };
    const inserted = tx.insert(messages).values(target).returning().get()!;
    messageMap.set(legacy.key, { legacy, target: inserted });

  }
  for (const legacy of ctx.rows("turns")) {
    const row = legacy.data;
    const source = messageMap.get(string(row.user_message_id) ?? "");
    if (source?.target.authorMemberId !== memberId) {
      audit.reject("turns", legacy, "source_unproven");
      continue;
    }
    const createdAt = millis(row.created_at);
    const storedStatus = row.status;
    if (storedStatus !== "queued" && storedStatus !== "generating" && storedStatus !== "completed"
      && storedStatus !== "stopped" && storedStatus !== "superseded" && storedStatus !== "failed") {
      throw new ImportError("旧聊天轮次状态无法映射");
    }
    const inFlight = storedStatus === "queued" || storedStatus === "generating";
    const id = ctx.id("turn", legacy.key, createdAt);
    const reply = messageMap.get(string(row.cat_message_id) ?? "")?.target;
    const target: typeof turns.$inferInsert = {
      id, conversationId: directId, triggerMessageId: source.target.id, publicationEpoch: null, requestId: null,
      status: inFlight ? "stopped" : storedStatus, replyMessageId: reply?.turnId === id ? reply.id : null,
      errorCode: storedStatus === "failed" ? "legacy_failed" : null,
      cancelReason: inFlight ? "pg_import_interrupted" : null, visibleLength: null,
      firstTokenAt: optionalMillis(row.first_token_at),
      heartbeatAt: optionalMillis(row.heartbeat_at) ?? createdAt, createdAt,
      finishedAt: optionalMillis(row.finished_at) ?? (inFlight ? optionalMillis(row.heartbeat_at) ?? createdAt : null),
      draftText: "", eventSeq: 0, supersededByTurnId: null,
    };
    audit.mapped("turns", legacy, [checked("turns", target, tx.insert(turns).values(target).returning().get())], [
      "input_version", "memory_ids", "context_source_ids", "context_revision", "diary_source_ids",
      "model", "error", "started_at", "extracted_at", "remembered", "status", "cat_message_id",
    ]);
  }
  return messageMap;
}

export type ImportedMessages = ReturnType<typeof importConversation>;

export function memberSource(ctx: ImportContext, index: ImportedMessages, id: unknown) {
  const row = index.get(string(id) ?? "");
  return row?.target.authorMemberId === ctx.memberId && row.target.status === "complete" && nonEmpty(row.target.text)
    ? row : undefined;
}

export function sourceProof(ctx: ImportContext, message: NativeMessage) {
  return { householdId: ctx.householdId, sourceMemberId: ctx.memberId, sourceMessageId: message.id, sourceRevision: message.rev };
}
