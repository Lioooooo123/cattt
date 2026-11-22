CREATE TABLE `peer_inbox` (
	`household_id` text NOT NULL,
	`source_host_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`receipt` text NOT NULL,
	PRIMARY KEY(`household_id`, `source_host_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `peer_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`target_host_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`envelope` text NOT NULL,
	`job_id` text NOT NULL,
	`status` text NOT NULL,
	`receipt` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT "peer_outbox_state" CHECK(
    ("peer_outbox"."status" = 'pending' AND "peer_outbox"."receipt" IS NULL AND "peer_outbox"."settled_at" IS NULL)
    OR ("peer_outbox"."status" = 'delivered' AND "peer_outbox"."receipt" IS NOT NULL AND "peer_outbox"."settled_at" IS NOT NULL)
    OR ("peer_outbox"."status" = 'rejected' AND "peer_outbox"."receipt" IS NULL AND "peer_outbox"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_outbox_target_key` ON `peer_outbox` (`household_id`,`target_host_id`,`idempotency_key`);