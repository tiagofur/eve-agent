import { defineSchedule } from "eve/schedules";

export default defineSchedule({
  cron: "0 9 * * *",
  markdown:
    "Generate the Creapolis.Dev daily operations and pipeline report. Call get_crm_metrics, calculate stage conversion rates, identify bottlenecks, and formulate exactly 3 data-backed improvements for the team.",
});
