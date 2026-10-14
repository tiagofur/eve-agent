CREATE TYPE "public"."social_platform" AS ENUM('instagram', 'facebook', 'linkedin', 'twitter');--> statement-breakpoint
CREATE TYPE "public"."social_post_status" AS ENUM('draft', 'pending_approval', 'approved', 'published', 'rejected');--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "social_platform" NOT NULL,
	"topic" text NOT NULL,
	"caption" text NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_prompt" text,
	"image_url" text,
	"status" "social_post_status" DEFAULT 'pending_approval' NOT NULL,
	"rejected_reason" text,
	"published_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "social_posts_status_idx" ON "social_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "social_posts_platform_idx" ON "social_posts" USING btree ("platform");