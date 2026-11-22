CREATE TABLE `mailbox_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`letter_id` text NOT NULL,
	`member_id` text NOT NULL,
	`read_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_reads_letter_id_unique` ON `mailbox_reads` (`letter_id`);--> statement-breakpoint
CREATE TABLE `ticket_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_rev` integer NOT NULL,
	`kind` text NOT NULL,
	`message_id` text,
	`letter_id` text,
	`audience_days` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ticket_publication_content" CHECK("ticket_publications"."message_id" IS NOT NULL OR "ticket_publications"."letter_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_publications_message_id_unique` ON `ticket_publications` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_publications_letter_id_unique` ON `ticket_publications` (`letter_id`);--> statement-breakpoint
CREATE INDEX `ticket_publications_ticket` ON `ticket_publications` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `publication_epochs` (
	`household_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`grant_id` text NOT NULL,
	`holder_host_id` text NOT NULL,
	`previous_holder_host_id` text NOT NULL,
	`previous_grant_id` text NOT NULL,
	`history_digest` text NOT NULL,
	`acknowledged` integer NOT NULL,
	PRIMARY KEY(`household_id`, `epoch`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_grant_id` ON `publication_epochs` (`household_id`,`grant_id`);--> statement-breakpoint
CREATE TABLE `publication_renewals` (
	`household_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`sequence` integer NOT NULL,
	`request_id` text NOT NULL,
	PRIMARY KEY(`household_id`, `epoch`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `group_send_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`member_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`text` text NOT NULL,
	`status` text,
	`delivery_id` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_send_client_request` ON `group_send_intents` (`conversation_id`,`member_id`,`client_message_id`);--> statement-breakpoint
CREATE INDEX `group_send_pending` ON `group_send_intents` (`origin_host_id`,`household_id`) WHERE "group_send_intents"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `messages` ADD `publication_epoch` integer;--> statement-breakpoint
ALTER TABLE `peer_outbox` ADD `rejection_code` text;--> statement-breakpoint
ALTER TABLE `peers` ADD `approval_id` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `publication_epoch` integer;
--> statement-breakpoint
-- The migration reconstructs business evidence only. Existing local reports,
-- jobs and delivery receipts keep their status and original references.
INSERT INTO mailbox_reads
  (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, household_id, letter_id, member_id, read_at)
SELECT l.id, m.home_host_id, l.hlc, 1, l.read_at, l.read_at, NULL, l.household_id, l.id, l.for_member_id, l.read_at
FROM mailbox_letters l JOIN members m ON m.id = l.for_member_id
WHERE l.read_at IS NOT NULL AND m.home_host_id = (SELECT value FROM host_meta WHERE key = 'host_id');
--> statement-breakpoint
INSERT INTO ticket_publications
  (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, household_id, ticket_id, ticket_rev, kind, message_id, letter_id, audience_days)
SELECT p.report_id, p.host_id, coalesce(m.hlc, l.created_hlc), 1, p.resolved_at, p.resolved_at, NULL,
  t.household_id, p.ticket_id, r.result_ticket_rev, 'worker', p.message_id, p.letter_id, '[]'
FROM publication_receipts p JOIN worker_reports r ON r.id = p.report_id JOIN tickets t ON t.id = p.ticket_id
LEFT JOIN messages m ON m.id = p.message_id LEFT JOIN mailbox_letters l ON l.id = p.letter_id
WHERE p.status = 'published';
--> statement-breakpoint
INSERT INTO ticket_publications
  (id, origin_host_id, hlc, rev, created_at, updated_at, deleted_at, household_id, ticket_id, ticket_rev, kind, message_id, letter_id, audience_days)
SELECT i.message_id, i.host_id, m.hlc, 1, i.resolved_at, i.resolved_at, NULL, i.household_id,
  i.ticket_id, 1, 'inference', i.message_id, i.letter_id,
  (SELECT json_group_array(json_object('memberId', d.member_id, 'localDay', d.local_day))
   FROM inference_daily_receipts d WHERE d.source_message_id = i.source_message_id ORDER BY d.member_id)
FROM inference_candidates i JOIN messages m ON m.id = i.message_id
WHERE i.status = 'published';
