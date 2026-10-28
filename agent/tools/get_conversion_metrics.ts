import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetConversions } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Retrieve honest funnel conversions computed from the transition history of live leads: per-edge flow-through rates, median time-in-stage, and loss reasons. Rates are trustworthy only when sufficientData is true; below minSample report counts and say the sample is insufficient — never invent confidence.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireStaff(ctx, "get_conversion_metrics");
    try {
      const data = await crmGetConversions();
      return {
        status: "metrics_retrieved",
        sampleSize: data.sampleSize,
        minSample: data.minSample,
        sufficientData: data.sufficientData,
        entries: data.entries,
        edges: data.edges,
        medianMsInStage: data.medianMsInStage,
        lossReasons: data.lossReasons,
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
