import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetBilling } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read billing status from Creapolis CRM: open projects with server-computed flags — overdueMilestones (past due, not done), dueSoonMilestones (due within 7 days), unsignedContracts (sent but not signed) — each milestone carrying its agreed amount when recorded. Use it to report cashflow risks; drafting reminders is the owner's call, not this tool's.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireStaff(ctx, "get_billing_status");
    try {
      const data = await crmGetBilling();
      const flagged = data.projects.map((p) => ({
        ...p,
        overdueCount: p.overdueMilestones.length,
        dueSoonCount: p.dueSoonMilestones.length,
        unsignedCount: p.unsignedContracts.length,
      }));
      const findings =
        flagged.reduce((n, p) => n + p.overdueCount + p.dueSoonCount + p.unsignedCount, 0);
      return {
        status: "billing_retrieved",
        openProjects: flagged.length,
        findings,
        projects: flagged,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "billing_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
