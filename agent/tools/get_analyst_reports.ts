import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetAnalystReports } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read past analyst briefings saved in Creapolis CRM, newest first. Use it to compare the current funnel against previous analyses and report genuine trends — never claim a trend from a single snapshot or from memory.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("How many past reports to read (default 10)"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "get_analyst_reports");
    try {
      const data = await crmGetAnalystReports(input.limit ?? 10);
      return {
        status: "reports_retrieved",
        reports: data.reports,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "reports_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
