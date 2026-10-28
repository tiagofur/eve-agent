ALTER TABLE "outbox" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_ticket_idx" ON "tasks" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "outbox_ticket_idx" ON "outbox" USING btree ("ticket_id");
