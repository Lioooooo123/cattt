CREATE TABLE `world_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`cat_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`grant_id` text NOT NULL,
	`member_id` text NOT NULL,
	`request_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`activity` text,
	`state_version` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`accept_before` integer NOT NULL,
	`finish_before` integer NOT NULL,
	`result_snapshot` text,
	`occurred_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cat_id`) REFERENCES `world_cats`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_action_request` ON `world_actions` (`household_id`,`member_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `world_action_publication` ON `world_actions` (`household_id`,`epoch`,`status`);--> statement-breakpoint
CREATE TABLE `world_cats` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`legacy_id` text,
	`epoch` integer NOT NULL,
	`grant_id` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_cats_household_id_unique` ON `world_cats` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `world_cats_legacy_id_unique` ON `world_cats` (`legacy_id`);--> statement-breakpoint
CREATE TABLE `world_executors` (
	`action_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `world_actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `world_executor_session` ON `world_executors` (`session_id`);--> statement-breakpoint
CREATE TABLE `world_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`member_id` text NOT NULL,
	`device_id` text NOT NULL,
	`generation` text NOT NULL,
	`present_until` integer NOT NULL,
	`stream_until` integer NOT NULL,
	`drive_grant_id` text,
	`snapshot` text,
	`state_version` integer NOT NULL,
	`observed_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_sessions_member_id_unique` ON `world_sessions` (`member_id`);--> statement-breakpoint
CREATE INDEX `world_sessions_household` ON `world_sessions` (`household_id`);--> statement-breakpoint
CREATE TABLE `world_states` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`cat_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`grant_id` text NOT NULL,
	`profile` text NOT NULL,
	`snapshot` text,
	`observed_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cat_id`) REFERENCES `world_cats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `world_state_publication` ON `world_states` (`household_id`,`epoch`);