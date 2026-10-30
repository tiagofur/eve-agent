CREATE TYPE "public"."content_pack_kind" AS ENUM('video', 'carousel', 'image');--> statement-breakpoint
CREATE TYPE "public"."content_pack_status" AS ENUM('pending_approval', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "content_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "content_pack_kind" NOT NULL,
	"topic" text NOT NULL,
	"hook" text,
	"caption" text NOT NULL,
	"captions_by_platform" jsonb,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"platforms" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"zip_path" text NOT NULL,
	"cover_path" text,
	"scheduled_for" date,
	"status" "content_pack_status" DEFAULT 'pending_approval' NOT NULL,
	"rejected_reason" text,
	"approved_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "content_packs_status_idx" ON "content_packs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "content_packs_created_idx" ON "content_packs" USING btree ("created_at");