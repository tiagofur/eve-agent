ALTER TABLE "interactions" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_contact_idx" ON "interactions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "interactions_org_idx" ON "interactions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "interactions_ticket_idx" ON "interactions" USING btree ("ticket_id");