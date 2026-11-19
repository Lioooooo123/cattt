CREATE INDEX "async_jobs_state_next_attempt" ON "async_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "async_jobs_state_lease" ON "async_jobs" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX "boundaries_cat_created" ON "boundaries" USING btree ("cat_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_receipts_cat_question" ON "memory_receipts" USING btree ("cat_id","question_id");--> statement-breakpoint
CREATE INDEX "memory_receipts_cat_source" ON "memory_receipts" USING btree ("cat_id","source_message_id");--> statement-breakpoint
CREATE INDEX "turns_stale_active" ON "turns" USING btree (coalesce("heartbeat_at", "created_at")) WHERE "turns"."status" in ('queued', 'generating');