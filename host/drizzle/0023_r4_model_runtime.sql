CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`day` text NOT NULL,
	`slot` text NOT NULL,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`turn_id` text,
	`job_id` text,
	`reserved_tokens` integer NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`reasoning_tokens` integer,
	`cache_read_tokens` integer,
	`latency_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "model_calls_status" CHECK("model_calls"."status" IN ('reserved', 'completed', 'failed')),
	CONSTRAINT "model_calls_reservation" CHECK("model_calls"."reserved_tokens" > 0)
);
--> statement-breakpoint
CREATE INDEX `model_calls_host_day` ON `model_calls` (`host_id`,`day`);