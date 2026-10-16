CREATE TYPE "public"."ticket_kind" AS ENUM('support', 'info');--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "kind" "ticket_kind" DEFAULT 'support' NOT NULL;