CREATE TABLE `__new_memories` (
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
	`subject_member_id` text,
	`fingerprint` text NOT NULL,
	`predicate` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memories_source_revision" CHECK("source_revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_memories`("id", "origin_host_id", "hlc", "rev", "created_at", "updated_at", "deleted_at", "household_id", "source_member_id", "source_message_id", "source_revision", "subject_member_id", "fingerprint", "predicate", "value") SELECT "id", "origin_host_id", "hlc", "rev", "created_at", "updated_at", "deleted_at", "household_id", "source_member_id", "source_message_id", "source_revision", "subject_member_id", "fingerprint", "predicate", "value" FROM `memories`;--> statement-breakpoint
DROP TABLE `memories`;--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;--> statement-breakpoint
CREATE UNIQUE INDEX `memories_source_fact` ON `memories` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `memories_source_household_fact` ON `memories` (`source_message_id`,`source_revision`,`fingerprint`) WHERE "memories"."subject_member_id" IS NULL;--> statement-breakpoint
CREATE INDEX `memories_household_subject` ON `memories` (`household_id`,`subject_member_id`);--> statement-breakpoint
CREATE INDEX `memories_household_source_member` ON `memories` (`household_id`,`source_member_id`);--> statement-breakpoint
CREATE TABLE `__new_memory_blocks` (
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
	`subject_member_id` text,
	`fingerprint` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_blocks_source_revision" CHECK("source_revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_memory_blocks`("id", "origin_host_id", "hlc", "rev", "created_at", "updated_at", "deleted_at", "household_id", "source_member_id", "source_message_id", "source_revision", "subject_member_id", "fingerprint") SELECT "id", "origin_host_id", "hlc", "rev", "created_at", "updated_at", "deleted_at", "household_id", "source_member_id", "source_message_id", "source_revision", "subject_member_id", "fingerprint" FROM `memory_blocks`;--> statement-breakpoint
DROP TABLE `memory_blocks`;--> statement-breakpoint
ALTER TABLE `__new_memory_blocks` RENAME TO `memory_blocks`;--> statement-breakpoint
CREATE UNIQUE INDEX `memory_blocks_source_fact` ON `memory_blocks` (`source_message_id`,`source_revision`,`subject_member_id`,`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `memory_blocks_source_household_fact` ON `memory_blocks` (`source_message_id`,`source_revision`,`fingerprint`) WHERE "memory_blocks"."subject_member_id" IS NULL;--> statement-breakpoint
CREATE INDEX `memory_blocks_household_subject_fact` ON `memory_blocks` (`household_id`,`subject_member_id`,`fingerprint`);