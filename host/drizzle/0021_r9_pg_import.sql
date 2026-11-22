CREATE TABLE `imported_cat_diary` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`text` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`local_day` text NOT NULL,
	`time_zone` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `imported_memory_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imported_memory_block_identity` ON `imported_memory_blocks` (`member_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `imported_memory_restrictions` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`learning_disabled` integer NOT NULL,
	`recall_disabled` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imported_memory_restrictions_member_id_unique` ON `imported_memory_restrictions` (`member_id`);--> statement-breakpoint
CREATE TABLE `pg_import_archive` (
	`source_table` text NOT NULL,
	`source_key` text NOT NULL,
	`source_sha256` text NOT NULL,
	`target_id` text,
	`reason` text NOT NULL,
	`evidence_json` text NOT NULL,
	PRIMARY KEY(`source_table`, `source_key`)
);
--> statement-breakpoint
CREATE TABLE `pg_import_receipts` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_sha256` text NOT NULL,
	`report` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `history_context_blocked` integer DEFAULT false NOT NULL;