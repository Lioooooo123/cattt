CREATE TABLE "conversation_locks" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_controls" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"cancel_reason" text,
	"cancel_expires_at" timestamp with time zone,
	"visible_length" integer,
	"visible_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turn_events" (
	"turn_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"event" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "turn_events_turn_seq" ON "turn_events" USING btree ("turn_id","seq");--> statement-breakpoint
CREATE INDEX "turn_events_created" ON "turn_events" USING btree ("created_at");