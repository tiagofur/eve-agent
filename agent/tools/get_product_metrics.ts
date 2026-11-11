import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetProductMetrics } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read the latest product metrics snapshots (daily collector): Solennix usage (users, events, clients), Pepinillo telemetry when its backend exists, and VPS health. Use these numbers whenever a post, report or estimate needs real product figures — NEVER cite product metrics from memory.",
  inputSchema: z.object({
    app: z
      .string()
      .max(40)
      .optional()
      .describe("Optional app filter, e.g. 'solennix', 'pepinillo' or 'vps'. Omit for all."),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "get_product_metrics");
    try {
      const data = await crmGetProductMetrics(input.app);
      return {
        status: "metrics_retrieved",
        snapshots: data.metrics.map((m) => ({
          app: m.app,
          date: m.metricDate,
          metrics: m.metrics,
        })),
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
