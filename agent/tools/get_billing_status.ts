import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetBilling } from "../lib/crm";

export default defineTool({
  description:
    "Read billing status from Creapolis CRM: open projects with their milestones (due dates, completion) and contracts (draft, in review, sent, signed). Use it to spot overdue deliverables, unsigned contracts, and payment reminders to draft.",
  inputSchema: z.object({}),
  async execute() {
    try {
      const data = await crmGetBilling();
      const now = Date.now();
      const flagged = data.projects.map((p) => ({
        ...p,
        overdueMilestones: p.milestones.filter((m) => !m.doneAt && m.dueDate && new Date(m.dueDate).getTime() < now),
        unsignedContracts: p.contracts.filter((c) => c.status !== "signed" && c.status !== "void"),
      }));
      return {
        status: "billing_retrieved",
        openProjects: flagged.length,
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
