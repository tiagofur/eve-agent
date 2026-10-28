import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetEstimates } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read saved technical proposals from Creapolis CRM, newest first, optionally filtered by lead or organization. Use it to reference real pending proposals (follow-up context, delivery handoff) instead of recalling them from chat memory.",
  inputSchema: z.object({
    leadId: z.string().uuid().optional().describe("Only proposals for this lead"),
    organizationId: z.string().uuid().optional().describe("Only proposals for this organization"),
    limit: z.number().int().min(1).max(50).optional().describe("How many proposals to read (default 20)"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "get_estimates");
    try {
      const data = await crmGetEstimates({
        leadId: input.leadId,
        organizationId: input.organizationId,
        limit: input.limit,
      });
      return {
        status: "estimates_retrieved",
        estimates: data.estimates,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "estimates_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
