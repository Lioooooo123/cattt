import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { businessColumns } from "./columns.ts";
import { conversations } from "./conversations.ts";
import { households, members } from "./identity.ts";

function manifestColumns() {
  return {
    householdId: text("household_id").notNull().references(() => households.id),
    ownerMemberId: text("owner_member_id").notNull().references(() => members.id),
    conversationId: text("conversation_id").notNull().references(() => conversations.id),
    // The source may arrive on a different replication stream after this row.
    sourceMessageId: text("source_message_id"),
    sourceMessageRev: integer("source_message_rev"),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    fileName: text("file_name").notNull(),
    mediaType: text("media_type").notNull(),
    description: text("description"),
  };
}

// Replicable business metadata and tombstones. The blob may arrive later.
export const files = sqliteTable("files", {
  ...businessColumns(),
  ...manifestColumns(),
}, (table) => [
  index("files_conversation_order").on(table.conversationId, table.id),
  index("files_sha256").on(table.sha256),
  check("files_source_message", sql`(${table.sourceMessageId} IS NULL AND ${table.sourceMessageRev} IS NULL)
    OR (${table.sourceMessageId} IS NOT NULL AND ${table.sourceMessageRev} IS NOT NULL AND ${table.sourceMessageRev} > 0)`),
]);

// Both auxiliary tables are local. Completed uploads use the same ID as files.
export const fileUploads = sqliteTable("file_uploads", {
  id: text("id").primaryKey(),
  clientUploadId: text("client_upload_id").notNull(),
  ...manifestColumns(),
}, (table) => [
  uniqueIndex("file_uploads_owner_client_id").on(table.ownerMemberId, table.clientUploadId),
]);

export const fileBlobs = sqliteTable("file_blobs", {
  sha256: text("sha256").primaryKey(),
  byteSize: integer("byte_size").notNull(),
  verifiedAt: integer("verified_at").notNull(),
});

// Replicable observation derived from exactly one file revision and its source.
export const fileDescriptions = sqliteTable("file_descriptions", {
  ...businessColumns(),
  fileId: text("file_id").notNull().references(() => files.id),
  fileRev: integer("file_rev").notNull(),
  sourceMessageId: text("source_message_id"),
  sourceMessageRev: integer("source_message_rev"),
  sha256: text("sha256").notNull(),
  modelId: text("model_id").notNull(),
  text: text("text").notNull(),
}, (table) => [
  uniqueIndex("file_descriptions_file_revision").on(table.fileId, table.fileRev),
]);
