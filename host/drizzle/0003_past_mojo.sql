CREATE TABLE `chat_events` (
	`stream_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`terminal` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`stream_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `chat_events_created_at` ON `chat_events` (`created_at`);