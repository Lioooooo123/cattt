CREATE TABLE `leases` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`epoch` integer NOT NULL,
	`acquired_hlc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
