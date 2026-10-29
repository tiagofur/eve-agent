-- Idempotent: some live databases already created this index outside the
-- migration journal (drizzle meta had drifted from the deployed schema).
CREATE INDEX IF NOT EXISTS "outbox_ticket_idx" ON "outbox" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_active_correction_per_ticket" ON "tasks" USING btree ("ticket_id") WHERE "tasks"."status" IN ('pending_approval', 'approved', 'ready', 'dispatched', 'in_progress', 'in_review', 'blocked');