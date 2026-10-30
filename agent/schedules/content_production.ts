import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "30 8 * * *",
  markdown:
    "Daily content production. Delegate to the `designer` subagent: produce exactly 4 content packs (2 noticias IA + 2 servicios/productos) with render_content_pack, grounded in the latest intel:scheduled brief and the product docs (search_product_docs). Follow today's slots from the latest strategist:scheduled weekly plan; if there is none, use the default weekday rotation. Report the 4 packIds when done — nothing gets published, everything waits for owner approval in Desktop → Contenido.",
});
