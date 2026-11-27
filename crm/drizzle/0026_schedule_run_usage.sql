ALTER TABLE "schedule_runs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN "cache_read_tokens" integer;