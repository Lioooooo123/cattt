CREATE TABLE "model_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource" text NOT NULL,
	"lane" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_admissions_lane_check" CHECK ("model_admissions"."lane" in ('chat', 'background')),
	CONSTRAINT "model_admissions_state_check" CHECK ("model_admissions"."state" in ('waiting', 'running'))
);
--> statement-breakpoint
CREATE INDEX "model_admissions_queue_idx" ON "model_admissions" USING btree ("resource","state","lane","created_at");