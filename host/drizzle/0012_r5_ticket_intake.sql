CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`trigger_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`outcome` text NOT NULL,
	`reasons` text NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_one_per_trigger` ON `decisions` (`trigger_id`);--> statement-breakpoint
CREATE INDEX `decisions_ticket` ON `decisions` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`publisher_host_id` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`local_day` text,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`elapsed_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_generation" CHECK("runs"."generation" >= 0),
	CONSTRAINT "runs_budget" CHECK("runs"."output_tokens" >= 0 AND "runs"."elapsed_ms" >= 0),
	CONSTRAINT "runs_status" CHECK("runs"."status" IN ('pending', 'running', 'ended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_ticket_generation` ON `runs` (`ticket_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_ticket_running` ON `runs` (`ticket_id`) WHERE "runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX `runs_host_local_day` ON `runs` (`publisher_host_id`,`local_day`);--> statement-breakpoint
CREATE TABLE `ticket_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`ticket_id` text NOT NULL,
	`trigger_id` text NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_message_id` text,
	`source_revision` integer,
	`text` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ticket_inputs_source_proof" CHECK(("ticket_inputs"."source_message_id" IS NULL AND "ticket_inputs"."source_revision" IS NULL)
    OR ("ticket_inputs"."source_message_id" IS NOT NULL AND "ticket_inputs"."source_revision" IS NOT NULL AND "ticket_inputs"."source_revision" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_inputs_trigger` ON `ticket_inputs` (`trigger_id`);--> statement-breakpoint
CREATE INDEX `ticket_inputs_ticket` ON `ticket_inputs` (`ticket_id`,`hlc`,`id`);--> statement-breakpoint
CREATE TABLE `tickets` (
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
	`kind` text NOT NULL,
	`mandate_kind` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`ended_reason` text,
	`due_at` integer,
	`time_zone` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`for_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tickets_due_at" CHECK(("tickets"."kind" = 'followup' AND "tickets"."due_at" IS NOT NULL)
    OR ("tickets"."kind" = 'errand' AND "tickets"."due_at" IS NULL)),
	CONSTRAINT "tickets_source_revision" CHECK("tickets"."source_revision" > 0),
	CONSTRAINT "tickets_status_stage" CHECK(("tickets"."status" = 'open'
    AND "tickets"."stage" IN ('scheduled', 'queued', 'thinking', 'waiting', 'quiet_waiting') AND "tickets"."ended_reason" IS NULL)
    OR ("tickets"."status" = 'ended'
    AND "tickets"."stage" IN ('completed', 'failed', 'blocked', 'discarded', 'cancelled')))
);
--> statement-breakpoint
CREATE INDEX `tickets_member_status` ON `tickets` (`household_id`,`for_member_id`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `tickets_host_admission` ON `tickets` (`publisher_host_id`,`kind`,`status`,`stage`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`publisher_host_id` text NOT NULL,
	`source` text NOT NULL,
	`source_message_id` text,
	`source_revision` integer,
	`idempotency_key` text NOT NULL,
	`command_kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`receipt` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "triggers_source_proof" CHECK(("triggers"."source_message_id" IS NULL AND "triggers"."source_revision" IS NULL AND "triggers"."source" = 'app')
    OR ("triggers"."source_message_id" IS NOT NULL AND "triggers"."source_revision" IS NOT NULL AND "triggers"."source_revision" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `triggers_request_key` ON `triggers` (`household_id`,`actor_member_id`,`source`,`idempotency_key`);