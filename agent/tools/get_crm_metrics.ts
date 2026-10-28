import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetFunnelMetrics } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description: "Retrieve real-time CRM funnel performance, lead conversion rates, and pipeline health metrics for Creapolis.Dev.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireStaff(ctx, "get_crm_metrics");
    try {
      const data = await crmGetFunnelMetrics();
      return {
        status: "metrics_retrieved",
        funnel: data.funnel,
        totalInFunnel: data.totalInFunnel,
        lostCount: data.lostCount,
        wonCount: data.wonCount,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "metrics_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
