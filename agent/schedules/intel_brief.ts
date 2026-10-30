import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 7 * * *",
  markdown:
    "Daily AI intelligence pass. Delegate to the `intel` subagent: fetch today's AI news with fetch_ai_news and produce the daily brief (qué se puede hacer ya, novedades, problema→solución, oportunidades Creapolis) saved via save_analyst_report as intel:scheduled. If fetch_ai_news fails for all sources, report that instead of inventing news.",
});
