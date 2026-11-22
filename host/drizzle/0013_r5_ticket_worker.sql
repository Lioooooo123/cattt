CREATE TABLE `run_steps` (
	`run_id` text NOT NULL,
	`step` integer NOT NULL,
	`ticket_rev` integer NOT NULL,
	`history` text NOT NULL,
	`input_ids` text NOT NULL,
	`conversation_head` text NOT NULL,
	`dependencies` text NOT NULL,
	`usage` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `step`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_steps_position" CHECK("run_steps"."step" BETWEEN 1 AND 20 AND "run_steps"."ticket_rev" > 0)
);
--> statement-breakpoint
CREATE TABLE `worker_reports` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_rev` integer NOT NULL,
	`result_ticket_rev` integer NOT NULL,
	`household_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`for_member_id` text NOT NULL,
	`publisher_host_id` text NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`generation` integer,
	`job_id` text NOT NULL,
	`job_attempt` integer NOT NULL,
	`result` text NOT NULL,
	`source_proofs` text NOT NULL,
	`dependencies` text NOT NULL,
	`conversation_head` text NOT NULL,
	`due_at` integer,
	`time_zone` text NOT NULL,
	`quiet_after` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`for_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publisher_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "worker_reports_kind_run" CHECK(("worker_reports"."kind" = 'followup' AND "worker_reports"."run_id" IS NULL
    AND "worker_reports"."generation" IS NULL AND "worker_reports"."due_at" IS NOT NULL)
    OR ("worker_reports"."kind" = 'errand' AND "worker_reports"."run_id" IS NOT NULL AND "worker_reports"."generation" IS NOT NULL AND "worker_reports"."generation" >= 0 AND "worker_reports"."due_at" IS NULL)),
	CONSTRAINT "worker_reports_revision" CHECK("worker_reports"."ticket_rev" > 0 AND "worker_reports"."result_ticket_rev" = "worker_reports"."ticket_rev" + 1
    AND "worker_reports"."job_attempt" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_reports_id_unique` ON `worker_reports` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `worker_reports_ticket_revision` ON `worker_reports` (`ticket_id`,`ticket_rev`);--> statement-breakpoint
CREATE INDEX `worker_reports_host_cursor` ON `worker_reports` (`publisher_host_id`,`sequence`);