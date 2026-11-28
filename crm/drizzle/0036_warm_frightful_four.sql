-- Solo el default nuevo de image_model. Las columnas de social_posts que el
-- generador arrastró ya existen en prod (aplicadas a mano con el PR #82 sin
-- migración); incluirlas rompería `drizzle-kit migrate` con duplicate column.
ALTER TABLE "brand_visual_configs" ALTER COLUMN "image_model" SET DEFAULT 'gemini-3-pro-image';
