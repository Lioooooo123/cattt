CREATE TABLE `chat_reply_knowledge` (
	`message_id` text PRIMARY KEY NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory_extraction_dependencies` (
	`memory_id` text NOT NULL,
	`context_message_id` text NOT NULL,
	`context_revision` integer NOT NULL,
	PRIMARY KEY(`memory_id`, `context_message_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`context_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_extraction_dependencies_revision" CHECK("memory_extraction_dependencies"."context_revision" > 0)
);
--> statement-breakpoint
CREATE INDEX `memory_extraction_dependencies_message` ON `memory_extraction_dependencies` (`context_message_id`);--> statement-breakpoint
CREATE TABLE `pending_memory_extractions` (
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
	`reason` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pending_memory_extractions_revision" CHECK("pending_memory_extractions"."source_revision" > 0),
	CONSTRAINT "pending_memory_extractions_reason" CHECK("pending_memory_extractions"."reason" IN ('subject', 'source'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_memory_extractions_source_fact` ON `pending_memory_extractions` (`source_message_id`,`source_revision`,`key`,`value`);--> statement-breakpoint
CREATE INDEX `pending_memory_extractions_household` ON `pending_memory_extractions` (`household_id`);--> statement-breakpoint
ALTER TABLE `memories` ADD `corrects_previous` integer DEFAULT false NOT NULL;