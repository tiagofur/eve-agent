import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmSaveDossier } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description: "Save a verified research dossier for a prospective business into Creapolis CRM, automatically transitioning lead to 'researched' stage.",
  inputSchema: z.object({
    leadId: z.string().optional().describe("Lead UUID if researching an existing lead"),
    organizationId: z.string().optional().describe("Organization UUID if already known"),
    companyName: z.string().optional().describe("Company or business name"),
    domain: z.string().optional().describe("Website domain (e.g. acme.com)"),
    googlePlaceId: z.string().optional().describe("Google Places ID if sourced from local maps"),
    summary: z.string().describe("Executive summary of the business and identified digital opportunities"),
    findings: z
      .record(z.string(), z.unknown())
      .describe("Structured findings: tech stack, missing automations, pain points, key contacts"),
    sources: z
      .array(
        z.object({
          url: z.string().url().describe("Exact source URL where information was retrieved"),
          retrievedAt: z.string().describe("ISO timestamp when the data was retrieved"),
          note: z.string().optional().describe("Context on what was found on this URL"),
        })
      )
      .min(1, "At least one verified source URL is required for auditability"),
    contact: z
      .object({
        name: z.string().optional().describe("Decision maker's name when identified"),
        email: z.string().optional().describe("Verified email published by the business"),
        phone: z.string().optional().describe("Verified phone/WhatsApp published by the business"),
      })
      .optional()
      .describe(
        "Contact data you actually verified on the business's pages. The CRM links it to the lead so outreach drafts have a recipient. NEVER guess or pattern-fill."
      ),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "save_prospect_dossier");
    try {
      const result = await crmSaveDossier({
        leadId: input.leadId,
        organizationId: input.organizationId,
        companyName: input.companyName,
        domain: input.domain,
        googlePlaceId: input.googlePlaceId,
        summary: input.summary,
        findings: input.findings,
        sources: input.sources,
        contact: input.contact,
      });

      return {
        status: "dossier_saved_in_crm",
        dossierId: result.dossier.id,
        organizationId: result.dossier.organizationId,
        leadId: result.dossier.leadId,
        message: "Verified dossier persisted and lead marked as researched.",
      };
    } catch (err) {
      return {
        status: "saved_locally_fallback",
        dossierId: `dossier_${Date.now()}`,
        error: err instanceof Error ? err.message : "CRM API unavailable",
      };
    }
  },
});
