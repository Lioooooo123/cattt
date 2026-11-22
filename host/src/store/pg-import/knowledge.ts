import { eq } from "drizzle-orm";
import { matchesDiaryLocalDay } from "../diary-date.ts";
import { saveReplyKnowledge } from "../knowledge-use.ts";
import { boundaries, diaryEntries, knowledgeSourceWithdrawals, memories, memoryBlocks, messages } from "../schema/index.ts";
import { importedCatDiary, importedMemoryBlocks } from "../schema/pg-import.ts";
import type { RecallEvidence } from "../schema/memory-extraction.ts";
import { memoryExtractionDependencies } from "../schema/memory-extraction.ts";
import { checked } from "./audit.ts";
import { integer, millis, nonEmpty, string } from "./context.ts";
import type { ImportContext } from "./context.ts";
import { memberSource, sourceProof } from "./conversations.ts";
import type { ImportedMessages } from "./conversations.ts";

const knowledgeMetadata = ["subject", "fingerprint", "source_message_id", "status", "revision", "scope", "created_at", "last_confirmed_at"] as const;
const messageList = (list: unknown) => Array.isArray(list) ? list : [];
const normalizeKey = (key: string) => key.normalize("NFKC").toLowerCase().trim();

export function importDiaries(ctx: ImportContext) {
  const { tx, audit, householdId, memberId, business } = ctx;
  const native = new Map<string, typeof diaryEntries.$inferSelect>();
  for (const legacy of ctx.rows("diary_entries")) {
    const row = legacy.data;
    const recordedAt = millis(row.recorded_at);
    const createdAt = millis(row.created_at);
    const updatedAt = millis(row.updated_at);
    const rev = integer(row.revision);
    const text = string(row.text);
    const localDay = string(row.day);
    const timeZone = string(row.time_zone);
    if (!nonEmpty(text) || !localDay || !timeZone || rev < 1 || !matchesDiaryLocalDay({ localDay, timeZone, recordedAt })) {
      audit.reject("diary_entries", legacy, "invalid_diary");
      continue;
    }
    const residual = ["seq", "change_seq", "client_id", "kind", "time", "mutation_id", "visit", "note"];
    if (row.kind === "text") {
      const target = {
        ...business("diary", legacy.key, createdAt, updatedAt, rev), householdId,
        ownerMemberId: memberId, sourceMemberId: memberId, sourceMessageId: null, sourceRevision: null,
        text, recordedAt, localDay, timeZone, catAllowed: row.cat_allowed === true,
      };
      const persisted = tx.insert(diaryEntries).values(target).returning().get()!;
      native.set(legacy.key, persisted);
      audit.mapped("diary_entries", legacy, [checked("diary_entries", target, persisted)], residual);
    } else if (row.kind === "cat") {
      const target = {
        ...business("cat-diary", legacy.key, createdAt, updatedAt, rev), householdId, ownerMemberId: memberId,
        text, recordedAt, localDay, timeZone,
      };
      const persisted = tx.insert(importedCatDiary).values(target).returning().get();
      audit.mapped("diary_entries", legacy, [checked("imported_cat_diary", target, persisted)], residual);
    } else {
      audit.reject("diary_entries", legacy, "unsupported_diary_kind");
    }
  }
  return native;
}

export function importKnowledge(ctx: ImportContext, index: ImportedMessages, diaries: ReturnType<typeof importDiaries>) {
  const { tx, memberId, business, audit } = ctx;
  const subject = { subjectMemberId: memberId };
  const withdrawn = new Set<string>();
  const withdrawals = new Map<string, ReturnType<typeof checked>>();
  for (const [key, { legacy, target }] of index) {
    const diaryId = string(legacy.data.diary_entry_id);
    if (legacy.data.context_allowed !== true || (diaryId && !diaries.get(diaryId)?.catAllowed)) {
      withdrawn.add(key);
      if (target.authorMemberId === null || target.status !== "complete") {
        target.historyContextBlocked = true;
        tx.update(messages).set({ historyContextBlocked: true }).where(eq(messages.id, target.id)).run();
        continue;
      }
      const row = { ...business("withdrawal", key, target.createdAt), ...sourceProof(ctx, target) };
      const stored = tx.insert(knowledgeSourceWithdrawals).values(row).returning().get();
      withdrawals.set(key, checked("knowledge_source_withdrawals", row, stored));
    }
  }

  const blockIndex = new Map(ctx.rows("memory_blocks").map((row) => [row.data.fingerprint, row]));
  const receiptsByFact = new Map(ctx.rows("memory_receipts").map((row) => [row.key, row]));
  const ownNames = new Set(["用户", "用户本人", "主人", "我", "你", "本人", "han"]);
  if (nonEmpty(ctx.user.data.name)) ownNames.add(normalizeKey(ctx.user.data.name));

  for (const legacy of blockIndex.values()) {
    const fingerprint = string(legacy.data.fingerprint);
    if (!fingerprint) {
      audit.reject("memory_blocks", legacy, "invalid_fingerprint");
      continue;
    }
    const target = { ...business("legacy-memory-block", legacy.key, millis(legacy.data.created_at)),
      householdId: ctx.householdId, memberId, fingerprint };
    const stored = tx.insert(importedMemoryBlocks).values(target).returning().get();
    audit.mapped("memory_blocks", legacy, [checked("imported_memory_blocks", target, stored)], ["source_seq", "created_at"]);
  }

  const accepted = new Map<string, typeof memories.$inferSelect>();
  const sourcesSuppressed = new Set<string>();
  const memoriesSuppressed = new Set<string>();
  const boundarySources = new Set(ctx.rows("boundaries").map((row) => row.data.source_message_id));
  for (const legacy of ctx.rows("turns")) {
    if (!boundarySources.has(legacy.data.cat_message_id)) continue;
    if (typeof legacy.data.user_message_id === "string") sourcesSuppressed.add(legacy.data.user_message_id);
    for (const id of messageList(legacy.data.memory_ids)) if (typeof id === "string") memoriesSuppressed.add(id);
  }
  for (const legacy of ctx.rows("memories")) {
    const row = legacy.data;
    const source = memberSource(ctx, index, row.source_message_id);
    const receipt = typeof row.fingerprint === "string" && source && receiptsByFact.get(`${source.legacy.key}:${row.fingerprint}`);
    const questionId = receipt ? string(receipt.data.question_id) : undefined;
    const question = questionId ? index.get(questionId) : undefined;
    const reason =
      !source ? "source_unproven" :
      withdrawn.has(source.legacy.key) || (questionId && withdrawn.has(questionId)) ? "source_withdrawn" :
      questionId && !question ? "source_unproven" :
      !nonEmpty(row.subject) || !ownNames.has(normalizeKey(row.subject)) ? "subject_unmapped" :
      row.status !== "active" ? "legacy_inactive" :
      blockIndex.has(row.fingerprint) || (receipt && receipt.data.accepted === false) ? "legacy_blocked" :
      boundarySources.has(source.legacy.key) || sourcesSuppressed.has(source.legacy.key)
        || memoriesSuppressed.has(legacy.key) || !!(questionId && boundarySources.has(questionId)) ? "legacy_boundary" :
      row.scope !== "cat" || (row.explicit !== true && !(typeof row.confidence === "number" && row.confidence >= 0.6))
        ? "legacy_recall_denied" : undefined;
    if (reason || !source || !nonEmpty(row.predicate) || !nonEmpty(row.value)) {
      audit.reject("memories", legacy, reason ?? "invalid_memory",
        ["source_unproven", "source_withdrawn", "legacy_blocked", "legacy_boundary"].includes(reason ?? "")
          ? knowledgeMetadata : undefined);
      continue;
    }
    const predicate = row.predicate;
    const fingerprint = normalizeKey(predicate);
    const createdAt = millis(row.created_at);
    const updatedAt = millis(row.last_confirmed_at);
    const rev = integer(row.revision) + 1;
    const target = { ...business("memory", legacy.key, createdAt, updatedAt, rev), ...subject, ...sourceProof(ctx, source.target),
      fingerprint, predicate, value: row.value, correctsPrevious: rev > 1 || row.extractor_version === "user-edit-v1" };
    const stored = tx.insert(memories).values(target).returning().get()!;
    accepted.set(legacy.key, stored);
    const mapped = [checked("memories", target, stored)];
    if (question && question.target.id !== source.target.id) {
      const dependency = { memoryId: target.id, contextMessageId: question.target.id, contextRevision: question.target.rev };
      mapped.push(checked("memory_extraction_dependencies", dependency,
        tx.insert(memoryExtractionDependencies).values(dependency).returning().get()));
    }
    audit.mapped("memories", legacy, mapped, [
      "subject", "fingerprint", "revision", "status", "confidence", "sensitivity", "scope", "explicit", "extractor_version", "edited_through_seq",
    ]);
  }

  for (const legacy of ctx.rows("boundaries")) {
    const row = legacy.data;
    const source = memberSource(ctx, index, row.source_message_id);
    if (!source || withdrawn.has(source.legacy.key)) {
      audit.reject("boundaries", legacy, source ? "source_withdrawn" : "source_unproven", ["source_message_id", "created_at"]);
      continue;
    }
    const target = { ...business("boundary", legacy.key, millis(row.created_at)), ...subject, ...sourceProof(ctx, source.target),
      description: nonEmpty(row.description) ? row.description : source.target.text };
    audit.mapped("boundaries", legacy, [checked("boundaries", target, tx.insert(boundaries).values(target).returning().get())]);
  }

  const evidenceByMessage = new Map<string, RecallEvidence[]>();
  for (const turn of ctx.rows("turns")) {
    const reply = index.get(string(turn.data.cat_message_id) ?? "");
    if (!reply || reply.target.authorMemberId !== null || reply.target.historyContextBlocked || !reply.target.turnId) continue;
    const proof: RecallEvidence[] = [];
    let blocked = false;
    for (const id of messageList(turn.data.context_source_ids)) {
      const source = memberSource(ctx, index, id);
      if (!source || withdrawn.has(source.legacy.key)) {
        blocked = true;
        break;
      }
      const { sourceMemberId, sourceMessageId, sourceRevision } = sourceProof(ctx, source.target);
      proof.push({ kind: "message", sourceMemberId, sourceMessageId, sourceRevision });
    }
    for (const key of messageList(turn.data.memory_ids)) {
      const memory = accepted.get(string(key) ?? "");
      if (memory) proof.push({ kind: "memory", id: memory.id, rev: memory.rev });
      else blocked = true;
    }
    for (const key of messageList(turn.data.diary_source_ids)) {
      const diary = diaries.get(string(key) ?? "");
      if (diary?.catAllowed) proof.push({ kind: "diary", id: diary.id, rev: diary.rev });
      else blocked = true;
    }
    if (blocked) {
      reply.target.historyContextBlocked = true;
      tx.update(messages).set({ historyContextBlocked: true }).where(eq(messages.id, reply.target.id)).run();
    } else if (proof.length) {
      const unique = [...new Map(proof.map((item) => [JSON.stringify(item), item])).values()];
      saveReplyKnowledge(tx, reply.target.id, unique);
      evidenceByMessage.set(reply.legacy.key, unique);
    }
  }
  return { withdrawn, evidenceByMessage, withdrawals };
}
