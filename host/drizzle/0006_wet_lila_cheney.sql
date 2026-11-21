CREATE TABLE `member_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`display_name` text,
	`code_hash` text NOT NULL,
	`invited_by_member_id` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	`failures` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
