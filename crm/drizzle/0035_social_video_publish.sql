-- Social video publishing (IG Reels/Stories + FB video): per-post brand for
-- credential resolution, an unguessable publicId so Meta can download the
-- clip from the public endpoint, the on-disk mp4 path, and the Facebook
-- best-effort result columns (mirrors content_packs).
ALTER TABLE "social_posts" ADD COLUMN "brand" text;
ALTER TABLE "social_posts" ADD COLUMN "public_id" text UNIQUE;
ALTER TABLE "social_posts" ADD COLUMN "video_path" text;
ALTER TABLE "social_posts" ADD COLUMN "fb_post_url" text;
ALTER TABLE "social_posts" ADD COLUMN "fb_published_at" timestamp with time zone;
