import { eq } from "drizzle-orm";
import { ImportError } from "../../import-pg/snapshot.ts";
import type { PgSnapshot, SourceTable } from "../../import-pg/snapshot.ts";
import { openStore } from "../index.ts";
import { initializeNativeReplication } from "../replication.ts";
import { readNativeSnapshot } from "../replication-snapshot.ts";
import { chatReplyKnowledge, messages } from "../schema/index.ts";
import { pgImportReceipts } from "../schema/pg-import.ts";
import { checked } from "./audit.ts";
import type { TableReport } from "./audit.ts";
import { importContext } from "./context.ts";
import { importConversation, importIdentity } from "./conversations.ts";
import { importDiaries, importKnowledge } from "./knowledge.ts";
import { importWorld } from "./world.ts";
import { importTickets } from "./tickets.ts";

export const IMPORT_VERSION = 1;

export interface ImportReport {
  formatVersion: number;
  status: "imported" | "verified";
  sourceSha256: string;
  sourceUserId: string;
  sourceCatId: string | null;
  householdId: string;
  hostId: string;
  memberId: string;
  conversationId: string;
  replicationRecords: number;
  tables: Record<SourceTable, TableReport>;
}

const archives: Partial<Record<SourceTable, string>> = {
  cats: "world_and_soul_pending",
  diary_facts: "world_and_soul_pending",
  diary_calendars: "historical_schedule_only",
  world_actions: "world_and_soul_pending",
  world_sessions: "world_and_soul_pending",
  cat_runtime_states: "world_and_soul_pending",
  personality_versions: "world_and_soul_pending",
  cat_runtime_events: "world_and_soul_pending",
  soul_versions: "world_and_soul_pending",
  turn_soul_snapshots: "world_and_soul_pending",
  soul_blocked_sources: "world_and_soul_pending",
  memory_receipts: "historical_extraction_only",
  runtime_calls: "historical_checkpoint_only",
  runtime_steps: "historical_checkpoint_only",
  model_calls: "historical_accounting_only",
  model_reservations: "historical_accounting_only",
  async_jobs: "historical_job_only",
  decisions: "command_proof_unavailable",
  run_steps: "historical_checkpoint_only",
  worker_reports: "historical_report_only",
  push_notifications: "historical_delivery_only",
  push_deliveries: "historical_delivery_only",
  push_budget_reservations: "historical_delivery_only",
  proactive_rules: "historical_inference_only",
  inference_watches: "historical_inference_only",
  inference_observations: "historical_inference_only",
  turn_events: "historical_stream_only",
  turn_controls: "historical_stream_only",
};

export function materializeImport(path: string, snapshot: PgSnapshot): ImportReport {
  const store = openStore(path);
  try {
    const report = store.db.transaction((tx) => {
      const ctx = importContext(tx, snapshot);
      importIdentity(ctx);
      importWorld(ctx);
      const messageIndex = importConversation(ctx);
      const diaries = importDiaries(ctx);
      const { withdrawn, withdrawals, evidenceByMessage } = importKnowledge(ctx, messageIndex, diaries);
      importTickets(ctx, messageIndex, withdrawn);
      for (const [key, { legacy, target }] of messageIndex) {
        const mapped = [checked("messages", target, tx.select().from(messages).where(eq(messages.id, target.id)).get())];
        const withdrawal = withdrawals.get(key);
        if (withdrawal) mapped.push(withdrawal);
        const evidence = evidenceByMessage.get(key);
        if (evidence) {
          mapped.push(checked("chat_reply_knowledge", { messageId: target.id, references: evidence },
            tx.select().from(chatReplyKnowledge).where(eq(chatReplyKnowledge.messageId, target.id)).get()));
        }
        ctx.audit.mapped("messages", legacy, mapped, [
          "seq", "role", "memory_eligible", "context_allowed", "turn_id", "ticket_id", "diary_entry_id", "client_message_id",
        ]);
      }

      for (const table of Object.keys(archives) as SourceTable[]) {
        for (const row of ctx.rows(table)) {
          if (ctx.audit.pending(table, row)) ctx.audit.reject(table, row, archives[table]!);
        }
      }

      const { householdId, hostId, memberId, directId: conversationId } = ctx;
      // A peer installs this history atomically with its source withdrawals
      // and provenance. There is no incremental page with an unguarded prefix.
      initializeNativeReplication(tx, hostId, householdId, true);
      const replicationRecords = readNativeSnapshot(tx, hostId).records.length;
      const report: ImportReport = {
        formatVersion: IMPORT_VERSION, status: "imported", sourceSha256: snapshot.sourceSha256,
        sourceUserId: snapshot.userId, sourceCatId: snapshot.catId, householdId, hostId, memberId, conversationId,
        replicationRecords, tables: ctx.audit.finish(),
      };
      tx.insert(pgImportReceipts).values({ id: 1, sourceSha256: report.sourceSha256, report }).run();
      return report;
    }, { behavior: "immediate" });
    if (store.raw.query("PRAGMA foreign_key_check").all().length
      || store.raw.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new ImportError("SQLite 完整性检查失败");
    }
    store.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.raw.exec("PRAGMA journal_mode = DELETE");
    return report;
  } finally {
    store.close();
  }
}
