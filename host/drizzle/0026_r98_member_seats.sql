CREATE TABLE `member_seat_grants` (
	`member_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`peer_host_id` text NOT NULL,
	`expires_at` integer,
	`confirmed_at` integer,
	`released_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `member_seat_legacy_peers` (
	`peer_host_id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `member_invites` ADD `seat_member_id` text;
--> statement-breakpoint
-- An older peer may have committed a member the creator never pulled.
INSERT OR IGNORE INTO member_seat_legacy_peers (peer_host_id, household_id)
SELECT p.host_id, p.household_id FROM peers p
JOIN households h ON h.id = p.household_id
JOIN host_meta m ON m.key = 'host_id' AND m.value = h.origin_host_id;
--> statement-breakpoint
-- Existing origin invitations already participate in its local transactions.
-- An older joined-host invitation has no household grant and must be reissued.
UPDATE member_invites SET revoked_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE used_at IS NULL AND revoked_at IS NULL AND household_id IN (
  SELECT h.id FROM households h
  JOIN host_meta m ON m.key = 'host_id' AND m.value <> h.origin_host_id
);
