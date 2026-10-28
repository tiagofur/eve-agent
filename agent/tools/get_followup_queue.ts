import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetFollowups } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read the unified follow-up queue from Creapolis CRM: overdue reminders first (leads, tickets, client organizations), then upcoming ones. Use it to decide who needs a nudge today.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireStaff(ctx, "get_followup_queue");
    try {
      const data = await crmGetFollowups();
      return {
        status: "queue_retrieved",
        overdueCount: data.overdue.length,
        upcomingCount: data.upcoming.length,
        overdue: data.overdue,
        upcoming: data.upcoming.slice(0, 20),
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "queue_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
