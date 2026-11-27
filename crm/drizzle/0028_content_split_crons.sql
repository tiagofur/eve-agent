-- Split each brand's daily content run into TWO half-size crons (1 pack each):
-- tips/news and product/service. The owner can pause one block of jobs to cut
-- spend without losing the other half of the cadence. Times stay staggered so
-- runs never overlap; new rows get next_run_at NULL (aligned on the first
-- tick without firing) and category content.
UPDATE "schedules" SET
  "title" = 'Contenido Creapolis: tip/noticia (1 pack)',
  "cron" = '30 8 * * *',
  "prompt" = 'Daily Creapolis.Dev TIP pack. Delegate to the `designer` subagent for brand creapolis: produce exactly 1 content pack — the AI news/tip pack (kind carousel, grounded in the latest intel:scheduled brief; fetch_ai_news if none exists today). Follow today''s CP1 slot from the latest strategist:scheduled weekly plan; if there is none, use the default weekday rotation. Always pass brand=''creapolis'' to render_content_pack. Report the packId — nothing gets published, everything waits for the owner''s 1-click approve+publish on Telegram.',
  "updated_at" = now()
WHERE "name" = 'content_production';--> statement-breakpoint
INSERT INTO "schedules" ("id", "name", "title", "cron", "prompt", "enabled", "source", "category", "next_run_at") VALUES
  ('10000000-0000-4000-8000-000000000021', 'content_products_creapolis', 'Contenido Creapolis: servicio/producto (1 pack)', '32 8 * * *',
   'Daily Creapolis.Dev PRODUCT pack. Delegate to the `designer` subagent for brand creapolis: produce exactly 1 content pack — the service/internal-product pack (grounded in search_product_docs; pricing/features only from the doc). Follow today''s CP2 slot from the latest strategist:scheduled weekly plan; if there is none, use the default weekday rotation. Always pass brand=''creapolis'' to render_content_pack. Report the packId — nothing gets published, everything waits for the owner''s 1-click approve+publish on Telegram.',
   true, 'system', 'content', NULL);--> statement-breakpoint
UPDATE "schedules" SET
  "title" = 'Contenido Pepinillo: tip (1 pack)',
  "cron" = '35 8 * * *',
  "prompt" = 'Daily Pepinillo TIP pack. Delegate to the `designer` subagent for brand pepinillo: produce exactly 1 content pack — the focus/deep-work tip pack (grounded in the pepinillo doc''s Ángulos de marketing, never repeating yesterday''s angle). Follow today''s PP1 slot from the latest strategist:scheduled plan when present. Always pass brand=''pepinillo'' to render_content_pack. Report the packId — nothing gets published; the owner approves+publishes from Telegram.',
  "updated_at" = now()
WHERE "name" = 'content_pepinillo';--> statement-breakpoint
INSERT INTO "schedules" ("id", "name", "title", "cron", "prompt", "enabled", "source", "category", "next_run_at") VALUES
  ('10000000-0000-4000-8000-000000000022', 'content_products_pepinillo', 'Contenido Pepinillo: producto (1 pack)', '37 8 * * *',
   'Daily Pepinillo PRODUCT pack. Delegate to the `designer` subagent for brand pepinillo: produce exactly 1 content pack — the product/feature pack (modes, Mode Intelligence, Watch, widgets, documented pricing; grounded in search_product_docs). Follow today''s PP2 slot from the latest strategist:scheduled plan when present. Always pass brand=''pepinillo'' to render_content_pack. Report the packId — nothing gets published; the owner approves+publishes from Telegram.',
   true, 'system', 'content', NULL);--> statement-breakpoint
UPDATE "schedules" SET
  "title" = 'Contenido Solennix: tip (1 pack)',
  "cron" = '40 8 * * *',
  "prompt" = 'Daily Solennix TIP pack. Delegate to the `designer` subagent for brand solennix: produce exactly 1 content pack — the event-organizer tip pack (checklists, depósitos, contratos, inventario — grounded in the solennix doc). Follow today''s SX1 slot from the latest strategist:scheduled plan when present. Always pass brand=''solennix'' to render_content_pack. Report the packId — nothing gets published; the owner approves+publishes from Telegram.',
  "updated_at" = now()
WHERE "name" = 'content_solennix';--> statement-breakpoint
INSERT INTO "schedules" ("id", "name", "title", "cron", "prompt", "enabled", "source", "category", "next_run_at") VALUES
  ('10000000-0000-4000-8000-000000000023', 'content_products_solennix', 'Contenido Solennix: producto (1 pack)', '42 8 * * *',
   'Daily Solennix PRODUCT pack. Delegate to the `designer` subagent for brand solennix: produce exactly 1 content pack — the product/feature pack (PDFs, portal del cliente, directorio, documented plans; grounded in search_product_docs). Follow today''s SX2 slot from the latest strategist:scheduled plan when present. Always pass brand=''solennix'' to render_content_pack. Report the packId — nothing gets published; the owner approves+publishes from Telegram.',
   true, 'system', 'content', NULL);
