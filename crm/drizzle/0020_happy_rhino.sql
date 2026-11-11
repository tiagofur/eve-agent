CREATE TYPE "public"."schedule_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."schedule_run_trigger" AS ENUM('cron', 'manual');--> statement-breakpoint
CREATE TYPE "public"."schedule_source" AS ENUM('system', 'user');--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"status" "schedule_run_status" DEFAULT 'running' NOT NULL,
	"trigger" "schedule_run_trigger" DEFAULT 'cron' NOT NULL,
	"thread_id" uuid,
	"result_summary" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"cron" text NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" "schedule_source" DEFAULT 'user' NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_runs_schedule_idx" ON "schedule_runs" USING btree ("schedule_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_name_uq" ON "schedules" USING btree ("name");--> statement-breakpoint
CREATE INDEX "schedules_enabled_idx" ON "schedules" USING btree ("enabled");--> statement-breakpoint
-- Seed: the four former static agent/schedules/*.ts files, migrated to rows.
-- next_run_at stays NULL: the first dispatcher tick aligns each one to its
-- next occurrence without firing it out of cadence. Idempotent on name.
INSERT INTO "schedules" ("id", "name", "title", "cron", "prompt", "enabled", "source", "next_run_at") VALUES
  ('10000000-0000-4000-8000-000000000001', 'intel_brief', 'Brief de inteligencia IA', '0 7 * * *', 'Daily AI intelligence pass. Delegate to the `intel` subagent: fetch today''s AI news with fetch_ai_news and produce the daily brief (qué se puede hacer ya, novedades, problema→solución, oportunidades Creapolis) saved via save_analyst_report as intel:scheduled. If fetch_ai_news fails for all sources, report that instead of inventing news.', true, 'system', NULL),
  ('10000000-0000-4000-8000-000000000002', 'content_production', 'Producción de contenido (4 packs)', '30 8 * * *', 'Daily content production. Delegate to the `designer` subagent: produce exactly 4 content packs (2 noticias IA + 2 servicios/productos) with render_content_pack, grounded in the latest intel:scheduled brief and the product docs (search_product_docs). Follow today''s slots from the latest strategist:scheduled weekly plan; if there is none, use the default weekday rotation. Report the 4 packIds when done — nothing gets published, everything waits for owner approval in Desktop → Contenido.', true, 'system', NULL),
  ('10000000-0000-4000-8000-000000000003', 'daily_report', 'Reporte diario de operaciones', '0 9 * * *', 'Generate the Creapolis.Dev daily operations and pipeline report. Call get_crm_metrics, calculate stage conversion rates, identify bottlenecks, and formulate exactly 3 data-backed improvements for the team. Then run the follow-up pass: call get_followup_queue and delegate every overdue item to `closer` so it drafts one nudge per item (pending_approval, nothing is ever sent without the owner) and advances each worked follow-up with `set_followup` so the queue drains.', true, 'system', NULL),
  ('10000000-0000-4000-8000-000000000004', 'editorial_plan', 'Plan editorial semanal', '0 20 * * 0', 'Weekly editorial planning (Sunday evening). Delegate to the `strategist` subagent: write next week''s editorial plan (Lunes–Domingo, 4 slots per day: 2 noticias + 2 servicios/productos con foco y ángulo) based on the recent intel:scheduled briefs, and save it via save_analyst_report as strategist:scheduled.', true, 'system', NULL)
ON CONFLICT ("name") DO NOTHING;