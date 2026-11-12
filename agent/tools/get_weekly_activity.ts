import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetWeeklyActivity } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read the week's CRM facts per open project: completed tasks (with PR and verification evidence), tasks in flight, milestones closed and upcoming, tickets resolved and open, and the client contacts for each organization. `pendingReport: true` means this week's report draft already awaits approval — do not draft it again. Everything here is internal evidence for drafting the client status report with draft_weekly_report.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(31).default(7).describe("Window size in days; 7 for the standard weekly report"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "get_weekly_activity");
    try {
      const data = await crmGetWeeklyActivity(input.days ?? 7);
      return { status: "weekly_activity_retrieved", ...data, retrievedAt: new Date().toISOString() };
    } catch (err) {
      return {
        status: "weekly_activity_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
