import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmSaveAnalystReport } from "../lib/crm";

export default defineTool({
  description:
    "Persist an analyst briefing in Creapolis CRM with the frozen metrics snapshot it was grounded in, so future analyses can compare real trends across saved history instead of relying on memory. Call it once per analysis, after writing the briefing.",
  inputSchema: z.object({
    summary: z.string().min(1).describe("Full markdown briefing (funnel table, findings, proposals)"),
    metrics: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Frozen snapshot of the numbers the briefing cites (sample size, edges, counts)"),
    periodStart: z.string().optional().describe("ISO datetime the analysis window starts at"),
    periodEnd: z.string().optional().describe("ISO datetime the analysis window ends at"),
    createdBy: z.string().describe("Author tag, e.g. analyst:scheduled or analyst:chat"),
  }),
  async execute(input) {
    try {
      const result = await crmSaveAnalystReport({
        summary: input.summary,
        metrics: input.metrics,
        periodStart: input.periodEnd ? input.periodStart : undefined,
        periodEnd: input.periodEnd,
        createdBy: input.createdBy,
      });

      return {
        status: "report_saved",
        reportId: result.report.id,
        message: "Analysis persisted with its metrics snapshot for trend comparison.",
      };
    } catch (err) {
      return {
        status: "report_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
