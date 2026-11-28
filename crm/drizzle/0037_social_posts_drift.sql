-- Formaliza en el historial de migraciones las columnas de social_posts que se
-- aplicaron a mano en prod con el PR #82 (Reels) sin generar migración. Sin
-- esto, cada `drizzle-kit generate` futuro las re-emite y rompe `migrate` con
-- duplicate column. Idempotente: IF NOT EXISTS no-op donde ya existen.
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "brand" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "public_id" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "video_path" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "fb_post_url" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN IF NOT EXISTS "fb_published_at" timestamp with time zone;
