CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`queue` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`run_at` integer NOT NULL,
	`locked_until` integer,
	`dedupe_key` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "jobs_status" CHECK("jobs"."status" IN ('queued', 'running', 'done', 'dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_active_dedupe` ON `jobs` (`queue`,`dedupe_key`) WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX `jobs_claim` ON `jobs` (`queue`,`status`,`run_at`);