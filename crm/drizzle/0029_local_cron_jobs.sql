CREATE TYPE "public"."schedule_kind" AS ENUM('agent', 'local');--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "kind" "schedule_kind" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "handler" text;--> statement-breakpoint
-- The two hardcoded node-cron daemons join the schedules table as kind=local
-- rows: same cadence they had, pausable from Mission Control, never spend
-- tokens, and their handlers run even while EVE is down (12h grace covers
-- the boot catch-up the daemons used to do themselves).
INSERT INTO "schedules" ("id", "name", "title", "cron", "prompt", "enabled", "source", "category", "kind", "handler", "next_run_at") VALUES
  ('10000000-0000-4000-8000-000000000031', 'followup_digest', 'Digest de seguimientos (job local)', '0 9 * * *',
   'Job local del CRM: digest diario de seguimientos a las 09:00 (sin LLM). El prompt no se ejecuta; el dispatcher llama al handler registrado "followup_digest".',
   true, 'system', 'sales', 'local', 'followup_digest', NULL),
  ('10000000-0000-4000-8000-000000000032', 'metrics_collector', 'Collector de métricas (job local)', '45 6 * * *',
   'Job local del CRM: snapshot diario de métricas a las 06:45 (sin LLM). El prompt no se ejecuta; el dispatcher llama al handler registrado "metrics_collector".',
   true, 'system', 'reports', 'local', 'metrics_collector', NULL)
ON CONFLICT ("name") DO NOTHING;
