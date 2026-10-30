import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 20 * * 0",
  markdown:
    "Weekly editorial planning (Sunday evening). Delegate to the `strategist` subagent: write next week's editorial plan (Lunes–Domingo, 4 slots per day: 2 noticias + 2 servicios/productos con foco y ángulo) based on the recent intel:scheduled briefs, and save it via save_analyst_report as strategist:scheduled.",
});
