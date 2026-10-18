ALTER TABLE "milestones" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;