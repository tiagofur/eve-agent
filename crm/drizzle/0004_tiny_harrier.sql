ALTER TABLE "leads" ADD COLUMN "next_follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "follow_up_note" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "next_follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "follow_up_note" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "next_follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "follow_up_note" text;