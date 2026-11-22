CREATE TABLE `file_blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`byte_size` integer NOT NULL,
	`verified_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `file_descriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`file_id` text NOT NULL,
	`file_rev` integer NOT NULL,
	`source_message_id` text,
	`source_message_rev` integer,
	`sha256` text NOT NULL,
	`model_id` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_descriptions_file_revision` ON `file_descriptions` (`file_id`,`file_rev`);--> statement-breakpoint
CREATE TABLE `file_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`client_upload_id` text NOT NULL,
	`household_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`source_message_id` text,
	`source_message_rev` integer,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`description` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_uploads_owner_client_id` ON `file_uploads` (`owner_member_id`,`client_upload_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`source_message_id` text,
	`source_message_rev` integer,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`file_name` text NOT NULL,
	`media_type` text NOT NULL,
	`description` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "files_source_message" CHECK(("files"."source_message_id" IS NULL AND "files"."source_message_rev" IS NULL)
    OR ("files"."source_message_id" IS NOT NULL AND "files"."source_message_rev" IS NOT NULL AND "files"."source_message_rev" > 0))
);
--> statement-breakpoint
CREATE INDEX `files_conversation_order` ON `files` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `files_sha256` ON `files` (`sha256`);--> statement-breakpoint
CREATE TABLE `member_change_projections` (
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`generation` text NOT NULL,
	`kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`fingerprint` text,
	PRIMARY KEY(`household_id`, `member_id`, `kind`, `resource_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_change_sequence` ON `member_change_projections` (`household_id`,`member_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `member_resource_receipts` (
	`member_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`resource_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `request_id`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `retired_peer_generations` (
	`source_host_id` text NOT NULL,
	`generation` text NOT NULL,
	PRIMARY KEY(`source_host_id`, `generation`)
);
--> statement-breakpoint
ALTER TABLE `change_log` ADD `transaction_end_seq` integer;