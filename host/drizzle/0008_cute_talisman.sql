CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`request_id` text,
	`status` text NOT NULL,
	`reply_message_id` text,
	`error_code` text,
	`cancel_reason` text,
	`visible_length` integer,
	`first_token_at` integer,
	`heartbeat_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`draft_text` text NOT NULL,
	`event_seq` integer NOT NULL,
	`superseded_by_turn_id` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "turns_status" CHECK("turns"."status" IN ('queued','generating','completed','stopped','superseded','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turns_request_id_unique` ON `turns` (`request_id`);--> statement-breakpoint
CREATE INDEX `turns_pending` ON `turns` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `turns_conversation` ON `turns` (`conversation_id`,`created_at`);