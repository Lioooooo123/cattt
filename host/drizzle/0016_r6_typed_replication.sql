CREATE TABLE `change_log` (
	`source_host_id` text NOT NULL,
	`generation` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`source_host_id`, `generation`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `peer_cursors` (
	`source_host_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`generation` text NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `peers` (
	`host_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`join_from_household_id` text,
	`join_prepared_at` integer,
	`address_host` text NOT NULL,
	`address_port` integer NOT NULL,
	`ca_certificate` text NOT NULL,
	`fingerprint` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`approved_at` integer NOT NULL,
	`confirmed_at` integer,
	`confirmed_local_fingerprint` text,
	`revoked_at` integer,
	`pull_paused` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peers_fingerprint_unique` ON `peers` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `replication_state` (
	`source_host_id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`last_seq` integer NOT NULL,
	`snapshot_required` integer NOT NULL
);
