CREATE TABLE "product_metrics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_date" date NOT NULL,
	"app" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "product_metrics_date_app_uq" ON "product_metrics_daily" USING btree ("metric_date","app");--> statement-breakpoint
-- daily_report now includes the product metrics section (via get_product_metrics).
UPDATE "schedules" SET "prompt" = 'Generate the Creapolis.Dev daily operations and pipeline report. Call get_crm_metrics, calculate stage conversion rates, identify bottlenecks, and formulate exactly 3 data-backed improvements for the team. Then run the follow-up pass: call get_followup_queue and delegate every overdue item to `closer` so it drafts one nudge per item (pending_approval, nothing is ever sent without the owner) and advances each worked follow-up with `set_followup` so the queue drains. Finally call get_product_metrics and add a short "Métricas de producto" section with the latest Solennix/Pepinillo usage and VPS health numbers when available (cite only what the tool returns).', "updated_at" = now() WHERE "name" = 'daily_report';
