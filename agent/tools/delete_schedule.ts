import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmDeleteSchedule, crmListSchedules } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Permanently delete a scheduled task and its run history. Confirm with the user first, and double-check schedules with source=system (they are part of the daily content pipeline). Prefer pausing (update_schedule enabled=false) when the task might come back.",
  inputSchema: z.object({
    name: z.string().min(1).max(60).optional(),
    id: z.string().uuid().optional(),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "delete_schedule");
    if (!input.name && !input.id) {
      return { status: "schedule_delete_failed", error: "Provide the schedule `name` or `id`." };
    }
    try {
      if (input.name) {
        const { schedules } = await crmListSchedules();
        const target = schedules.find((s) => s.name === input.name);
        if (target?.source === "system") {
          return {
            status: "confirmation_required",
            message:
              `"${target.name}" is a system schedule of the daily content pipeline. ` +
              "Ask the user to confirm deletion explicitly before retrying, or pause it with update_schedule instead.",
          };
        }
      }
      await crmDeleteSchedule(input);
      return { status: "schedule_deleted" };
    } catch (err) {
      return {
        status: "schedule_delete_failed",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
