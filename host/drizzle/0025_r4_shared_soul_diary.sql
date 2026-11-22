CREATE TABLE `cat_facts` (
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
	`kind` text NOT NULL,
	`business_key` text NOT NULL,
	`fact` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cat_id`) REFERENCES `world_cats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cat_facts_business` ON `cat_facts` (`cat_id`,`kind`,`business_key`);--> statement-breakpoint
CREATE INDEX `cat_facts_publication` ON `cat_facts` (`household_id`,`epoch`);