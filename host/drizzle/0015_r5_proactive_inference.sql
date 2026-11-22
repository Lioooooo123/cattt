CREATE TABLE `inference_candidates` (
	`source_message_id` text PRIMARY KEY NOT NULL,
	`source_revision` integer NOT NULL,
	`household_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`host_id` text NOT NULL,
	`publication_epoch` text NOT NULL,
	`audience` text NOT NULL,
	`source_time_zone` text NOT NULL,
	`rule` text NOT NULL,
	`topic` text NOT NULL,
	`after_at` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`retry_at` integer,
	`resolved_at` integer,
	`ticket_id` text,
	`message_id` text,
	`letter_id` text,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `mailbox_letters`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inference_status" CHECK(
    ("inference_candidates"."status" = 'pending' AND "inference_candidates"."retry_at" IS NOT NULL AND "inference_candidates"."resolved_at" IS NULL)
    OR ("inference_candidates"."status" IN ('observed', 'dropped', 'published') AND "inference_candidates"."retry_at" IS NULL AND "inference_candidates"."resolved_at" IS NOT NULL)
  ),
	CONSTRAINT "inference_delivery" CHECK(
    ("inference_candidates"."status" = 'published' AND "inference_candidates"."ticket_id" IS NOT NULL AND "inference_candidates"."message_id" IS NOT NULL AND "inference_candidates"."letter_id" IS NOT NULL)
    OR ("inference_candidates"."status" <> 'published' AND "inference_candidates"."ticket_id" IS NULL AND "inference_candidates"."message_id" IS NULL AND "inference_candidates"."letter_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX `inference_ready` ON `inference_candidates` (`host_id`,`status`,`retry_at`,`source_message_id`);--> statement-breakpoint
CREATE TABLE `inference_daily_receipts` (
	`member_id` text NOT NULL,
	`local_day` text NOT NULL,
	`source_message_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `local_day`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `inference_candidates`(`source_message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `proactive_permissions` (
	`member_id` text PRIMARY KEY NOT NULL,
	`allowed` integer NOT NULL,
	`revision` integer NOT NULL,
	`time_zone` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `turns` ADD `publication_epoch` text;