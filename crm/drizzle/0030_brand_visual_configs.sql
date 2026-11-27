CREATE TABLE "brand_visual_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"mode" text DEFAULT 'editorial' NOT NULL,
	"art_direction" text DEFAULT '' NOT NULL,
	"cover_title_max_words" integer DEFAULT 8 NOT NULL,
	"show_logo" boolean DEFAULT true NOT NULL,
	"image_model" text DEFAULT 'gemini-nano-banana-2.1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "brand_visual_configs_brand_uq" ON "brand_visual_configs" USING btree ("brand");--> statement-breakpoint
-- One visual profile per brand, all starting in editorial mode (today's
-- deterministic typography): the owner flips a brand to hybrid from
-- Mission Control when they want the AI cover.
INSERT INTO "brand_visual_configs" ("brand", "mode", "art_direction", "cover_title_max_words", "show_logo", "image_model") VALUES
  ('creapolis', 'editorial', '', 8, true, 'gemini-nano-banana-2.1'),
  ('pepinillo', 'editorial', '', 8, true, 'gemini-nano-banana-2.1'),
  ('solennix', 'editorial', '', 8, true, 'gemini-nano-banana-2.1')
ON CONFLICT ("brand") DO NOTHING;
