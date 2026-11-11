import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmUpdateSchedule } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Change, pause (enabled=false) or resume (enabled=true) a scheduled task, including this schedule's own prompt — you may improve your own cronjobs. Address it by `name` (or id). List first when unsure which one. Changing the cron or resuming re-arms the next run from now.",
  inputSchema: z.object({
    name: z.string().min(1).max(60).optional(),
    id: z.string().uuid().optional(),
    title: z.string().min(1).max(120).optional(),
    cron: z.string().min(1).max(60).optional(),
    prompt: z.string().min(1).max(20000).optional(),
    enabled: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "update_schedule");
    if (!input.name && !input.id) {
      return { status: "schedule_update_failed", error: "Provide the schedule `name` or `id`." };
    }
    try {
      const out = await crmUpdateSchedule(input);
      return {
        status: "schedule_updated",
        name: out.schedule.name,
        cron: out.schedule.cron,
        enabled: out.schedule.enabled,
        nextRunAt: out.schedule.nextRunAt,
      };
    } catch (err) {
      return {
        status: "schedule_update_failed",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
