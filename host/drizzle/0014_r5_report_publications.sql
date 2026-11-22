CREATE TABLE `mailbox_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`for_member_id` text NOT NULL,
	`publisher_host_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`text` text NOT NULL,
	`created_hlc` text NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`for_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mailbox_member_order` ON `mailbox_letters` (`household_id`,`for_member_id`,`created_hlc`,`id`);--> statement-breakpoint
CREATE TABLE `publication_receipts` (
	`report_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`status` text NOT NULL,
	`retry_at` integer,
	`reason` text,
	`message_id` text,
	`letter_id` text,
	`resolved_at` integer,
	FOREIGN KEY (`report_id`) REFERENCES `worker_reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_receipt_status" CHECK(
    ("publication_receipts"."status" = 'pending' AND "publication_receipts"."retry_at" IS NOT NULL AND "publication_receipts"."resolved_at" IS NULL
      AND "publication_receipts"."message_id" IS NULL AND "publication_receipts"."letter_id" IS NULL)
    OR ("publication_receipts"."status" = 'dropped' AND "publication_receipts"."retry_at" IS NULL AND "publication_receipts"."resolved_at" IS NOT NULL
      AND "publication_receipts"."reason" IS NOT NULL AND "publication_receipts"."message_id" IS NULL AND "publication_receipts"."letter_id" IS NULL)
    OR ("publication_receipts"."status" = 'published' AND "publication_receipts"."retry_at" IS NULL AND "publication_receipts"."resolved_at" IS NOT NULL
      AND ("publication_receipts"."message_id" IS NOT NULL OR "publication_receipts"."letter_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE INDEX `publication_receipts_ready` ON `publication_receipts` (`host_id`,`status`,`retry_at`,`report_id`);--> statement-breakpoint
CREATE TABLE `publication_push_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`host_id` text NOT NULL,
	`member_id` text NOT NULL,
	`status` text NOT NULL,
	`retry_at` integer NOT NULL,
	`budget_day` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `publication_receipts`(`report_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_push_outbox_report_id_unique` ON `publication_push_outbox` (`report_id`);--> statement-breakpoint
CREATE INDEX `publication_push_ready` ON `publication_push_outbox` (`host_id`,`status`,`retry_at`,`id`);--> statement-breakpoint
CREATE INDEX `publication_push_member_day` ON `publication_push_outbox` (`member_id`,`budget_day`);