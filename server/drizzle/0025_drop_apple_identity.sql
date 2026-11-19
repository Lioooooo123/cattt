DROP TABLE "auth_nonces" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_apple_sub_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "apple_sub";