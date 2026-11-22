CREATE TABLE `relay_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_host_id` text NOT NULL,
	`hlc` text NOT NULL,
	`rev` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`household_id` text NOT NULL,
	`source_member_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`target_member_id` text NOT NULL,
	`target_host_id` text NOT NULL,
	`source_generation` text NOT NULL,
	`source_seq` integer NOT NULL,
	`source_day` text NOT NULL,
	`source_time_zone` text NOT NULL,
	`urgent` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "relay_grants_proof" CHECK("relay_grants"."source_member_id" <> "relay_grants"."target_member_id"
    AND "relay_grants"."source_revision" > 0 AND "relay_grants"."source_seq" > 0 AND "relay_grants"."rev" = 1 AND "relay_grants"."deleted_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_grants_original` ON `relay_grants` (`source_message_id`);--> statement-breakpoint
CREATE INDEX `relay_grants_quota` ON `relay_grants` (`source_member_id`,`source_day`,`urgent`);--> statement-breakpoint
CREATE TABLE `relay_publications` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`target_host_id` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`retry_at` integer,
	`message_id` text,
	FOREIGN KEY (`grant_id`) REFERENCES `relay_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "relay_publications_state" CHECK(
    ("relay_publications"."state" = 'pending' AND "relay_publications"."retry_at" IS NOT NULL AND "relay_publications"."message_id" IS NULL)
    OR ("relay_publications"."state" = 'published' AND "relay_publications"."retry_at" IS NULL AND "relay_publications"."message_id" IS NOT NULL)
    OR ("relay_publications"."state" = 'dropped' AND "relay_publications"."retry_at" IS NULL AND "relay_publications"."message_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `relay_publications_due` ON `relay_publications` (`target_host_id`,`state`,`retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `relay_publications_message` ON `relay_publications` (`message_id`);