CREATE TABLE `device_push_registrations` (
	`device_id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`token` text NOT NULL,
	`environment` text NOT NULL,
	`topic` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_push_provider_token` ON `device_push_registrations` (`environment`,`topic`,`token`);--> statement-breakpoint
CREATE TABLE `publication_push_deliveries` (
	`notification_id` text NOT NULL,
	`device_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`apns_id` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`notification_id`, `device_id`),
	FOREIGN KEY (`notification_id`) REFERENCES `publication_push_outbox`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_push_deliveries_apns_id_unique` ON `publication_push_deliveries` (`apns_id`);