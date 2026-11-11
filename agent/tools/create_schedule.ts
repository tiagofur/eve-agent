import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateSchedule } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Create a scheduled task (agent cronjob) that runs a prompt automatically on a cron cadence. The prompt must be fully self-contained: it runs headless in a fresh session, so spell out every step (including which subagent or tools to use). Confirm the cadence (cron is 5-field, server timezone) with the user before creating.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    cron: z.string().min(1).max(60),
    prompt: z.string().min(1).max(20000),
    name: z.string().regex(/^[a-z0-9_]+$/).max(60).optional(),
    enabled: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "create_schedule");
    try {
      const out = await crmCreateSchedule(input);
      return {
        status: "schedule_created",
        name: out.schedule.name,
        cron: out.schedule.cron,
        nextRunAt: out.schedule.nextRunAt,
      };
    } catch (err) {
      return {
        status: "schedule_creation_failed",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
