CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`kind` text NOT NULL,
	`owner_member_id` text,
	`publisher_host_id` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_kind_owner" CHECK(("conversations"."kind" = 'group' AND "conversations"."owner_member_id" IS NULL)
    OR ("conversations"."kind" = 'direct' AND "conversations"."owner_member_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_one_group` ON `conversations` (`household_id`) WHERE "conversations"."kind" = 'group';--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_one_direct` ON `conversations` (`owner_member_id`) WHERE "conversations"."kind" = 'direct';--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`conversation_id` text NOT NULL,
	`author_member_id` text,
	`text` text NOT NULL,
	`modality` text NOT NULL,
	`status` text NOT NULL,
	`client_message_id` text,
	`reply_to_message_id` text,
	`turn_id` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_modality" CHECK("messages"."modality" = 'text'),
	CONSTRAINT "messages_status" CHECK("messages"."status" IN ('complete', 'stopped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_idempotency` ON `messages` (`conversation_id`,`author_member_id`,`client_message_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_order` ON `messages` (`conversation_id`,`hlc`,`id`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`conversation_id` text NOT NULL,
	`member_id` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participants_conversation_member` ON `participants` (`conversation_id`,`member_id`);