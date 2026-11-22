CREATE TABLE `boundaries` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subject_member_id` text NOT NULL,
	`description` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "boundaries_source_revision" CHECK("boundaries"."source_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boundaries_source_subject` ON `boundaries` (`source_message_id`,`source_revision`,`subject_member_id`);--> statement-breakpoint
CREATE INDEX `boundaries_household_subject` ON `boundaries` (`household_id`,`subject_member_id`);--> statement-breakpoint
CREATE INDEX `boundaries_household_source_member` ON `boundaries` (`household_id`,`source_member_id`);--> statement-breakpoint
CREATE TABLE `diary_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`source_message_id` text,
	`source_revision` integer,
	`text` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`local_day` text NOT NULL,
	`time_zone` text NOT NULL,
	`cat_allowed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "diary_entries_source_revision" CHECK(
    ("diary_entries"."source_message_id" IS NULL AND "diary_entries"."source_revision" IS NULL)
    OR ("diary_entries"."source_message_id" IS NOT NULL AND "diary_entries"."source_revision" IS NOT NULL AND "diary_entries"."source_revision" > 0)
  )
);
--> statement-breakpoint
CREATE INDEX `diary_entries_household_owner_day` ON `diary_entries` (`household_id`,`owner_member_id`,`local_day`);--> statement-breakpoint
CREATE INDEX `diary_entries_household_source_message` ON `diary_entries` (`household_id`,`source_message_id`);--> statement-breakpoint
CREATE TABLE `knowledge_source_withdrawals` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "knowledge_source_withdrawals_revision" CHECK("knowledge_source_withdrawals"."source_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_source_withdrawals_message` ON `knowledge_source_withdrawals` (`source_message_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subject_member_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`predicate` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memories_source_revision" CHECK("memories"."source_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_source_fact` ON `memories` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `memories_household_subject` ON `memories` (`household_id`,`subject_member_id`);--> statement-breakpoint
CREATE INDEX `memories_household_source_member` ON `memories` (`household_id`,`source_member_id`);--> statement-breakpoint
CREATE TABLE `memory_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`subject_member_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_blocks_source_revision" CHECK("memory_blocks"."source_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_blocks_source_fact` ON `memory_blocks` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `memory_blocks_household_subject_fact` ON `memory_blocks` (`household_id`,`subject_member_id`,`fingerprint`);