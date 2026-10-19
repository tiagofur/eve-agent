import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmSaveEstimate } from "../lib/crm";

export default defineTool({
  description:
    "Save a technical proposal in Creapolis CRM against its lead or organization: category, complexity, scope, phased milestones with timeframes, timeline, and the agreed value only when quoted. Call it for every proposal you write so estimates never vanish into chat. Never invent money: omit valueCents when no figure was agreed.",
  inputSchema: z.object({
    leadId: z.string().uuid().optional().describe("Lead UUID the proposal belongs to"),
    organizationId: z.string().uuid().optional().describe("Organization UUID for existing-client proposals"),
    category: z
      .enum(["web_mobile_app", "workflow_automation", "enterprise_ai_agent", "full_system_integration"])
      .describe("Service category matching the ballpark taxonomy"),
    complexity: z.enum(["mvp", "standard", "enterprise"]).describe("Engagement complexity"),
    scopeSummary: z.string().min(1).describe("What is proposed, in concrete terms"),
    phases: z
      .array(z.object({ title: z.string().min(1), timeframe: z.string().optional() }))
      .optional()
      .describe("MVP milestone breakdown with realistic timeframes"),
    timelineText: z.string().optional().describe("Overall delivery window (e.g. '2 - 4 weeks')"),
    valueCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Agreed/quoted price in minor units. Omit when not quoted — never guess."),
    currency: z.string().max(8).optional().describe("Currency code (default USD)"),
    createdBy: z.string().describe("Author tag, e.g. solutions:chat"),
  }),
  async execute(input) {
    try {
      const result = await crmSaveEstimate({
        leadId: input.leadId,
        organizationId: input.organizationId,
        category: input.category,
        complexity: input.complexity,
        scopeSummary: input.scopeSummary,
        phases: input.phases,
        timelineText: input.timelineText,
        valueCents: input.valueCents,
        currency: input.currency,
        createdBy: input.createdBy,
      });

      return {
        status: "estimate_saved",
        estimateId: result.estimate.id,
        message: "Proposal persisted against the pipeline with its scope and timeline.",
      };
    } catch (err) {
      return {
        status: "estimate_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
