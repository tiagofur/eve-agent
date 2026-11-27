CREATE TYPE "public"."schedule_category" AS ENUM('content', 'reports', 'sales', 'system', 'other');--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "category" "schedule_category" DEFAULT 'other' NOT NULL;--> statement-breakpoint
-- Classify the seeded pipeline the way inferScheduleCategory files new tasks:
-- everything that produces content (the intel brief feeds it) under content,
-- both operation/client reports under reports. Later custom tasks stay
-- 'other' until the owner re-files them from Mission Control.
UPDATE "schedules" SET "category" = 'content' WHERE "name" IN ('content_production', 'content_pepinillo', 'content_solennix', 'intel_brief', 'editorial_plan');--> statement-breakpoint
UPDATE "schedules" SET "category" = 'reports' WHERE "name" IN ('daily_report', 'weekly_reports');
