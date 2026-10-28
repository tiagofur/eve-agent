CREATE TYPE "public"."task_kind" AS ENUM('feature', 'correction');--> statement-breakpoint
CREATE TYPE "public"."task_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'pending_approval' BEFORE 'ready';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'approved' BEFORE 'ready';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" "task_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"log_path" text,
	"issue_path" text,
	"branch" text,
	"result_summary" text,
	"pr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_branch" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "test_command" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "folder_check" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "folder_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'feature' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_runs_task_idx" ON "task_runs" USING btree ("task_id");